-- K-28: per-card comments (append-only progress log).
--
-- Rationale: agents were overwriting cards.description with progress updates,
-- destroying the original task text. Progress updates and discussion now live
-- here; the description is written at creation and stays stable for the whole
-- card lifecycle (enforced API-side: token-authenticated agents cannot PATCH
-- description; browser sessions can).
--
-- Append-only by convention: there is no UPDATE/DELETE endpoint for comments.
-- Comments cascade-delete with their card.

CREATE TABLE IF NOT EXISTS card_comments (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stable read order for a card's timeline.
CREATE INDEX IF NOT EXISTS idx_card_comments_card_time
  ON card_comments(card_id, created_at, id);
