const express = require('express');
const {
  deriveAccountNetState,
  getAccountAccessState,
  toPublicRestriction
} = require('../services/net-withdrawal-restriction');

module.exports = function createControlTowerRouter({ pool, requireControlTowerAccess }) {
  const router = express.Router();
  router.use(requireControlTowerAccess);

  const parseAmount = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const amount = Number(value);
    return Number.isFinite(amount) && amount >= 0 ? amount : null;
  };
  const parseDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const queryRange = (query) => {
    const clauses = [];
    const values = [];
    const add = (sql, value) => {
      values.push(value);
      clauses.push(sql.replace('?', '$' + values.length));
    };
    const minAmount = parseAmount(query.minAmount);
    const maxAmount = parseAmount(query.maxAmount);
    const from = parseDate(query.from);
    const to = parseDate(query.to);
    if (minAmount !== null) add('w.amount >= ?', minAmount);
    if (maxAmount !== null) add('w.amount <= ?', maxAmount);
    if (from) add('w.submitted_at >= ?', from);
    if (to) add('w.submitted_at <= ?', to);
    return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', values };
  };
  const rowLock = pool.databaseClient === 'sqlite' ? '' : ' FOR UPDATE';

  router.get('/cash-flow', async (req, res) => {
    try {
      const result = await pool.query("SELECT day, SUM(inflow) AS inflow, SUM(outflow) AS outflow FROM (SELECT DATE(COALESCE(transaction_time, created_at)) AS day, amount AS inflow, 0 AS outflow FROM mpesa_transactions WHERE status = 'completed' UNION ALL SELECT DATE(transaction_time) AS day, amount AS inflow, 0 AS outflow FROM savings_deposits UNION ALL SELECT DATE(submitted_at) AS day, 0 AS inflow, amount AS outflow FROM withdrawals WHERE LOWER(COALESCE(status, 'pending')) <> 'refunded' UNION ALL SELECT DATE(submitted_at) AS day, 0 AS inflow, amount AS outflow FROM savings_withdrawals UNION ALL SELECT DATE(created_at) AS day, 0 AS inflow, reward_amount AS outflow FROM referrals WHERE reward_paid = true AND reward_amount > 0) cash_flow GROUP BY day ORDER BY day ASC");
      const series = result.rows.map((row) => ({
        date: row.day,
        inflow: Number(row.inflow || 0),
        outflow: Number(row.outflow || 0)
      }));
      const totals = series.reduce(
        (summary, item) => ({
          inflow: summary.inflow + item.inflow,
          outflow: summary.outflow + item.outflow
        }),
        { inflow: 0, outflow: 0 }
      );
      res.json({ success: true, series, totals });
    } catch (error) {
      console.error('Cash-flow report error:', error);
      res.status(500).json({ success: false, message: 'Unable to load the cash-flow report.' });
    }
  });

  router.get('/requests', async (req, res) => {
    try {
      const result = await pool.query("SELECT * FROM (SELECT 'AI purchase' AS request_type, m.id, m.user_id, u.phone, m.amount, m.status, m.created_at AS submitted_at, m.ai_task AS detail FROM mpesa_transactions m JOIN users u ON u.id = m.user_id UNION ALL SELECT 'Savings deposit' AS request_type, d.id, d.user_id, u.phone, d.amount, d.status, d.created_at AS submitted_at, d.tier AS detail FROM savings_deposits d JOIN users u ON u.id = d.user_id UNION ALL SELECT 'Earnings withdrawal' AS request_type, w.id, w.user_id, u.phone, w.amount, w.status, w.submitted_at, w.receiving_number AS detail FROM withdrawals w JOIN users u ON u.id = w.user_id UNION ALL SELECT 'Savings withdrawal' AS request_type, s.id, s.user_id, u.phone, s.amount, s.status, s.submitted_at, '' AS detail FROM savings_withdrawals s JOIN users u ON u.id = s.user_id UNION ALL SELECT 'Loan application' AS request_type, l.id, l.user_id, u.phone, 0 AS amount, l.status, l.submitted_at, '' AS detail FROM loan_applications l JOIN users u ON u.id = l.user_id) requests ORDER BY submitted_at DESC LIMIT 100");
      res.json({ success: true, requests: result.rows });
    } catch (error) {
      console.error('Control Tower request feed error:', error);
      res.status(500).json({ success: false, message: 'Unable to load incoming requests.' });
    }
  });

  router.get('/withdrawals', async (req, res) => {
    try {
      const range = queryRange(req.query);
      const [withdrawals, wallets] = await Promise.all([
        pool.query(
          'SELECT w.id, w.user_id, u.phone, u.first_name, u.last_name, w.amount, w.status, w.receiving_number, w.submitted_at, w.processed_at FROM withdrawals w JOIN users u ON u.id = w.user_id ' +
            range.where +
            ' ORDER BY w.submitted_at DESC LIMIT 1000',
          range.values
        ),
        pool.query('SELECT COALESCE(SUM(totalEarned), 0) AS total_wallet_balance, COUNT(*) AS user_count FROM users')
      ]);
      res.json({
        success: true,
        withdrawals: withdrawals.rows,
        totalWalletBalance: Number(wallets.rows[0]?.total_wallet_balance || 0),
        userCount: Number(wallets.rows[0]?.user_count || 0),
        refreshedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error('Control Tower withdrawals error:', error);
      res.status(500).json({ success: false, message: 'Unable to load withdrawal requests.' });
    }
  });

  // A payout is marked only from the authenticated Control Tower. Preserve the
  // one-way status update and enforce referral/NET rules on subsequent requests.
  const markWithdrawalPaid = async (req, res) => {
    const withdrawalId = Number(req.params.withdrawalId);
    if (!Number.isInteger(withdrawalId) || withdrawalId < 1) {
      return res.status(400).json({ success: false, message: 'Invalid withdrawal request.' });
    }

    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      const reference = await client.query(
        'SELECT id, user_id FROM withdrawals WHERE id = $1',
        [withdrawalId]
      );
      if (!reference.rows.length) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(404).json({ success: false, message: 'Withdrawal request not found.' });
      }

      const userId = reference.rows[0].user_id;
      const user = await client.query('SELECT id FROM users WHERE id = $1' + rowLock, [userId]);
      if (!user.rows.length) throw new Error('Withdrawal contributor was not found.');
      const existing = await client.query(
        'SELECT id, status FROM withdrawals WHERE id = $1' + rowLock,
        [withdrawalId]
      );
      if (!existing.rows.length) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(404).json({ success: false, message: 'Withdrawal request not found.' });
      }

      const status = String(existing.rows[0].status).toLowerCase();
      if (status === 'paid') {
        await client.query('COMMIT');
        transactionOpen = false;
        return res.json({ success: true, status: 'paid' });
      }
      if (!['pending', 'processing'].includes(status)) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(409).json({
          success: false,
          message: 'This withdrawal request can no longer be marked as paid.'
        });
      }

      const access = await getAccountAccessState(userId, client.query.bind(client));
      const priorWithdrawals = await client.query(
        "SELECT COUNT(*) AS count FROM withdrawals WHERE user_id = $1 AND id < $2 AND LOWER(COALESCE(status, 'pending')) <> 'refunded'",
        [userId, withdrawalId]
      );
      // The first request is allowed to be paid without a referral. Any later
      // request stays on hold while its referral/NET requirement fails.
      if (Number(priorWithdrawals.rows[0]?.count || 0) > 0 && access.restricted) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(409).json({
          success: false,
          message: access.message,
          withdrawalRestriction: toPublicRestriction(access)
        });
      }

      const updated = await client.query(
        "UPDATE withdrawals SET status = 'paid', processed_at = CURRENT_TIMESTAMP, message = 'Paid to the selected receiving number.' WHERE id = $1 AND status IN ('pending', 'processing')",
        [withdrawalId]
      );
      if (Number(updated.rowCount) !== 1) {
        throw new Error('This withdrawal request changed before it could be marked as paid.');
      }
      await client.query('COMMIT');
      transactionOpen = false;
      res.json({ success: true, status: 'paid' });
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
      console.error('Control Tower mark withdrawal paid error:', error);
      res.status(500).json({ success: false, message: 'Unable to mark this withdrawal as paid.' });
    } finally {
      client.release();
    }
  };
  // POST is used by the browser UI because it is reliably supported by the
  // deployed reverse proxy. Keep PATCH as a compatible API alias.
  router.post('/withdrawals/:withdrawalId/paid', markWithdrawalPaid);
  router.patch('/withdrawals/:withdrawalId/paid', markWithdrawalPaid);

  const deleteWithdrawal = async (req, res) => {
    const withdrawalId = Number(req.params.withdrawalId);
    if (!Number.isInteger(withdrawalId) || withdrawalId < 1) {
      return res.status(400).json({ success: false, message: 'Invalid withdrawal request.' });
    }

    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const reference = await client.query(
        'SELECT id, user_id FROM withdrawals WHERE id = $1',
        [withdrawalId]
      );
      if (!reference.rows.length) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(404).json({ success: false, message: 'Withdrawal request not found.' });
      }

      const userId = reference.rows[0].user_id;
      const user = await client.query('SELECT id FROM users WHERE id = $1' + rowLock, [userId]);
      if (!user.rows.length) throw new Error('Withdrawal contributor was not found.');

      const existing = await client.query(
        'SELECT id, user_id, amount, status FROM withdrawals WHERE id = $1' + rowLock,
        [withdrawalId]
      );
      if (!existing.rows.length) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(404).json({ success: false, message: 'Withdrawal request not found.' });
      }
      if (String(existing.rows[0].status).toLowerCase() !== 'pending') {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(409).json({
          success: false,
          message: 'Only pending withdrawal requests can be deleted.'
        });
      }

      const deleted = await client.query(
        "DELETE FROM withdrawals WHERE id = $1 AND status = 'pending'",
        [withdrawalId]
      );
      if (Number(deleted.rowCount) !== 1) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(409).json({
          success: false,
          message: 'This withdrawal request is no longer pending.'
        });
      }

      await client.query('COMMIT');
      transactionOpen = false;
      res.json({ success: true, withdrawalId, deleted: true });
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
      console.error('Control Tower delete withdrawal error:', error);
      res.status(500).json({
        success: false,
        message: 'Unable to delete this pending withdrawal request.'
      });
    } finally {
      client.release();
    }
  };
  router.delete('/withdrawals/:withdrawalId', deleteWithdrawal);
  // The hosted reverse proxy reliably forwards POST requests, so the tower
  // UI uses this alias while DELETE remains available for API clients.
  router.post('/withdrawals/:withdrawalId/delete', deleteWithdrawal);

  const refundWithdrawal = async (req, res) => {
    const withdrawalId = Number(req.params.withdrawalId);
    if (!Number.isInteger(withdrawalId) || withdrawalId < 1) {
      return res.status(400).json({ success: false, message: 'Invalid withdrawal request.' });
    }

    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const reference = await client.query(
        'SELECT id, user_id FROM withdrawals WHERE id = $1',
        [withdrawalId]
      );
      if (!reference.rows.length) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(404).json({ success: false, message: 'Withdrawal request not found.' });
      }

      const userId = reference.rows[0].user_id;
      const user = await client.query('SELECT id FROM users WHERE id = $1' + rowLock, [userId]);
      if (!user.rows.length) throw new Error('Withdrawal contributor was not found.');

      const existing = await client.query(
        'SELECT id, user_id, amount, status FROM withdrawals WHERE id = $1' + rowLock,
        [withdrawalId]
      );
      if (!existing.rows.length) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(404).json({ success: false, message: 'Withdrawal request not found.' });
      }
      if (String(existing.rows[0].status).toLowerCase() !== 'pending') {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(409).json({
          success: false,
          message: 'Only pending withdrawal requests can be refunded.'
        });
      }

      const credited = await client.query(
        'UPDATE users SET totalEarned = COALESCE(totalEarned, 0) + $1 WHERE id = $2',
        [existing.rows[0].amount, userId]
      );
      if (Number(credited.rowCount) !== 1) {
        throw new Error('Unable to return the pending withdrawal amount.');
      }

      const marked = await client.query(
        "UPDATE withdrawals SET status = 'refunded', processed_at = CURRENT_TIMESTAMP, message = 'Withdrawal request refunded to the contributor wallet.' WHERE id = $1 AND status = 'pending'",
        [withdrawalId]
      );
      if (Number(marked.rowCount) !== 1) {
        throw new Error('The withdrawal request changed before it could be refunded.');
      }
      const balanceResult = await client.query(
        'SELECT totalEarned FROM users WHERE id = $1',
        [userId]
      );

      await client.query('COMMIT');
      transactionOpen = false;
      res.json({
        success: true,
        withdrawalId,
        status: 'refunded',
        refundedAmount: Number(existing.rows[0].amount),
        balance: Number(balanceResult.rows[0]?.totalearned || 0)
      });
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
      console.error('Control Tower refund withdrawal error:', error);
      res.status(500).json({
        success: false,
        message: 'Unable to refund this pending withdrawal request.'
      });
    } finally {
      client.release();
    }
  };
  router.post('/withdrawals/:withdrawalId/refund', refundWithdrawal);

  router.get('/registrations', async (req, res) => {
    try {
      const [users, purchases, withdrawals] = await Promise.all([
        pool.query('SELECT id, phone, first_name, last_name, email, createdAt AS created_at FROM users ORDER BY createdAt DESC'),
        pool.query("SELECT user_id, task_ai_number, amount FROM mpesa_transactions WHERE status = 'completed'"),
        pool.query("SELECT user_id, amount FROM withdrawals WHERE LOWER(COALESCE(status, 'pending')) <> 'refunded'")
      ]);
      const summary = new Map(
        users.rows.map((user) => [
          String(user.id),
          { ...user, paidRows: [], withdrawalRows: [], levels: [] }
        ])
      );
      for (const purchase of purchases.rows) {
        const user = summary.get(String(purchase.user_id));
        if (!user) continue;
        user.paidRows.push(purchase);
        user.levels.push(String(purchase.task_ai_number));
      }
      for (const withdrawal of withdrawals.rows) {
        const user = summary.get(String(withdrawal.user_id));
        if (user) user.withdrawalRows.push(withdrawal);
      }
      const registrations = [...summary.values()].map((user) => {
        const netState = deriveAccountNetState({
          paidFeeRows: user.paidRows,
          withdrawalRows: user.withdrawalRows
        });
        const { paidRows, withdrawalRows, ...account } = user;
        return {
          ...account,
          levels: [...new Set(user.levels)].sort(),
          paid: netState.paidFees,
          withdrawn: netState.withdrawn,
          net: netState.net,
          withdrawalExceedsFees: netState.withdrawnCents > netState.paidFeesCents
        };
      });
      const totalNetState = deriveAccountNetState({
        paidFeeRows: purchases.rows,
        withdrawalRows: withdrawals.rows
      });
      const totals = {
        paid: totalNetState.paidFees,
        withdrawn: totalNetState.withdrawn,
        net: totalNetState.net
      };
      res.json({
        success: true,
        registrations,
        totals,
        refreshedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error('Control Tower registrations error:', error);
      res.status(500).json({ success: false, message: 'Unable to load registrations.' });
    }
  });

  router.get('/referrals', async (req, res) => {
    try {
      const result = await pool.query("SELECT inviter.id AS referrer_id, r.referred_id, r.task_ai_purchased, r.reward_amount, r.reward_paid, r.created_at, inviter.phone AS inviter_phone, inviter.first_name AS inviter_first_name, inviter.last_name AS inviter_last_name, friend.phone AS friend_phone, friend.first_name AS friend_first_name, friend.last_name AS friend_last_name FROM users inviter LEFT JOIN referrals r ON r.referrer_id = inviter.id LEFT JOIN users friend ON friend.id = r.referred_id ORDER BY r.created_at DESC, inviter.createdAt DESC");
      const groups = new Map();
      for (const referral of result.rows) {
        const key = String(referral.referrer_id);
        if (!groups.has(key)) {
          groups.set(key, {
            referrerId: referral.referrer_id,
            phone: referral.inviter_phone,
            firstName: referral.inviter_first_name,
            lastName: referral.inviter_last_name,
            referrals: []
          });
        }
        if (referral.referred_id) {
          groups.get(key).referrals.push({
            friendPhone: referral.friend_phone,
            friendFirstName: referral.friend_first_name,
            friendLastName: referral.friend_last_name,
            taskAiLevel: referral.task_ai_purchased || 'Not purchased',
            rewardAmount: Number(referral.reward_amount || 0),
            rewardPaid: Boolean(referral.reward_paid),
            createdAt: referral.created_at
          });
        }
      }
      const referrers = [...groups.values()].map((group) => ({
        ...group,
        referralCount: group.referrals.length,
        needsAttention: group.referrals.length <= 2
      }));
      res.json({
        success: true,
        referrers,
        totals: {
          referrers: referrers.length,
          referrals: result.rows.filter((row) => row.referred_id).length,
          flagged: referrers.filter((group) => group.needsAttention).length
        },
        refreshedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error('Control Tower referrals error:', error);
      res.status(500).json({ success: false, message: 'Unable to load referral programme.' });
    }
  });

  return router;
};
