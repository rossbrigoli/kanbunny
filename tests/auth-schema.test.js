const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const TEST_DB = path.resolve(__dirname, '..', 'kanbunny.test-auth.db');

describe('Auth schema (KB-AUTH-1)', () => {
  let db;

  before(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    process.env.KANBUNNY_DB_PATH = TEST_DB;
    process.env.KANBUNNY_BOOTSTRAP_ADMINS = 'rossbrigoli, alice';
    delete require.cache[require.resolve('../src/db')];
    db = require('../src/db');
    db.getDb(); // run migrations
  });

  after(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    delete process.env.KANBUNNY_DB_PATH;
    delete process.env.KANBUNNY_BOOTSTRAP_ADMINS;
  });

  it('creates users, board_members and api_tokens tables', () => {
    const names = db
      .getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    assert.ok(names.includes('users'));
    assert.ok(names.includes('board_members'));
    assert.ok(names.includes('api_tokens'));
  });

  it('bootstrap admins are created as pending: rows, idempotently', () => {
    const ross = db.getUserByLogin('rossbrigoli');
    assert.ok(ross, 'bootstrap admin exists');
    assert.strictEqual(ross.role, 'admin');
    assert.strictEqual(ross.id, 'pending:rossbrigoli');

    const before = db.listUsers().length;
    db.ensureBootstrapAdmins();
    db.ensureBootstrapAdmins();
    assert.strictEqual(db.listUsers().length, before, 're-running creates no rows');
  });

  it('bootstrap env parsing trims whitespace and skips empties', () => {
    assert.deepStrictEqual(db.bootstrapAdminLogins().sort(), ['alice', 'rossbrigoli']);
  });

  it('users.role CHECK constraint rejects invalid roles', () => {
    assert.throws(() => {
      db.getDb().prepare("INSERT INTO users (id, login, role) VALUES ('x1', 'x1', 'root')").run();
    }, /CHECK/);
  });

  it('setUserRole validates role and missing user', () => {
    const u = db.upsertUserFromOidc('sub-bob', 'bob');
    assert.strictEqual(u.role, 'user');
    assert.strictEqual(db.setUserRole(u.id, 'admin').role, 'admin');
    assert.strictEqual(db.setUserRole(u.id, 'user').role, 'user');
    assert.throws(() => db.setUserRole(u.id, 'wizard'), (e) => e.code === 'invalid_role');
    assert.strictEqual(db.setUserRole('nope', 'admin'), null);
  });

  it('upsertUserFromOidc: new sub gets role user (deny-by-default)', () => {
    const u = db.upsertUserFromOidc('sub-carol', 'carol');
    assert.strictEqual(u.id, 'sub-carol');
    assert.strictEqual(u.role, 'user');
  });

  it('upsertUserFromOidc: re-keys pending bootstrap row to real sub, keeps admin', () => {
    const u = db.upsertUserFromOidc('sub-ross-999', 'rossbrigoli');
    assert.strictEqual(u.id, 'sub-ross-999');
    assert.strictEqual(u.role, 'admin');
    assert.strictEqual(db.getUserById('pending:rossbrigoli'), undefined);
  });

  it('upsertUserFromOidc: known sub with changed GitHub login updates login only', () => {
    db.upsertUserFromOidc('sub-dave', 'dave');
    const renamed = db.upsertUserFromOidc('sub-dave', 'dave-new');
    assert.strictEqual(renamed.id, 'sub-dave');
    assert.strictEqual(renamed.login, 'dave-new');
    assert.strictEqual(db.getUserByLogin('dave'), undefined);
  });

  it('upsertUserFromOidc: login collision with a different real sub throws', () => {
    assert.throws(
      () => db.upsertUserFromOidc('sub-evil', 'carol'),
      /login_conflict/
    );
  });

  it('board membership: add is idempotent, remove works, membership check works', () => {
    const board = db.createBoard('Auth Test Board');
    const u = db.getUserByLogin('carol');
    const granter = db.getUserByLogin('rossbrigoli');
    assert.strictEqual(db.addBoardMember(board.id, u.id, granter.id), true);
    assert.strictEqual(db.addBoardMember(board.id, u.id, granter.id), false, 'duplicate grant is a no-op');
    assert.strictEqual(db.isBoardMember(board.id, u.id), true);
    assert.strictEqual(db.removeBoardMember(board.id, u.id), true);
    assert.strictEqual(db.isBoardMember(board.id, u.id), false);
    assert.strictEqual(db.removeBoardMember(board.id, u.id), false);
    db.addBoardMember(board.id, u.id, null);
  });

  it('board_members cascades on board delete and on user delete', () => {
    const board = db.createBoard('Cascade Board');
    const u = db.upsertUserFromOidc('sub-eve', 'eve');
    db.addBoardMember(board.id, u.id, null);
    db.deleteBoard(board.id);
    assert.strictEqual(db.isBoardMember(board.id, u.id), false, 'rows gone with board');

    const board2 = db.createBoard('Cascade Board 2');
    db.addBoardMember(board2.id, u.id, null);
    db.getDb().prepare('DELETE FROM users WHERE id = ?').run(u.id);
    assert.strictEqual(db.isBoardMember(board2.id, u.id), false, 'rows gone with user');
  });

  it('visibleBoardsFor: admin sees all, user sees granted only, null sees none', () => {
    const b1 = db.createBoard('Visible B1');
    const b2 = db.createBoard('Visible B2');
    const admin = db.getUserByLogin('rossbrigoli');
    const user = db.getUserByLogin('carol');
    db.addBoardMember(b1.id, user.id, admin.id);

    const adminBoards = db.visibleBoardsFor(admin).map((b) => b.name);
    const userBoards = db.visibleBoardsFor(user).map((b) => b.name);
    assert.ok(adminBoards.includes('Visible B1') && adminBoards.includes('Visible B2'));
    assert.ok(userBoards.includes('Visible B1'), 'granted board visible');
    assert.ok(!userBoards.includes('Visible B2'), 'ungranted board hidden');
    assert.deepStrictEqual(db.visibleBoardsFor(null), []);
  });

  it('api_tokens: create, resolve principal by hash, touch, unique hash, delete', () => {
    const owner = db.upsertUserFromOidc('agent:sherlock', 'agent:sherlock');
    db.setUserRole(owner.id, 'agent');
    const t = db.createApiToken({ name: 'sherlock-curl', ownerId: owner.id, tokenHash: 'hash-aaa' });
    assert.strictEqual(t.name, 'sherlock-curl');
    assert.strictEqual(t.last_used_at, null);

    const p = db.findPrincipalByTokenHash('hash-aaa');
    assert.strictEqual(p.user.login, 'agent:sherlock');
    assert.strictEqual(p.user.role, 'agent');
    assert.strictEqual(p.token.name, 'sherlock-curl');
    assert.strictEqual(db.findPrincipalByTokenHash('nope'), null);

    db.touchApiToken(t.id);
    assert.match(db.getDb().prepare('SELECT last_used_at FROM api_tokens WHERE id=?').get(t.id).last_used_at, /\d{4}-\d{2}-\d{2}/);

    assert.throws(() => db.createApiToken({ name: 'dup', ownerId: owner.id, tokenHash: 'hash-aaa' }), /UNIQUE/);
    assert.strictEqual(db.deleteApiToken(t.id), true);
    assert.strictEqual(db.findPrincipalByTokenHash('hash-aaa'), null);
  });

  it('api_tokens cascade on owner delete', () => {
    const owner = db.upsertUserFromOidc('agent:juan', 'agent:juan');
    const t = db.createApiToken({ name: 'juan-curl', ownerId: owner.id, tokenHash: 'hash-juan' });
    db.getDb().prepare('DELETE FROM users WHERE id = ?').run(owner.id);
    assert.strictEqual(db.getDb().prepare('SELECT * FROM api_tokens WHERE id = ?').get(t.id), undefined);
  });

  it('existing routes/behaviour unchanged: boards+cards still work', () => {
    const b = db.createBoard('Legacy OK');
    const c = db.createCard(b.id, 'still works');
    assert.strictEqual(c.title, 'still works');
    assert.strictEqual(db.listBoards().some((x) => x.name === 'Legacy OK'), true);
  });
});
