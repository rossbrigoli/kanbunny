// Harness: start kanbunny on a random port for API tests, print port to stdout
const path = require('path');
const fs = require('fs');

const TEST_DB = process.env.KANBUNNY_DB_PATH || path.join(__dirname, '..', 'kanbunny.test-api.db');
process.env.KANBUNNY_DB_PATH = TEST_DB;
process.env.KANBUNNY_ALLOW_UNAUTH = '1'; // legacy pre-cutover behaviour

// Clean slate
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
if (fs.existsSync(TEST_DB + '-wal')) fs.unlinkSync(TEST_DB + '-wal');
if (fs.existsSync(TEST_DB + '-shm')) fs.unlinkSync(TEST_DB + '-shm');

const app = require('../src/server');

const server = app.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  console.log('KANBUNNY_TEST_PORT=' + port);
});

process.on('SIGTERM', () => {
  server.close(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (fs.existsSync(TEST_DB + '-wal')) fs.unlinkSync(TEST_DB + '-wal');
    if (fs.existsSync(TEST_DB + '-shm')) fs.unlinkSync(TEST_DB + '-shm');
    process.exit(0);
  });
});
