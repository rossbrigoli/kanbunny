-- 002_auth_tables.sql
-- Auth schema (OIDC users, board membership, API tokens) per
-- docs/oidc-auth-design.md §3, converted from the live SQLite schema.
--   users.id       = Dex OIDC subject once logged in; 'pending:<login>'
--                   placeholder for bootstrap admins (re-keyed on first login).
--   board_members  = per-board grants; admins/agents see all implicitly.
--   api_tokens     = agent/automation bearer tokens, sha256 hashes only.
-- Timestamps: TIMESTAMPTZ (SQLite stored UTC TEXT; same instants).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user', 'agent')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS board_members (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_board_members_user ON board_members(user_id);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_owner ON api_tokens(owner_id);
