/*
 * One-way, resumable PostgreSQL -> MySQL/MariaDB data copy.
 *
 * First start Toloka once with DB_CLIENT=mysql so the application creates its
 * schema. Then run this script with SOURCE_DATABASE_URL and MYSQL_* set.
 * It preserves primary keys and upserts by the target's unique/primary keys,
 * making it safe to re-run after a temporary network failure.
 */
const { Pool } = require('pg');
const mysql = require('mysql2/promise');

const TABLES = [
  'users', 'recipient_names', 'deposit_numbers', 'mpesa_codes', 'videos', 'ai_training_metrics',
  'mpesa_transactions', 'inbound_sms_messages', 'withdrawals', 'loan_applications',
  'savings', 'savings_deposits', 'savings_withdrawals', 'referrals', 'timer_status',
  'video_responses', 'video_metadata', 'task_choice_responses'
];
const CHUNK_SIZE = Math.max(1, Math.min(Number(process.env.MIGRATION_CHUNK_SIZE || 250), 1000));
const dryRun = process.argv.includes('--dry-run');

function mysqlOptions() {
  if (!process.env.MYSQL_USER) throw new Error('MYSQL_USER is required.');
  return {
    host: process.env.MYSQL_HOST || 'localhost',
    port: Number(process.env.MYSQL_PORT || 3306),
    database: process.env.MYSQL_DATABASE || 'toloka',
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    waitForConnections: true,
    connectionLimit: 2,
    decimalNumbers: true
  };
}

function quote(name) {
  return `\`${String(name).replace(/`/g, '``')}\``;
}

function normaliseValue(value) {
  if (value === undefined) return null;
  if (Buffer.isBuffer(value) || value instanceof Date || value === null) return value;
  return typeof value === 'object' ? JSON.stringify(value) : value;
}

async function copyTable(source, target, table) {
  const exists = await source.query('SELECT to_regclass($1) AS name', [`public.${table}`]);
  if (!exists.rows[0]?.name) {
    console.log(`Skipping ${table}: not present in source.`);
    return;
  }
  const count = await source.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
  const total = Number(count.rows[0].count || 0);
  console.log(`${dryRun ? 'Would copy' : 'Copying'} ${total} row(s) from ${table}.`);
  if (dryRun || total === 0) return;

  let offset = 0;
  while (offset < total) {
    const page = await source.query(`SELECT * FROM ${table} ORDER BY 1 ASC LIMIT $1 OFFSET $2`, [CHUNK_SIZE, offset]);
    if (!page.rows.length) break;
    const columns = Object.keys(page.rows[0]);
    const values = page.rows.flatMap(row => columns.map(column => normaliseValue(row[column])));
    const rowPlaceholders = `(${columns.map(() => '?').join(', ')})`;
    const updates = columns
      .filter(column => column !== 'id')
      .map(column => `${quote(column)} = VALUES(${quote(column)})`)
      .join(', ');
    const sql = `INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES ${page.rows.map(() => rowPlaceholders).join(', ')} ON DUPLICATE KEY UPDATE ${updates || 'id = id'}`;
    await target.execute(sql, values);
    offset += page.rows.length;
    console.log(`  ${table}: ${Math.min(offset, total)}/${total}`);
  }
}

async function main() {
  if (!process.env.SOURCE_DATABASE_URL) {
    throw new Error('SOURCE_DATABASE_URL must contain the existing PostgreSQL connection string.');
  }
  if (!process.env.MYSQL_USER) throw new Error('MYSQL_USER is required.');
  if (!process.env.MYSQL_PASSWORD) throw new Error('MYSQL_PASSWORD is required.');
  if ((process.env.MYSQL_HOST || '').includes('HOSTNALI_')) {
    throw new Error('MYSQL_HOST is still a placeholder. Use the real Hostnali MySQL hostname.');
  }
  const source = new Pool({ connectionString: process.env.SOURCE_DATABASE_URL, ssl: process.env.SOURCE_PGSSL === 'true' ? { rejectUnauthorized: false } : undefined });
  const target = mysql.createPool(mysqlOptions());
  try {
    await source.query('SELECT 1');
    await target.query('SELECT 1');
    for (const table of TABLES) await copyTable(source, target, table);
    console.log(dryRun ? 'Dry run complete. No MySQL data was changed.' : 'PostgreSQL-to-MySQL copy complete.');
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch(error => {
  console.error('Migration failed:', error.message || error);
  if (error.code) console.error(`Code: ${error.code}`);
  if (error.address) console.error(`Address: ${error.address}:${error.port || ''}`);
  if (process.env.MIGRATION_DEBUG === 'true' && error.stack) console.error(error.stack);
  process.exitCode = 1;
});
