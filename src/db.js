// Kanbunny data layer — PostgreSQL (node-postgres).
//
// Migrated from better-sqlite3 (KB-PG-2, 2026-09-17). The whole layer is now
// ASYNC; every caller must await. Route contracts, response shapes, status
// codes, error semantics and the card_number / priority / position ordering
// behaviour are intentionally identical to the SQLite version.
//
// Config: DATABASE_URL (postgres://user:***@host:5432/dbname)
//
// Byte-compatibility note: SQLite returned timestamps as TEXT
// 'YYYY-MM-DD HH:MM:SS' in UTC (datetime('now')). To keep API responses
// byte-identical, timestamptz values are parsed into that exact string form
// (UTC, second precision) via a pg type parser. Storage keeps full µs
// precision; only the wire format is normalized.

const pg = require('pg');
const { Pool } = pg;
const fs = require('fs');
const path = require('path');

// --- timestamp wire-format compatibility (SQLite 'YYYY-MM-DD HH:MM:SS' UTC) ---
function toSqliteTimestamp(value) {
  if (value === null || value === undefined) return value;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}
// 1184 = timestamptz, 1114 = timestamp (defensive: we only use timestamptz)
pg.types.setTypeParser(1184, toSqliteTimestamp);
pg.types.setTypeParser(1114, toSqliteTimestamp);

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const MIGRATION_ADVISORY_LOCK_KEY = 7748321; // arbitrary, stable across replicas
const BOARD_WRITE_ADVISORY_LOCK_NS = 7748322;

// ---------------------------------------------------------------------------
// Connection resilience (KB-PG-4 — HA Postgres cutover, 2026-09-18)
//
// Three rules drive every number below:
//   1. A request is never left hanging through a Patroni failover. Every wait
//      is bounded, and the bound is seconds, not minutes.
//   2. A statement that may have reached the server is NEVER retried. Retries
//      happen only while *acquiring* a connection, where no write can have
//      landed. Retrying an issued INSERT/UPDATE after a half-failed failover
//      is how you get duplicate card_numbers.
//   3. One stuck lock holder never serialises a whole board behind it.
//
// Driver fact this rests on (verified in the vendored source, not folklore):
//   node_modules/pg-pool/index.js:192-266 (pg 8.23) — `connectionTimeoutMillis`
//   bounds BOTH the checkout wait for a client from a full/idle pool AND the
//   establishment of a brand-new client (socket destroy / forced end). One knob
//   covers both paths, so neither can wait unbounded.
//   node_modules/pg/lib/connection-parameters.js:151 — `options` is forwarded
//   in the PostgreSQL startup message, so session GUCs are applied by the
//   server at connect time with no extra round trip and no post-connect race.
// ---------------------------------------------------------------------------

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`invalid ${name}: ${raw} (expected a non-negative integer)`);
  }
  return n;
}

// 2 app replicas x 10 = 20 server connections: comfortably inside PGO's
// default max_connections even while a failed primary's connections drain.
const POOL_MAX = intEnv('KANBUNNY_DB_POOL_MAX', 10);
// Bounds pool checkout AND new-connection setup (see driver note above).
const ACQUIRE_TIMEOUT_MS = intEnv('KANBUNNY_DB_ACQUIRE_TIMEOUT_MS', 3000);
const STATEMENT_TIMEOUT_MS = intEnv('KANBUNNY_DB_STATEMENT_TIMEOUT_MS', 10000);
// Generous: a transaction awaiting an advisory lock is counted here, and we do
// not want a normal lock wait to look like an idle-in-transaction bug.
const IDLE_IN_TX_TIMEOUT_MS = intEnv('KANBUNNY_DB_IDLE_IN_TX_TIMEOUT_MS', 60000);
const IDLE_TIMEOUT_MS = intEnv('KANBUNNY_DB_IDLE_TIMEOUT_MS', 30000);
const CONNECT_RETRIES = intEnv('KANBUNNY_DB_CONNECT_RETRIES', 3);
const CONNECT_RETRY_BASE_MS = intEnv('KANBUNNY_DB_CONNECT_RETRY_BASE_MS', 200);
const CONNECT_RETRY_MAX_MS = intEnv('KANBUNNY_DB_CONNECT_RETRY_MAX_MS', 2000);
// A board write that cannot get its advisory lock this fast is failed, not
// queued. Chosen well above observed lock hold times (~ms) and far below
// "the user is still willing to wait".
const BOARD_LOCK_TIMEOUT_MS = intEnv('KANBUNNY_DB_BOARD_LOCK_TIMEOUT_MS', 5000);
const READINESS_TIMEOUT_MS = intEnv('KANBUNNY_DB_READINESS_TIMEOUT_MS', 1500);

// SQLSTATEs meaning "the endpoint/connection is the problem, not the query".
// During a Patroni promotion these are expected and transient:
//   57P01 admin_shutdown      — Patroni demoted/stopped the old primary
//   57P02 crash_shutdown      — backend killed
//   57P03 cannot_connect_now   — postmaster up but still in archive recovery
//   53300 too_many_connections — old pod's connections still draining mid-roll
// 08xxx is the whole connection-exception class.
const RETRYABLE_SQLSTATES = new Set([
  '08000', '08001', '08003', '08004', '08006', '08007', '08P01',
  '57P01', '57P02', '57P03', '53300',
]);

// OS-level socket errors (Node `err.code`), same category.
const RETRYABLE_SYSERRORS = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTCONN', 'EHOSTUNREACH', 'ENETUNREACH',
  'ETIMEDOUT', 'EPIPE',
]);

// Explicitly NOT retryable, listed so a future edit cannot quietly widen the
// retry net over a constraint violation (which must surface to the caller).
const NON_RETRYABLE_SQLSTATES = new Set([
  '23505', // unique_violation
  '23503', // foreign_key_violation
  '23514', // check_violation
  '22000', // data_exception
  '42501', // insufficient_privilege
  '42P01', // undefined_table
  '42703', // undefined_column
]);

function isRetryableConnectError(err) {
  if (!err) return false;
  const code = err.code;
  if (NON_RETRYABLE_SQLSTATES.has(code)) return false;
  if (RETRYABLE_SQLSTATES.has(code)) return true;
  if (RETRYABLE_SYSERRORS.has(code)) return true;
  // pg-pool's own checkout timeout carries no SQLSTATE, only this message.
  return /timeout exceeded when trying to connect/i.test(err.message || '');
}

// Broader classifier for the HTTP layer: "we could not talk to the database",
// including a connection that died *after* it was handed to us (the classic
// mid-failover "Connection terminated unexpectedly").
function isDatabaseUnavailable(err) {
  if (!err) return false;
  if (isRetryableConnectError(err)) return true;
  if (err.code === '55P03') return true; // lock_timeout — failed fast, by design
  if (err.code === '57014') return false; // statement_timeout — our own cap, not an outage
  return /connection terminated|end of stream|not queryable|server closed the connection unexpectedly/i.test(
    err.message || ''
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Exponential backoff with half-jitter, capped. Worst-case total for the
// default 3 retries stays inside ~3.5s — i.e. inside one Patroni election.
function backoffMs(attempt) {
  const raw = Math.min(CONNECT_RETRY_MAX_MS, CONNECT_RETRY_BASE_MS * 2 ** attempt);
  return Math.round(raw / 2 + Math.random() * (raw / 2));
}

// Acquire a client from `p`, retrying only connection-shaped failures.
// Takes any object exposing connect() so it is unit-testable without a server.
async function connectWithRetry(p, { retries = CONNECT_RETRIES, label = 'db' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await p.connect();
    } catch (err) {
      lastErr = err;
      if (!isRetryableConnectError(err) || attempt === retries) break;
      const wait = backoffMs(attempt);
      console.warn(
        `[db] ${label}: connect attempt ${attempt + 1}/${retries + 1} failed ` +
          `(${err.code || err.message}); retrying in ${wait}ms`
      );
      await sleep(wait);
    }
  }
  throw lastErr;
}

let pool = null;
let initPromise = null;

function databaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set (postgres://user:***@host:5432/db)');
  }
  return url;
}

// --- versioned migrations, applied idempotently at boot ---
// Concurrent replicas (kanbunny runs 2) are serialized with a session-level
// advisory lock so only one pod applies each migration.
async function runMigrations(client) {
  // Advisory lock FIRST — the CREATE TABLE IF NOT EXISTS below is itself racy
  // across concurrent processes (pg_type_typname_nsp_index collisions).
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
        console.log(`Migration applied: ${version}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${version} failed: ${err.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
  }
}

async function initialize() {
  const client = await connectWithRetry(pool, { label: 'init' });
  try {
    // Migrations legitimately wait on another replica's advisory lock for as
    // long as that replica takes. That can exceed any request budget, so this
    // one session is unbounded while it holds/queues for the lock... and the
    // bounded defaults are restored before the client goes back to the pool,
    // so the reset can never leak into request traffic.
    await client.query('SET statement_timeout = 0');
    await client.query('SET idle_in_transaction_session_timeout = 0');
    await runMigrations(client);
    // Bootstrap + priority recompute run on THIS client (never via ready(),
    // which would await initialize itself and deadlock).
    await withTransactionOn(client, ensureBootstrapAdminsWith);
    const { rows } = await client.query('SELECT id FROM boards');
    for (const b of rows) {
      await recomputePrioritiesWith(client, b.id);
    }
  } finally {
    // Best-effort restore; if this fails the connection is broken anyway and
    // pg-pool will discard it rather than hand it to a request.
    await client
      .query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
      .catch(() => {});
    await client
      .query(`SET idle_in_transaction_session_timeout = ${IDLE_IN_TX_TIMEOUT_MS}`)
      .catch(() => {});
    client.release();
  }
}

// Transaction helper bound to an already-acquired client (no pool checkout).
// ROLLBACK failure is swallowed deliberately: when the connection is already
// dead (killed primary), the ROLLBACK error is noise and would mask the root
// cause. The original error is always what gets rethrown.
async function withTransactionOn(client, fn) {
  await client.query('BEGIN');
  try {
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // connection already gone; nothing to roll back, keep the real error
    }
    throw err;
  }
}

// Lazily create the pool and run boot-time setup exactly once.
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl(),
      max: POOL_MAX,
      // Bounds BOTH the wait for a client from the pool and the setup of a new
      // one (pg-pool/index.js:192-266). This is the knob that stops a failover
      // from turning into a queue of hung requests.
      connectionTimeoutMillis: ACQUIRE_TIMEOUT_MS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      application_name: process.env.KANBUNNY_DB_APP_NAME || 'kanbunny-app',
      // Applied by the server during startup — no post-connect race, and every
      // connection is bounded from the moment it exists.
      options:
        `-c statement_timeout=${STATEMENT_TIMEOUT_MS}` +
        ` -c idle_in_transaction_session_timeout=${IDLE_IN_TX_TIMEOUT_MS}`,
    });
    // A client can fail while sitting IDLE — the classic case is the primary we
    // were talking to getting demoted/killed. pg-pool removes the bad client
    // itself, but it then re-emits on the POOL, and an 'error' event with no
    // listener becomes an uncaughtException that kills the pod. That would turn
    // a routine 30s failover into a crash loop, so we absorb it here: the next
    // checkout simply builds a fresh connection.
    pool.on('error', (err) => {
      console.error('[db] idle client error (client discarded):', (err && (err.code || err.message)) || err);
    });
    // The one that actually bites during a failover: pg-pool REMOVES its idle
    // error listener while a client is checked out (pg-pool/index.js:345), so
    // a FATAL packet from the server — 57P01 "terminating connection due to
    // administrator command", which is exactly what a demoted Patroni primary
    // sends to every session — has no handler mid-request and Node converts it
    // into an uncaughtException. Reproduced locally: the packet lands on the
    // socket parser with nothing downstream holding it.
    //
    // Attaching here (pool 'connect') means one listener per client LIFETIME,
    // not per checkout, so it never accumulates. This is the safety net, not
    // the error channel — the request path still gets its own rejected promise.
    pool.on('connect', (client) => {
      client.on('error', (err) => {
        console.error(
          '[db] client emitted error (connection discarded):',
          (err && (err.code || err.message)) || err
        );
      });
    });
    initPromise = initialize().catch((err) => {
      // Allow a later call to retry initialization after a transient failure.
      pool.end().catch(() => {});
      pool = null;
      initPromise = null;
      throw err;
    });
  }
  return pool;
}

// Ensure schema + bootstrap are ready before the first query.
async function ready() {
  getPool();
  await initPromise;
}

// Return a client to the pool. When `err` is connection-shaped, hand it to
// release(err) so pg-pool DISCARDS the client rather than passing a dead
// socket to the next request.
function releaseClient(client, err) {
  if (err && isDatabaseUnavailable(err)) {
    client.release(err);
  } else {
    client.release();
  }
}

// Single statement on a dedicated client. Acquisition is retried (nothing has
// been sent yet, so a retry cannot duplicate a write); the statement itself is
// NEVER retried — a retried INSERT after a half-completed failover is exactly
// how duplicate card_numbers get born.
async function query(sql, params) {
  await ready();
  const client = await connectWithRetry(pool, { label: 'query' });
  let failure = null;
  try {
    return await client.query(sql, params);
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    releaseClient(client, failure);
  }
}

// Legacy-compat alias: callers/tests use db.getDb() to reach the connection.
// Returns the pool (await db.getDb() first to guarantee migrations ran).
async function getDb() {
  await ready();
  return pool;
}

async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    initPromise = null;
    await p.end();
  }
}

// Transaction helper: fn receives a dedicated client; use it for ALL queries
// inside so they share the transaction.
async function withTransaction(fn) {
  await ready();
  const client = await connectWithRetry(pool, { label: 'tx' });
  let failure = null;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    failure = err;
    try {
      await client.query('ROLLBACK');
    } catch {
      // Same as withTransactionOn: never let a failed ROLLBACK hide the cause.
    }
    throw err;
  } finally {
    releaseClient(client, failure);
  }
}

const COLUMNS_LIST = ['todo', 'in-progress', 'blocked', 'in-review', 'done'];

// Per-board mutual exclusion for card_number / position integrity.
//
// pg_advisory_xact_lock (NOT the session-level variant): it is released by the
// COMMIT/ROLLBACK that ends the write, so a crashed caller cannot strand a lock.
//
// SET LOCAL lock_timeout makes the *wait* bounded: if a holder is wedged, the
// next writer aborts with 55P03 after BOARD_LOCK_TIMEOUT_MS and the request
// fails fast (503) instead of queueing the board indefinitely.
//
// ⚠ This is exactly the semantics that PgBouncer *transaction pooling* destroys
// — a pooled transaction would not own the session, so two different requests
// could believe they hold the same board lock at once. Decision A (no pooler)
// is what keeps this correct; tests/ha-resilience.test.js fails loudly if that
// ever stops being true.
async function lockBoardForWrite(exec, boardId) {
  await exec.query(`SET LOCAL lock_timeout = ${BOARD_LOCK_TIMEOUT_MS}`);
  await exec.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
    BOARD_WRITE_ADVISORY_LOCK_NS,
    boardId,
  ]);
}

// Internal: runs with an explicit executor (client or pool) so initialize()
// can use it WITHOUT going through ready() (which would self-deadlock).
async function recomputePrioritiesWith(exec, boardId) {
  for (const col of COLUMNS_LIST) {
    const { rows } = await exec.query(
      'SELECT id FROM cards WHERE board_id = $1 AND "column" = $2 ORDER BY position',
      [boardId, col]
    );
    for (let i = 0; i < rows.length; i++) {
      await exec.query('UPDATE cards SET priority = $1 WHERE id = $2', [i + 1, rows[i].id]);
    }
  }
}

async function recomputePriorities(boardId) {
  await ready();
  return recomputePrioritiesWith(pool, boardId);
}

// --- Auth: users, roles, board membership, API tokens ---
// (design: docs/oidc-auth-design.md §3)

const VALID_ROLES = ['admin', 'user', 'agent'];

function bootstrapAdminLogins() {
  return (process.env.KANBUNNY_BOOTSTRAP_ADMINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Idempotently ensure KANBUNNY_BOOTSTRAP_ADMINS logins exist as admins.
async function ensureBootstrapAdminsWith(tx) {
  const logins = bootstrapAdminLogins();
  for (const login of logins) {
    const { rows } = await tx.query('SELECT * FROM users WHERE login = $1', [login]);
    const existing = rows[0];
    if (existing) {
      if (existing.role !== 'admin') {
        await tx.query("UPDATE users SET role = 'admin', updated_at = now() WHERE id = $1", [
          existing.id,
        ]);
      }
    } else {
      await tx.query("INSERT INTO users (id, login, role) VALUES ($1, $2, 'admin')", [
        `pending:${login}`,
        login,
      ]);
    }
  }
  return logins;
}

async function ensureBootstrapAdmins() {
  await ready();
  return withTransaction(ensureBootstrapAdminsWith);
}

// Upsert a user from a verified OIDC id_token (sub + preferred_username/login).
// - New sub            -> insert with role 'user' (deny-by-default).
// - Known sub          -> refresh login if GitHub login changed; role untouched.
// - Pending bootstrap  -> re-key pending:<login> row to the real sub; role stays 'admin'.
// - Login collision    -> throw (login already claimed by a different sub).
async function upsertUserFromOidc(sub, login) {
  if (!sub || !login) throw new Error('upsertUserFromOidc requires sub and login');
  return withTransaction(async (tx) => {
    let { rows } = await tx.query('SELECT * FROM users WHERE id = $1', [sub]);
    if (rows[0]) {
      if (rows[0].login !== login) {
        await tx.query('UPDATE users SET login = $1, updated_at = now() WHERE id = $2', [login, sub]);
      }
      return (await tx.query('SELECT * FROM users WHERE id = $1', [sub])).rows[0];
    }
    ({ rows } = await tx.query('SELECT * FROM users WHERE login = $1', [login]));
    if (rows[0]) {
      if (!rows[0].id.startsWith('pending:')) {
        throw new Error(`login_conflict: '${login}' is already claimed by another subject`);
      }
      await tx.query('UPDATE users SET id = $1, updated_at = now() WHERE id = $2', [sub, rows[0].id]);
      return (await tx.query('SELECT * FROM users WHERE id = $1', [sub])).rows[0];
    }
    await tx.query("INSERT INTO users (id, login, role) VALUES ($1, $2, 'user')", [sub, login]);
    return (await tx.query('SELECT * FROM users WHERE id = $1', [sub])).rows[0];
  });
}

async function listUsers() {
  const { rows } = await query('SELECT * FROM users ORDER BY role, login');
  return rows;
}

async function getUserById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0];
}

async function getUserByLogin(login) {
  const { rows } = await query('SELECT * FROM users WHERE login = $1', [login]);
  return rows[0];
}

async function setUserRole(id, role) {
  if (!VALID_ROLES.includes(role)) {
    const err = new Error(`invalid_role: ${role}`);
    err.code = 'invalid_role';
    throw err;
  }
  const user = await getUserById(id);
  if (!user) return null;
  await query('UPDATE users SET role = $1, updated_at = now() WHERE id = $2', [role, id]);
  return getUserById(id);
}

// --- Board membership (grants for role='user'/'agent'; admins see all) ---

async function addBoardMember(boardId, userId, grantedBy = null) {
  const { rowCount } = await query(
    'INSERT INTO board_members (board_id, user_id, granted_by) VALUES ($1, $2, $3) ON CONFLICT (board_id, user_id) DO NOTHING',
    [boardId, userId, grantedBy]
  );
  return rowCount > 0;
}

async function removeBoardMember(boardId, userId) {
  const { rowCount } = await query('DELETE FROM board_members WHERE board_id = $1 AND user_id = $2', [
    boardId,
    userId,
  ]);
  return rowCount > 0;
}

async function listBoardMembers(boardId) {
  const { rows } = await query(
    'SELECT u.id, u.login, u.role, bm.granted_by, bm.created_at FROM board_members bm JOIN users u ON u.id = bm.user_id WHERE bm.board_id = $1 ORDER BY u.login',
    [boardId]
  );
  return rows;
}

async function isBoardMember(boardId, userId) {
  const { rows } = await query('SELECT 1 FROM board_members WHERE board_id = $1 AND user_id = $2', [
    boardId,
    userId,
  ]);
  return rows.length > 0;
}

// Boards visible to a principal: all for admins and agents, granted-only otherwise.
// (Per Ross 2026-09-17: the `agent` role sees all boards.)
function seesAllBoards(principal) {
  return principal && (principal.role === 'admin' || principal.role === 'agent');
}

async function visibleBoardsFor(principal) {
  if (!principal) return [];
  if (seesAllBoards(principal)) {
    const { rows } = await query('SELECT * FROM boards ORDER BY name');
    return rows;
  }
  const { rows } = await query(
    'SELECT b.* FROM boards b JOIN board_members bm ON bm.board_id = b.id WHERE bm.user_id = $1 ORDER BY b.name',
    [principal.id]
  );
  return rows;
}

// --- API tokens (agents/automation) ---

async function createApiToken({ id, name, ownerId, tokenHash }) {
  const { v4: uuid } = require('uuid');
  const token = { id: id || uuid(), name, owner_id: ownerId, token_hash: tokenHash };
  await query('INSERT INTO api_tokens (id, name, owner_id, token_hash) VALUES ($1, $2, $3, $4)', [
    token.id,
    token.name,
    token.owner_id,
    token.token_hash,
  ]);
  return (await query('SELECT * FROM api_tokens WHERE id = $1', [token.id])).rows[0];
}

// Resolve a bearer token hash to { token, user } (single join: auth is one lookup).
async function findPrincipalByTokenHash(tokenHash) {
  const { rows } = await query(
    'SELECT t.id AS token_id, t.name AS token_name, t.last_used_at, u.id AS user_id, u.login, u.role FROM api_tokens t JOIN users u ON u.id = t.owner_id WHERE t.token_hash = $1',
    [tokenHash]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    token: { id: row.token_id, name: row.token_name, last_used_at: row.last_used_at },
    user: { id: row.user_id, login: row.login, role: row.role },
  };
}

async function touchApiToken(tokenId) {
  await query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [tokenId]);
}

async function listApiTokens() {
  const { rows } = await query(
    'SELECT t.id, t.name, t.owner_id, t.last_used_at, t.created_at, u.login AS owner_login FROM api_tokens t JOIN users u ON u.id = t.owner_id ORDER BY t.created_at'
  );
  return rows;
}

async function deleteApiToken(id) {
  const { rowCount } = await query('DELETE FROM api_tokens WHERE id = $1', [id]);
  return rowCount > 0;
}

// --- Board CRUD ---

async function listBoards() {
  const { rows } = await query('SELECT * FROM boards ORDER BY name');
  return rows;
}

async function getBoard(id) {
  const { rows } = await query('SELECT * FROM boards WHERE id = $1', [id]);
  return rows[0];
}

async function createBoard(name) {
  const { v4: uuid } = require('uuid');
  const id = uuid();
  await query('INSERT INTO boards (id, name) VALUES ($1, $2)', [id, name]);
  return getBoard(id);
}

async function updateBoard(id, name) {
  await query('UPDATE boards SET name = $1, updated_at = now() WHERE id = $2', [name, id]);
  return getBoard(id);
}

async function deleteBoard(id) {
  const { rowCount } = await query('DELETE FROM boards WHERE id = $1', [id]);
  return rowCount > 0;
}

// --- Card CRUD ---

// Cards carry a human-friendly ref ("X-N") computed from the board name and
// the immutable per-board card_number sequence.
const CARD_SELECT_COLUMNS = `cards.*, CASE WHEN cards.card_number IS NULL THEN NULL
  ELSE substr(upper(ltrim(b.name)), 1, 1) || '-' || cards.card_number::text END AS ref`;
const CARD_SELECT_FROM = 'FROM cards JOIN boards b ON b.id = cards.board_id';

async function listCards(boardId, filters = {}) {
  const { column } = filters;
  if (column) {
    const { rows } = await query(
      `SELECT ${CARD_SELECT_COLUMNS} ${CARD_SELECT_FROM} WHERE cards.board_id = $1 AND cards."column" = $2 ORDER BY cards.position`,
      [boardId, column]
    );
    return rows;
  }
  const { rows } = await query(
    `SELECT ${CARD_SELECT_COLUMNS} ${CARD_SELECT_FROM} WHERE cards.board_id = $1 ORDER BY cards."column", cards.position`,
    [boardId]
  );
  return rows;
}

async function getCard(id) {
  const { rows } = await query(
    `SELECT ${CARD_SELECT_COLUMNS} ${CARD_SELECT_FROM} WHERE cards.id = $1`,
    [id]
  );
  return rows[0];
}

async function createCard(boardId, title, description = '', column = 'todo', assignee = '', priority = null) {
  const { v4: uuid } = require('uuid');
  const cardId = await withTransaction(async (tx) => {
    await lockBoardForWrite(tx, boardId);
    const { rows: maxRows } = await tx.query(
      'SELECT COALESCE(MAX(position), -1) AS maxpos FROM cards WHERE board_id = $1 AND "column" = $2',
      [boardId, column]
    );
    const { rows: numRows } = await tx.query(
      'SELECT COALESCE(MAX(card_number), 0) + 1 AS nextnum FROM cards WHERE board_id = $1',
      [boardId]
    );
    const card = {
      id: uuid(),
      board_id: boardId,
      title,
      description,
      assignee,
      column,
      position: Number(maxRows[0].maxpos) + 1,
      priority,
      card_number: Number(numRows[0].nextnum),
    };
    await tx.query(
      'INSERT INTO cards (id, board_id, title, description, assignee, "column", position, priority, card_number) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [
        card.id,
        card.board_id,
        card.title,
        card.description,
        card.assignee,
        card.column,
        card.position,
        card.priority,
        card.card_number,
      ]
    );
    return card.id;
  });
  return getCard(cardId);
}

async function updateCard(id, updates) {
  const card = await getCard(id);
  if (!card) return null;

  const fields = [];
  const values = [];
  let columnChanged = false;

  if (updates.title !== undefined) { fields.push('title = $' + (values.length + 1)); values.push(updates.title); }
  if (updates.description !== undefined) { fields.push('description = $' + (values.length + 1)); values.push(updates.description); }
  if (updates.assignee !== undefined) { fields.push('assignee = $' + (values.length + 1)); values.push(updates.assignee); }
  if (updates.priority !== undefined) {
    fields.push('priority = $' + (values.length + 1));
    values.push(updates.priority == null ? null : parseInt(updates.priority, 10));
  }
  if (updates.column !== undefined) {
    fields.push('"column" = $' + (values.length + 1));
    values.push(updates.column);
    // When moving to a new column, append at end
    if (updates.column !== card.column) {
      columnChanged = true;
    }
  }

  if (fields.length === 0) return card;

  fields.push('updated_at = now()');

  await withTransaction(async (tx) => {
    if (columnChanged) {
      await lockBoardForWrite(tx, card.board_id);
      const { rows } = await tx.query(
        'SELECT COALESCE(MAX(position), -1) AS maxpos FROM cards WHERE board_id = $1 AND "column" = $2',
        [card.board_id, updates.column]
      );
      fields.push('position = $' + (values.length + 1));
      values.push(Number(rows[0].maxpos) + 1);
    }
    values.push(id);
    await tx.query(`UPDATE cards SET ${fields.join(', ')} WHERE id = $${values.length}`, values);
    // Auto-recompute priorities for affected columns
    if (columnChanged) {
      await recomputePrioritiesTx(tx, card.board_id);
    }
  });

  return getCard(id);
}

async function deleteCard(id) {
  const { rowCount } = await query('DELETE FROM cards WHERE id = $1', [id]);
  return rowCount > 0;
}

// recomputePriorities inside an existing transaction (same semantics as the
// standalone version, but shares the caller's tx).
async function recomputePrioritiesTx(tx, boardId) {
  for (const col of COLUMNS_LIST) {
    const { rows } = await tx.query(
      'SELECT id FROM cards WHERE board_id = $1 AND "column" = $2 ORDER BY position',
      [boardId, col]
    );
    for (let i = 0; i < rows.length; i++) {
      await tx.query('UPDATE cards SET priority = $1 WHERE id = $2', [i + 1, rows[i].id]);
    }
  }
}

async function reorderCard(cardId, afterCardId) {
  const card = await getCard(cardId);
  const after = afterCardId ? await getCard(afterCardId) : null;

  if (!card || (after && after.board_id !== card.board_id)) return false;

  const result = await withTransaction(async (tx) => {
    await lockBoardForWrite(tx, card.board_id);
    const { rows } = await tx.query(
      'SELECT id, position FROM cards WHERE board_id = $1 AND "column" = $2 ORDER BY position',
      [card.board_id, card.column]
    );
    const cardsInCol = rows.map((r) => ({ id: r.id, position: r.position }));

    if (after) {
      // Move card to position after "after" card
      const afterIdx = cardsInCol.findIndex((c) => c.id === afterCardId);
      if (afterIdx === -1) return false; // after card not in same column

      const cardIdx = cardsInCol.findIndex((c) => c.id === cardId);
      if (cardIdx === -1) return false; // card not in column

      // Remove card from current position
      const [removed] = cardsInCol.splice(cardIdx, 1);

      // Insert after the target index (adjust for removal shift)
      const newIdx = cardIdx < afterIdx ? afterIdx : afterIdx + 1;
      cardsInCol.splice(newIdx, 0, removed);
    } else {
      // No afterCardId: move to end of column
      const cardIdx = cardsInCol.findIndex((c) => c.id === cardId);
      if (cardIdx === -1) return false;

      const [removed] = cardsInCol.splice(cardIdx, 1);
      cardsInCol.push(removed);
    }

    // Re-normalize positions
    for (let i = 0; i < cardsInCol.length; i++) {
      await tx.query('UPDATE cards SET position = $1 WHERE id = $2', [i, cardsInCol[i].id]);
    }

    return true;
  });

  // Auto-recompute priorities for affected column (outside the reorder tx,
  // exactly as the SQLite version did).
  await recomputePriorities(card.board_id);

  return result;
}

// Health check for /readyz: bounded, uses an existing pooled connection, and
// never triggers boot-time migration work. Returns false (not throws) when the
// pool is absent or the DB cannot answer inside the budget.
async function ping(timeoutMs = READINESS_TIMEOUT_MS) {
  if (!pool) return false;
  let timer;
  const probe = (async () => {
    const client = await pool.connect();
    try {
      const { rows } = await client.query('SELECT 1 AS ok');
      return rows.length === 1 && rows[0].ok === 1;
    } finally {
      client.release();
    }
  })();
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([probe, budget]);
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  getPool,
  getDb,
  query,
  ready,
  withTransaction,
  closePool,
  ping,
  lockBoardForWrite,
  // resilience surface (used by server.js error mapping + tests)
  isRetryableConnectError,
  isDatabaseUnavailable,
  connectWithRetry,
  backoffMs,
  CONFIG: {
    POOL_MAX,
    ACQUIRE_TIMEOUT_MS,
    STATEMENT_TIMEOUT_MS,
    IDLE_IN_TX_TIMEOUT_MS,
    IDLE_TIMEOUT_MS,
    CONNECT_RETRIES,
    BOARD_LOCK_TIMEOUT_MS,
    READINESS_TIMEOUT_MS,
  },
  listBoards,
  getBoard,
  createBoard,
  updateBoard,
  deleteBoard,
  listCards,
  getCard,
  createCard,
  updateCard,
  deleteCard,
  reorderCard,
  recomputePriorities,
  // auth (KB-AUTH-1)
  VALID_ROLES,
  bootstrapAdminLogins,
  ensureBootstrapAdmins,
  upsertUserFromOidc,
  listUsers,
  getUserById,
  getUserByLogin,
  setUserRole,
  addBoardMember,
  removeBoardMember,
  listBoardMembers,
  isBoardMember,
  visibleBoardsFor,
  seesAllBoards,
  createApiToken,
  findPrincipalByTokenHash,
  touchApiToken,
  listApiTokens,
  deleteApiToken,
};
