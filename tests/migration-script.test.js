const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

const execFileAsync = promisify(execFile);
const TEST_PG_URL = 'postgres://kanbunny:kanbunny@127.0.0.1:55432/kanbunny_test_migration';

describe('SQLite to Postgres migration script (KB-PG-3)', () => {
  let dir;
  let sqlitePath;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanbunny-migrate-'));
    sqlitePath = path.join(dir, 'kanbunny.db');
    const sqlite = new Database(sqlitePath);
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE boards (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE cards (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        assignee TEXT DEFAULT '',
        "column" TEXT NOT NULL CHECK("column" IN ('todo','in-progress','blocked','in-review','done')) DEFAULT 'todo',
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT,
        updated_at TEXT,
        priority INTEGER,
        card_number INTEGER,
        UNIQUE(board_id, card_number)
      );
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        login TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user','agent')),
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE board_members (
        board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        granted_by TEXT REFERENCES users(id),
        created_at TEXT,
        PRIMARY KEY(board_id, user_id)
      );
      CREATE TABLE api_tokens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        last_used_at TEXT,
        created_at TEXT
      );
    `);
    sqlite.prepare('INSERT INTO users (id, login, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      'agent:sherlock',
      'agent:sherlock',
      'agent',
      '2026-09-17 10:00:00',
      '2026-09-17 10:01:00'
    );
    sqlite.prepare('INSERT INTO boards (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
      'default',
      'My Board',
      '2026-09-17 10:02:00',
      '2026-09-17 10:03:00'
    );
    sqlite.prepare('INSERT INTO cards (id, board_id, title, description, assignee, "column", position, created_at, updated_at, priority, card_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'card-1',
      'default',
      'Migrated card',
      'keep me',
      'Sherlock',
      'blocked',
      7,
      '2026-09-17 10:04:00',
      '2026-09-17 10:05:00',
      3,
      42
    );
    sqlite.prepare('INSERT INTO board_members (board_id, user_id, granted_by, created_at) VALUES (?, ?, ?, ?)').run(
      'default',
      'agent:sherlock',
      null,
      '2026-09-17 10:06:00'
    );
    sqlite.prepare('INSERT INTO api_tokens (id, name, token_hash, owner_id, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      'token-1',
      'sherlock-curl',
      'sha256-token-hash-preserved',
      'agent:sherlock',
      '2026-09-17 10:07:00',
      '2026-09-17 10:08:00'
    );
    sqlite.close();
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('imports FK-safe rows idempotently and preserves token/card identity fields', async () => {
    for (let i = 0; i < 2; i++) {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['ops/migrate-sqlite-to-postgres.js', '--sqlite', sqlitePath],
        {
          cwd: path.resolve(__dirname, '..'),
          env: { ...process.env, DATABASE_URL: TEST_PG_URL },
        }
      );
      const report = JSON.parse(stdout);
      assert.strictEqual(report.ok, true);
      assert.strictEqual(report.counts.sqlite.cards, 1);
      assert.strictEqual(report.counts.postgres.cards, 1);
      assert.deepStrictEqual(report.checksums.postgres.cards, report.checksums.sqlite.cards);
      assert.deepStrictEqual(report.checksums.postgres.api_tokens, report.checksums.sqlite.api_tokens);
    }

    const pool = new Pool({ connectionString: TEST_PG_URL });
    try {
      const { rows: cards } = await pool.query('SELECT id, card_number, "column", position, priority FROM cards');
      assert.deepStrictEqual(cards, [{
        id: 'card-1',
        card_number: 42,
        column: 'blocked',
        position: 7,
        priority: 3,
      }]);
      const { rows: tokens } = await pool.query('SELECT token_hash FROM api_tokens');
      assert.strictEqual(tokens[0].token_hash, 'sha256-token-hash-preserved');
    } finally {
      await pool.end();
    }
  });
});
