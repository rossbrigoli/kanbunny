const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 3500;
const HOST = process.env.HOST || '0.0.0.0';

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Unauthenticated health endpoint for k8s probes (auth is enforced on /api/*).
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

// Readiness is DB-backed and time-bounded (KB-PG-4). During a Patroni failover
// the pod goes NotReady and K8s stops routing to it, rather than serving 500s
// from a pool that cannot reach a primary. Liveness (/healthz) deliberately
// stays DB-free: restarting this pod cannot fix a down database, so coupling
// liveness to the DB would turn a 30s failover into a restart storm.
app.get('/readyz', async (_req, res) => {
  let ok = false;
  try {
    ok = await db.ping();
  } catch {
    ok = false;
  }
  res.status(ok ? 200 : 503).json({ ok });
});

// Auth: principal resolution for every request (must be registered BEFORE any
// route that reads req.principal, including /auth/me), CSRF on cookie mutations under /api.
app.use(auth.authMiddleware);
auth.registerAuthRoutes(app);
app.use('/api', auth.csrfMiddleware);

// --- Board Routes ---

app.get('/api/boards', auth.requireAuth, async (req, res) => {
  res.json(await db.visibleBoardsFor(req.principal));
});

app.post('/api/boards', auth.requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Board name is required' });
  const board = await db.createBoard(name.trim());
  res.status(201).json(board);
});

app.get('/api/boards/:id', auth.requireBoardAccess, async (req, res) => {
  const board = await db.getBoard(req.params.id);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  res.json(board);
});

app.put('/api/boards/:id', auth.requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Board name is required' });
  const board = await db.updateBoard(req.params.id, name.trim());
  if (!board) return res.status(404).json({ error: 'Board not found' });
  res.json(board);
});

app.delete('/api/boards/:id', auth.requireAdmin, async (req, res) => {
  const deleted = await db.deleteBoard(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Board not found' });
  res.status(204).end();
});

// --- Card Routes ---

app.get('/api/boards/:boardId/cards', auth.requireBoardAccess, async (req, res) => {
  const board = await db.getBoard(req.params.boardId);
  if (!board) return res.status(404).json({ error: 'Board not found' });

  // `column` and `status` are aliases for filtering by column
  const { column, status } = req.query;
  const filters = {};
  if (column || status) {
    const validColumns = ['todo', 'in-progress', 'blocked', 'in-review', 'done'];
    const value = column || status;
    if (!validColumns.includes(value)) {
      return res.status(400).json({ error: `Invalid column. Must be one of: ${validColumns.join(', ')}` });
    }
    filters.column = value;
  }

  res.json(await db.listCards(req.params.boardId, filters));
});

app.post('/api/boards/:boardId/cards', auth.requireBoardAccess, async (req, res) => {
  const board = await db.getBoard(req.params.boardId);
  if (!board) return res.status(404).json({ error: 'Board not found' });

  const { title, description, column, assignee, priority } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Card title is required' });

  const validColumns = ['todo', 'in-progress', 'blocked', 'in-review', 'done'];
  const col = (column && validColumns.includes(column)) ? column : 'todo';

  const card = await db.createCard(req.params.boardId, title.trim(), description || '', col, assignee || '', priority);
  res.status(201).json(card);
});

// Card search for the dependency picker (S-275). Registered BEFORE
// /api/cards/:id so "search" is not swallowed as a card id.
// Non-admin/non-agent principals only see cards on boards they can see.
app.get('/api/cards/search', auth.requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });
  let boardId = req.query.board_id || null;
  if (boardId) {
    const board = await db.getBoard(boardId);
    if (!board) return res.status(404).json({ error: 'Board not found' });
  }
  let results = await db.searchCards(q, { boardId });
  if (!db.seesAllBoards(req.principal)) {
    const visible = new Set((await db.visibleBoardsFor(req.principal)).map((b) => b.id));
    results = results.filter((c) => visible.has(c.board_id));
  }
  res.json(
    results.slice(0, 20).map((c) => ({
      id: c.id,
      ref: c.ref,
      title: c.title,
      column: c.column,
      board_id: c.board_id,
    }))
  );
});

app.get('/api/cards/:id', auth.requireCardAccess, async (req, res) => {
  const card = await db.getCard(req.params.id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  res.json(card);
});

app.patch('/api/cards/:id', auth.requireCardAccess, async (req, res) => {
  const { title, description, column, assignee, priority } = req.body;
  // K-28: the description is the stable task statement. Token-authenticated
  // agents (the ones that were overwriting it with progress notes) may not
  // change it at all — progress goes to POST /api/cards/:id/comments.
  // Browser sessions (Ross) can still edit descriptions.
  if (description !== undefined && req.principal && req.principal.via === 'token') {
    return res.status(400).json({
      error: 'description_immutable_for_agents',
      hint: `Progress updates go in comments: kb comment ${req.params.id} "your update" (POST /api/cards/${req.params.id}/comments). The description must not change during the card lifecycle.`,
    });
  }
  const updates = {};
  if (title !== undefined) updates.title = title.trim();
  if (description !== undefined) updates.description = description;
  if (assignee !== undefined) updates.assignee = assignee;
  if (priority !== undefined) updates.priority = priority;
  if (column !== undefined) {
    const validColumns = ['todo', 'in-progress', 'blocked', 'in-review', 'done'];
    if (!validColumns.includes(column)) return res.status(400).json({ error: 'Invalid column' });
    updates.column = column;
  }
  // S-275 claim guard: token-authenticated agents may not start a card that
  // still has unsatisfied dependencies (depended card not 'done'). Browser
  // sessions are never blocked — same token-vs-session split as the K-28
  // description_immutable_for_agents guard above. Checked BEFORE any write:
  // on 409 nothing is applied.
  if (updates.column === 'in-progress' && req.principal && req.principal.via === 'token') {
    const blocked = await db.unsatisfiedDependencies(req.params.id);
    if (blocked.length > 0) {
      return res.status(409).json({
        error: 'dependencies_unsatisfied',
        blocked: blocked.map((d) => ({ id: d.id, ref: d.ref, title: d.title, column: d.column })),
      });
    }
  }
  const card = await db.updateCard(req.params.id, updates);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  res.json(card);
});

// --- Comment Routes (K-28) ---
// Append-only progress log per card. See migrations/003_card_comments.sql.

app.get('/api/cards/:id/comments', auth.requireCardAccess, async (req, res) => {
  const card = await db.getCard(req.params.id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  res.json(await db.listComments(req.params.id));
});

app.post('/api/cards/:id/comments', auth.requireCardAccess, async (req, res) => {
  const card = await db.getCard(req.params.id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  const bodyText = req.body && req.body.body != null ? String(req.body.body) : '';
  if (!bodyText.trim()) return res.status(400).json({ error: 'Comment body is required' });
  if (bodyText.length > 4000) return res.status(400).json({ error: 'Comment too long (max 4000 chars)' });
  const author = String(
    (req.body && req.body.author) || (req.principal && req.principal.login) || 'unknown'
  )
    .trim()
    .slice(0, 100);
  const comment = await db.addComment(req.params.id, author || 'unknown', bodyText.trim());
  res.status(201).json(comment);
});

// --- Dependency Routes (S-275) ---
// Directed edges: card --depends_on--> target. Satisfied iff target is 'done'.
// See migrations/004_card_dependencies.sql.

app.get('/api/cards/:id/dependencies', auth.requireCardAccess, async (req, res) => {
  const card = await db.getCard(req.params.id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  res.json({
    depends_on: await db.listDependencies(req.params.id),
    dependents: await db.listDependents(req.params.id),
  });
});

app.post('/api/cards/:id/dependencies', auth.requireCardAccess, async (req, res) => {
  const card = await db.getCard(req.params.id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  const raw = String((req.body && req.body.depends_on) || '').trim();
  if (!raw) return res.status(400).json({ error: 'depends_on is required' });

  // The target may be a card UUID or a human ref like "S-275" / "K-28".
  let target;
  if (/^[A-Za-z]-\d+$/.test(raw)) {
    const matches = await db.findCardsByRef(raw);
    if (matches.length === 0) return res.status(404).json({ error: 'target_not_found' });
    // Boards can share a first letter: prefer a match on the same board as
    // the source card; otherwise require a unique global match.
    target = matches.find((m) => m.board_id === card.board_id) || (matches.length === 1 ? matches[0] : null);
    if (!target) {
      return res
        .status(409)
        .json({ error: 'ambiguous_ref', matches: matches.map((m) => ({ id: m.id, ref: m.ref, board_id: m.board_id })) });
    }
  } else {
    target = await db.getCard(raw);
    if (!target) return res.status(404).json({ error: 'target_not_found' });
  }

  try {
    await db.addDependency(card.id, target.id);
    res.status(201).json({ card_id: card.id, depends_on: target.id });
  } catch (err) {
    if (err.code === 'self_dependency') return res.status(400).json({ error: 'self_dependency' });
    if (err.code === 'cycle_detected') {
      return res.status(400).json({ error: 'cycle_detected', path: err.path });
    }
    if (err.code === 'duplicate_dependency') {
      return res.status(409).json({ error: 'duplicate_dependency' });
    }
    throw err;
  }
});

app.delete('/api/cards/:id/dependencies/:dependsOnCardId', auth.requireCardAccess, async (req, res) => {
  const card = await db.getCard(req.params.id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  const removed = await db.removeDependency(req.params.id, req.params.dependsOnCardId);
  if (!removed) return res.status(404).json({ error: 'Dependency not found' });
  res.status(204).end();
});

app.put('/api/cards/:id/move', auth.requireCardAccess, async (req, res) => {
  const { afterCardId } = req.body;
  const moved = await db.reorderCard(req.params.id, afterCardId);
  if (!moved) return res.status(400).json({ error: 'Could not move card' });
  res.json(await db.getCard(req.params.id));
});

app.delete('/api/cards/:id', auth.requireCardAccess, async (req, res) => {
  const deleted = await db.deleteCard(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Card not found' });
  res.status(204).end();
});

app.post('/api/cards/:id/priority/recompute', auth.requireCardAccess, async (req, res) => {
  const card = await db.getCard(req.params.id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  await db.recomputePriorities(card.board_id);
  res.json({ ok: true });
});

app.post('/api/boards/:boardId/cards/priority/recompute', auth.requireBoardAccess, async (req, res) => {
  const board = await db.getBoard(req.params.boardId);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  await db.recomputePriorities(req.params.boardId);
  res.json({ ok: true });
});

// --- Admin API (KB-AUTH-4, all requireAdmin) ---

app.get('/api/admin/users', auth.requireAdmin, async (req, res) => {
  res.json(await db.listUsers());
});

app.patch('/api/admin/users/:id', auth.requireAdmin, async (req, res) => {
  const { role } = req.body || {};
  const target = await db.getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!['admin', 'user', 'agent'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  // Lockout guard: never remove the last admin (self-demotion allowed while
  // another admin exists).
  if (target.role === 'admin' && role !== 'admin') {
    const admins = (await db.listUsers()).filter((u) => u.role === 'admin');
    if (admins.length <= 1) {
      return res.status(409).json({ error: 'cannot_demote_last_admin' });
    }
  }
  res.json(await db.setUserRole(target.id, role));
});

app.get('/api/admin/boards/:id/members', auth.requireAdmin, async (req, res) => {
  const board = await db.getBoard(req.params.id);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  res.json(await db.listBoardMembers(req.params.id));
});

app.post('/api/admin/boards/:id/members', auth.requireAdmin, async (req, res) => {
  const board = await db.getBoard(req.params.id);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  const { userId } = req.body || {};
  if (!userId || !(await db.getUserById(userId))) return res.status(400).json({ error: 'userId is required and must exist' });
  const added = await db.addBoardMember(board.id, userId, req.principal.id);
  res.status(added ? 201 : 200).json({ ok: true, added });
});

app.delete('/api/admin/boards/:id/members/:userId', auth.requireAdmin, async (req, res) => {
  const removed = await db.removeBoardMember(req.params.id, req.params.userId);
  if (!removed) return res.status(404).json({ error: 'Grant not found' });
  res.status(204).end();
});

app.get('/api/admin/tokens', auth.requireAdmin, async (req, res) => {
  res.json(await db.listApiTokens());
});

app.post('/api/admin/tokens', auth.requireAdmin, async (req, res) => {
  const { name, ownerId } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Token name is required' });
  const owner = ownerId ? await db.getUserById(ownerId) : req.principal;
  if (!(await db.getUserById(owner.id))) return res.status(400).json({ error: 'Owner not found' });
  const plaintext = 'kb_' + crypto.randomBytes(20).toString('hex'); // kb_ + 40 hex
  const token = await db.createApiToken({
    name: name.trim(),
    ownerId: owner.id,
    tokenHash: auth.sha256hex(plaintext),
  });
  // Plaintext shown ONCE here; only the hash is stored.
  res.status(201).json({ token: plaintext, id: token.id, name: token.name, owner_login: owner.login });
});

app.delete('/api/admin/tokens/:id', auth.requireAdmin, async (req, res) => {
  const deleted = await db.deleteApiToken(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Token not found' });
  res.status(204).end();
});

// SPA fallback — serve index.html for any non-API route
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) {
    return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
  next();
});

// --- error mapping (KB-PG-4) ---
// A database that is mid-failover is 503 + Retry-After, not 500. 500 means
// "the app is broken"; 503 means "a dependency is briefly unavailable, try
// again" — and it is the honest answer while Patroni elects a new primary.
// Registered last so it also catches Express 5's async-rejection forwarding.
app.use('/api', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (db.isDatabaseUnavailable(err)) {
    console.warn(
      `[api] database unavailable on ${req.method} ${req.path}: ${err.code || err.message}`
    );
    res.setHeader('Retry-After', '5');
    return res.status(503).json({ error: 'database_unavailable' });
  }
  console.error(`[api] unhandled error on ${req.method} ${req.path}:`, err);
  return res.status(500).json({ error: 'internal_error' });
});

if (require.main === module) {
  // Run migrations/bootstrap before accepting traffic; fail fast on boot errors.
  db.ready()
    .then(() => {
      const server = app.listen(PORT, HOST, () => {
        const addr = server.address();
        console.log(`\n  🐰 Kanbunny is running!`);
        console.log(`  → http://localhost:${PORT}`);
        console.log(`  → LAN:  http://${addr.address === '::' ? '[::]' : addr.address}:${PORT}`);
        console.log(`  → API:  http://localhost:${PORT}/api/boards\n`);
      });
    })
    .catch((err) => {
      console.error('Kanbunny boot failed:', err);
      process.exit(1);
    });
}

module.exports = app;
