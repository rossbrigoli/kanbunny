#!/usr/bin/env node
// KB-PG-3: one-shot/re-runnable SQLite -> PostgreSQL data migration.
//
// Usage:
//   DATABASE_URL=postgres://kanbunny:...@host:5432/kanbunny \
//     node ops/migrate-sqlite-to-postgres.js --sqlite /path/to/kanbunny.db
//
// The source DB is checkpointed and copied aside first. All data reads happen
// from that copied SQLite file opened read-only; Postgres writes happen inside
// one transaction and preserve ids, token hashes, timestamps, card numbers,
// priorities, columns and positions.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

const TABLES = ['users', 'boards', 'cards', 'board_members', 'api_tokens'];
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const MIGRATION_ADVISORY_LOCK_KEY = 7748321;

function usage() {
  console.error('Usage: DATABASE_URL=postgres://... node ops/migrate-sqlite-to-postgres.js --sqlite /path/to/kanbunny.db [--backup /path/copy.db]');
  process.exit(2);
}

function parseArgs(argv) {
  const args = { sqlite: null, backup: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sqlite') args.sqlite = argv[++i];
    else if (arg === '--backup') args.backup = argv[++i];
    else usage();
  }
  if (!args.sqlite) usage();
  return args;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sqliteUtcToTimestamptz(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value).trim();
  if (!s) return null;
  // SQLite datetime('now') stored UTC as "YYYY-MM-DD HH:MM:SS".
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return s.replace(' ', 'T') + 'Z';
  }
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    return s;
  }
  throw new Error(`unsupported timestamp format: ${s}`);
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

function checkpointAndCopy(sqlitePath, backupPath) {
  const resolved = path.resolve(sqlitePath);
  const backup = path.resolve(
    backupPath || `${resolved}.pg-migration-${nowStamp()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}.copy`
  );

  if (!fs.existsSync(resolved)) {
    throw new Error(`SQLite DB not found: ${resolved}`);
  }
  if (fs.existsSync(backup)) {
    throw new Error(`backup path already exists: ${backup}`);
  }

  // TRUNCATE checkpoint needs a writable SQLite handle. Data migration reads
  // from the copied file below with readonly=true.
  const checkpointDb = new Database(resolved);
  try {
    checkpointDb.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    checkpointDb.close();
  }

  fs.copyFileSync(resolved, backup, fs.constants.COPYFILE_EXCL);
  return backup;
}

function readSqliteRows(sqliteCopyPath) {
  const sqlite = new Database(sqliteCopyPath, { readonly: true, fileMustExist: true });
  try {
    return {
      users: sqlite.prepare('SELECT id, login, role, created_at, updated_at FROM users ORDER BY id').all(),
      boards: sqlite.prepare('SELECT id, name, created_at, updated_at FROM boards ORDER BY id').all(),
      cards: sqlite.prepare('SELECT id, board_id, title, description, assignee, "column", position, created_at, updated_at, priority, card_number FROM cards ORDER BY id').all(),
      board_members: sqlite.prepare('SELECT board_id, user_id, granted_by, created_at FROM board_members ORDER BY board_id, user_id').all(),
      api_tokens: sqlite.prepare('SELECT id, name, token_hash, owner_id, last_used_at, created_at FROM api_tokens ORDER BY id').all(),
    };
  } finally {
    sqlite.close();
  }
}

async function upsertRows(client, rows) {
  for (const user of rows.users) {
    await client.query(
      `INSERT INTO users (id, login, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         login = EXCLUDED.login,
         role = EXCLUDED.role,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at`,
      [
        user.id,
        user.login,
        user.role,
        sqliteUtcToTimestamptz(user.created_at),
        sqliteUtcToTimestamptz(user.updated_at),
      ]
    );
  }

  for (const board of rows.boards) {
    await client.query(
      `INSERT INTO boards (id, name, created_at, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at`,
      [
        board.id,
        board.name,
        sqliteUtcToTimestamptz(board.created_at),
        sqliteUtcToTimestamptz(board.updated_at),
      ]
    );
  }

  for (const card of rows.cards) {
    await client.query(
      `INSERT INTO cards (
         id, board_id, title, description, assignee, "column", position,
         created_at, updated_at, priority, card_number
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET
         board_id = EXCLUDED.board_id,
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         assignee = EXCLUDED.assignee,
         "column" = EXCLUDED."column",
         position = EXCLUDED.position,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at,
         priority = EXCLUDED.priority,
         card_number = EXCLUDED.card_number`,
      [
        card.id,
        card.board_id,
        card.title,
        card.description || '',
        card.assignee || '',
        card.column,
        card.position,
        sqliteUtcToTimestamptz(card.created_at),
        sqliteUtcToTimestamptz(card.updated_at),
        card.priority,
        card.card_number,
      ]
    );
  }

  for (const member of rows.board_members) {
    await client.query(
      `INSERT INTO board_members (board_id, user_id, granted_by, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (board_id, user_id) DO UPDATE SET
         granted_by = EXCLUDED.granted_by,
         created_at = EXCLUDED.created_at`,
      [
        member.board_id,
        member.user_id,
        member.granted_by,
        sqliteUtcToTimestamptz(member.created_at),
      ]
    );
  }

  for (const token of rows.api_tokens) {
    await client.query(
      `INSERT INTO api_tokens (id, name, token_hash, owner_id, last_used_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         token_hash = EXCLUDED.token_hash,
         owner_id = EXCLUDED.owner_id,
         last_used_at = EXCLUDED.last_used_at,
         created_at = EXCLUDED.created_at`,
      [
        token.id,
        token.name,
        token.token_hash,
        token.owner_id,
        sqliteUtcToTimestamptz(token.last_used_at),
        sqliteUtcToTimestamptz(token.created_at),
      ]
    );
  }
}

async function runMigrations(client) {
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const applied = new Set(
      (await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version)
    );
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${version} failed: ${err.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
  }
}

async function pgCounts(client) {
  const out = {};
  for (const table of TABLES) {
    const { rows } = await client.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
    out[table] = rows[0].count;
  }
  return out;
}

async function pgChecksums(client) {
  const api = await client.query('SELECT id, token_hash FROM api_tokens ORDER BY id');
  const cards = await client.query(
    'SELECT id, card_number, "column", position FROM cards ORDER BY id'
  );
  return {
    api_tokens: api.rows.map((r) => ({ id: r.id, checksum: sha256(r.token_hash) })),
    cards: cards.rows.map((r) => ({
      id: r.id,
      checksum: sha256(`${r.id}|${r.card_number ?? ''}|${r.column}|${r.position}`),
    })),
  };
}

function sqliteChecksums(rows) {
  return {
    api_tokens: rows.api_tokens.map((r) => ({
      id: r.id,
      checksum: sha256(r.token_hash),
    })),
    cards: rows.cards.map((r) => ({
      id: r.id,
      checksum: sha256(`${r.id}|${r.card_number ?? ''}|${r.column}|${r.position}`),
    })),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const sqliteCopy = checkpointAndCopy(args.sqlite, args.backup);
  const sqliteRows = readSqliteRows(sqliteCopy);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    await runMigrations(client);
    await client.query('BEGIN');
    await upsertRows(client, sqliteRows);
    const counts = await pgCounts(client);
    const checksums = {
      sqlite: sqliteChecksums(sqliteRows),
      postgres: await pgChecksums(client),
    };
    await client.query('COMMIT');

    process.stdout.write(JSON.stringify({
      ok: true,
      sqlite_copy: sqliteCopy,
      counts: {
        sqlite: Object.fromEntries(TABLES.map((t) => [t, sqliteRows[t].length])),
        postgres: counts,
      },
      checksums,
    }, null, 2) + '\n');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
