const Database = require('better-sqlite3');
const path = require('path');

let db;
let lastPath;

function getDb() {
  const DB_PATH = process.env.KANBUNNY_DB_PATH || path.join(__dirname, '..', 'kanbunny.db');
  if (!db || lastPath !== DB_PATH) {
    if (db) db.close();
    lastPath = DB_PATH;
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initialize();
  }
  return db;
}

function initialize() {
  db.exec(`
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
      assignee TEXT DEFAULT '',
      column TEXT NOT NULL CHECK(column IN ('todo', 'in-progress', 'blocked', 'in-review', 'done')) DEFAULT 'todo',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
    );

    -- Seed a default board if none exists
    INSERT INTO boards (id, name)
    SELECT 'default', 'My Board'
    WHERE NOT EXISTS (SELECT 1 FROM boards WHERE id = 'default');
  `);

  // --- Migration: add assignee column if missing ---
  const cols = db.prepare(
    "PRAGMA table_info(cards)"
  ).all();
  if (!cols.some((c) => c.name === 'assignee')) {
    db.exec("ALTER TABLE cards ADD COLUMN assignee TEXT DEFAULT ''");
  }

  // --- Migration: add priority column if missing (1-based rank within column) ---
  if (!cols.some((c) => c.name === 'priority')) {
    db.exec('ALTER TABLE cards ADD COLUMN priority INTEGER DEFAULT NULL');
  }

  // --- Migration: update column CHECK constraint to include 'blocked' ---
  const cardTableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='cards'").get();
  console.log('Migration check: cards table SQL:', cardTableInfo?.sql?.substring(0, 200));
  if (cardTableInfo && !cardTableInfo.sql.includes('blocked')) {
    db.exec(`
      BEGIN TRANSACTION;
      CREATE TABLE cards_new (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        assignee TEXT DEFAULT '',
        column TEXT NOT NULL CHECK(column IN ('todo', 'in-progress', 'blocked', 'in-review', 'done')) DEFAULT 'todo',
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        priority INTEGER DEFAULT NULL,
        FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
      );
      INSERT INTO cards_new (id, board_id, title, description, assignee, column, position, created_at, updated_at, priority) SELECT id, board_id, title, description, assignee, column, position, created_at, updated_at, priority FROM cards;
      DROP TABLE cards;
      ALTER TABLE cards_new RENAME TO cards;
      COMMIT;
    `);
  }

  // --- Migration: add card_number column if missing (per-board human ID sequence) ---
  // Display ref is "X-N": X = first letter of the board name, N = immutable
  // per-board sequence number assigned at creation. The number never changes;
  // the prefix follows the current board name.
  const colsNow = db.prepare('PRAGMA table_info(cards)').all();
  if (!colsNow.some((c) => c.name === 'card_number')) {
    db.exec('ALTER TABLE cards ADD COLUMN card_number INTEGER');
    const backfill = db.transaction(() => {
      for (const b of db.prepare('SELECT id FROM boards').all()) {
        const rows = db
          .prepare('SELECT id FROM cards WHERE board_id = ? ORDER BY column, position')
          .all(b.id);
        rows.forEach((r, i) => {
          db.prepare('UPDATE cards SET card_number = ? WHERE id = ?').run(i + 1, r.id);
        });
      }
    });
    backfill();
  }
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_board_number ON cards(board_id, card_number)'
  );

  // --- Migration: auth tables (OIDC users, board membership, API tokens) ---
  // Design: docs/oidc-auth-design.md §3
  //   users.id       = Dex OIDC subject (stable GitHub numeric id) once logged in;
  //                   'pending:<login>' placeholder for bootstrap admins created
  //                   before first login (re-keyed to the real sub on login).
  //   board_members  = per-board grants; admins implicitly see all boards, so
  //                   existing boards need no backfill.
  //   api_tokens     = agent/automation bearer tokens, stored as sha256 hashes.
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      login TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user', 'agent')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS board_members (
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      granted_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (board_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_board_members_user ON board_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_api_tokens_owner ON api_tokens(owner_id);
  `);

  ensureBootstrapAdmins();

  // --- Recompute priorities on startup for all boards ---
  // Priority = ordinal rank within each column (1-based), derived from position.
  // Stored so it survives even if position is a float during drag-reordering.
  const allBoards = db.prepare('SELECT id FROM boards').all();
  allBoards.forEach((b) => {
    recomputePriorities(b.id);
  });
}

function recomputePriorities(boardId) {
  const db = getDb();
  for (const col of ['todo', 'in-progress', 'blocked', 'in-review', 'done']) {
    const ranked = db.prepare(
      `SELECT id FROM cards WHERE board_id = ? AND column = ? ORDER BY position`
    ).all(boardId, col);
    ranked.forEach((c, i) => {
      db.prepare('UPDATE cards SET priority = ? WHERE id = ?').run(i + 1, c.id);
    });
  }
}

// --- Auth: users, roles, board membership, API tokens ---
// (design: docs/oidc-auth-design.md §3)

const VALID_ROLES = ['admin', 'user', 'agent'];

function bootstrapAdminLogins() {
  return (process.env.KANBUNNY_BOOTSTRAP_ADMINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Idempotently ensure KANBUNNY_BOOTSTRAP_ADMINS logins exist as admins.
// Called on startup; also safe to call again later. Existing users with a
// listed login are promoted; missing ones get a 'pending:<login>' row that
// upsertUserFromOidc() re-keys to the real Dex sub on first login.
function ensureBootstrapAdmins() {
  const db = getDb();
  const logins = bootstrapAdminLogins();
  const tx = db.transaction(() => {
    for (const login of logins) {
      const existing = db.prepare('SELECT * FROM users WHERE login = ?').get(login);
      if (existing) {
        if (existing.role !== 'admin') {
          db.prepare("UPDATE users SET role = 'admin', updated_at = datetime('now') WHERE id = ?").run(existing.id);
        }
      } else {
        db.prepare("INSERT INTO users (id, login, role) VALUES (?, ?, 'admin')").run(`pending:${login}`, login);
      }
    }
  });
  tx();
  return logins;
}

// Upsert a user from a verified OIDC id_token (sub + preferred_username/login).
// - New sub            -> insert with role 'user' (deny-by-default).
// - Known sub          -> refresh login if GitHub login changed; role untouched.
// - Pending bootstrap  -> re-key pending:<login> row to the real sub; role stays 'admin'.
// - Login collision    -> throw (login already claimed by a different sub).
function upsertUserFromOidc(sub, login) {
  if (!sub || !login) throw new Error('upsertUserFromOidc requires sub and login');
  const db = getDb();
  const tx = db.transaction(() => {
    const bySub = db.prepare('SELECT * FROM users WHERE id = ?').get(sub);
    if (bySub) {
      if (bySub.login !== login) {
        db.prepare("UPDATE users SET login = ?, updated_at = datetime('now') WHERE id = ?").run(login, sub);
      }
      return db.prepare('SELECT * FROM users WHERE id = ?').get(sub);
    }
    const byLogin = db.prepare('SELECT * FROM users WHERE login = ?').get(login);
    if (byLogin) {
      if (!byLogin.id.startsWith('pending:')) {
        throw new Error(`login_conflict: '${login}' is already claimed by another subject`);
      }
      db.prepare("UPDATE users SET id = ?, updated_at = datetime('now') WHERE id = ?").run(sub, byLogin.id);
      return db.prepare('SELECT * FROM users WHERE id = ?').get(sub);
    }
    db.prepare("INSERT INTO users (id, login, role) VALUES (?, ?, 'user')").run(sub, login);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(sub);
  });
  return tx();
}

function listUsers() {
  return getDb().prepare('SELECT * FROM users ORDER BY role, login').all();
}

function getUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserByLogin(login) {
  return getDb().prepare('SELECT * FROM users WHERE login = ?').get(login);
}

function setUserRole(id, role) {
  if (!VALID_ROLES.includes(role)) {
    const err = new Error(`invalid_role: ${role}`);
    err.code = 'invalid_role';
    throw err;
  }
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return null;
  db.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?").run(role, id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// --- Board membership (grants for role='user'/'agent'; admins see all) ---

function addBoardMember(boardId, userId, grantedBy = null) {
  const db = getDb();
  const result = db
    .prepare('INSERT OR IGNORE INTO board_members (board_id, user_id, granted_by) VALUES (?, ?, ?)')
    .run(boardId, userId, grantedBy);
  return result.changes > 0;
}

function removeBoardMember(boardId, userId) {
  const result = getDb()
    .prepare('DELETE FROM board_members WHERE board_id = ? AND user_id = ?')
    .run(boardId, userId);
  return result.changes > 0;
}

function listBoardMembers(boardId) {
  return getDb()
    .prepare(
      'SELECT u.id, u.login, u.role, bm.granted_by, bm.created_at FROM board_members bm JOIN users u ON u.id = bm.user_id WHERE bm.board_id = ? ORDER BY u.login'
    )
    .all(boardId);
}

function isBoardMember(boardId, userId) {
  return !!getDb()
    .prepare('SELECT 1 FROM board_members WHERE board_id = ? AND user_id = ?')
    .get(boardId, userId);
}

// Boards visible to a principal: all for admins and agents, granted-only otherwise.
// (Per Ross 2026-09-17: the `agent` role sees all boards.)
function seesAllBoards(principal) {
  return principal && (principal.role === 'admin' || principal.role === 'agent');
}

function visibleBoardsFor(principal) {
  if (!principal) return [];
  const db = getDb();
  if (seesAllBoards(principal)) {
    return db.prepare('SELECT * FROM boards ORDER BY name').all();
  }
  return db
    .prepare(
      'SELECT b.* FROM boards b JOIN board_members bm ON bm.board_id = b.id WHERE bm.user_id = ? ORDER BY b.name'
    )
    .all(principal.id);
}

// --- API tokens (agents/automation) ---

function createApiToken({ id, name, ownerId, tokenHash }) {
  const { v4: uuid } = require('uuid');
  const token = { id: id || uuid(), name, owner_id: ownerId, token_hash: tokenHash };
  getDb()
    .prepare('INSERT INTO api_tokens (id, name, owner_id, token_hash) VALUES (?, ?, ?, ?)')
    .run(token.id, token.name, token.owner_id, token.token_hash);
  return getDb().prepare('SELECT * FROM api_tokens WHERE id = ?').get(token.id);
}

// Resolve a bearer token hash to { token, user } (single join: auth is one lookup).
function findPrincipalByTokenHash(tokenHash) {
  const row = getDb()
    .prepare(
      'SELECT t.id AS token_id, t.name AS token_name, t.last_used_at, u.id AS user_id, u.login, u.role FROM api_tokens t JOIN users u ON u.id = t.owner_id WHERE t.token_hash = ?'
    )
    .get(tokenHash);
  if (!row) return null;
  return { token: { id: row.token_id, name: row.token_name, last_used_at: row.last_used_at }, user: { id: row.user_id, login: row.login, role: row.role } };
}

function touchApiToken(tokenId) {
  getDb()
    .prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?")
    .run(tokenId);
}

function listApiTokens() {
  return getDb()
    .prepare('SELECT t.id, t.name, t.owner_id, t.last_used_at, t.created_at, u.login AS owner_login FROM api_tokens t JOIN users u ON u.id = t.owner_id ORDER BY t.created_at')
    .all();
}

function deleteApiToken(id) {
  const result = getDb().prepare('DELETE FROM api_tokens WHERE id = ?').run(id);
  return result.changes > 0;
}

// --- Board CRUD ---

function listBoards() {
  return getDb().prepare('SELECT * FROM boards ORDER BY name').all();
}

function getBoard(id) {
  return getDb().prepare('SELECT * FROM boards WHERE id = ?').get(id);
}

function createBoard(name) {
  const { v4: uuid } = require('uuid');
  const row = { id: uuid(), name };
  getDb().prepare('INSERT INTO boards (id, name) VALUES (?, ?)').run(row.id, row.name);
  return getBoard(row.id);
}

function updateBoard(id, name) {
  getDb().prepare("UPDATE boards SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, id);
  return getBoard(id);
}

function deleteBoard(id) {
  const result = getDb().prepare('DELETE FROM boards WHERE id = ?').run(id);
  return result.changes > 0;
}

// --- Card CRUD ---

// Cards carry a human-friendly ref ("X-N") computed from the board name and
// the immutable per-board card_number sequence.
const CARD_SELECT_COLUMNS = `cards.*, CASE WHEN cards.card_number IS NULL THEN NULL
  ELSE substr(upper(ltrim(b.name)), 1, 1) || '-' || cards.card_number END AS ref`;
const CARD_SELECT_FROM = 'FROM cards JOIN boards b ON b.id = cards.board_id';

function listCards(boardId, filters = {}) {
  const { column } = filters;
  const db = getDb();

  if (column) {
    return db
      .prepare(
        `SELECT ${CARD_SELECT_COLUMNS} ${CARD_SELECT_FROM} WHERE cards.board_id = ? AND cards.column = ? ORDER BY cards.position`
      )
      .all(boardId, column);
  }

  return db
    .prepare(
      `SELECT ${CARD_SELECT_COLUMNS} ${CARD_SELECT_FROM} WHERE cards.board_id = ? ORDER BY cards.column, cards.position`
    )
    .all(boardId);
}

function getCard(id) {
  return getDb()
    .prepare(`SELECT ${CARD_SELECT_COLUMNS} ${CARD_SELECT_FROM} WHERE cards.id = ?`)
    .get(id);
}

function createCard(boardId, title, description = '', column = 'todo', assignee = '', priority = null) {
  const { v4: uuid } = require('uuid');
  const db = getDb();

  const insert = db.transaction(() => {
    const maxPos = db.prepare(
      `SELECT COALESCE(MAX(position), -1) as maxPos FROM cards WHERE board_id = ? AND column = ?`
    ).get(boardId, column);
    const nextNumber = db.prepare(
      'SELECT COALESCE(MAX(card_number), 0) + 1 as nextNum FROM cards WHERE board_id = ?'
    ).get(boardId).nextNum;

    const card = {
      id: uuid(),
      board_id: boardId,
      title,
      description,
      assignee,
      column,
      position: maxPos.maxPos + 1,
      priority,
      card_number: nextNumber,
    };

    db.prepare(
      'INSERT INTO cards (id, board_id, title, description, assignee, column, position, priority, card_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(card.id, card.board_id, card.title, card.description, card.assignee, card.column, card.position, card.priority, card.card_number);

    return card.id;
  });

  return getCard(insert());
}

function updateCard(id, updates) {
  const card = getCard(id);
  if (!card) return null;

  const db = getDb();
  const fields = [];
  const values = [];
  let columnChanged = false;

  if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
  if (updates.assignee !== undefined) {
    fields.push('assignee = ?');
    values.push(updates.assignee);
  }
  if (updates.priority !== undefined) {
    fields.push('priority = ?');
    values.push(updates.priority == null ? null : parseInt(updates.priority, 10));
  }
  if (updates.column !== undefined) {
    fields.push('column = ?');
    values.push(updates.column);
    // When moving to a new column, append at end
    if (updates.column !== card.column) {
      columnChanged = true;
      const maxPos = db.prepare(
        `SELECT COALESCE(MAX(position), -1) as maxPos FROM cards WHERE board_id = ? AND column = ?`
      ).get(card.board_id, updates.column);
      fields.push('position = ?');
      values.push(maxPos.maxPos + 1);
    }
  }

  if (fields.length === 0) return card;

  fields.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE cards SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  // Auto-recompute priorities for affected columns
  if (columnChanged) {
    recomputePriorities(card.board_id);
  }

  return getCard(id);
}

function deleteCard(id) {
  const result = getDb().prepare('DELETE FROM cards WHERE id = ?').run(id);
  return result.changes > 0;
}

function reorderCard(cardId, afterCardId) {
  const db = getDb();
  const card = getCard(cardId);
  const after = afterCardId ? getCard(afterCardId) : null;

  if (!card || (after && after.board_id !== card.board_id)) return false;

  const result = db.transaction(() => {
    const cardsInCol = db.prepare(
      `SELECT id, position FROM cards WHERE board_id = ? AND column = ? ORDER BY position`
    ).all(card.board_id, card.column);

    if (after) {
      // Move card to position after "after" card
      const afterIdx = cardsInCol.findIndex((c) => c.id === afterCardId);
      if (afterIdx === -1) return false; // after card not in same column

      const cardIdx = cardsInCol.findIndex((c) => c.id === cardId);
      if (cardIdx === -1) return false; // card not in column

      // Remove card from current position
      const [removed] = cardsInCol.splice(cardIdx, 1);

      // Insert after the target index (adjust for removal shift)
      const newIdx = (cardIdx < afterIdx ? afterIdx : afterIdx + 1);
      cardsInCol.splice(newIdx, 0, removed);
    } else {
      // No afterCardId: move to end of column
      const cardIdx = cardsInCol.findIndex((c) => c.id === cardId);
      if (cardIdx === -1) return false;

      const [removed] = cardsInCol.splice(cardIdx, 1);
      cardsInCol.push(removed);
    }

    // Re-normalize positions
    cardsInCol.forEach((c, i) => {
      db.prepare('UPDATE cards SET position = ? WHERE id = ?').run(i, c.id);
    });

    return true;
  })();

  // Auto-recompute priorities for affected column
  recomputePriorities(card.board_id);

  return result;
}

module.exports = {
  getDb,
  listBoards,
  getBoard,
  createBoard,
  updateBoard,
  deleteBoard,
  listCards,
  getCard,
  createCard,
  updateCard,
  deleteCard,
  reorderCard,
  recomputePriorities,
  // auth (KB-AUTH-1)
  VALID_ROLES,
  bootstrapAdminLogins,
  ensureBootstrapAdmins,
  upsertUserFromOidc,
  listUsers,
  getUserById,
  getUserByLogin,
  setUserRole,
  addBoardMember,
  removeBoardMember,
  listBoardMembers,
  isBoardMember,
  visibleBoardsFor,
  seesAllBoards,
  createApiToken,
  findPrincipalByTokenHash,
  touchApiToken,
  listApiTokens,
  deleteApiToken,
};
