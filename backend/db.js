const path = require('path');
const sqlite3 = require('sqlite3').verbose();

/*
 * Database boundary
 * -----------------
 * Application queries retain PostgreSQL-style $1 parameters so the existing
 * local database remains a safe rollback option. In production set
 * DB_CLIENT=mysql and this module converts the documented SQL differences
 * before handing statements to mysql2 prepared statements.
 */
const requestedClient = String(process.env.DB_CLIENT || '').trim().toLowerCase();
const databaseUrl = process.env.DATABASE_URL || '';
const useSqlite = process.env.USE_SQLITE === 'true';
const databaseClient = useSqlite
  ? 'sqlite'
  : (requestedClient || (databaseUrl.startsWith('postgres') ? 'postgres' : 'mysql'));

function postgresConfig() {
  const config = databaseUrl
    ? { connectionString: databaseUrl }
    : {
        host: process.env.PGHOST || 'localhost',
        port: Number(process.env.PGPORT || 5432),
        database: process.env.PGDATABASE || 'link_ai',
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || undefined
      };
  config.max = Number(process.env.PGPOOL_MAX || 20);
  config.min = Number(process.env.PGPOOL_MIN || 2);
  config.idleTimeoutMillis = Number(process.env.PG_IDLE_TIMEOUT_MS || 30000);
  config.connectionTimeoutMillis = Number(process.env.PG_CONNECT_TIMEOUT_MS || 5000);
  config.maxUses = Number(process.env.PG_MAX_USES || 7500);
  if (process.env.PGSSL === 'true') config.ssl = { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' };
  return config;
}

function mysqlConfig() {
  let config;
  if (databaseUrl.startsWith('mysql')) {
    const url = new URL(databaseUrl);
    config = {
      host: url.hostname,
      port: Number(url.port || 3306),
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password)
    };
  } else {
    config = {
      host: process.env.MYSQL_HOST || 'localhost',
      port: Number(process.env.MYSQL_PORT || 3306),
      database: process.env.MYSQL_DATABASE || 'toloka',
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD
    };
  }
  config.waitForConnections = true;
  config.connectionLimit = Number(process.env.MYSQL_POOL_MAX || 20);
  config.queueLimit = Number(process.env.MYSQL_QUEUE_LIMIT || 0);
  config.enableKeepAlive = true;
  config.keepAliveInitialDelay = Number(process.env.MYSQL_KEEPALIVE_DELAY_MS || 10000);
  config.decimalNumbers = true;
  if (process.env.MYSQL_SSL === 'true') config.ssl = { rejectUnauthorized: process.env.MYSQL_SSL_REJECT_UNAUTHORIZED !== 'false' };
  return config;
}

function bindMysqlPlaceholders(sql, params) {
  const values = [];
  const statement = sql.replace(/\$(\d+)/g, (_, number) => {
    values.push(params[Number(number) - 1]);
    return '?';
  });
  return { statement, values };
}

function mysqlSql(sql) {
  let statement = String(sql)
    .replace(/\bSERIAL\s+PRIMARY\s+KEY\b/gi, 'INT AUTO_INCREMENT PRIMARY KEY')
    .replace(/\bBIGSERIAL\s+PRIMARY\s+KEY\b/gi, 'BIGINT AUTO_INCREMENT PRIMARY KEY')
    .replace(/COUNT\(\*\)::int/gi, 'COUNT(*)')
    .replace(/\bFOR\s+KEY\s+SHARE\b/gi, 'FOR UPDATE')
    .replace(/\bORDER\s+BY\s+RANDOM\(\)/gi, 'ORDER BY RAND()')
    .replace(/NOW\(\)\s*-\s*interval\s+'(\d+)\s+hour'/gi, 'DATE_SUB(NOW(), INTERVAL $1 HOUR)')
    .replace(/created_at\s*\+\s*INTERVAL\s+'(\d+)\s+minutes'/gi, 'DATE_ADD(created_at, INTERVAL $1 MINUTE)')
    .replace(/\bSELECT\s+NOW\(\)\s*;?$/i, 'SELECT NOW() AS now')
    .replace(/\bCREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+/gi, 'CREATE $1INDEX ')
    .replace(/\s+WHERE\s+referralCode\s+IS\s+NOT\s+NULL\s*;?$/i, '')
    .replace(/\bTEXT\s+NOT\s+NULL\s+DEFAULT\s+'([^']*)'/gi, "VARCHAR(2048) NOT NULL DEFAULT '$1'")
    .replace(/\bTEXT\s+DEFAULT\s+'([^']*)'/gi, "VARCHAR(2048) DEFAULT '$1'")
    .replace(/\bTEXT\b/gi, 'MEDIUMTEXT')
    .replace(/\bON\s+CONFLICT\s*\(([^)]*)\)\s+DO\s+NOTHING/gi, (_, conflictColumns) => {
      const firstConflictColumn = String(conflictColumns).split(',')[0].trim();
      return `ON DUPLICATE KEY UPDATE ${firstConflictColumn} = ${firstConflictColumn}`;
    })
    .replace(/\bON\s+CONFLICT\s+DO\s+NOTHING/gi, 'ON DUPLICATE KEY UPDATE id = id');

  // PostgreSQL's upsert syntax is used only by video registration. VALUES()
  // works on the MySQL/MariaDB versions offered by common cPanel hosts.
  statement = statement
    .replace(/\bON\s+CONFLICT\s*\([^)]*\)\s+DO\s+UPDATE\s+SET/gi, 'ON DUPLICATE KEY UPDATE')
    .replace(/\bexcluded\.([a-z_]+)/gi, 'VALUES($1)');
  return statement;
}

function removeReturning(statement) {
  const match = statement.match(/\s+RETURNING\s+(.+?)\s*;?\s*$/is);
  if (!match) return { statement, returning: null };
  return { statement: statement.slice(0, match.index), returning: match[1].trim() };
}

function normalizeMysqlResult(result, returning) {
  if (Array.isArray(result)) {
    // PostgreSQL folds unquoted identifiers to lowercase, while MySQL returns
    // the spelling used in the CREATE TABLE statement. Existing handlers read
    // legacy fields such as `aitimers`; expose lowercase aliases without
    // changing the original result keys.
    const rows = result.map(row => {
      const normalised = { ...row };
      for (const [key, value] of Object.entries(row)) {
        const lowercase = key.toLowerCase();
        if (!(lowercase in normalised)) normalised[lowercase] = value;
      }
      return normalised;
    });
    return { rows, rowCount: rows.length };
  }
  const rowCount = Number(result?.affectedRows || 0);
  if (!returning || rowCount === 0) return { rows: [], rowCount };
  // Existing writes consume an inserted id; this keeps INSERT ... RETURNING id
  // portable without unsafe follow-up SQL.
  if (/^id\b/i.test(returning) || returning === '*') return { rows: [{ id: result.insertId }], rowCount };
  return { rows: [], rowCount };
}

function createMysqlAdapter() {
  const mysql = require('mysql2/promise');
  const nativePool = mysql.createPool(mysqlConfig());
  const execute = async (connection, sql, params = []) => {
    const { statement: withoutReturning, returning } = removeReturning(mysqlSql(sql));
    const { statement, values } = bindMysqlPlaceholders(withoutReturning, params);
    try {
      const [result] = await connection.execute(statement, values);
      return normalizeMysqlResult(result, returning);
    } catch (error) {
      // MySQL has no portable CREATE INDEX IF NOT EXISTS. A duplicate index is
      // already the desired state during repeatable application bootstraps.
      if (/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement) && error.code === 'ER_DUP_KEYNAME') {
        return { rows: [], rowCount: 0 };
      }
      throw error;
    }
  };
  return {
    databaseClient: 'mysql',
    query: (sql, params = []) => execute(nativePool, sql, params),
    connect: async () => {
      const connection = await nativePool.getConnection();
      return {
        query: (sql, params = []) => execute(connection, sql, params),
        release: () => connection.release()
      };
    },
    end: () => nativePool.end()
  };
}

function convertPostgresToSqlite(sql, params = []) {
  const values = [];
  const convertedSql = String(sql)
    .replace(/NOW\(\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/SERIAL\s+PRIMARY\s+KEY/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT')
    .replace(/::\w+/g, '')
    // SQLite positional placeholders cannot reuse a value the way PostgreSQL
    // allows $1 to appear more than once, so expand each reference in order.
    .replace(/\$(\d+)/g, (_, number) => {
      values.push(params[Number(number) - 1]);
      return '?';
    });
  return { sql: convertedSql, params: values };
}

function createSqliteAdapter() {
  const db = new sqlite3.Database(path.join(__dirname, 'database.db'), (error) => {
    if (error) throw error;
  });
  db.run('PRAGMA foreign_keys = ON');
  db.configure('busyTimeout', 5000);

  const normalizeRows = (rows = []) => rows.map(row => {
    const normalized = { ...row };
    for (const [key, value] of Object.entries(row)) {
      const lowercase = key.toLowerCase();
      if (!(lowercase in normalized)) normalized[lowercase] = value;
    }
    return normalized;
  });

  const query = (sql, params = []) => {
    const converted = convertPostgresToSqlite(sql, params);
    const statement = String(converted.sql).trim().toLowerCase();

    // sqlite3#run does not expose result rows. Use #all for DML statements
    // with RETURNING as well as SELECTs so callers can consume inserted IDs.
    if (/^\s*select\b/i.test(statement) || /\breturning\b/i.test(statement)) {
      return new Promise((resolve, reject) => {
        db.all(converted.sql, converted.params, function onResult(error, rows) {
          if (error) return reject(error);
          const normalizedRows = normalizeRows(rows);
          resolve({ rows: normalizedRows, rowCount: normalizedRows.length });
        });
      });
    }

    return new Promise((resolve, reject) => {
      db.run(converted.sql, converted.params, function onWrite(error) {
        if (error) return reject(error);
        const changes = Number(this.changes || 0);
        resolve({ rows: [], rowCount: changes });
      });
    });
  };

  return { databaseClient: 'sqlite', query, connect: async () => ({ query, release: () => {} }) };
}

let adapter;
if (databaseClient === 'mysql') {
  if (!process.env.MYSQL_USER && !databaseUrl.startsWith('mysql')) throw new Error('MYSQL_USER is required when DB_CLIENT=mysql.');
  adapter = createMysqlAdapter();
  console.log(`Using MySQL/MariaDB database: ${process.env.MYSQL_DATABASE || '(from DATABASE_URL)'}.`);
} else if (databaseClient === 'postgres') {
  const { Pool } = require('pg');
  const nativePool = new Pool(postgresConfig());
  nativePool.on('error', (error) => console.error('PostgreSQL idle client error:', error));
  nativePool.databaseClient = 'postgres';
  adapter = nativePool;
} else if (databaseClient === 'sqlite') {
  console.warn('Using SQLite recovery mode because USE_SQLITE=true.');
  adapter = createSqliteAdapter();
} else {
  throw new Error(`Unsupported DB_CLIENT "${databaseClient}". Use mysql, postgres, or set USE_SQLITE=true.`);
}

module.exports = adapter;
