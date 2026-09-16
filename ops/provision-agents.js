#!/usr/bin/env node
// Provision fixed agent service accounts + API tokens (KB-AUTH-7 / Gate 2).
// Run INSIDE the kanbunny pod against the live DB. Idempotent: re-running
// reuses existing users and only adds tokens that don't already exist.
//
// The generated plaintext tokens are printed to stdout ONCE (JSON) and are
// NOT stored anywhere by this script — capture them into each agent's
// workspace TOOLS.md. Only the SHA-256 hash is persisted in the DB.
//
// Usage (in pod):  node /tmp/provision-agents.js [agentname ...]
//   With no args, provisions the default set. Pass names to add specific agents.
'use strict';
const crypto = require('crypto');
const db = require('/app/src/db');
const auth = require('/app/src/auth');

const DEFAULT_AGENTS = ['sherlock', 'juan', 'botioc'];
const AGENTS = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_AGENTS;

function main() {
  const conn = db.getDb();
  conn.pragma('busy_timeout = 8000'); // don't fight the running app's WAL writer

  const out = {};
  for (const name of AGENTS) {
    const id = `agent:${name}`;
    const login = `agent:${name}`;

    // 1) Ensure the service-account user row exists with role 'agent'.
    let user = db.getUserById(id);
    if (!user) {
      db.upsertUserFromOidc(id, login); // inserts role='user'
      db.setUserRole(id, 'agent');
      user = db.getUserById(id);
      console.error(`created user ${id} role=${user.role}`);
    } else if (user.role !== 'agent') {
      db.setUserRole(id, 'agent');
      user = db.getUserById(id);
      console.error(`re-keyed user ${id} role=${user.role}`);
    } else {
      console.error(`user ${id} already present role=agent`);
    }

    // 2) Issue a token only if this agent has none yet (idempotent).
    const existing = db.listApiTokens
      ? db.listApiTokens().filter((t) => t.owner_id === id)
      : [];
    if (existing.length > 0) {
      console.error(`agent ${id} already has ${existing.length} token(s); NOT re-issuing`);
      out[name] = { tokenId: existing[0].id, plaintext: null, note: 'already-issued' };
      continue;
    }

    const plaintext = 'kb_' + crypto.randomBytes(20).toString('hex');
    const token = db.createApiToken({
      name: `${name}-curl`,
      ownerId: id,
      tokenHash: auth.sha256hex(plaintext),
    });
    out[name] = { tokenId: token.id, plaintext };
    console.error(`issued token ${token.name} (${token.id}) for ${id}`);
  }

  // Machine-readable result on stdout (capture this).
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main();
