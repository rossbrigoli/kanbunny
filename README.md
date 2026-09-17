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

## SQLite To Postgres Migration

The migration utility checkpoints and copies the SQLite database first, then reads the copy read-only and imports rows into Postgres in FK-safe order.

```bash
DATABASE_URL=postgres://kanbunny:password@host:5432/kanbunny \
  npm run migrate:sqlite-to-postgres -- --sqlite /path/to/kanbunny.db
```

Do not run this against production until the target Postgres service is provisioned and the cutover plan is approved.
