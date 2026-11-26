/* Verify the configured MySQL/MariaDB connection and the Toloka schema. */
const pool = require('../db');

const REQUIRED_TABLES = [
  'users', 'mpesa_transactions', 'inbound_sms_messages', 'withdrawals',
  'loan_applications', 'savings', 'savings_deposits', 'savings_withdrawals',
  'referrals', 'videos', 'video_responses', 'ai_training_metrics',
  'task_choice_responses'
];

async function main() {
  if (pool.databaseClient !== 'mysql') throw new Error('Set DB_CLIENT=mysql before running this verification.');
  const identity = await pool.query('SELECT DATABASE() AS database_name, VERSION() AS version');
  const tableRows = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name IN (${REQUIRED_TABLES.map((_, index) => `$${index + 1}`).join(', ')})`,
    REQUIRED_TABLES
  );
  const found = new Set(tableRows.rows.map(row => row.table_name || row.table_name?.toLowerCase()));
  const missing = REQUIRED_TABLES.filter(table => !found.has(table));
  console.log(`Connected to ${identity.rows[0].database_name} (${identity.rows[0].version}).`);
  if (missing.length) throw new Error(`Missing required tables: ${missing.join(', ')}. Start the application once to initialize the schema.`);
  const referralIndexes = await pool.query(
    `SELECT index_name FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'referrals' AND index_name = 'uq_referrals_referred_id'`
  );
  if (!referralIndexes.rows.length) throw new Error('Referral uniqueness index is missing. Do not go live until the application bootstrap completes.');
  console.log(`MySQL verification passed: ${REQUIRED_TABLES.length} required tables and the referral reward guard are ready.`);
}

main().catch(error => {
  console.error('MySQL verification failed:', error.message);
  process.exitCode = 1;
}).finally(() => pool.end?.());
