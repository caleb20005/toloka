/** Referral records are the source of truth for a reward entitlement. */
module.exports = function createReferralModel(pool) {
  const rewards = { '1': 100, '2': 250, '3': 700, '4': 1500, '5': 2000, '6': 3000 };
  return {
    createForRegistration: (db, { referrerId, referredId, referralCode }) => db.query(
      `INSERT INTO referrals (referrer_id, referred_id, referral_code)
       VALUES ($1, $2, $3) ON CONFLICT (referred_id) DO NOTHING`,
      [referrerId, referredId, referralCode]
    ),
    // Lock the entitlement, mark it paid, and credit the inviter in one
    // transaction. This is deliberately portable across PostgreSQL and
    // MySQL/MariaDB; both engines support SELECT ... FOR UPDATE.
    awardFirstVerifiedPurchase: async (userId, taskAiNumber, aiTask, db = null) => {
      const rewardAmount = rewards[String(taskAiNumber)] || 0;
      if (!rewardAmount) return null;
      const ownsTransaction = !db;
      const client = db || await pool.connect();
      try {
        if (ownsTransaction) await client.query('BEGIN');
        const entitlement = await client.query(
          `SELECT id, referrer_id FROM referrals
           WHERE referred_id = $1 AND reward_paid = false
           FOR UPDATE`,
          [userId]
        );
        if (!entitlement.rows.length) {
          if (ownsTransaction) await client.query('COMMIT');
          return null;
        }

        const referral = entitlement.rows[0];
        const marked = await client.query(
          `UPDATE referrals
           SET reward_amount = $1, task_ai_purchased = $2, reward_paid = true
           WHERE id = $3 AND reward_paid = false`,
          [rewardAmount, aiTask, referral.id]
        );
        if (!marked.rowCount) {
          if (ownsTransaction) await client.query('COMMIT');
          return null;
        }
        await client.query(
          'UPDATE users SET totalEarned = totalEarned + $1 WHERE id = $2',
          [rewardAmount, referral.referrer_id]
        );
        if (ownsTransaction) await client.query('COMMIT');
        return { referrer_id: referral.referrer_id, reward_amount: rewardAmount };
      } catch (error) {
        if (ownsTransaction) await client.query('ROLLBACK');
        throw error;
      } finally {
        if (ownsTransaction) client.release();
      }
    }
  };
};
