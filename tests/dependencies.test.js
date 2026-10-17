// S-275: card dependencies — cycle detection, cross-board deps, search,
// and the token claim guard (409 dependencies_unsatisfied).
// Pattern follows tests/comments.test.js (fake OIDC + session login + real
// bearer token via the admin API).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const TEST_PG_URL = 'postgres://kanbunny:kanbunny@127.0.0.1:55432/kanbunny_test_deps';
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

describe('Card dependencies + claim guard (S-275)', () => {
  let server;
  let ross;
  let rossAuth; // session cookies + CSRF header
  let bearer; // "agent" token (via=token)
  let boardA; // prefix "A"
  let boardB; // prefix "B"
  let a1, a2, a3, a4, a5, b1;

  before(async () => {
    process.env.DATABASE_URL = process.env.KANBUNNY_TEST_PG_URL_DEPS || TEST_PG_URL;
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
    rossAuth = {
      cookies: ross.session + '; ' + ross.csrf,
      headers: { 'X-Kb-Csrf': ross.csrfValue },
    };

    boardA = (await req('POST', '/api/boards', { body: { name: 'Alpha' }, ...rossAuth })).body;
    boardB = (await req('POST', '/api/boards', { body: { name: 'Beta' }, ...rossAuth })).body;
    const mk = async (board, title) =>
      (await req('POST', `/api/boards/${board.id}/cards`, { body: { title }, ...rossAuth })).body;
    a1 = await mk(boardA, 'Deploy API');
    a2 = await mk(boardA, 'Write docs');
    a3 = await mk(boardA, 'Add monitoring');
    a4 = await mk(boardA, 'Session-unblocked card');
    a5 = await mk(boardA, 'Prerequisite task');
    b1 = await mk(boardB, 'Cross-board prerequisite');

    const tok = await req('POST', '/api/admin/tokens', { body: { name: 's275-agent-token' }, ...rossAuth });
    assert.strictEqual(tok.status, 201);
    bearer = { Authorization: `Bearer ${tok.body.token}` };
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    const db = require('../src/db');
    await db.closePool();
  });

  // ---- creation + validation ----

  it('self-dependency is rejected (400 self_dependency)', async () => {
    const res = await req('POST', `/api/cards/${a1.id}/dependencies`, {
      body: { depends_on: a1.id },
      headers: bearer,
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'self_dependency');
  });

  it('unknown target is 404', async () => {
    const res = await req('POST', `/api/cards/${a1.id}/dependencies`, {
      body: { depends_on: 'no-such-card-id' },
      headers: bearer,
    });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error, 'target_not_found');
  });

  it('missing depends_on is 400', async () => {
    const res = await req('POST', `/api/cards/${a1.id}/dependencies`, {
      body: {},
      headers: bearer,
    });
    assert.strictEqual(res.status, 400);
  });

  it('a1 -> a2 dependency is created (201)', async () => {
    const res = await req('POST', `/api/cards/${a1.id}/dependencies`, {
      body: { depends_on: a2.id },
      headers: bearer,
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.card_id, a1.id);
    assert.strictEqual(res.body.depends_on, a2.id);
  });

  it('duplicate dependency is rejected (409 duplicate_dependency)', async () => {
    const res = await req('POST', `/api/cards/${a1.id}/dependencies`, {
      body: { depends_on: a2.id },
      headers: bearer,
    });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.error, 'duplicate_dependency');
  });

  it('direct cycle a2 -> a1 is rejected (400 cycle_detected)', async () => {
    const res = await req('POST', `/api/cards/${a2.id}/dependencies`, {
      body: { depends_on: a1.id },
      headers: bearer,
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'cycle_detected');
    assert.ok(Array.isArray(res.body.path), 'error carries the cycle path');
    assert.deepStrictEqual(res.body.path, [a2.id, a1.id, a2.id]);
  });

  it('transitive cycle a3 -> a1 is rejected (a1->a2->a3 chain)', async () => {
    const mid = await req('POST', `/api/cards/${a2.id}/dependencies`, {
      body: { depends_on: a3.id },
      headers: bearer,
    });
    assert.strictEqual(mid.status, 201);
    const res = await req('POST', `/api/cards/${a3.id}/dependencies`, {
      body: { depends_on: a1.id },
      headers: bearer,
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'cycle_detected');
    assert.deepStrictEqual(res.body.path, [a3.id, a1.id, a2.id, a3.id]);
  });

  it('cross-board dependency a1 -> b1 is allowed', async () => {
    const res = await req('POST', `/api/cards/${a1.id}/dependencies`, {
      body: { depends_on: b1.id },
      headers: bearer,
    });
    assert.strictEqual(res.status, 201);
  });

  it('dependency by human ref (lowercase "b-1") resolves to b1', async () => {
    // a4 depends on b1 via ref string, exercising ref resolution + case-insensitivity
    const res = await req('POST', `/api/cards/${a4.id}/dependencies`, {
      body: { depends_on: `b-${b1.card_number}` },
      headers: bearer,
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.depends_on, b1.id);
  });

  // ---- GET both directions ----

  it('GET dependencies returns both directions with ref/title/column', async () => {
    const res = await req('GET', `/api/cards/${a1.id}/dependencies`, { headers: bearer });
    assert.strictEqual(res.status, 200);
    const on = res.body.depends_on;
    const ids = on.map((d) => d.id);
    assert.ok(ids.includes(a2.id), 'depends_on includes a2');
    assert.ok(ids.includes(b1.id), 'depends_on includes cross-board b1');
    const a2row = on.find((d) => d.id === a2.id);
    assert.strictEqual(a2row.title, 'Write docs');
    assert.strictEqual(a2row.column, 'todo');
    assert.strictEqual(a2row.ref, `A-${a2.card_number}`);
    assert.strictEqual(a2row.board_id, boardA.id);
    assert.ok(a2row.dependency_id, 'dependency row id present');

    // dependents: a2 is depended on by a1; a3 is depended on by a2
    const res2 = await req('GET', `/api/cards/${a2.id}/dependencies`, { headers: bearer });
    const depIds = res2.body.dependents.map((d) => d.id);
    assert.ok(depIds.includes(a1.id), 'dependents of a2 include a1');
    const res3 = await req('GET', `/api/cards/${a3.id}/dependencies`, { headers: bearer });
    assert.deepStrictEqual(res3.body.dependents.map((d) => d.id), [a2.id]);
  });

  it('GET dependencies on missing card is 404', async () => {
    const res = await req('GET', '/api/cards/no-such-card/dependencies', { headers: bearer });
    assert.strictEqual(res.status, 404);
  });

  // ---- search ----

  it('search by ref (case-insensitive) finds the card', async () => {
    const ref = `a-${a1.card_number}`;
    const res = await req('GET', `/api/cards/search?q=${ref}`, { headers: bearer });
    assert.strictEqual(res.status, 200);
    const hit = res.body.find((c) => c.id === a1.id);
    assert.ok(hit, 'found by lowercase ref');
    assert.strictEqual(hit.ref, `A-${a1.card_number}`);
    assert.strictEqual(hit.title, 'Deploy API');
    for (const k of ['id', 'ref', 'title', 'column', 'board_id']) {
      assert.ok(k in hit, `search result has ${k}`);
    }
  });

  it('search by title substring finds matching cards', async () => {
    const res = await req('GET', '/api/cards/search?q=cross-board', { headers: bearer });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.some((c) => c.id === b1.id));
  });

  it('search with board_id filter excludes other boards', async () => {
    const res = await req('GET', `/api/cards/search?q=prerequisite&board_id=${boardA.id}`, {
      headers: bearer,
    });
    assert.strictEqual(res.status, 200);
    assert.ok(!res.body.some((c) => c.id === b1.id), 'b1 excluded by board filter');
  });

  it('search without q is 400', async () => {
    const res = await req('GET', '/api/cards/search', { headers: bearer });
    assert.strictEqual(res.status, 400);
  });

  // ---- claim guard (token PATCH to in-progress) ----

  it('token PATCH to in-progress is blocked 409 with blocked list (deps in todo)', async () => {
    const res = await req('PATCH', `/api/cards/${a1.id}`, {
      body: { column: 'in-progress' },
      headers: bearer,
    });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.error, 'dependencies_unsatisfied');
    const blockedIds = res.body.blocked.map((b) => b.id);
    assert.ok(blockedIds.includes(a2.id), 'a2 (todo) in blocked list');
    assert.ok(blockedIds.includes(b1.id), 'b1 (todo) in blocked list');
    const blockedA2 = res.body.blocked.find((b) => b.id === a2.id);
    assert.strictEqual(blockedA2.ref, `A-${a2.card_number}`);
    assert.strictEqual(blockedA2.column, 'todo');
    // nothing applied
    const after = await req('GET', `/api/cards/${a1.id}`, { headers: bearer });
    assert.strictEqual(after.body.column, 'todo', 'card stayed in todo');
  });

  it('token PATCH to other columns is NOT blocked by deps', async () => {
    const res = await req('PATCH', `/api/cards/${a1.id}`, {
      body: { column: 'blocked' },
      headers: bearer,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.column, 'blocked');
  });

  it('token PATCH to in-progress allowed once all deps are done', async () => {
    for (const dep of [a2, b1]) {
      const d = await req('PATCH', `/api/cards/${dep.id}`, {
        body: { column: 'done' },
        ...rossAuth,
      });
      assert.strictEqual(d.status, 200);
    }
    const res = await req('PATCH', `/api/cards/${a1.id}`, {
      body: { column: 'in-progress' },
      headers: bearer,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.column, 'in-progress');
  });

  it('session (Ross) PATCH to in-progress is NOT blocked even with unsatisfied deps', async () => {
    // a4 depends on a5 (still todo) — session must sail through.
    const link = await req('POST', `/api/cards/${a4.id}/dependencies`, {
      body: { depends_on: a5.id },
      ...rossAuth,
    });
    assert.strictEqual(link.status, 201);
    const res = await req('PATCH', `/api/cards/${a4.id}`, {
      body: { column: 'in-progress' },
      ...rossAuth,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.column, 'in-progress');
  });

  // ---- listing payload ----

  it('board listing carries dependencies_pending count per card', async () => {
    const res = await req('GET', `/api/boards/${boardA.id}/cards`, { headers: bearer });
    assert.strictEqual(res.status, 200);
    const byId = Object.fromEntries(res.body.map((c) => [c.id, c]));
    assert.strictEqual(byId[a1.id].dependencies_pending, 0, 'a1 deps are all done now');
    assert.strictEqual(byId[a4.id].dependencies_pending, 1, 'a4 waits on a5 (todo)');
    assert.strictEqual(byId[a3.id].dependencies_pending, 0, 'a3 has no deps');
  });

  // ---- removal + cascade ----

  it('DELETE removes a single dependency (204, then 404 on repeat)', async () => {
    const del = await req('DELETE', `/api/cards/${a4.id}/dependencies/${a5.id}`, {
      headers: bearer,
    });
    assert.strictEqual(del.status, 204);
    const again = await req('DELETE', `/api/cards/${a4.id}/dependencies/${a5.id}`, {
      headers: bearer,
    });
    assert.strictEqual(again.status, 404);
  });

  it('card delete cascades dependency rows in both directions', async () => {
    const del = await req('DELETE', `/api/cards/${a2.id}`, { headers: bearer });
    assert.strictEqual(del.status, 204);
    const a1deps = await req('GET', `/api/cards/${a1.id}/dependencies`, { headers: bearer });
    assert.ok(!a1deps.body.depends_on.some((d) => d.id === a2.id), 'a1 no longer depends on a2');
    const db = require('../src/db');
    const { rows } = await db.query(
      "SELECT COUNT(*)::int AS n FROM card_dependencies WHERE card_id = $1 OR depends_on_card_id = $2",
      [a2.id, a2.id]
    );
    assert.strictEqual(rows[0].n, 0, 'no orphan dependency rows');
  });
});
