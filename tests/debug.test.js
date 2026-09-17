const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

// KB-PG-2: Postgres-backed test DB (reset by tests/setup-test-pg.sh)
const TEST_PG_URL = 'postgres://kanbunny:kanbunny@127.0.0.1:55432/kanbunny_test_debug';

describe('Debug', () => {
  let server, base;

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
      const url = new URL(relPath, base);
      let requestBody = undefined;
      if (body) requestBody = JSON.stringify(body);
      const opts = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { 'Content-Type': 'application/json' },
      };
      if (requestBody) opts.headers['Content-Length'] = Buffer.byteLength(requestBody);
      const client = http.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { if (data.trim()) json = JSON.parse(data); } catch {}
          resolve({ status: res.statusCode, body: json });
        });
      });
      client.on('error', reject);
      if (requestBody) client.write(requestBody);
      client.end();
    });
  }

  it('GET boards', async () => {
    const r = await req('GET', 'boards');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });

  it('POST board', async () => {
    const r = await req('POST', 'boards', { name: 'Test' });
    assert.strictEqual(r.status, 201);
    assert.ok(r.body.id);
  });

  it('PUT board', async () => {
    const c = await req('POST', 'boards', { name: 'Old' });
    assert.ok(c.body && c.body.id);
    const r = await req('PUT', `boards/${c.body.id}`, { name: 'New' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.name, 'New');
  });
});
