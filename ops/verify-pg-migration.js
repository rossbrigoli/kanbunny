#!/usr/bin/env node
// KB-PG-6 — Postgres -> Postgres migration verifier (Kanbunny PGO cutover).
//
// Purpose: before we flip kanbunny-db-url at the PGO cluster, prove the target
// is a faithful copy of the source. Row counts alone are weak (a partial
// import has the right shape); per-table ordered digests over the full row
// payload are what actually catch drift.
//
// Both sessions are pinned to UTC so timestamptz renders identically on source
// and target — otherwise a session-timezone difference masquerades as data drift.
//
// Usage:
//   node ops/verify-pg-migration.js \
//     --source postgres://user:***@old-host:5432/kanbunny \
//     --target postgres://user:***@kanbunny-pg-primary:5432/kanbunny \
//     [--tables boards,cards,users,board_members,api_tokens] [--explain 10]
//
// Exit 0 = every table matches. Non-zero = DO NOT CUT OVER.

const { Pool } = require('pg');

const DEFAULT_TABLES = ['boards', 'cards', 'users', 'board_members', 'api_tokens'];

// Primary-key column(s) per table. Most Kanbunny tables are TEXT-PK'd on `id`;
// board_members has a composite PK and schema_migrations is version-PK'd.
const PK = {
  schema_migrations: ['version'],
  board_members: ['board_id', 'user_id'],
};
const DEFAULT_PK = ['id'];
const pkFor = (table) => PK[table] || DEFAULT_PK;

function parseArgs(argv) {
  const out = { tables: DEFAULT_TABLES, explain: 0 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') out.source = argv[++i];
    else if (a === '--target') out.target = argv[++i];
    else if (a === '--tables') {
      out.tables = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--explain') {
      out.explain = parseInt(argv[i + 1] || '10', 10);
      i++;
    } else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

// Deterministic digest: order by PK, render each row as JSON, concatenate,
// md5. Column order comes from the table definition and the PK ordering makes
// the result independent of physical layout, vacuum state, or page order.
async function tableDigest(pool, table, pkCols) {
  const orderBy = pkCols.join(', ');
  const { rows } = await pool.query(
    `SELECT md5(string_agg(row_to_json(t)::text, chr(10) ORDER BY ${orderBy})) AS digest,
            count(*)::int AS rows
     FROM ${table} t`
  );
  return { digest: rows[0].digest, rows: rows[0].rows };
}

// PK set as pipe-joined strings — handles composite keys without per-table SQL.
async function keySet(pool, table, pkCols) {
  const keyExpr = pkCols.map((c) => `coalesce(${c}::text, '')`).join(` || '|' || `);
  const { rows } = await pool.query(`SELECT ${keyExpr} AS k FROM ${table}`);
  return new Set(rows.map((r) => r.k));
}

function diffKeys(a, b, limit) {
  return {
    onlyInSource: [...a].filter((k) => !b.has(k)).slice(0, limit),
    onlyInTarget: [...b].filter((k) => !a.has(k)).slice(0, limit),
  };
}

async function connect(url, label) {
  const pool = new Pool({
    connectionString: url,
    max: 4,
    connectionTimeoutMillis: 5000,
    application_name: `kanbunny-verify-${label}`,
  });
  const c = await pool.connect();
  try {
    await c.query(`SET TIME ZONE 'UTC'`);
  } finally {
    c.release();
  }
  return pool;
}

(async () => {
  const args = parseArgs(process.argv);
  if (args.help || !args.source || !args.target) {
    console.log(
      'usage: node ops/verify-pg-migration.js --source <pg-url> --target <pg-url> [--tables a,b,c] [--explain N]'
    );
    process.exit(2);
  }

  const src = await connect(args.source, 'source');
  const dst = await connect(args.target, 'target');
  let allOk = true;

  for (const table of args.tables) {
    const pk = pkFor(table);
    let row;
    try {
      const [a, b] = await Promise.all([
        tableDigest(src, table, pk),
        tableDigest(dst, table, pk),
      ]);
      row = {
        table,
        sourceRows: a.rows,
        targetRows: b.rows,
        sourceDigest: a.digest,
        targetDigest: b.digest,
        ok: a.rows === b.rows && a.digest === b.digest,
      };
    } catch (err) {
      row = { table, error: err.message, ok: false };
    }

    if (row.ok) {
      console.log(
        `✅ ${table.padEnd(16)} rows ${String(row.sourceRows).padStart(6)} / ${String(row.targetRows).padStart(6)}` +
          `   digest ${row.sourceDigest} / ${row.targetDigest}`
      );
    } else {
      allOk = false;
      console.log(`❌ ${table.padEnd(16)} ${row.error || 'MISMATCH'}`);
      if (!row.error && args.explain) {
        try {
          const [srcKeys, dstKeys] = await Promise.all([
            keySet(src, table, pk),
            keySet(dst, table, pk),
          ]);
          const d = diffKeys(srcKeys, dstKeys, args.explain);
          if (d.onlyInSource.length) console.log(`     only in SOURCE: ${d.onlyInSource.join(', ')}`);
          if (d.onlyInTarget.length) console.log(`     only in TARGET: ${d.onlyInTarget.join(', ')}`);
          if (!d.onlyInSource.length && !d.onlyInTarget.length) {
            console.log(`     same keys on both sides — a column VALUE differs (digest mismatch)`);
          }
        } catch (e) {
          console.log(`     explain failed: ${e.message}`);
        }
      }
    }
  }

  // Integrity probes a digest cannot catch: the invariants the app's advisory
  // locks exist to protect. If the restore produced duplicates, they show here.
  console.log('');
  try {
    const { rows } = await dst.query(
      'SELECT board_id, COUNT(*)::int AS n, COUNT(DISTINCT card_number)::int AS uniq ' +
        'FROM cards GROUP BY board_id HAVING COUNT(*) <> COUNT(DISTINCT card_number) LIMIT 20'
    );
    if (rows.length) {
      allOk = false;
      console.log(`❌ cards: board(s) with duplicate card_number: ${JSON.stringify(rows)}`);
    } else {
      console.log('✅ cards: card_number unique per board on target');
    }
  } catch (e) {
    allOk = false;
    console.log('❌ card_number uniqueness check failed:', e.message);
  }

  try {
    const { rows } = await dst.query(
      'SELECT board_id, "column", position, COUNT(*)::int AS n FROM cards ' +
        'GROUP BY board_id, "column", position HAVING COUNT(*) > 1 LIMIT 20'
    );
    if (rows.length) {
      allOk = false;
      console.log(`❌ cards: duplicate (board, column, position): ${JSON.stringify(rows)}`);
    } else {
      console.log('✅ cards: (board, column, position) unique on target');
    }
  } catch (e) {
    allOk = false;
    console.log('❌ position uniqueness check failed:', e.message);
  }

  await src.end();
  await dst.end();

  console.log('');
  console.log(allOk ? 'RESULT: PARITY — safe to cut over.' : 'RESULT: MISMATCH — DO NOT CUT OVER.');
  process.exit(allOk ? 0 : 1);
})().catch((err) => {
  console.error('verifier crashed:', err);
  process.exit(3);
});
