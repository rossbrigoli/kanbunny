const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

// KB-PG-2: Postgres-backed test DB (reset by tests/setup-test-pg.sh)
const TEST_PG_URL = 'postgres://kanbunny:kanbunny@127.0.0.1:55432/kanbunny_test_api';

describe('API Endpoints', () => {
  let server;
  let base;

  before(async () => {
    process.env.DATABASE_URL = process.env.KANBUNNY_TEST_PG_URL || TEST_PG_URL;
    process.env.KANBUNNY_ALLOW_UNAUTH = '1'; // legacy pre-cutover behaviour

    // Clear require cache so modules pick up the test DATABASE_URL
    delete require.cache[require.resolve('../src/db')];
    delete require.cache[require.resolve('../src/server')];

    const db = require('../src/db');
    await db.ready();
    const testApp = require('../src/server');

    // Wait for the server to actually be listening
    await new Promise((resolve, reject) => {
      server = testApp.listen(0, '127.0.0.1', resolve);
      server.on('error', reject);
    });

    const addr = server.address();
    base = `http://localhost:${addr.port}/api/`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    const db = require('../src/db');
    await db.closePool();
  });

  function req(method, relPath, body) {
    return new Promise((resolve, reject) => {
      // Strip leading slash so new URL treats it as relative to base, not origin-relative
      const path = relPath.startsWith('/') ? relPath.slice(1) : relPath;
      const url = new URL(path, base);
      let requestBody = undefined;
      if (body) requestBody = JSON.stringify(body);
      const opts = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: { 'Content-Type': 'application/json' },
      };
      if (requestBody) opts.headers['Content-Length'] = Buffer.byteLength(requestBody);
      const client = http.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            if (data.trim()) json = JSON.parse(data);
          } catch {
            /* 204 or empty */
          }
          resolve({ status: res.statusCode, body: json });
        });
      });
      client.on('error', reject);
      if (requestBody) client.write(requestBody);
      client.end();
    });
  }

  it('GET /boards returns default board', async () => {
    const { status, body } = await req('GET', 'boards');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
    assert.ok(body.length >= 1);
    const defaultBoard = body.find((b) => b.id === 'default');
    assert.ok(defaultBoard, 'Default board exists');
    assert.strictEqual(defaultBoard.name, 'My Board');
  });

  it('POST /boards creates a new board', async () => {
    const { status, body } = await req('POST', 'boards', { name: 'Project Alpha' });
    assert.strictEqual(status, 201);
    assert.strictEqual(body.name, 'Project Alpha');
    assert.ok(body.id);
  });

  it('POST /boards rejects empty name', async () => {
    const { status, body } = await req('POST', 'boards', { name: '' });
    assert.strictEqual(status, 400);
    assert.ok(body.error);
  });

  it('PUT /boards/:id renames a board', async () => {
    const { body: created } = await req('POST', '/boards', { name: 'Old Name' });
    const { status, body: updated } = await req('PUT', `boards/${created.id}`, {
      name: 'New Name',
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(updated.name, 'New Name');
  });

  it('DELETE /boards/:id removes a board', async () => {
    const { body: created } = await req('POST', '/boards', { name: 'To Delete' });
    const { status } = await req('DELETE', `boards/${created.id}`);
    assert.strictEqual(status, 204);
    const { status: after } = await req('GET', `boards/${created.id}`);
    assert.strictEqual(after, 404);
  });

  it('POST /boards/:id/cards creates a card', async () => {
    const { body: board } = await req('GET', '/boards');
    const boardId = board[0].id;

    const { status, body: card } = await req('POST', `boards/${boardId}/cards`, {
      title: 'Setup CI/CD',
      description: 'Get GitHub Actions running',
    });
    assert.strictEqual(status, 201);
    assert.strictEqual(card.title, 'Setup CI/CD');
    assert.strictEqual(card.column, 'todo');
    assert.strictEqual(card.board_id, boardId);
  });

  it('POST /boards/:id/cards creates a card with assignee', async () => {
    const { body: board } = await req('GET', '/boards');
    const { status, body: card } = await req('POST', `boards/${board[0].id}/cards`, {
      title: 'Assigned task',
      assignee: 'Ross',
    });
    assert.strictEqual(status, 201);
    assert.strictEqual(card.assignee, 'Ross');
  });

  it('PATCH /cards/:id updates assignee', async () => {
    const { body: card } = await req('POST', 'boards/default/cards', {
      title: 'Assignee test',
      assignee: 'Alice',
    });
    const { status, body: updated } = await req('PATCH', `cards/${card.id}`, {
      assignee: 'Bob',
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(updated.assignee, 'Bob');
  });

  it('PATCH /cards/:id updates a card column', async () => {
    const { body: board } = await req('GET', '/boards');
    const { body: cardList } = await req('GET', `boards/${board[0].id}/cards`);
    const card = cardList.find((c) => c.column === 'todo');
    assert.ok(card, 'Should have a todo card');

    const { status, body: updated } = await req('PATCH', `cards/${card.id}`, {
      column: 'in-progress',
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(updated.column, 'in-progress');
  });

  it('PATCH /cards/:id rejects invalid column', async () => {
    const { body: board } = await req('GET', '/boards');
    const { body: cardList } = await req('GET', `boards/${board[0].id}/cards`);
    const card = cardList[0];

    const { status, body } = await req('PATCH', `cards/${card.id}`, {
      column: 'invalid-col',
    });
    assert.strictEqual(status, 400);
  });

  it('DELETE /cards/:id removes a card', async () => {
    const { body: board } = await req('GET', '/boards');
    const { body: cardList } = await req('GET', `boards/${board[0].id}/cards`);
    const card = cardList[cardList.length - 1];

    const { status } = await req('DELETE', `cards/${card.id}`);
    assert.strictEqual(status, 204);

    const { body: after } = await req('GET', `cards/${card.id}`);
    assert.strictEqual(after.error, 'Card not found');
  });

  it('GET /boards/:id/cards returns cards grouped', async () => {
    const { body: board } = await req('GET', '/boards');
    const { status, body } = await req('GET', `boards/${board[0].id}/cards`);
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
  });

  it('GET /boards/:id returns 404 for missing board', async () => {
    const { status, body } = await req('GET', 'boards/nonexistent');
    assert.strictEqual(status, 404);
  });

  // --- Column/Status Filter Tests ---

  it('GET /boards/:id/cards?column=todo filters by column', async () => {
    const { body: board } = await req('GET', '/boards');
    const boardId = board[0].id;

    // Ensure we have cards in multiple columns
    await req('POST', `boards/${boardId}/cards`, { title: 'Filter todo', column: 'todo' });
    await req('POST', `boards/${boardId}/cards`, { title: 'Filter done', column: 'done' });

    const { status, body } = await req('GET', `boards/${boardId}/cards?column=todo`);
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
    for (const card of body) {
      assert.strictEqual(card.column, 'todo', `Card ${card.title} should be in todo`);
    }
    assert.ok(body.length > 0, 'Should have at least one todo card');
  });

  it('GET /boards/:id/cards?status=in-progress filters by status alias', async () => {
    const { body: board } = await req('GET', '/boards');
    const boardId = board[0].id;

    await req('POST', `boards/${boardId}/cards`, { title: 'Filter in-progress', column: 'in-progress' });

    const { status, body } = await req('GET', `boards/${boardId}/cards?status=in-progress`);
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
    for (const card of body) {
      assert.strictEqual(card.column, 'in-progress', `Card ${card.title} should be in in-progress`);
    }
    assert.ok(body.length > 0, 'Should have at least one in-progress card');
  });

  it('GET /boards/:id/cards?column=invalid returns 400', async () => {
    const { status, body } = await req('GET', 'boards/default/cards?column=invalid');
    assert.strictEqual(status, 400);
    assert.ok(body.error);
    assert.ok(body.error.includes('Invalid column'));
  });

  it('GET /boards/:id/cards?status=invalid returns 400', async () => {
    const { status, body } = await req('GET', 'boards/default/cards?status=invalid');
    assert.strictEqual(status, 400);
    assert.ok(body.error);
  });

  it('column query param takes precedence over status when both present', async () => {
    const { body: board } = await req('GET', '/boards');
    const boardId = board[0].id;

    const { status, body } = await req('GET', `boards/${boardId}/cards?column=done&status=todo`);
    assert.strictEqual(status, 200);
    for (const card of body) {
      assert.strictEqual(card.column, 'done', `Card ${card.title} should be in done (column takes precedence)`);
    }
  });
});
