// KB-PG-4 — HA Postgres connection resilience tests.
//
// These exist to prove three properties that the Kanbunny cutover depends on,
// and to fail loudly if a future change quietly breaks them:
//
//   1. Retry policy is correct: connection-shaped failures retry, query-shaped
//      failures never do. (A retried INSERT after a half-failed failover is how
//      duplicate card_numbers are born.)
//   2. The per-board advisory lock really does provide mutual exclusion, and a
//      wedged lock holder fails fast instead of queueing the board forever.
//   3. A backend killed mid-transaction (the deterministic analogue of the
//      primary dying) surfaces as "database unavailable" and leaves no partial
//      write behind.
//
// Run against the same real Postgres the rest of the suite uses. NOTE: these are
// NOT a substitute for the PGO-cluster proof in the cutover plan — advisory
// locks must be re-verified against a real Crunchy PGO cluster with 2 app
// replicas (see k3s-cluster/docs/plans/2026-09-18-ha-postgres-kanbunny.md
// Phase 4.3). What this file proves is the driver/app-side contract.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

// Tighten the board lock budget BEFORE requiring the module (config is read at
// load time) so the wedged-lock test does not have to sit on the 5s default.
process.env.KANBUNNY_DB_BOARD_LOCK_TIMEOUT_MS = '500';
process.env.KANBUNNY_DB_CONNECT_RETRY_BASE_MS = '50';

const TEST_PG_URL = 'postgres://kanbunny:kanbunny@127.0.0.1:55432/kanbunny_test_hares';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1. Retry classification — pure functions, no server needed.
// ---------------------------------------------------------------------------
describe('retry classification (KB-PG-4)', () => {
  let db;
  before(() => {
    delete require.cache[require.resolve('../src/db')];
    db = require('../src/db');
  });

  it('retries the Patroni-failover SQLSTATEs', () => {
    const cases = [
      ['57P01', 'admin_shutdown — old primary demoted'],
      ['57P02', 'crash_shutdown'],
      ['57P03', 'cannot_connect_now — still in archive recovery'],
      ['53300', 'too_many_connections — old pod draining mid-roll'],
      ['08001', 'unable to establish sqlconnection'],
      ['08006', 'connection_failure'],
      ['ECONNREFUSED', 'endpoint gone (service has no ready backend)'],
      ['ECONNRESET', 'socket killed mid-handshake'],
      ['ETIMEDOUT', 'connect timed out'],
    ];
    for (const [code, why] of cases) {
      const err = Object.assign(new Error(`boom ${why}`), { code });
      assert.strictEqual(db.isRetryableConnectError(err), true, `${code} (${why}) must be retryable`);
    }
  });

  it('does NOT retry query-shaped or constraint errors', () => {
    const cases = [
      ['23505', 'unique_violation'],
      ['23503', 'foreign_key_violation'],
      ['23514', 'check_violation'],
      ['42501', 'insufficient_privilege'],
      ['42P01', 'undefined_table'],
      ['22001', 'string_data_right_truncation'],
    ];
    for (const [code, why] of cases) {
      const err = Object.assign(new Error(`boom ${why}`), { code });
      assert.strictEqual(db.isRetryableConnectError(err), false, `${code} (${why}) must NOT be retryable`);
    }
  });

  it('treats pg-pool checkout timeout (no SQLSTATE) as retryable', () => {
    const err = new Error('timeout exceeded when trying to connect');
    assert.strictEqual(db.isRetryableConnectError(err), true);
  });

  it('classifies a mid-request dead connection as unavailable (→ HTTP 503)', () => {
    const dead = Object.assign(new Error('Connection terminated unexpectedly'), {});
    assert.strictEqual(db.isDatabaseUnavailable(dead), true);
    assert.strictEqual(db.isDatabaseUnavailable(new Error('boom')), false);
    // lock_timeout: we failed fast on purpose; the client should back off.
    assert.strictEqual(db.isDatabaseUnavailable(Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })), true);
    // our own statement_timeout cap is a bug signal, not an outage.
    assert.strictEqual(db.isDatabaseUnavailable(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })), false);
  });
});

// ---------------------------------------------------------------------------
// 2. connectWithRetry — exercised with a fake pool so attempt counts are exact.
// ---------------------------------------------------------------------------
describe('connectWithRetry (KB-PG-4)', () => {
  let db;
  before(() => {
    delete require.cache[require.resolve('../src/db')];
    db = require('../src/db');
  });

  function fakePool(script) {
    // script: array of Error | 'ok'
    let i = 0;
    return {
      attempts: 0,
      async connect() {
        const step = script[i++];
        this.attempts = i;
        if (step === 'ok') return { released: false, release() { this.released = true; } };
        throw step;
      },
    };
  }

  it('succeeds on the first try when the pool is healthy', async () => {
    const p = fakePool(['ok']);
    const client = await db.connectWithRetry(p, { retries: 3, label: 'test' });
    assert.ok(client);
    assert.strictEqual(p.attempts, 1);
  });

  it('retries connection-shaped failures and succeeds', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const p = fakePool([refused, refused, 'ok']);
    await db.connectWithRetry(p, { retries: 3, label: 'test' });
    assert.strictEqual(p.attempts, 3);
  });

  it('gives up after the retry budget and rethrows the last error', async () => {
    const refused = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const p = fakePool([refused(), refused(), refused(), refused(), refused()]);
    await assert.rejects(
      () => db.connectWithRetry(p, { retries: 3, label: 'test' }),
      (e) => e.code === 'ECONNREFUSED'
    );
    assert.strictEqual(p.attempts, 4, 'exactly retries+1 attempts, no more');
  });

  it('does NOT retry a constraint violation (would risk a duplicate write)', async () => {
    const dup = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    const p = fakePool([dup, 'ok', 'ok', 'ok']);
    await assert.rejects(() => db.connectWithRetry(p, { retries: 3, label: 'test' }), (e) => e.code === '23505');
    assert.strictEqual(p.attempts, 1, 'must fail immediately, never re-attempt');
  });

  it('backoff grows but stays bounded', () => {
    const a = db.backoffMs(0);
    const b = db.backoffMs(1);
    const c = db.backoffMs(2);
    const z = db.backoffMs(20);
    assert.ok(a >= 0 && a <= 2000, `attempt0 backoff ${a} within cap`);
    assert.ok(b >= a, `backoff not decreasing (${a} -> ${b})`);
    assert.ok(c <= 2000 && z <= 2000, 'hard cap 2s so total stays inside one election');
  });
});

// ---------------------------------------------------------------------------
// 3. Advisory-lock mutual exclusion against a real Postgres.
// ---------------------------------------------------------------------------
describe('per-board advisory lock (real Postgres, KB-PG-4)', () => {
  let db;

  before(async () => {
    process.env.DATABASE_URL = process.env.KANBUNNY_TEST_PG_URL_HA || TEST_PG_URL;
    delete require.cache[require.resolve('../src/db')];
    db = require('../src/db');
    await db.ready();
  });

  after(async () => {
    await db.closePool();
  });

  async function newBoard(name) {
    return db.createBoard(`${name} ${crypto.randomBytes(4).toString('hex')}`);
  }

  it('a second writer on the same board blocks until the first commits', async () => {
    const board = await newBoard('LockSerial');
    let firstCommittedAt = null;

    const holder = db.withTransaction(async (tx) => {
      await db.lockBoardForWrite(tx, board.id);
      await sleep(400);
      await tx.query(
        `INSERT INTO cards (id, board_id, title, "column", position, card_number)
         VALUES ($1, $2, 'held-first', 'todo', 0, 1)`,
        ['lock-holder-card', board.id]
      );
      firstCommittedAt = Date.now();
    });

    await sleep(60); // let the holder acquire the lock first
    const startWait = Date.now();
    // Second writer: same board, same code path createCard uses.
    await db.withTransaction(async (tx) => {
      await db.lockBoardForWrite(tx, board.id);
      const { rows } = await tx.query(
        'SELECT COUNT(*)::int AS n FROM cards WHERE board_id = $1',
        [board.id]
      );
      assert.strictEqual(rows[0].n, 1, 'second writer sees the first writer\'s committed row');
    });
    const waited = Date.now() - startWait;

    await holder;
    assert.ok(firstCommittedAt, 'holder committed');
    assert.ok(
      waited >= 300,
      `second writer only waited ${waited}ms — mutual exclusion is NOT holding`
    );
    assert.ok(startWait < firstCommittedAt, 'second writer started before the holder finished');
  });

  it('a wedged lock holder makes the next writer fail fast (lock_timeout → 503 class)', async () => {
    const board = await newBoard('LockWedged');
    const budgetMs = Number(process.env.KANBUNNY_DB_BOARD_LOCK_TIMEOUT_MS);

    // Holder sleeps well past the lock budget.
    const holder = db.withTransaction(async (tx) => {
      await db.lockBoardForWrite(tx, board.id);
      await sleep(budgetMs + 700);
    });
    await sleep(60);

    const start = Date.now();
    let err;
    try {
      await db.withTransaction(async (tx) => {
        await db.lockBoardForWrite(tx, board.id);
      });
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - start;

    assert.ok(err, 'wedged board write must fail, not hang');
    assert.strictEqual(err.code, '55P03', `expected lock_timeout, got ${err.code}: ${err.message}`);
    assert.ok(
      elapsed >= budgetMs - 50 && elapsed < budgetMs + 400,
      `failed in ${elapsed}ms — expected ~${budgetMs}ms (bounded fail-fast)`
    );
    assert.strictEqual(db.isDatabaseUnavailable(err), true, 'maps to HTTP 503');
    await holder;
  });

  it('locks are per-board: a different board is not blocked', async () => {
    const a = await newBoard('BoardA');
    const b = await newBoard('BoardB');

    const holderA = db.withTransaction(async (tx) => {
      await db.lockBoardForWrite(tx, a.id);
      await sleep(300);
    });
    await sleep(50);
    const start = Date.now();
    await db.withTransaction(async (tx) => {
      await db.lockBoardForWrite(tx, b.id);
    });
    const elapsed = Date.now() - start;
    await holderA;
    assert.ok(elapsed < 200, `other board blocked for ${elapsed}ms — lock scoping is wrong`);
  });

  it('24 concurrent creates on one board yield unique card_numbers and positions', async () => {
    const board = await newBoard('Concurrent24');
    const N = 24;
    const cards = await Promise.all(
      Array.from({ length: N }, (_, i) => db.createCard(board.id, `C${i + 1}`, '', 'todo'))
    );
    const nums = cards.map((c) => c.card_number).sort((x, y) => x - y);
    assert.deepStrictEqual(nums, Array.from({ length: N }, (_, i) => i + 1), 'card_numbers exactly 1..N');
    const pos = cards.map((c) => c.position);
    assert.strictEqual(new Set(pos).size, N, 'positions unique under concurrency');
  });

  it('mixed concurrent create + move + reorder keeps every invariant', async () => {
    const board = await newBoard('MixedLoad');
    const N = 10;
    const created = await Promise.all(
      Array.from({ length: N }, (_, i) => db.createCard(board.id, `M${i + 1}`, '', 'todo'))
    );
    const cols = ['todo', 'in-progress', 'blocked', 'in-review', 'done'];

    // Fire a mixed batch at the same board from many concurrent callers.
    const ops = [];
    for (let i = 0; i < N; i++) {
      const card = created[i];
      const target = cols[i % cols.length];
      ops.push(db.updateCard(card.id, { column: target }));
      if (i + 1 < N) ops.push(db.reorderCard(card.id, created[i + 1].id));
      ops.push(db.createCard(board.id, `Extra${i}`, '', target));
    }
    await Promise.all(ops);

    const all = await db.listCards(board.id);
    const total = 2 * N; // N created up front + N extras pushed in during the mixed batch
    assert.strictEqual(all.length, total, 'no rows lost or duplicated');

    const nums = all.map((c) => c.card_number).sort((x, y) => x - y);
    assert.deepStrictEqual(
      nums,
      Array.from({ length: total }, (_, i) => i + 1),
      'card_numbers remain a gap-free unique sequence'
    );

    for (const col of cols) {
      const inCol = all.filter((c) => c.column === col);
      const positions = inCol.map((c) => c.position);
      assert.strictEqual(
        new Set(positions).size,
        positions.length,
        `duplicate positions in column ${col}: ${JSON.stringify(positions)}`
      );
    }
  });

  it('SQLite-format timestamp normalisation did not regress', async () => {
    const board = await newBoard('TsReg');
    const card = await db.createCard(board.id, 'Ts', '', 'todo');
    assert.match(card.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'created_at wire format');
    assert.match(card.updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'updated_at wire format');
    const moved = await db.updateCard(card.id, { title: 'Ts2' });
    assert.match(moved.updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'updated_at after PATCH');
    assert.strictEqual(typeof board.created_at, 'string');
  });
});

// ---------------------------------------------------------------------------
// 4. Failover analogue: backend killed mid-transaction.
// ---------------------------------------------------------------------------
describe('killed backend mid-transaction (failover analogue, KB-PG-4)', () => {
  let db;

  before(async () => {
    process.env.DATABASE_URL = process.env.KANBUNNY_TEST_PG_URL_HA || TEST_PG_URL;
    delete require.cache[require.resolve('../src/db')];
    db = require('../src/db');
    await db.ready();
  });

  after(async () => {
    await db.closePool();
  });

  it('surfaces as database_unavailable and leaves no partial write', async () => {
    const board = await db.createBoard(`KillMid ${crypto.randomBytes(4).toString('hex')}`);
    const pool = await db.getDb();

    let err;
    try {
      await db.withTransaction(async (tx) => {
        const { rows } = await tx.query('SELECT pg_backend_pid() AS pid');
        const pid = rows[0].pid;
        await tx.query(
          `INSERT INTO cards (id, board_id, title, "column", position, card_number)
           VALUES ($1, $2, 'doomed', 'todo', 0, 9001)`,
          ['doomed-card', board.id]
        );
        // This is precisely what happens to every backend when a primary dies:
        // Postgres terminates the connection out from under the transaction.
        await pool.query('SELECT pg_terminate_backend($1)', [pid]);
        for (let i = 0; i < 100; i++) {
          const { rows: alive } = await pool.query(
            'SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE pid = $1',
            [pid]
          );
          if (alive[0].n === 0) break;
          await sleep(20);
        }
        await tx.query('SELECT 1'); // must blow up: our backend is gone
      });
    } catch (e) {
      err = e;
    }

    assert.ok(err, 'the killed transaction must reject');
    assert.strictEqual(
      db.isDatabaseUnavailable(err),
      true,
      `must classify as unavailable (503), got code=${err.code} msg=${err.message}`
    );

    const { rows } = await db.query(
      'SELECT COUNT(*)::int AS n FROM cards WHERE board_id = $1',
      [board.id]
    );
    assert.strictEqual(rows[0].n, 0, 'no partial write survived');

    // And the pool itself must still be usable afterwards (broken client
    // discarded, not handed to the next request).
    const after = await db.createCard(board.id, 'AfterFailover', '', 'todo');
    assert.ok(after.id, 'pool recovers after a killed backend');
  });

  it('ping() reports healthy against a live pool and false once closed', async () => {
    assert.strictEqual(await db.ping(), true);
    await db.closePool();
    assert.strictEqual(await db.ping(), false, 'closed pool must report not-ready');
  });
});
