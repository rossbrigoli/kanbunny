-- 001_initial_schema.sql
-- Core boards + cards schema, converted from the live SQLite schema (dumped
-- 2026-09-17) to PostgreSQL. Differences from SQLite are type-level only:
--   * TEXT timestamps (UTC via datetime('now'))  -> TIMESTAMPTZ (DEFAULT now())
--   * INTEGER stays INTEGER (position, priority, card_number)
--   * `column` is quoted (reserved word in Postgres)
-- The consolidated schema here matches the *final* live SQLite state
-- (assignee/priority/card_number already migrated, CHECK includes 'blocked').

CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  assignee TEXT NOT NULL DEFAULT '',
  "column" TEXT NOT NULL DEFAULT 'todo'
    CHECK ("column" IN ('todo', 'in-progress', 'blocked', 'in-review', 'done')),
  position INTEGER NOT NULL DEFAULT 0,
  priority INTEGER DEFAULT NULL,
  card_number INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-board immutable human ID sequence ("X-N" ref).
CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_board_number ON cards(board_id, card_number);

-- Seed a default board if none exists (same behaviour as the SQLite bootstrap).
INSERT INTO boards (id, name)
SELECT 'default', 'My Board'
WHERE NOT EXISTS (SELECT 1 FROM boards WHERE id = 'default');
