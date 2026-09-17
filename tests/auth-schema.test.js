const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

// KB-PG-2: Postgres-backed test DB (reset by tests/setup-test-pg.sh)
const TEST_PG_URL = 'postgres://kanbunny:kanbunny@127.0.0.1:55432/kanbunny_test_auth';

describe('Auth schema (KB-AUTH-1, Postgres)', () => {
  let db;

  before(async () => {
    process.env.DATABASE_URL = process.env.KANBUNNY_TEST_PG_URL || TEST_PG_URL;
    process.env.KANBUNNY_BOOTSTRAP_ADMINS = 'rossbrigoli, alice';
    delete require.cache[require.resolve('../src/db')];
    db = require('../src/db');
    await db.ready(); // run migrations
  });

  after(async () => {
    await db.closePool();
    delete process.env.KANBUNNY_BOOTSTRAP_ADMINS;
  });

  it('creates users, board_members and api_tokens tables', async () => {
    const { rows } = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    const names = rows.map((r) => r.table_name);
    assert.ok(names.includes('users'));
    assert.ok(names.includes('board_members'));
    assert.ok(names.includes('api_tokens'));
    assert.ok(names.includes('schema_migrations'), 'migration tracking table exists');
  });

  it('bootstrap admins are created as pending: rows, idempotently', async () => {
    const ross = await db.getUserByLogin('rossbrigoli');
    assert.ok(ross, 'bootstrap admin exists');
    assert.strictEqual(ross.role, 'admin');
    assert.strictEqual(ross.id, 'pending:rossbrigoli');

    const beforeCount = (await db.listUsers()).length;
    await db.ensureBootstrapAdmins();
    await db.ensureBootstrapAdmins();
    const afterCount = (await db.listUsers()).length;
    assert.strictEqual(afterCount, beforeCount, 're-running creates no rows');
  });

  it('bootstrap env parsing trims whitespace and skips empties', () => {
    assert.deepStrictEqual(db.bootstrapAdminLogins().sort(), ['alice', 'rossbrigoli']);
  });

  it('users.role CHECK constraint rejects invalid roles', async () => {
    await assert.rejects(
      () => db.query("INSERT INTO users (id, login, role) VALUES ('x1', 'x1', 'root')"),
      /check constraint/i
    );
  });

  it('setUserRole validates role and missing user', async () => {
    const u = await db.upsertUserFromOidc('sub-bob', 'bob');
    assert.strictEqual(u.role, 'user');
    assert.strictEqual((await db.setUserRole(u.id, 'admin')).role, 'admin');
    assert.strictEqual((await db.setUserRole(u.id, 'user')).role, 'user');
    await assert.rejects(() => db.setUserRole(u.id, 'wizard'), (e) => e.code === 'invalid_role');
    assert.strictEqual(await db.setUserRole('nope', 'admin'), null);
  });

  it('upsertUserFromOidc: new sub gets role user (deny-by-default)', async () => {
    const u = await db.upsertUserFromOidc('sub-carol', 'carol');
    assert.strictEqual(u.id, 'sub-carol');
    assert.strictEqual(u.role, 'user');
  });

  it('upsertUserFromOidc: re-keys pending bootstrap row to real sub, keeps admin', async () => {
    const u = await db.upsertUserFromOidc('sub-ross-999', 'rossbrigoli');
    assert.strictEqual(u.id, 'sub-ross-999');
    assert.strictEqual(u.role, 'admin');
    assert.strictEqual(await db.getUserById('pending:rossbrigoli'), undefined);
  });

  it('upsertUserFromOidc: known sub with changed GitHub login updates login only', async () => {
    await db.upsertUserFromOidc('sub-dave', 'dave');
    const renamed = await db.upsertUserFromOidc('sub-dave', 'dave-new');
    assert.strictEqual(renamed.id, 'sub-dave');
    assert.strictEqual(renamed.login, 'dave-new');
    assert.strictEqual(await db.getUserByLogin('dave'), undefined);
  });

  it('upsertUserFromOidc: login collision with a different real sub throws', async () => {
    await assert.rejects(
      () => db.upsertUserFromOidc('sub-evil', 'carol'),
      /login_conflict/
    );
  });

  it('board membership: add is idempotent, remove works, membership check works', async () => {
    const board = await db.createBoard('Auth Test Board');
    const u = await db.getUserByLogin('carol');
    const granter = await db.getUserByLogin('rossbrigoli');
    assert.strictEqual(await db.addBoardMember(board.id, u.id, granter.id), true);
    assert.strictEqual(await db.addBoardMember(board.id, u.id, granter.id), false, 'duplicate grant is a no-op');
    assert.strictEqual(await db.isBoardMember(board.id, u.id), true);
    assert.strictEqual(await db.removeBoardMember(board.id, u.id), true);
    assert.strictEqual(await db.isBoardMember(board.id, u.id), false);
    assert.strictEqual(await db.removeBoardMember(board.id, u.id), false);
    await db.addBoardMember(board.id, u.id, null);
  });

  it('board_members cascades on board delete and on user delete', async () => {
    const board = await db.createBoard('Cascade Board');
    const u = await db.upsertUserFromOidc('sub-eve', 'eve');
    await db.addBoardMember(board.id, u.id, null);
    await db.deleteBoard(board.id);
    assert.strictEqual(await db.isBoardMember(board.id, u.id), false, 'rows gone with board');

    const board2 = await db.createBoard('Cascade Board 2');
    await db.addBoardMember(board2.id, u.id, null);
    await db.query('DELETE FROM users WHERE id = $1', [u.id]);
    assert.strictEqual(await db.isBoardMember(board2.id, u.id), false, 'rows gone with user');
  });

  it('visibleBoardsFor: admin sees all, user sees granted only, null sees none', async () => {
    const b1 = await db.createBoard('Visible B1');
    const b2 = await db.createBoard('Visible B2');
    const admin = await db.getUserByLogin('rossbrigoli');
    const user = await db.getUserByLogin('carol');
    await db.addBoardMember(b1.id, user.id, admin.id);

    const adminBoards = (await db.visibleBoardsFor(admin)).map((b) => b.name);
    const userBoards = (await db.visibleBoardsFor(user)).map((b) => b.name);
    assert.ok(adminBoards.includes('Visible B1') && adminBoards.includes('Visible B2'));
    assert.ok(userBoards.includes('Visible B1'), 'granted board visible');
    assert.ok(!userBoards.includes('Visible B2'), 'ungranted board hidden');
    assert.deepStrictEqual(await db.visibleBoardsFor(null), []);
  });

  it('api_tokens: create, resolve principal by hash, touch, unique hash, delete', async () => {
    const owner = await db.upsertUserFromOidc('agent:sherlock', 'agent:sherlock');
    await db.setUserRole(owner.id, 'agent');
    const t = await db.createApiToken({ name: 'sherlock-curl', ownerId: owner.id, tokenHash: 'hash-aaa' });
    assert.strictEqual(t.name, 'sherlock-curl');
    assert.strictEqual(t.last_used_at, null);

    const p = await db.findPrincipalByTokenHash('hash-aaa');
    assert.strictEqual(p.user.login, 'agent:sherlock');
    assert.strictEqual(p.user.role, 'agent');
    assert.strictEqual(p.token.name, 'sherlock-curl');
    assert.strictEqual(await db.findPrincipalByTokenHash('nope'), null);

    await db.touchApiToken(t.id);
    const touched = (await db.query('SELECT last_used_at FROM api_tokens WHERE id=$1', [t.id])).rows[0];
    assert.match(touched.last_used_at, /\d{4}-\d{2}-\d{2}/, 'wire format stays SQLite-style text');

    await assert.rejects(
      () => db.createApiToken({ name: 'dup', ownerId: owner.id, tokenHash: 'hash-aaa' }),
      /unique/i
    );
    assert.strictEqual(await db.deleteApiToken(t.id), true);
    assert.strictEqual(await db.findPrincipalByTokenHash('hash-aaa'), null);
  });

  it('api_tokens cascade on owner delete', async () => {
    const owner = await db.upsertUserFromOidc('agent:juan', 'agent:juan');
    const t = await db.createApiToken({ name: 'juan-curl', ownerId: owner.id, tokenHash: 'hash-juan' });
    await db.query('DELETE FROM users WHERE id = $1', [owner.id]);
    const { rows } = await db.query('SELECT * FROM api_tokens WHERE id = $1', [t.id]);
    assert.strictEqual(rows[0], undefined);
  });

  it('existing routes/behaviour unchanged: boards+cards still work', async () => {
    const b = await db.createBoard('Legacy OK');
    const c = await db.createCard(b.id, 'still works');
    assert.strictEqual(c.title, 'still works');
    assert.strictEqual((await db.listBoards()).some((x) => x.name === 'Legacy OK'), true);
  });
});
