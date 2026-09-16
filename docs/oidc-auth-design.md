# Kanbunny — OIDC Authentication + Role-Based Authorization Design

**Date:** 2026-09-16 · **Author:** Sherlock · **Status:** Proposed
**Driver card:** K-? `694a58bb-01d5-4628-9c77-f8430a1e281d` (Kanbunny board)

---

## 1. Goals, Constraints, Context

**Goals**
- Browser users authenticate via **Dex (OIDC) → GitHub OAuth** (org-gated: `ross-private-cloud`).
- Admin can **grant access** to other users and **assign roles**.
- Roles: **Admin** (full control, today's behaviour) · **User** (no board create/delete; sees only assigned boards).

**Constraints / facts (verified)**
- Kanbunny: Express 5 + better-sqlite3, SPA (`public/`), **zero auth today**. API is also consumed by agents (Sherlock/Juan/Botioc) via plain `curl` — this traffic must keep working.
- Dex already deployed: issuer `https://cloud.rossbrigoli.com/auth`, GitHub connector gated to org `ross-private-cloud`, `teamNameField: slug`, clients registered via `staticClients` + `secretEnv` from `dex-clients` sealed secret. Existing clients: `kubernetes-cluster`, `headlamp`, `argocd` — we follow the same pattern.
- Kanbunny ingress: `kanbunny.lab` + `kanbunny.rossbrigoli.com` (Traefik IngressRoute).
- Dex does **not** support `client_credentials` grant → agents cannot get tokens from Dex; app-issued API tokens are required regardless.

---

## 2. Decision: Where to enforce authn/authz

| Option | Verdict | Why |
|---|---|---|
| **A. App-level OIDC RP** (Kanbunny server is the relying party; session cookie; role checks in middleware) | ✅ **Chosen** | Per-board authorization *must* live in the app anyway (user→board mapping is app data). One component, no new infra, agent-token story unified. |
| B. oauth2-proxy sidecar in front | ❌ | Solves authn only; board-level authz still needs app changes; adds a component + its own secrets; agent curl traffic still needs a separate token path — worst of both. |
| C. Traefik forwardAuth | ❌ | Same objection as B, plus a custom verifier service. |

**Key insight:** a proxy cannot answer "may this user see board X" without calling Kanbunny's data — so moving authn to a proxy buys nothing while adding a moving part.

---

## 3. Identity & Role Model

### Principals
1. **Human users** — log in via Dex/GitHub. Identity = Dex `sub` (stable GitHub numeric id); `login` = GitHub login for display.
2. **Agents/automation** — long-lived **API tokens** issued by an admin in the admin UI: `kb_<random40>`, stored **SHA-256 hashed**, sent as `Authorization: Bearer kb_...`.

### Roles (stored per principal)
| Role | Boards | Board create/delete | Card CRUD | User/role/board-access admin |
|---|---|---|---|---|
| `admin` | all (implicit) | ✅ | ✅ | ✅ |
| `user` | **only assigned** | ❌ (403) | ✅ on assigned boards | ❌ |
| `agent` | explicit scope list | ❌ | ✅ on scoped boards | ❌ |

- **Bootstrap:** env `KANBUNNY_BOOTSTRAP_ADMINS=rossbrigoli` — first login(s) with these GitHub logins are promoted to `admin` automatically (idempotent).
- **New Dex users:** created on first login with role `user` and **zero board grants** → they see a "requested access" empty state. Admin grants boards (and optionally promotes). Deny-by-default.
- GitHub org membership (`ross-private-cloud`) is the outer gate (enforced by Dex already); Kanbunny-level grants are the inner gate. Team membership alone grants nothing in-app — mirrors the cluster's oidc-rbac "Plan B" philosophy.

### Data model (SQLite migrations)
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,              -- Dex sub
  login TEXT NOT NULL UNIQUE,       -- GitHub login
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user','agent')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE TABLE board_members (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (board_id, user_id)
);
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,               -- e.g. "sherlock-curl"
  token_hash TEXT NOT NULL UNIQUE,  -- sha256 of kb_...
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- role read from owner
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```
- Agents are rows in `users` with role `agent` (login e.g. `agent:sherlock`) so token→owner→role is one lookup; board grants reuse `board_members`.
- **Migration of existing data:** all existing boards become admin-only (no `board_members` rows needed — admins see everything). No user rows exist pre-auth → nothing to backfill except bootstrap admin on first login.

---

## 4. AuthN Flow (browser)

```
SPA (no session) ── 401 JSON from API ──▶ GET /auth/login
     Kanbunny: generate state+nonce (signed short-lived cookie)
     ──302──▶ Dex /auth?client_id=kanbunny&state=..&nonce=..&scope=openid profile
     ──▶ GitHub (Dex connector) ──▶ Dex callback ──302──▶ GET /auth/callback?code=..&state=..
     Kanbunny: verify state → exchange code at Dex token endpoint → verify id_token
     (JWKS: /.well-known/openid-configuration; check iss, aud, exp, nonce)
     Upsert users row → issue session cookie:
       KanbunnySessionJWT: HS256, secret=KANBUNNY_SESSION_SECRET, TTL 8h,
       claims {sub, login, role, iat, exp}
     ──302──▶ /  (SPA boots, now authenticated)
```

- **API responses stay JSON:** unauthenticated API calls get `401 {"error":"unauthenticated","login":"/auth/login"}` — SPA intercepts and redirects; agents never see HTML redirects.
- **Logout:** `POST /auth/logout` clears the cookie (stateless JWT — no server-side revocation; TTL bounds exposure. Token revocation for agents *is* supported: delete `api_tokens` row).
- **CSRF:** cookie is `HttpOnly; Secure; SameSite=Lax`. Mutations from the SPA additionally require header `X-Kanbunny-CSRF: <value mirrored from a readable non-HttpOnly cookie>` (double-submit). Bearer-token requests are exempt (not cookie-borne).

**Library:** `openid-client` (npm) for discovery/exchange/validation — avoids hand-rolled JWT/JWKS pitfalls. Session = signed JWT cookie (stateless; better-sqlite3 session store is the fallback if revocation for humans is ever needed).

---

## 5. AuthZ Enforcement (middleware)

```
requireAuth      → session cookie OR valid Bearer token → req.principal {id, login, role, boards?}
requireAdmin     → 403 unless role=admin
requireBoardAccess(boardId) → admin: pass; else: board_members row exists, else 404
                              (404 not 403 — don't leak board existence)
```

Route matrix changes:
| Route | Today | After |
|---|---|---|
| `GET /api/boards` | all | admin: all · user/agent: only granted boards |
| `POST /api/boards` | open | **admin** |
| `PUT /api/boards/:id` | open | admin (rename) — *user cannot* |
| `DELETE /api/boards/:id` | open | **admin** |
| `GET/POST /api/boards/:id/cards*` | open | board-access required |
| `GET/PATCH/PUT/DELETE /api/cards/:id` | open | board-access of the card's board (resolve via JOIN) |
| `POST .../priority/recompute` | open | board-access |
| `GET /healthz` | open | stays open (probe) |

New admin API (all `requireAdmin`):
- `GET /api/admin/users` · `PATCH /api/admin/users/:id {role}`
- `GET/POST/DELETE /api/admin/boards/:id/members[/:userId]`
- `GET/POST /api/admin/tokens` · `DELETE /api/admin/tokens/:id` (plaintext shown once at creation)

---

## 6. Dex & Deployment Changes

1. **Dex client** (`manifests/dex/01-configmap.yaml`): add
   ```yaml
   - id: kanbunny
     name: Kanbunny
     secretEnv: KANBUNNY_OIDC_CLIENT_SECRET
     redirectURIs:
       - https://kanbunny.rossbrigoli.com/auth/callback
   ```
   Add `KANBUNNY_OIDC_CLIENT_SECRET` to the `dex-clients` sealed secret via existing `scripts/seal-dex-secrets.sh`.
2. **Kanbunny sealed secret** (new `manifests/kanbunny/03-sealed-secret.yaml`): `KANBUNNY_OIDC_CLIENT_SECRET`, `KANBUNNY_SESSION_SECRET` (32-byte random), `KANBUNNY_BOOTSTRAP_ADMINS=rossbrigoli`.
3. **Deployment env:** `OIDC_ISSUER=https://cloud.rossbrigoli.com/auth`, `OIDC_CLIENT_ID=kanbunny`, callback base derived from `Host` header (allow-list: kanbunny.rossbrigoli.com; `kanbunny.lab` internal stays… decide: **also protect kanbunny.lab** — same session cookie domain won't span `.lab`→https; simplest: on `kanbunny.lab` HTTP, still require login; cookie `Secure` flag can't be set over HTTP → **redirect `kanbunny.lab` to the https host** at Traefik (RedirectScheme-style middleware) so all auth happens over TLS only. Agents on the LAN use `kanbunny.lab` with Bearer tokens only (no browser flow needed there).
4. **Agent rollout:** after tokens are issued, update the kanbunny **SKILL.md** (and Juan/Botioc notes) so all agent curls include `Authorization: Bearer kb_...`. Cut-over order: deploy with auth → agents break (401) → immediately update skills with tokens. Keep a brief window where `KANBUNNY_ALLOW_UNAUTH=1` env can emergency-restore old behaviour (default off; documented escape hatch, remove after cutover verified).

---

## 7. Failure Modes & Risks

| Risk | Analysis | Mitigation |
|---|---|---|
| Dex down → nobody logs in | Agents unaffected (Bearer tokens are local). Humans can't log in. | Acceptable (home lab); sessions valid until TTL for already-logged-in users. |
| Session secret leak | Forge admin sessions | Sealed secret, not in plain git; rotate = bump sealed secret + rollout (invalidates all sessions). |
| Stale role in JWT after demotion | User keeps old role up to 8h TTL | Short TTL; optional `token_version` column checked on read for instant revoke (defer, add if needed). |
| Agent token leak | Bearer token = full owner scope | Hashed at rest; per-agent tokens (revocable individually); `last_used_at` audit; name tokens per agent. |
| CSRF on cookie mutations | Classic | SameSite=Lax + double-submit header + JSON-only API. |
| `kanbunny.lab` over plain HTTP | Cookie theft on LAN | 301 to https host; LAN-only exposure today anyway; Bearer-only on .lab. |
| Board-existence leak | 403 vs 404 | Return 404 for non-granted boards. |
| Migration breaks agent access (regression) | All agent automation halts | `KANBUNNY_ALLOW_UNAUTH` escape hatch + staged cutover + smoke tests. |

---

## 8. Alternatives Considered (rejected)

- **oauth2-proxy / forwardAuth:** see §2 — authz still app-side; extra component.
- **K8s RBAC (oidc-rbac style):** Kanbunny isn't the K8s API; not applicable.
- **Dex groups → Kanbunny roles (e.g. team `kanbunny-admin`):** tempting for zero-UI role management, but the card explicitly wants *in-app grants per user/board*, and GitHub team edits are a coarser lever. We keep role in DB; can layer group-mapping later (config: `KANBUNNY_ADMIN_GROUP=ross-private-cloud:platform`) as a convenience — recommended as a small addition so Ross never locks himself out.

---

## 9. Implementation Task Breakdown

Created on the Kanbunny board (see cards, ordered by dependency):

1. **DB schema + migrations** (users, board_members, api_tokens, bootstrap admin) — no behaviour change yet.
2. **OIDC RP endpoints** (`/auth/login`, `/auth/callback`, `/auth/logout`, openid-client, state/nonce, id_token validation, session JWT).
3. **Auth middleware + route enforcement** (requireAuth/requireAdmin/requireBoardAccess wired into all existing routes; 401 JSON contract; `KANBUNNY_ALLOW_UNAUTH` escape hatch).
4. **Admin API** (users list/role, board members grant/revoke, token CRUD with hash + show-once).
5. **Admin UI + SPA auth UX** (login button on 401, logout, "Admin" page: users/roles/board grants/tokens; empty-state for pending users).
6. **Dex client + secrets + deploy wiring** (configmap client, seal scripts, kanbunny sealed secret, env, https redirect for kanbunny.lab).
7. **Agent token cutover + docs** (issue per-agent tokens, update kanbunny SKILL.md + agent notes, smoke test all agent flows).
8. **E2E test + deploy + verification** (test matrix: admin/user/agent/anonymous × board ops; GitOps deploy; live smoke).

Dependency: 1 → {2,3} → 4 → 5; 6 parallel until deploy; 7 after 3; 8 last.
