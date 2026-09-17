const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

// KB-PG-2: Postgres-backed test DB (reset by tests/setup-test-pg.sh)
const TEST_PG_URL = 'postgres://kanbunny:kanbunny@127.0.0.1:55432/kanbunny_test_cardref';

describe('Card human IDs (ref "X-N")', () => {
  let server;
  let base;
  let boardId;

  before(async () => {
    process.env.DATABASE_URL = process.env.KANBUNNY_TEST_PG_URL || TEST_PG_URL;
    process.env.KANBUNNY_ALLOW_UNAUTH = '1'; // legacy pre-cutover behaviour
    delete require.cache[require.resolve('../src/db')];
    delete require.cache[require.resolve('../src/server')];
    const db = require('../src/db');
    await db.ready();
    const testApp = require('../src/server');
    await new Promise((resolve, reject) => {
      server = testApp.listen(0, '127.0.0.1', resolve);
      server.on('error', reject);
    });
    base = `http://localhost:${server.address().port}/api/`;
    const { body: board } = await req('POST', 'boards', { name: 'Zeta Work' });
    boardId = board.id;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    const db = require('../src/db');
    await db.closePool();
  });

  function req(method, relPath, body) {
    return new Promise((resolve, reject) => {
      const p = relPath.startsWith('/') ? relPath.slice(1) : relPath;
      const url = new URL(p, base);
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

  it('assigns sequential refs from the board name prefix', async () => {
    const { status, body: first } = await req('POST', `boards/${boardId}/cards`, { title: 'One' });
    assert.strictEqual(status, 201);
    assert.strictEqual(first.card_number, 1);
    assert.strictEqual(first.ref, 'Z-1');

    const { body: second } = await req('POST', `boards/${boardId}/cards`, { title: 'Two', column: 'in-progress' });
    assert.strictEqual(second.card_number, 2);
    assert.strictEqual(second.ref, 'Z-2');
  });

  it('keeps the ref stable across updates and column moves', async () => {
    const { body: card } = await req('POST', `boards/${boardId}/cards`, { title: 'Stable' });
    const ref = card.ref;
    assert.strictEqual(ref, 'Z-3');

    const { body: patched } = await req('PATCH', `cards/${card.id}`, { title: 'Renamed', column: 'done' });
    assert.strictEqual(patched.ref, ref);
    assert.strictEqual(patched.card_number, card.card_number);
  });

  it('ignores client-supplied card_number on create and patch (immutable)', async () => {
    const { body: created } = await req('POST', `boards/${boardId}/cards`, {
      title: 'Hijack',
      card_number: 99,
    });
    assert.notStrictEqual(created.card_number, 99);

    const { body: patched } = await req('PATCH', `cards/${created.id}`, { card_number: 42 });
    assert.strictEqual(patched.card_number, created.card_number);
  });

  it('numbers new cards as max existing + 1 after deletion', async () => {
    const { body: a } = await req('POST', `boards/${boardId}/cards`, { title: 'Keep' });
    const { body: b } = await req('POST', `boards/${boardId}/cards`, { title: 'Drop' });
    assert.strictEqual(b.card_number, a.card_number + 1);

    await req('DELETE', `cards/${b.id}`);
    const { body: c } = await req('POST', `boards/${boardId}/cards`, { title: 'Next' });
    assert.strictEqual(c.card_number, b.card_number);
  });

  it('exposes ref on list and single-card endpoints', async () => {
    const { body: list } = await req('GET', `boards/${boardId}/cards`);
    assert.ok(list.length > 0);
    assert.ok(list.every((card) => /^Z-\d+$/.test(card.ref)), 'every card has a Z-N ref');

    const { body: one } = await req('GET', `cards/${list[0].id}`);
    assert.match(one.ref, /^Z-\d+$/);
  });

  it('follows board renames for the prefix while keeping the number', async () => {
    const { body: board } = await req('POST', 'boards', { name: 'Alpha' });
    const { body: card } = await req('POST', `boards/${board.id}/cards`, { title: 'Renamed board' });
    assert.strictEqual(card.ref, 'A-1');

    await req('PUT', `boards/${board.id}`, { name: 'Beta' });
    const { body: reread } = await req('GET', `cards/${card.id}`);
    assert.strictEqual(reread.ref, 'B-1');
    assert.strictEqual(reread.card_number, 1);
  });
});
