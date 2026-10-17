-- S-275: per-card dependencies (task ordering).
--
-- A row (card_id, depends_on_card_id) means "card_id depends on depends_on_card_id".
-- A dependency is satisfied iff the depended-on card is in column 'done'.
--
-- Enforcement (API-side): token-authenticated agents may not move a card to
-- 'in-progress' while any of its dependencies is unsatisfied (409
-- dependencies_unsatisfied). Browser sessions are never blocked. Cycles are
-- rejected at creation time (transitive, via recursive CTE in db.js); the
-- CHECK constraint below is the last-resort guard against direct self-deps.
--
-- Cross-board dependencies are allowed by design. Dependencies cascade-delete
-- with either endpoint card (both FKs are ON DELETE CASCADE).

CREATE TABLE IF NOT EXISTS card_dependencies (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  depends_on_card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (card_id, depends_on_card_id),
  CHECK (card_id <> depends_on_card_id)
);

-- Both directions are hot: "what does this card need" and "what needs this card".
CREATE INDEX IF NOT EXISTS idx_card_dependencies_card
  ON card_dependencies(card_id);
CREATE INDEX IF NOT EXISTS idx_card_dependencies_depends_on
  ON card_dependencies(depends_on_card_id);
