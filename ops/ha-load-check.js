#!/usr/bin/env node
// KB-PG-5 — cross-replica advisory-lock proof for the Kanbunny PGO cutover.
//
// Why this exists: the unit tests prove the data layer is correct against ONE
// Postgres from ONE process. They cannot prove that two SEPARATE app replicas,
// behind the service, still get mutual exclusion on a shared board — which is
// the exact property Decision A (no PgBouncer) is protecting.
//
// So this drives the app over HTTP through the k8s Service (which round-robins
// across both pods) and then asserts the invariants by reading the database
// directly. If a pooler in transaction-pooling mode is ever inserted, or the
// advisory lock is weakened, the assertions fail here — loudly — instead of
// silently corrupting card_number / position.
//
// Usage:
//   KANBUNNY_BASE_URL=https://kanbunny.rossbrigoli.com \
//   KANBUNNY_TOKEN_FILE=~/.kanbunny-token \
//   DATABASE_URL=postgres://...@kanbunny-pg-primary:5432/kanbunny \
//   node ops/ha-load-check.js [--concurrency 24] [--rounds 3]
//
// Exit 0 = invariants held across replicas. Non-zero = DO NOT CUT OVER.

const fs = require('fs');
const { Pool } = require('pg');

function envRequired(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function token() {
  if (process.env.KANBUNNY_TOKEN_FILE) {
    return fs.readFileSync(process.env.KANBUNNY_TOKEN_FILE, 'utf8').trim();
  }
  throw new Error('KANBUNNY_TOKEN_FILE is required (do not put the token in argv)');
}

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > -1 ? Number(process.argv[i + 1]) : dflt;
}

const BASE = envRequired('KANBUNNY_BASE_URL').replace(/\/+$/, '');
const COLS = ['todo', 'in-progress', 'blocked', 'in-review', 'done'];

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${token()}`,
      'content-type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusMessage} on ${opts.method || 'GET'} ${path}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

(async () => {
  const concurrency = arg('--concurrency', 24);
  const rounds = arg('--rounds', 3);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 5000 });

  console.log(`target ${BASE}  concurrency=${concurrency} rounds=${rounds}`);

  // Dedicated board so we do not perturb real data. If an admin token is not
  // available (POST /api/boards requires admin), pass --board <id> to use an
  // existing board the token can write to — but then this run writes test rows
  // into that board, so choose deliberately.
  const explicitBoard = process.argv.includes('--board')
    ? process.argv[process.argv.indexOf('--board') + 1]
    : null;
  const board = explicitBoard
    ? { id: explicitBoard, name: '(existing, supplied via --board)' }
    : await api('/api/boards', { method: 'POST', body: JSON.stringify({ name: `HA PROOF ${Date.now()}` }) });
  console.log(`board ${board.id} (${board.name})`);

  // Guard: an explicitly-supplied board must contain NO real (non-test) cards.
  // On 2026-09-18 a run with --board polluted the real australian-visa board
  // with 241 `r{round}-c{index}` cards. Refuse rather than learn the lesson twice.
  if (explicitBoard) {
    const existing = await api(`/api/boards/${board.id}/cards`);
    const foreign = existing.filter((c) => !/^r\d+-c\d+$/.test(c.title));
    if (foreign.length) {
      console.error(`REFUSING: board ${board.id} contains ${foreign.length} non-test card(s), e.g. "${foreign[0].title}"${foreign[0].ref ? ` (${foreign[0].ref})` : ''}.`);
      console.error('This test writes synthetic rows. Omit --board to auto-create a dedicated "HA PROOF <ts>" board, or pass a board that holds only test cards.');
      process.exit(2);
    }
  }

  const errors = [];
  let created = 0;

  for (let r = 0; r < rounds; r++) {
    // 1. Concurrent creates on the SAME board — the card_number race.
    const creates = Array.from({ length: concurrency }, (_, i) =>
      api(`/api/boards/${board.id}/cards`, {
        method: 'POST',
        body: JSON.stringify({ title: `r${r}-c${i}`, column: COLS[i % COLS.length] }),
      }).catch((e) => { errors.push(`create: ${e.message}`); return null; })
    );
    const cards = (await Promise.all(creates)).filter(Boolean);
    created += cards.length;

    // 2. Concurrent moves WITHIN each column. Deliberately no concurrent column
    //    changes here: a move whose after-card has drifted to another column is a
    //    legitimate 400 from the app, and mixing that noise in would bury the
    //    signal we are actually testing (position uniqueness under contention).
    const byCol = {};
    for (const c of cards) (byCol[c.column] ||= []).push(c);
    const mutations = [];
    for (const col of Object.keys(byCol)) {
      const group = byCol[col];
      for (let i = 0; i < group.length; i++) {
        const card = group[i];
        const after = group[(i + 1) % group.length];
        if (card.id === after.id) continue;
        mutations.push(
          api(`/api/cards/${card.id}/move`, {
            method: 'PUT',
            body: JSON.stringify({ afterCardId: after.id }),
          }).catch((e) => { errors.push(`move(${col}): ${e.message}`); })
        );
      }
    }
    await Promise.all(mutations);
    console.log(`round ${r + 1}: ${cards.length} created, ${mutations.length} in-column moves, ${errors.length} errors so far`);
  }

  // ---- Invariant assertions, read straight off the PGO primary ----
  let ok = true;

  const { rows: dupNums } = await pool.query(
    `SELECT board_id, COUNT(*) n, COUNT(DISTINCT card_number) u FROM cards
     WHERE board_id = $1 GROUP BY board_id HAVING COUNT(*) <> COUNT(DISTINCT card_number)`,
    [board.id]
  );
  if (dupNums.length) {
    ok = false;
    console.log(`❌ duplicate card_number on the board: ${JSON.stringify(dupNums)}`);
  } else {
    console.log(`✅ card_number unique across ${created} concurrent creates`);
  }

  const { rows: dupPos } = await pool.query(
    `SELECT board_id, "column", position, COUNT(*) n FROM cards
     WHERE board_id = $1 GROUP BY board_id, "column", position HAVING COUNT(*) > 1 LIMIT 20`,
    [board.id]
  );
  if (dupPos.length) {
    ok = false;
    console.log(`❌ duplicate (board, column, position): ${JSON.stringify(dupPos)}`);
  } else {
    console.log(`✅ (board, column, position) unique`);
  }

  const { rows: seq } = await pool.query(
    `SELECT MIN(card_number)::int lo, MAX(card_number)::int hi,
            COUNT(*)::int n, COUNT(DISTINCT card_number)::int d
     FROM cards WHERE board_id = $1`,
    [board.id]
  );
  const s = seq[0];
  const lo = Number(s.lo), hi = Number(s.hi), n = Number(s.n), d = Number(s.d);
  if (n !== d || hi - lo + 1 !== n) {
    ok = false;
    console.log(`❌ card_number sequence not gap-free/unique: ${JSON.stringify(s)}`);
  } else {
    console.log(`✅ card_number sequence gap-free: ${lo}..${hi} (${n} rows)`);
  }

  if (errors.length) {
    ok = false;
    console.log(`❌ ${errors.length} HTTP error(s) during the load:`);
    for (const e of errors.slice(0, 10)) console.log(`   ${e}`);
  } else {
    console.log('✅ no HTTP errors during the load');
  }

  // Confirm the writes actually landed on the CURRENT primary (i.e. we followed
  // the leader, not a stale replica or a mis-pointed service).
  const { rows: whoami } = await pool.query('SELECT pg_is_in_recovery() AS in_recovery');
  if (whoami[0].in_recovery) {
    ok = false;
    console.log('❌ DATABASE_URL points at a REPLICA, not the primary — this run proves nothing');
  } else {
    console.log('✅ reads/writes went to a non-recovery (primary) node');
  }

  await pool.end();
  console.log('');
  console.log(ok
    ? 'RESULT: PASS — advisory-lock exclusion held across app replicas on PGO.'
    : 'RESULT: FAIL — do not cut over.');
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('load check crashed:', err.message || err);
  process.exit(3);
});
