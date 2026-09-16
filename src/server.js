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

// Auth: principal resolution for every request (must be registered BEFORE any
// route that reads req.principal, including /auth/me), CSRF on cookie mutations under /api.
app.use(auth.authMiddleware);
auth.registerAuthRoutes(app);
app.use('/api', auth.csrfMiddleware);

// --- Board Routes ---

app.get('/api/boards', auth.requireAuth, (req, res) => {
  res.json(db.visibleBoardsFor(req.principal));
});

app.post('/api/boards', auth.requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Board name is required' });
  const board = db.createBoard(name.trim());
  res.status(201).json(board);
});

app.get('/api/boards/:id', auth.requireBoardAccess, (req, res) => {
  const board = db.getBoard(req.params.id);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  res.json(board);
});

app.put('/api/boards/:id', auth.requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Board name is required' });
  const board = db.updateBoard(req.params.id, name.trim());
  if (!board) return res.status(404).json({ error: 'Board not found' });
  res.json(board);
});

app.delete('/api/boards/:id', auth.requireAdmin, (req, res) => {
  const deleted = db.deleteBoard(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Board not found' });
  res.status(204).end();
});

// --- Card Routes ---

app.get('/api/boards/:boardId/cards', auth.requireBoardAccess, (req, res) => {
  const board = db.getBoard(req.params.boardId);
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

  res.json(db.listCards(req.params.boardId, filters));
});

app.post('/api/boards/:boardId/cards', auth.requireBoardAccess, (req, res) => {
  const board = db.getBoard(req.params.boardId);
  if (!board) return res.status(404).json({ error: 'Board not found' });

  const { title, description, column, assignee, priority } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Card title is required' });

  const validColumns = ['todo', 'in-progress', 'blocked', 'in-review', 'done'];
  const col = (column && validColumns.includes(column)) ? column : 'todo';

  const card = db.createCard(req.params.boardId, title.trim(), description || '', col, assignee || '', priority);
  res.status(201).json(card);
});

app.get('/api/cards/:id', auth.requireCardAccess, (req, res) => {
  const card = db.getCard(req.params.id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  res.json(card);
});

app.patch('/api/cards/:id', auth.requireCardAccess, (req, res) => {
  const { title, description, column, assignee, priority } = req.body;
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
  const card = db.updateCard(req.params.id, updates);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  res.json(card);
});

app.put('/api/cards/:id/move', auth.requireCardAccess, (req, res) => {
  const { afterCardId } = req.body;
  const moved = db.reorderCard(req.params.id, afterCardId);
  if (!moved) return res.status(400).json({ error: 'Could not move card' });
  res.json(db.getCard(req.params.id));
});

app.delete('/api/cards/:id', auth.requireCardAccess, (req, res) => {
  const deleted = db.deleteCard(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Card not found' });
  res.status(204).end();
});

app.post('/api/cards/:id/priority/recompute', auth.requireCardAccess, (req, res) => {
  const card = db.getCard(req.params.id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  db.recomputePriorities(card.board_id);
  res.json({ ok: true });
});

app.post('/api/boards/:boardId/cards/priority/recompute', auth.requireBoardAccess, (req, res) => {
  const board = db.getBoard(req.params.boardId);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  db.recomputePriorities(req.params.boardId);
  res.json({ ok: true });
});

// --- Admin API (KB-AUTH-4, all requireAdmin) ---

app.get('/api/admin/users', auth.requireAdmin, (req, res) => {
  res.json(db.listUsers());
});

app.patch('/api/admin/users/:id', auth.requireAdmin, (req, res) => {
  const { role } = req.body || {};
  const target = db.getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!['admin', 'user', 'agent'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  // Lockout guard: never remove the last admin (self-demotion allowed while
  // another admin exists).
  if (target.role === 'admin' && role !== 'admin') {
    const admins = db.listUsers().filter((u) => u.role === 'admin');
    if (admins.length <= 1) {
      return res.status(409).json({ error: 'cannot_demote_last_admin' });
    }
  }
  res.json(db.setUserRole(target.id, role));
});

app.get('/api/admin/boards/:id/members', auth.requireAdmin, (req, res) => {
  const board = db.getBoard(req.params.id);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  res.json(db.listBoardMembers(req.params.id));
});

app.post('/api/admin/boards/:id/members', auth.requireAdmin, (req, res) => {
  const board = db.getBoard(req.params.id);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  const { userId } = req.body || {};
  if (!userId || !db.getUserById(userId)) return res.status(400).json({ error: 'userId is required and must exist' });
  const added = db.addBoardMember(board.id, userId, req.principal.id);
  res.status(added ? 201 : 200).json({ ok: true, added });
});

app.delete('/api/admin/boards/:id/members/:userId', auth.requireAdmin, (req, res) => {
  const removed = db.removeBoardMember(req.params.id, req.params.userId);
  if (!removed) return res.status(404).json({ error: 'Grant not found' });
  res.status(204).end();
});

app.get('/api/admin/tokens', auth.requireAdmin, (req, res) => {
  res.json(db.listApiTokens());
});

app.post('/api/admin/tokens', auth.requireAdmin, (req, res) => {
  const { name, ownerId } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Token name is required' });
  const owner = ownerId ? db.getUserById(ownerId) : req.principal;
  if (!db.getUserById(owner.id)) return res.status(400).json({ error: 'Owner not found' });
  const plaintext = 'kb_' + crypto.randomBytes(20).toString('hex'); // kb_ + 40 hex
  const token = db.createApiToken({
    name: name.trim(),
    ownerId: owner.id,
    tokenHash: auth.sha256hex(plaintext),
  });
  // Plaintext shown ONCE here; only the hash is stored.
  res.status(201).json({ token: plaintext, id: token.id, name: token.name, owner_login: owner.login });
});

app.delete('/api/admin/tokens/:id', auth.requireAdmin, (req, res) => {
  const deleted = db.deleteApiToken(req.params.id);
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

if (require.main === module) {
  const server = app.listen(PORT, HOST, () => {
    const addr = server.address();
    console.log(`\n  🐰 Kanbunny is running!`);
    console.log(`  → http://localhost:${PORT}`);
    console.log(`  → LAN:  http://${addr.address === '::' ? '[::]' : addr.address}:${PORT}`);
    console.log(`  → API:  http://localhost:${PORT}/api/boards\n`);
  });
}

module.exports = app;
