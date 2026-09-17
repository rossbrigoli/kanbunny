const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

// KB-PG-2: Postgres-backed test DB (reset by tests/setup-test-pg.sh).
// Previously this file exercised raw better-sqlite3 schema; it now exercises
// the real data layer against a REAL Postgres instance (no mocking).
const TEST_PG_URL = 'postgres://kanbunny:kanbunny@127.0.0.1:55432/kanbunny_test_layer';

describe('Database Layer (Postgres)', () => {
  let db;

  before(async () => {
    process.env.DATABASE_URL = process.env.KANBUNNY_TEST_PG_URL || TEST_PG_URL;
    delete require.cache[require.resolve('../src/db')];
    db = require('../src/db');
    await db.ready();
  });

  after(async () => {
    await db.closePool();
  });

  it('initializes schema correctly (versioned migrations applied)', async () => {
    const { rows } = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    const names = rows.map((r) => r.table_name);
    for (const t of ['schema_migrations', 'boards', 'cards', 'users', 'board_members', 'api_tokens']) {
      assert.ok(names.includes(t), `${t} table exists`);
    }
    const applied = await db.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.ok(applied.rows.length >= 2, 'migrations recorded in schema_migrations');
  });

  it('timestamps are timestamptz columns', async () => {
    const { rows } = await db.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'boards'"
    );
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
    assert.strictEqual(byName.created_at, 'timestamp with time zone');
    assert.strictEqual(byName.updated_at, 'timestamp with time zone');
  });

  it('creates a board', async () => {
    const board = await db.createBoard('Test Board');
    assert.strictEqual(board.name, 'Test Board');
    assert.ok(board.created_at);
    assert.match(board.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'SQLite wire format preserved');
  });

  it('creates a card in a column', async () => {
    const board = await db.createBoard('Card Board');
    const card = await db.createCard(board.id, 'Test Card', 'A description', 'todo');
    assert.strictEqual(card.title, 'Test Card');
    assert.strictEqual(card.column, 'todo');
    assert.strictEqual(card.board_id, board.id);
  });

  it('serializes concurrent card creation per board for unique card_number and position', async () => {
    const board = await db.createBoard('Concurrent Board');
    const cards = await Promise.all(
      Array.from({ length: 8 }, (_, i) => db.createCard(board.id, `Concurrent ${i + 1}`, '', 'todo'))
    );
    const numbers = cards.map((c) => c.card_number).sort((a, b) => a - b);
    const positions = cards.map((c) => c.position).sort((a, b) => a - b);
    assert.deepStrictEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepStrictEqual(positions, [0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('enforces valid column values', async () => {
    const board = await db.createBoard('Constraint Board');
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO cards (id, board_id, title, "column", position) VALUES ($1, $2, $3, $4, $5)`,
          ['bad-card', board.id, 'Bad', 'invalid-column', 0]
        ),
      /check constraint/i
    );
  });

  it('lists cards ordered by column and position', async () => {
    const board = await db.createBoard('Order Board');
    await db.createCard(board.id, 'Todo Card', '', 'todo');
    await db.createCard(board.id, 'Done Card', '', 'done');
    await db.createCard(board.id, 'Progress Card', '', 'in-progress');

    const cards = await db.listCards(board.id);
    assert.ok(cards.length >= 3);
    const cols = cards.map((c) => c.column);
    const sorted = [...cols].sort();
    assert.deepStrictEqual(cols, sorted, 'ORDER BY column,position holds');
  });

  it('reorder moves a card and re-normalizes positions', async () => {
    const board = await db.createBoard('Reorder Board');
    const a = await db.createCard(board.id, 'A', '', 'todo');
    const b = await db.createCard(board.id, 'B', '', 'todo');
    const c = await db.createCard(board.id, 'C', '', 'todo');
    assert.deepStrictEqual([a.position, b.position, c.position], [0, 1, 2]);

    // Move C after A → order A, C, B with positions 0,1,2
    const moved = await db.reorderCard(c.id, a.id);
    assert.strictEqual(moved, true);
    const cards = await db.listCards(board.id, { column: 'todo' });
    assert.deepStrictEqual(cards.map((x) => x.title), ['A', 'C', 'B']);
    assert.deepStrictEqual(cards.map((x) => x.position), [0, 1, 2]);
    assert.deepStrictEqual(cards.map((x) => x.priority), [1, 2, 3], 'priority recomputed after reorder');
  });

  it('cross-column move appends at end and recomputes priority', async () => {
    const board = await db.createBoard('CrossCol Board');
    const a = await db.createCard(board.id, 'A', '', 'todo');
    const d1 = await db.createCard(board.id, 'D1', '', 'done');
    const d2 = await db.createCard(board.id, 'D2', '', 'done');

    const updated = await db.updateCard(a.id, { column: 'done' });
    assert.strictEqual(updated.column, 'done');
    assert.strictEqual(updated.position, d2.position + 1, 'appended after last card in target column');

    const done = await db.listCards(board.id, { column: 'done' });
    assert.deepStrictEqual(done.map((c) => c.title), ['D1', 'D2', 'A']);
    assert.deepStrictEqual(done.map((c) => c.priority), [1, 2, 3]);
  });

  it('deletes a card', async () => {
    const board = await db.createBoard('Delete Board');
    const card = await db.createCard(board.id, 'Zap', '', 'todo');
    assert.strictEqual(await db.deleteCard(card.id), true);
    assert.strictEqual(await db.getCard(card.id), undefined);
    assert.strictEqual(await db.deleteCard('missing-id'), false);
  });

  it('deletes a board and cascades to cards', async () => {
    const board = await db.createBoard('Cascade Board');
    await db.createCard(board.id, 'Card A', '', 'todo');
    await db.createCard(board.id, 'Card B', '', 'done');
    assert.strictEqual(await db.deleteBoard(board.id), true);
    const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM cards WHERE board_id = $1', [board.id]);
    assert.strictEqual(rows[0].count, 0);
  });
});
