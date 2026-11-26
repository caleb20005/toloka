/* Creates the single hosted Control Tower administrator without storing a password in source code. */
const bcrypt = require('bcryptjs');
const pool = require('../db');

async function main() {
  const phone = String(process.env.CONTROL_TOWER_BOOTSTRAP_PHONE || '').trim();
  const password = String(process.env.CONTROL_TOWER_BOOTSTRAP_PASSWORD || '');
  if (!phone || !password) throw new Error('Set CONTROL_TOWER_BOOTSTRAP_PHONE and CONTROL_TOWER_BOOTSTRAP_PASSWORD before running this script.');
  if (password.length < 8) throw new Error('The Control Tower password must be at least 8 characters.');
  const existing = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
  if (existing.rows.length) {
    console.log('Control Tower administrator already exists. No password was changed.');
    return;
  }
  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO users (phone, password, first_name, last_name, email, onboarding_complete, terms_accepted_at, createdAt, lastLogin, lastActivity)
     VALUES ($1, $2, 'Control', 'Tower', $3, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [phone, hash, `control-tower-${phone.replace(/\D/g, '')}@local.invalid`]
  );
  console.log('Control Tower administrator created.');
}

main().catch(error => {
  console.error('Control Tower admin seed failed:', error.message);
  process.exitCode = 1;
}).finally(() => pool.end?.());
