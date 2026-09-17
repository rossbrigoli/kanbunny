// Harness: start kanbunny on a random port for API tests, print port to stdout.
// KB-PG-2: Postgres-backed. Requires the test PG container + reset DBs
// (see tests/setup-test-pg.sh).
process.env.DATABASE_URL =
  process.env.KANBUNNY_TEST_PG_URL || 'postgres://kanbunny:kanbunny@127.0.0.1:55432/kanbunny_test_api';
process.env.KANBUNNY_ALLOW_UNAUTH = '1'; // legacy pre-cutover behaviour

const db = require('../src/db');
const app = require('../src/server');

db.ready()
  .then(
    () =>
      new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => {
          const port = server.address().port;
          console.log('KANBUNNY_TEST_PORT=' + port);
          resolve(server);
        });
      })
  )
  .catch((err) => {
    console.error('test harness boot failed:', err);
    process.exit(1);
  });

process.on('SIGTERM', () => {
  process.exit(0);
});
