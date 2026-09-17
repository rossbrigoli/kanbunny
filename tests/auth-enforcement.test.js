const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// KB-PG-2: Postgres-backed test DB (reset by tests/setup-test-pg.sh)
const TEST_PG_URL = 'postgres://kanbunny:kanbunny@127.0.0.1:55432/kanbunny_test_authz';
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

// Fake OIDC client — exercises our RP wiring without a live Dex.
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

// Full login: returns { session, csrf } cookie strings for the given identity.
async function loginAs(claims) {
  nextClaims = claims;
  const loginRes = await req('GET', '/auth/login');
  assert.strictEqual(loginRes.status, 302, 'login redirects');
  const oauth = cookieOf(loginRes, 'kb_oauth');
  assert.ok(oauth, 'oauth state cookie set');
  const loc = new URL(loginRes.headers.location);
  assert.strictEqual(loc.origin, 'https://dex.example', 'redirects to issuer');
  const state = loc.searchParams.get('state');
  const cb = await req('GET', `/auth/callback?code=***&state=${state}`, { cookies: oauth });
  assert.strictEqual(cb.status, 302, 'callback redirects home');
  const session = cookieOf(cb, 'kb_session');
  const csrf = cookieOf(cb, 'kb_csrf');
  assert.ok(session && csrf, 'session + csrf cookies issued');
  return { session, csrf, csrfValue: csrf.split('=').slice(1).join('=') };
}

describe('Auth enforcement (KB-AUTH-2/3/4)', () => {
  let server;
  let ross; // { session, csrf }
  let bob;
  let grantedBoard;
  let hiddenBoard;
  let hiddenCard;

  before(async () => {
    process.env.DATABASE_URL = process.env.KANBUNNY_TEST_PG_URL || TEST_PG_URL;
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
    bob = await loginAs({ sub: 'sub-bob', preferred_username: 'bob' });

    // Admin fixtures
    grantedBoard = (await req('POST', '/api/boards', { body: { name: 'Granted Board' }, cookies: ross.session + '; ' + ross.csrf, headers: { 'X-Kb-Csrf': ross.csrfValue } })).body;
    hiddenBoard = (await req('POST', '/api/boards', { body: { name: 'Hidden Board' }, cookies: ross.session + '; ' + ross.csrf, headers: { 'X-Kb-Csrf': ross.csrfValue } })).body;
    hiddenCard = (await req('POST', `/api/boards/${hiddenBoard.id}/cards`, { body: { title: 'secret card' }, cookies: ross.session + '; ' + ross.csrf, headers: { 'X-Kb-Csrf': ross.csrfValue } })).body;
    await req('POST', `/api/admin/boards/${grantedBoard.id}/members`, { body: { userId: 'sub-bob' }, cookies: ross.session + '; ' + ross.csrf, headers: { 'X-Kb-Csrf': ross.csrfValue } });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    const db = require('../src/db');
    await db.closePool();
  });

  // ---- KB-AUTH-2: OIDC flow ----

  it('bootstrap admin: login promotes KANBUNNY_BOOTSTRAP_ADMINS login to admin', async () => {
    const me = await req('GET', '/auth/me', { cookies: ross.session });
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.body.login, 'rossbrigoli');
    assert.strictEqual(me.body.role, 'admin');
    assert.strictEqual(me.body.via, 'session');
  });

  it('new OIDC user lands as role=user (deny-by-default)', async () => {
    const me = await req('GET', '/auth/me', { cookies: bob.session });
    assert.strictEqual(me.body.role, 'user');
  });

  it('callback with wrong state is rejected', async () => {
    const loginRes = await req('GET', '/auth/login');
    const oauth = cookieOf(loginRes, 'kb_oauth');
    const cb = await req('GET', '/auth/callback?code=***&state=forged', { cookies: oauth });
    assert.strictEqual(cb.status, 401);
    assert.match(JSON.stringify(cb.body), /callback_failed/);
  });

  it('callback without state cookie is rejected', async () => {
    const cb = await req('GET', '/auth/callback?code=***&state=abc');
    assert.strictEqual(cb.status, 400);
  });

  it('tampered session cookie is rejected', async () => {
    const parts = ross.session.split('=')[1].split('.');
    const tampered = `kb_session=${parts[0]}.${parts[1].slice(0, -2)}xy.${parts[2]}`;
    const me = await req('GET', '/auth/me', { cookies: tampered });
    assert.strictEqual(me.status, 401);
  });

  it('logout clears the session', async () => {
    const tmp = await loginAs({ sub: 'sub-tmp', preferred_username: 'tmpuser' });
    const out = await req('POST', '/auth/logout', { cookies: `${tmp.session}; ${tmp.csrf}` , headers: { 'X-Kb-Csrf': tmp.csrfValue } });
    assert.strictEqual(out.status, 200);
    const cleared = (out.headers['set-cookie'] || []).find((c) => c.startsWith('kb_session='));
    assert.ok(cleared && /Max-Age=0/.test(cleared), 'logout sends clearing cookie (stateless JWT: browser-side removal)');
  });

  // ---- KB-AUTH-3: route enforcement ----

  it('anonymous API access gets 401 with login hint', async () => {
    const r = await req('GET', '/api/boards');
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.login, '/auth/login');
  });

  it('/healthz is reachable without auth (k8s probes)', async () => {
    const r = await req('GET', '/healthz');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
  });

  it('user sees only granted boards', async () => {
    const r = await req('GET', '/api/boards', { cookies: bob.session });
    const names = r.body.map((b) => b.name);
    assert.ok(names.includes('Granted Board'));
    assert.ok(!names.includes('Hidden Board'), 'ungranted board invisible in list');
  });

  it('agent role sees ALL boards (Ross 2026-09-17)', async () => {
    // Promote bob to agent
    const promo = await req('PATCH', `/api/admin/users/sub-bob`, {
      body: { role: 'agent' },
      cookies: `${ross.session}; ${ross.csrf}`,
      headers: { 'X-Kb-Csrf': ross.csrfValue },
    });
    assert.strictEqual(promo.status, 200);
    assert.strictEqual(promo.body.role, 'agent');
    // Agent sees both boards
    const r = await req('GET', '/api/boards', { cookies: bob.session });
    const names = r.body.map((b) => b.name);
    assert.ok(names.includes('Granted Board'));
    assert.ok(names.includes('Hidden Board'), 'agent sees all boards incl. previously-hidden');
    // Agent can reach a board it was never granted
    const hidden = await req('GET', `/api/boards/${hiddenBoard.id}`, { cookies: bob.session });
    assert.strictEqual(hidden.status, 200);
    // Revert bob to user so later tests are unaffected
    await req('PATCH', `/api/admin/users/sub-bob`, {
      body: { role: 'user' },
      cookies: `${ross.session}; ${ross.csrf}`,
      headers: { 'X-Kb-Csrf': ross.csrfValue },
    });
  });

  it('ungranted board returns 404 (existence not leaked), granted board returns 200', async () => {
    const hidden = await req('GET', `/api/boards/${hiddenBoard.id}`, { cookies: bob.session });
    assert.strictEqual(hidden.status, 404);
    const ok = await req('GET', `/api/boards/${grantedBoard.id}`, { cookies: bob.session });
    assert.strictEqual(ok.status, 200);
  });

  it('user can create cards on granted board (with CSRF header)', async () => {
    const r = await req('POST', `/api/boards/${grantedBoard.id}/cards`, {
      body: { title: 'bob card' },
      cookies: `${bob.session}; ${bob.csrf}`,
      headers: { 'X-Kb-Csrf': bob.csrfValue },
    });
    assert.strictEqual(r.status, 201);
  });

  it('cookie mutation without CSRF header is rejected', async () => {
    const r = await req('POST', `/api/boards/${grantedBoard.id}/cards`, {
      body: { title: 'no csrf' },
      cookies: `${bob.session}; ${bob.csrf}`,
    });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.error, 'csrf_failed');
  });

  it('user cannot touch cards on ungranted boards (404)', async () => {
    const patch = await req('PATCH', `/api/cards/${hiddenCard.id}`, {
      body: { title: 'hijacked' },
      cookies: `${bob.session}; ${bob.csrf}`,
      headers: { 'X-Kb-Csrf': bob.csrfValue },
    });
    assert.strictEqual(patch.status, 404);
    const list = await req('GET', `/api/boards/${hiddenBoard.id}/cards`, { cookies: ross.session });
    assert.strictEqual(list.body[0].title, 'secret card', 'card unchanged');
  });

  it('user cannot create, rename, or delete boards (403)', async () => {
    const create = await req('POST', '/api/boards', {
      body: { name: 'bob board' },
      cookies: `${bob.session}; ${bob.csrf}`,
      headers: { 'X-Kb-Csrf': bob.csrfValue },
    });
    assert.strictEqual(create.status, 403);
    const rename = await req('PUT', `/api/boards/${grantedBoard.id}`, {
      body: { name: 'hijacked name' },
      cookies: `${bob.session}; ${bob.csrf}`,
      headers: { 'X-Kb-Csrf': bob.csrfValue },
    });
    assert.strictEqual(rename.status, 403);
    const del = await req('DELETE', `/api/boards/${grantedBoard.id}`, {
      cookies: `${bob.session}; ${bob.csrf}`,
      headers: { 'X-Kb-Csrf': bob.csrfValue },
    });
    assert.strictEqual(del.status, 403);
  });

  it('admin can do everything on any board', async () => {
    const card = await req('POST', `/api/boards/${hiddenBoard.id}/cards`, {
      body: { title: 'admin card' },
      cookies: `${ross.session}; ${ross.csrf}`,
      headers: { 'X-Kb-Csrf': ross.csrfValue },
    });
    assert.strictEqual(card.status, 201);
    const patch = await req('PATCH', `/api/cards/${card.body.id}`, {
      body: { column: 'in-progress' },
      cookies: `${ross.session}; ${ross.csrf}`,
      headers: { 'X-Kb-Csrf': ross.csrfValue },
    });
    assert.strictEqual(patch.status, 200);
    assert.strictEqual(patch.body.column, 'in-progress');
  });

  // ---- KB-AUTH-4: admin API + tokens + guards ----

  it('non-admin cannot reach admin API', async () => {
    const r = await req('GET', '/api/admin/users', { cookies: bob.session });
    assert.strictEqual(r.status, 403);
  });

  it('admin lists users with roles', async () => {
    const r = await req('GET', '/api/admin/users', { cookies: ross.session });
    assert.strictEqual(r.status, 200);
    const byLogin = Object.fromEntries(r.body.map((u) => [u.login, u.role]));
    assert.strictEqual(byLogin.rossbrigoli, 'admin');
    assert.strictEqual(byLogin.bob, 'user');
  });

  it('token: create (plaintext once), use as bearer, list hides secret, revoke', async () => {
    const created = await req('POST', '/api/admin/tokens', {
      body: { name: 'juan-curl', ownerId: 'sub-bob' },
      cookies: `${ross.session}; ${ross.csrf}`,
      headers: { 'X-Kb-Csrf': ross.csrfValue },
    });
    assert.strictEqual(created.status, 201);
    assert.match(created.body.token, /^kb_[0-9a-f]{40}$/);

    const boards = await req('GET', '/api/boards', { headers: { Authorization: `Bearer ${created.body.token}` } });
    assert.strictEqual(boards.status, 200);
    assert.ok(boards.body.map((b) => b.name).includes('Granted Board'), 'token inherits owner grants');

    const me = await req('GET', '/auth/me', { headers: { Authorization: `Bearer ${created.body.token}` } });
    assert.strictEqual(me.body.via, 'token');

    const list = await req('GET', '/api/admin/tokens', { cookies: ross.session });
    assert.strictEqual(list.status, 200);
    assert.ok(!JSON.stringify(list.body).includes(created.body.token.slice(3)), 'plaintext/hash not exposed in list');

    const revoked = await req('DELETE', `/api/admin/tokens/${created.body.id}`, {
      cookies: `${ross.session}; ${ross.csrf}`,
      headers: { 'X-Kb-Csrf': ross.csrfValue },
    });
    assert.strictEqual(revoked.status, 204);
    const after = await req('GET', '/api/boards', { headers: { Authorization: `Bearer ${created.body.token}` } });
    assert.strictEqual(after.status, 401, 'revoked token rejected instantly');
  });

  it('bogus bearer token is rejected', async () => {
    const r = await req('GET', '/api/boards', { headers: { Authorization: '***' } });
    assert.strictEqual(r.status, 401);
  });

  it('bearer tokens are exempt from CSRF', async () => {
    const created = await req('POST', '/api/admin/tokens', {
      body: { name: 'no-csrf-test', ownerId: 'sub-bob' },
      cookies: `${ross.session}; ${ross.csrf}`,
      headers: { 'X-Kb-Csrf': ross.csrfValue },
    });
    const r = await req('POST', `/api/boards/${grantedBoard.id}/cards`, {
      body: { title: 'via bearer no csrf' },
      headers: { Authorization: `Bearer ${created.body.token}` },
    });
    assert.strictEqual(r.status, 201);
  });

  it('role change via admin API works and takes effect instantly on live sessions', async () => {
    const promote = await req('PATCH', '/api/admin/users/sub-bob', {
      body: { role: 'admin' },
      cookies: `${ross.session}; ${ross.csrf}`,
      headers: { 'X-Kb-Csrf': ross.csrfValue },
    });
    assert.strictEqual(promote.status, 200);
    assert.strictEqual(promote.body.role, 'admin');
    const boards = await req('GET', '/api/boards', { cookies: bob.session });
    assert.ok(boards.body.map((b) => b.name).includes('Hidden Board'), 'promoted session sees all immediately');
    // demote back
    await req('PATCH', '/api/admin/users/sub-bob', {
      body: { role: 'user' },
      cookies: `${ross.session}; ${ross.csrf}`,
      headers: { 'X-Kb-Csrf': ross.csrfValue },
    });
  });

  it('self-demotion by the LAST admin is blocked', async () => {
    const r = await req('PATCH', '/api/admin/users/sub-ross', {
      body: { role: 'user' },
      cookies: `${ross.session}; ${ross.csrf}`,
      headers: { 'X-Kb-Csrf': ross.csrfValue },
    });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, 'cannot_demote_last_admin');
  });

  it('last-admin demotion is blocked (with another admin present it is allowed)', async () => {
    // Only ross is admin: demoting ross by anyone == self here; simulate by
    // adding alice as admin, then demoting ross (allowed), then alice tries
    // self-demotion (blocked by self-guard as the last admin).
    await loginAs({ sub: 'sub-alice', preferred_username: 'alice' });
    await req('PATCH', '/api/admin/users/sub-alice', {
      body: { role: 'admin' },
      cookies: `${ross.session}; ${ross.csrf}`,
      headers: { 'X-Kb-Csrf': ross.csrfValue },
    });
    const demoteRoss = await req('PATCH', '/api/admin/users/sub-ross', {
      body: { role: 'user' },
      cookies: `${ross.session}; ${ross.csrf}`,
      headers: { 'X-Kb-Csrf': ross.csrfValue },
    });
    assert.strictEqual(demoteRoss.status, 200, 'ross demoted while alice remains admin');

    const alice = await loginAs({ sub: 'sub-alice', preferred_username: 'alice' });
    const lastStand = await req('PATCH', '/api/admin/users/sub-alice', {
      body: { role: 'user' },
      cookies: `${alice.session}; ${alice.csrf}`,
      headers: { 'X-Kb-Csrf': alice.csrfValue },
    });
    assert.strictEqual(lastStand.status, 409, 'last admin cannot self-demote');
  });
});
