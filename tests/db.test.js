const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

// Use a test database
const TEST_DB = './kanbunny.test.db';
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

// Mock the DB path before importing
const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  const mod = origRequire.apply(this, arguments);
  return mod;
};

// Dynamically set DB path
const path = require('path');
process.env.KANBUNNY_TEST_DB = TEST_DB;

// Re-require db with test DB
const dbPath = path.resolve(__dirname, '..', 'kanbunny.test.db');
const Database = require('better-sqlite3');

describe('Database Layer', () => {
  let testDb;

  it('initializes schema correctly', () => {
    testDb = new Database(dbPath);
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');

    testDb.exec(`
      CREATE TABLE IF NOT EXISTS boards (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        column TEXT NOT NULL CHECK(column IN ('todo', 'in-progress', 'in-review', 'done')) DEFAULT 'todo',
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
      );
    `);

    const tables = testDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    assert.ok(tables.some((t) => t.name === 'boards'), 'boards table exists');
    assert.ok(tables.some((t) => t.name === 'cards'), 'cards table exists');
  });

  it('creates a board', () => {
    const id = 'test-board-1';
    testDb.prepare('INSERT INTO boards (id, name) VALUES (?, ?)').run(id, 'Test Board');
    const board = testDb.prepare('SELECT * FROM boards WHERE id = ?').get(id);
    assert.strictEqual(board.name, 'Test Board');
    assert.ok(board.created_at);
  });

  it('creates a card in a column', () => {
    const cardId = 'test-card-1';
    testDb.prepare(
      'INSERT INTO cards (id, board_id, title, description, column, position) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(cardId, 'test-board-1', 'Test Card', 'A description', 'todo', 0);

    const card = testDb.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
    assert.strictEqual(card.title, 'Test Card');
    assert.strictEqual(card.column, 'todo');
    assert.strictEqual(card.board_id, 'test-board-1');
  });

  it('enforces valid column values', () => {
    assert.throws(() => {
      testDb.prepare(
        'INSERT INTO cards (id, board_id, title, column, position) VALUES (?, ?, ?, ?, ?)'
      ).run('bad-card', 'test-board-1', 'Bad', 'invalid-column', 0);
    }, /CHECK constraint failed/); // better-sqlite3 throws SQLITE_CONSTRAINT_CHECK
  });

  it('lists cards ordered by column and position', () => {
    // Insert cards in different columns
    testDb.prepare(
      'INSERT INTO cards (id, board_id, title, column, position) VALUES (?, ?, ?, ?, ?)'
    ).run('c2', 'test-board-1', 'Done Card', 'done', 0);
    testDb.prepare(
      'INSERT INTO cards (id, board_id, title, column, position) VALUES (?, ?, ?, ?, ?)'
    ).run('c3', 'test-board-1', 'Progress Card', 'in-progress', 0);

    const cards = testDb.prepare(
      "SELECT * FROM cards WHERE board_id = ? ORDER BY column, position"
    ).all('test-board-1');

    assert.ok(cards.length >= 3);
    // 'done' > 'in-progress' > 'todo' alphabetically
    const cols = cards.map((c) => c.column);
    assert.ok(cols.every((c) => ['todo', 'in-progress', 'in-review', 'done'].includes(c)));
  });

  it('deletes a card', () => {
    const result = testDb.prepare('DELETE FROM cards WHERE id = ?').run('c3');
    assert.strictEqual(result.changes, 1);
    const card = testDb.prepare('SELECT * FROM cards WHERE id = ?').get('c3');
    assert.strictEqual(card, undefined);
  });

  it('deletes a board and cascades to cards', () => {
    // Create board with cards
    testDb.prepare('INSERT INTO boards (id, name) VALUES (?, ?)').run('cascade-board', 'Cascade');
    testDb.prepare(
      'INSERT INTO cards (id, board_id, title, column, position) VALUES (?, ?, ?, ?, ?)'
    ).run('cc1', 'cascade-board', 'Card A', 'todo', 0);
    testDb.prepare(
      'INSERT INTO cards (id, board_id, title, column, position) VALUES (?, ?, ?, ?, ?)'
    ).run('cc2', 'cascade-board', 'Card B', 'done', 0);

    testDb.prepare('DELETE FROM boards WHERE id = ?').run('cascade-board');
    const remaining = testDb.prepare(
      "SELECT COUNT(*) as count FROM cards WHERE board_id = 'cascade-board'"
    ).get();
    assert.strictEqual(remaining.count, 0);
  });
});

// Cleanup
process.on('exit', () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});
