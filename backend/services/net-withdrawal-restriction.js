const KES_PER_USD_CENTS = 13000n;
const THRESHOLD_STEP_USD_CENTS = 500n;
const THRESHOLD_STEP_KES_CENTS = KES_PER_USD_CENTS * THRESHOLD_STEP_USD_CENTS / 100n;

function amountToCents(value) {
  const raw = String(value ?? '0').trim();
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) return 0n;

  const [, sign, whole, fractional = ''] = match;
  const cents = BigInt(whole) * 100n + BigInt(`${fractional}00`.slice(0, 2));
  return sign === '-' ? -cents : cents;
}

function sumAmountsToCents(rows) {
  return rows.reduce((total, row) => total + amountToCents(row.amount), 0n);
}

function activeWithdrawalRows(rows) {
  return rows.filter((row) => String(row.status || '').toLowerCase() !== 'refunded');
}

function centsToAmount(cents) {
  return Number(cents) / 100;
}

function restrictionMessage(requiredSuccessfulReferrals) {
  const referralLabel = requiredSuccessfulReferrals === 1 ? 'referral' : 'referrals';
  return `Withdrawals and AI-task access are temporarily restricted. You need ${requiredSuccessfulReferrals} successful ${referralLabel} to continue. A successful referral means someone you refer purchases an AI task. Once the referral requirement is verified, your access can be restored.`;
}

function deriveRestriction(netKesCents, successfulReferralCount) {
  const successfulReferrals = Math.max(0, Number(successfulReferralCount) || 0);
  if (netKesCents > 0n) {
    return {
      restricted: false,
      requiredSuccessfulReferrals: 0,
      successfulReferralCount: successfulReferrals,
      message: null
    };
  }

  const negativeNet = netKesCents < 0n ? -netKesCents : 0n;
  // One successful referral clears the first post-withdrawal / NET-zero
  // barrier. Each additional $5 of negative NET adds one more referral, so
  // later barriers cannot be skipped with the referral that cleared the first.
  const requiredSuccessfulReferrals = Number(
    negativeNet / THRESHOLD_STEP_KES_CENTS + 1n
  );

  const restricted = successfulReferrals < requiredSuccessfulReferrals;
  return {
    restricted,
    requiredSuccessfulReferrals,
    successfulReferralCount: successfulReferrals,
    message: restricted ? restrictionMessage(requiredSuccessfulReferrals) : null
  };
}

function deriveAccountNetState({ paidFeeRows = [], withdrawalRows = [], successfulReferralCount = 0 }) {
  const paidFeesCents = sumAmountsToCents(paidFeeRows);
  // Pending and processing requests count because they already reduced the
  // wallet. A refunded request is excluded because its amount was restored.
  const withdrawnCents = sumAmountsToCents(activeWithdrawalRows(withdrawalRows));
  const netKesCents = paidFeesCents - withdrawnCents;
  const restriction = paidFeesCents > 0n
    ? deriveRestriction(netKesCents, successfulReferralCount)
    : {
      restricted: false,
      requiredSuccessfulReferrals: 0,
      successfulReferralCount: Math.max(0, Number(successfulReferralCount) || 0),
      message: null
    };
  return {
    paidFeesCents,
    withdrawnCents,
    netKesCents,
    paidFees: centsToAmount(paidFeesCents),
    withdrawn: centsToAmount(withdrawnCents),
    net: centsToAmount(netKesCents),
    ...restriction
  };
}

// The first earnings withdrawal request is fixed at 30% in the withdrawal
// endpoint. As soon as that request is recorded, the user must have one
// qualifying referral before either withdrawals or AI work can continue.
// Pending/processing requests count because access must stop immediately; the
// NET threshold is combined with, not replaced by, this post-first-request gate.
function deriveAccountAccessState({
  paidFeeRows = [],
  withdrawalRows = [],
  successfulReferralCount = 0,
  withdrawalCount = null
}) {
  const netState = deriveAccountNetState({ paidFeeRows, withdrawalRows, successfulReferralCount });
  const suppliedWithdrawalCount = withdrawalCount === null || withdrawalCount === undefined
    ? activeWithdrawalRows(withdrawalRows).length
    : Number(withdrawalCount);
  const recordedWithdrawalCount = Math.max(0, Number(suppliedWithdrawalCount) || 0);
  const postFirstWithdrawalReferralRequired = recordedWithdrawalCount > 0 ? 1 : 0;
  const requiredSuccessfulReferrals = Math.max(
    postFirstWithdrawalReferralRequired,
    netState.requiredSuccessfulReferrals
  );
  const restricted = netState.successfulReferralCount < requiredSuccessfulReferrals;

  return {
    ...netState,
    withdrawalCount: recordedWithdrawalCount,
    postFirstWithdrawalReferralRequired: Boolean(postFirstWithdrawalReferralRequired),
    requiredSuccessfulReferrals,
    restricted,
    message: restricted ? restrictionMessage(requiredSuccessfulReferrals) : null
  };
}

async function getAccountNetState(userId, query) {
  const [paidFeesResult, withdrawalsResult, referralsResult] = await Promise.all([
    query('SELECT amount FROM mpesa_transactions WHERE user_id = $1 AND status = \'completed\'', [userId]),
    // Pending/processing rows already reduced the wallet; refunded rows did not
    // remain as withdrawals and therefore do not count toward NET.
    query("SELECT amount, status FROM withdrawals WHERE user_id = $1 AND LOWER(COALESCE(status, 'pending')) <> 'refunded'", [userId]),
    query(
      `SELECT COUNT(DISTINCT r.referred_id) AS count
       FROM referrals r
       INNER JOIN mpesa_transactions m ON m.user_id = r.referred_id
       WHERE r.referrer_id = $1
         AND m.status = 'completed'
         AND m.task_ai_number IS NOT NULL`,
      [userId]
    )
  ]);

  return deriveAccountNetState({
    paidFeeRows: paidFeesResult.rows,
    withdrawalRows: withdrawalsResult.rows,
    successfulReferralCount: referralsResult.rows[0]?.count
  });
}

async function getAccountAccessState(userId, query, { additionalWithdrawalAmount = 0 } = {}) {
  const [paidFeesResult, withdrawalsResult, referralsResult, withdrawalCountResult] = await Promise.all([
    query('SELECT amount FROM mpesa_transactions WHERE user_id = $1 AND status = \'completed\'', [userId]),
    // Keep NET and the post-first-request gate based on the same active rows.
    query("SELECT amount, status FROM withdrawals WHERE user_id = $1 AND LOWER(COALESCE(status, 'pending')) <> 'refunded'", [userId]),
    query(
      `SELECT COUNT(DISTINCT r.referred_id) AS count
       FROM referrals r
       INNER JOIN mpesa_transactions m ON m.user_id = r.referred_id
       WHERE r.referrer_id = $1
         AND m.status = 'completed'
         AND m.task_ai_number IS NOT NULL`,
      [userId]
    ),
    query("SELECT COUNT(*) AS count FROM withdrawals WHERE user_id = $1 AND LOWER(COALESCE(status, 'pending')) <> 'refunded'", [userId])
  ]);

  const projectedAmount = Number(additionalWithdrawalAmount);
  const projectedWithdrawalRows = Number.isFinite(projectedAmount) && projectedAmount > 0
    ? [...withdrawalsResult.rows, { amount: projectedAmount, status: 'pending' }]
    : withdrawalsResult.rows;
  const currentWithdrawalCount = Number(withdrawalCountResult.rows[0]?.count) || 0;
  const projectedWithdrawalCount = currentWithdrawalCount + (projectedWithdrawalRows.length > withdrawalsResult.rows.length ? 1 : 0);

  return deriveAccountAccessState({
    paidFeeRows: paidFeesResult.rows,
    withdrawalRows: projectedWithdrawalRows,
    successfulReferralCount: referralsResult.rows[0]?.count,
    withdrawalCount: projectedWithdrawalCount
  });
}

function toPublicRestriction(state) {
  return {
    restricted: state.restricted,
    requiredSuccessfulReferrals: state.requiredSuccessfulReferrals,
    successfulReferralCount: state.successfulReferralCount,
    message: state.message
  };
}

module.exports = {
  amountToCents,
  deriveAccountNetState,
  deriveAccountAccessState,
  getAccountNetState,
  getAccountAccessState,
  toPublicRestriction
};
