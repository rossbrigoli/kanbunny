// K-28: card comments + description immutability for token-authenticated agents.
// Pattern follows tests/auth-enforcement.test.js (fake OIDC + session login),
// plus a real bearer token created through the admin API.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const TEST_PG_URL = 'postgres://kanbunny:kanbunny@127.0.0.1:55432/kanbunny_test_comments';
let port;

function req(method, urlPath, { body, cookies = '', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(cookies ? { Cookie: cookies } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function cookieOf(res, name) {
  const sc = res.headers['set-cookie'] || [];
  const hit = sc.find((c) => c.startsWith(name + '='));
  return hit ? hit.split(';')[0] : null;
}

let nextClaims = { sub: 'sub-ross', preferred_username: 'rossbrigoli' };
const fakeClient = {
  authorizationUrl: (p) => 'https://dex.example/auth?' + new URLSearchParams(p).toString(),
  callbackParams: (request) => {
    const u = new URL('http://x/' + String(request.url || '').replace(/^\//, ''));
    const out = {};
    for (const [k, v] of u.searchParams) out[k] = v;
    return out;
  },
  callback: async (redirectUri, params, checks) => {
    if (params.state !== checks.state) throw new Error('state_mismatch');
    return { claims: () => nextClaims };
  },
};

async function loginAs(claims) {
  nextClaims = claims;
  const loginRes = await req('GET', '/auth/login');
  const oauth = cookieOf(loginRes, 'kb_oauth');
  const loc = new URL(loginRes.headers.location);
  const state = loc.searchParams.get('state');
  const cb = await req('GET', `/auth/callback?code=***&state=${state}`, { cookies: oauth });
  const session = cookieOf(cb, 'kb_session');
  const csrf = cookieOf(cb, 'kb_csrf');
  return { session, csrf, csrfValue: csrf.split('=').slice(1).join('=') };
}

describe('Card comments + description immutability (K-28)', () => {
  let server;
  let ross;
  let bearer; // "agent" token (via=token)
  let board;
  let card;

  before(async () => {
    process.env.DATABASE_URL = process.env.KANBUNNY_TEST_PG_URL_COMMENTS || TEST_PG_URL;
    process.env.KANBUNNY_SESSION_SECRET = 'test-session-secret-0123456789abcdef';
    process.env.KANBUNNY_OIDC_CLIENT_SECRET = 'test-client-secret';
    process.env.KANBUNNY_BOOTSTRAP_ADMINS = 'rossbrigoli';
    delete process.env.KANBUNNY_ALLOW_UNAUTH;
    delete require.cache[require.resolve('../src/db')];
    delete require.cache[require.resolve('../src/server')];
    const db = require('../src/db');
    await db.ready();
    const auth = require('../src/auth');
    auth.setClientForTesting(fakeClient);
    const testApp = require('../src/server');
    await new Promise((resolve, reject) => {
      server = testApp.listen(0, '127.0.0.1', resolve);
      server.on('error', reject);
    });
    port = server.address().port;

    ross = await loginAs({ sub: 'sub-ross', preferred_username: 'rossbrigoli' });
    const rossAuth = { cookies: ross.session + '; ' + ross.csrf, headers: { 'X-Kb-Csrf': ross.csrfValue } };

    board = (await req('POST', '/api/boards', { body: { name: 'K28 Board' }, ...rossAuth })).body;
    card = (await req('POST', `/api/boards/${board.id}/cards`, {
      body: { title: 'Task with comments', description: 'ORIGINAL TASK TEXT' },
      ...rossAuth,
    })).body;

    // Real bearer token via the admin API (this is the agent auth path).
    const tok = await req('POST', '/api/admin/tokens', { body: { name: 'k28-agent-token' }, ...rossAuth });
    assert.strictEqual(tok.status, 201);
    bearer = { Authorization: `Bearer ${tok.body.token}` };
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    const db = require('../src/db');
    await db.closePool();
  });

  // ---- comments CRUD ----

  it('agent can post a comment (201, author defaults to token login)', async () => {
    const res = await req('POST', `/api/cards/${card.id}/comments`, {
      body: { body: 'started work on the parser' },
      headers: bearer,
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.card_id, card.id);
    assert.strictEqual(res.body.author, 'rossbrigoli');
    assert.strictEqual(res.body.body, 'started work on the parser');
    assert.ok(res.body.created_at, 'created_at present');
  });

  it('explicit author override is honoured (agent name, not login)', async () => {
    const res = await req('POST', `/api/cards/${card.id}/comments`, {
      body: { body: 'blocked on API schema', author: 'JUAN' },
      headers: bearer,
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.author, 'JUAN');
  });

  it('GET comments returns them oldest-first', async () => {
    const res = await req('GET', `/api/cards/${card.id}/comments`, { headers: bearer });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.strictEqual(res.body.length, 2);
    assert.strictEqual(res.body[0].body, 'started work on the parser');
    assert.strictEqual(res.body[1].body, 'blocked on API schema');
  });

  it('empty comment body is rejected (400)', async () => {
    const res = await req('POST', `/api/cards/${card.id}/comments`, {
      body: { body: '   ' },
      headers: bearer,
    });
    assert.strictEqual(res.status, 400);
  });

  it('oversized comment is rejected (400)', async () => {
    const res = await req('POST', `/api/cards/${card.id}/comments`, {
      body: { body: 'x'.repeat(4001) },
      headers: bearer,
    });
    assert.strictEqual(res.status, 400);
  });

  it('comment on missing card is 404', async () => {
    const res = await req('POST', '/api/cards/no-such-card/comments', {
      body: { body: 'hello?' },
      headers: bearer,
    });
    assert.strictEqual(res.status, 404);
  });

  // ---- description immutability ----

  it('token PATCH with description is rejected 400 (immutable for agents)', async () => {
    const res = await req('PATCH', `/api/cards/${card.id}`, {
      body: { description: 'agent rewrote the task' },
      headers: bearer,
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'description_immutable_for_agents');
    assert.ok(res.body.hint.includes('/comments'), 'error points at the comments API');
  });

  it('token PATCH with description alongside column is rejected (no partial apply)', async () => {
    const res = await req('PATCH', `/api/cards/${card.id}`, {
      body: { column: 'in-review', description: 'sneaky' },
      headers: bearer,
    });
    assert.strictEqual(res.status, 400);
    const after = await req('GET', `/api/cards/${card.id}`, { headers: bearer });
    assert.strictEqual(after.body.column, 'todo', 'column untouched');
    assert.strictEqual(after.body.description, 'ORIGINAL TASK TEXT', 'description untouched');
  });

  it('token PATCH without description still works (column/assignee/title/priority)', async () => {
    const res = await req('PATCH', `/api/cards/${card.id}`, {
      body: { column: 'in-progress', assignee: 'BOTIOC', title: 'Task with comments', priority: 2 },
      headers: bearer,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.column, 'in-progress');
    assert.strictEqual(res.body.assignee, 'BOTIOC');
    assert.strictEqual(res.body.description, 'ORIGINAL TASK TEXT');
  });

  it('session (Ross) can still edit the description', async () => {
    const res = await req('PATCH', `/api/cards/${card.id}`, {
      body: { description: 'Ross clarified the task' },
      cookies: ross.session + '; ' + ross.csrf,
      headers: { 'X-Kb-Csrf': ross.csrfValue },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.description, 'Ross clarified the task');
  });

  it('card delete cascades comments; comments of deleted card 404', async () => {
    const del = await req('DELETE', `/api/cards/${card.id}`, { headers: bearer });
    assert.strictEqual(del.status, 204);
    const res = await req('GET', `/api/cards/${card.id}/comments`, { headers: bearer });
    assert.strictEqual(res.status, 404);
    const db = require('../src/db');
    const n = await db.countComments(card.id);
    assert.strictEqual(n, 0, 'no orphan comments');
  });
});
