#!/usr/bin/env bash
# Reset per-test-file databases on the local test Postgres (KB-PG-2).
# Requires the test container to be running, e.g.:
#   podman run -d --name kanbunny-pg-test -p 55432:5432 \
#     -e POSTGRES_USER=kanbunny -e POSTGRES_PASSWORD=*** -e POSTGRES_DB=kanbunny postgres:16
#
# Each test file gets its OWN database so `node --test` parallelism is safe.
set -euo pipefail

PG_CONTAINER=${KANBUNNY_TEST_PG_CONTAINER:-kanbunny-pg-test}
DBS=(kanbunny_test_api kanbunny_test_authz kanbunny_test_auth kanbunny_test_cardref kanbunny_test_debug kanbunny_test_layer kanbunny_test_migration kanbunny_test_hares)

if ! podman exec "$PG_CONTAINER" pg_isready -U kanbunny -q 2>/dev/null; then
  echo "ERROR: test Postgres container '$PG_CONTAINER' is not ready." >&2
  echo "Start it with the podman run command in this script's header comment." >&2
  exit 1
fi

for db in "${DBS[@]}"; do
  podman exec "$PG_CONTAINER" psql -U kanbunny -d postgres -v ON_ERROR_STOP=1 -q \
    -c "DROP DATABASE IF EXISTS $db WITH (FORCE);" \
    -c "CREATE DATABASE $db OWNER kanbunny;"
done
echo "OK: test databases reset: ${DBS[*]}"
