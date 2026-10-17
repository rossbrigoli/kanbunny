# Kanbunny

Kanbunny is a lightweight Express 5 kanban app with a static SPA in `public/`.

## Runtime

The app stores data in PostgreSQL via `pg.Pool`.

Required environment:

```bash
DATABASE_URL=postgres://kanbunny:password@kanbunny-postgres:5432/kanbunny
```

Useful optional environment:

```bash
PORT=3500
HOST=0.0.0.0
KANBUNNY_SESSION_SECRET=...
KANBUNNY_OIDC_CLIENT_SECRET=...
KANBUNNY_BOOTSTRAP_ADMINS=rossbrigoli
```

Schema migrations live in `migrations/` and are applied idempotently at boot through `schema_migrations`.

## Mobile board UX (K-26)

On phones (≤768px) the board renders one column at a time. Two dependency-free mechanisms move cards between columns:

- **Column drop dock** — while a touch-drag is active (started from the card drag handle), a fixed bottom dock shows all five columns as chips. The chip under the finger highlights; releasing over it moves the card there (`PATCH /api/cards/{id}`, optimistic UI, revert via reload on failure). While over the dock, card-to-card targeting is skipped and the page cannot scroll (`touch-action: none`).
- **Move-to sheet** — every card has a move button (mobile-only) that opens a bottom sheet picker; no dragging required. The card's current column is shown disabled in the sheet.

Swipe navigation is suppressed during and immediately after a card drag so drags don't accidentally change columns. Desktop drag-and-drop is unchanged; all new UI is hidden outside the mobile media query.

Code: `public/app.js` (`showMobileDropDock`/`chipUnderPoint`/`commitColumnMove`/`openMoveSheet`), markup in `public/index.html` (`#mobileDropDock`, `#moveSheetOverlay`), styles in `public/style.css` under `@media (max-width: 768px)`.

## Development

Install dependencies:

```bash
npm install
```

Start the app:

```bash
npm run dev
```

## Tests

Tests run against a real local Postgres instance, not a mock.

```bash
podman run -d --name kanbunny-pg-test -p 55432:5432 \
  -e POSTGRES_USER=kanbunny \
  -e POSTGRES_PASSWORD=kanbunny \
  -e POSTGRES_DB=kanbunny \
  postgres:16

npm test
```

`npm test` resets per-file test databases before running.

## Task Dependencies (S-275)

Cards can depend on other cards (`card --depends_on--> target`). A dependency is **satisfied** iff the depended-on card is in column `done`. Cross-board dependencies are allowed. Data lives in `migrations/004_card_dependencies.sql` (`card_dependencies`, both FKs cascade-delete with the card).

### API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/cards/{id}/dependencies` | `{"depends_on":[...], "dependents":[...]}` — each entry has `id`, `ref`, `title`, `column`, `board_id`, `dependency_id`, `dependency_created_at`. |
| `POST` | `/api/cards/{id}/dependencies` | Body `{"depends_on": "<card-id or ref like S-275>"}` → `201`. Refs resolve case-insensitively; same-board match wins, otherwise a unique global match is required (`409 ambiguous_ref`). |
| `DELETE` | `/api/cards/{id}/dependencies/{dependsOnCardId}` | `204`, or `404` if the edge does not exist. |
| `GET` | `/api/cards/search?q=<term>&board_id=<optional>` | Up to 20 cards `{id, ref, title, column, board_id}` — case-insensitive exact ref match (e.g. `s-275`) OR title substring. Non-admin/non-agent principals only see cards on visible boards. |

POST error codes:

- `400 {"error":"self_dependency"}` — a card cannot depend on itself.
- `400 {"error":"cycle_detected","path":[...]}` — the new edge would close a **transitive** cycle (recursive CTE in `db.addDependency`); `path` is the card-id chain that would loop.
- `409 {"error":"duplicate_dependency"}` — the edge already exists.
- `404 {"error":"target_not_found"}` — unknown card id/ref.

### Claim guard (the core rule)

When a **token/bearer-authenticated agent** `PATCH`es a card setting `column` to `in-progress` and the card has ≥1 unsatisfied dependency, the API responds `409 {"error":"dependencies_unsatisfied","blocked":[{id, ref, title, column}...]}` and applies **nothing**. Browser/session principals are never blocked — the same token-vs-session split as the K-28 `description_immutable_for_agents` guard. Moves to other columns are unrestricted.

### Board listing

`GET /api/boards/{id}/cards` includes `dependencies_pending` per card (count of depends-on cards not yet `done`), computed with one correlated subquery — no N+1. The board UI shows a 🔗 badge with that count.

### UI

The card modal has a **Dependencies** section: depends-on list (ref, title, colored column badge, open-card button, `×` remove in session mode), a read-only "Needed by" (dependents) list, and an add row with a debounced (~250 ms) search dropdown hitting `/api/cards/search`. Works on desktop and mobile via the existing modal styles.

## SQLite To Postgres Migration

The migration utility checkpoints and copies the SQLite database first, then reads the copy read-only and imports rows into Postgres in FK-safe order.

```bash
DATABASE_URL=postgres://kanbunny:password@host:5432/kanbunny \
  npm run migrate:sqlite-to-postgres -- --sqlite /path/to/kanbunny.db
```

Do not run this against production until the target Postgres service is provisioned and the cutover plan is approved.
