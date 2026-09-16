# Kanbunny Worklog

## 2026-06-29 20:30:00 ACST

- objective: Refine card drag and drop animations for smoother, more polished UX.
- files changed:
  - `/home/ross/projects/kanbunny/public/app.js`
  - `/home/ross/projects/kanbunny/public/style.css`
- changes:
  - Enhanced drag start: added smooth scale-down (0.92) and rotation (3deg) with spring easing
  - Improved drag ghost: created clone card with elevated shadow and brightness boost
  - Refined drag end: added fade-out animation for placeholder (200ms)
  - Enhanced drop indicator: gradient background, glow effect, smooth position transitions
  - Improved card landing: multi-stage bounce animation (0.85→1.08→0.95→1.02→1) with ripple effect
  - Polished column highlight: spring easing, subtle border glow, smoother transitions
  - Better placeholder: spring animation, glow shadow, smoother fade-in/out
  - All transitions now use cubic-bezier(0.34, 1.56, 0.64, 1) for consistent spring-like feel
- command/test run:
  - `bash ops/k8s/deploy.sh`
- result: Deployed to K3s. Card moved to `in-review` for Ross validation.

## 2026-06-26 06:40:58 ACST

- objective: Move Kanbunny from the lab user systemd service to K3s without exposing it through Caddy.
- files changed:
  - `/home/ross/projects/kanbunny/.dockerignore`
  - `/home/ross/projects/kanbunny/Dockerfile`
  - `/home/ross/projects/kanbunny/ops/k8s/namespace.yaml`
  - `/home/ross/projects/kanbunny/ops/k8s/pv.yaml`
  - `/home/ross/projects/kanbunny/ops/k8s/pvc.yaml`
  - `/home/ross/projects/kanbunny/ops/k8s/deployment.yaml`
  - `/home/ross/projects/kanbunny/ops/k8s/deploy.sh`
  - `/home/ross/.openclaw/skills/kanbunny/SKILL.md`
  - `/home/ross/projects/kanbunny/WORKLOG.md`
- command/test run:
  - `npm test`
  - `podman build -t localhost/kanbunny:latest /home/ross/projects/kanbunny`
  - loaded the image onto optiplex2 (`192.168.68.141`) with `ctr -n k8s.io images import`
  - `sqlite3 kanbunny.db 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA integrity_check;'`
  - `kubectl apply -f /home/ross/projects/kanbunny/ops/k8s`
  - `kubectl rollout status deployment/kanbunny -n kanbunny --timeout=120s`
  - `curl -fsS http://192.168.68.141:30083/api/boards | jq length`
- result: Kanbunny is running in K3s namespace `kanbunny` on optiplex2 with NodePort `30083`, backed by a retained hostPath PV at `/home/ross/k3s-data/kanbunny`. The old user systemd service is stopped/disabled, tests passed before migration, and the API returns 7 boards from the migrated SQLite database.

## 2026-09-08 16:2x ACST — Card human IDs "X-N" (Kanbunny card K-11)
- **Objective:** Kanbunny card `8cf70326` — add an immutable, auto-generated ID field to cards formatted `X-N` (X = first letter of board name, N = per-board sequence, new = max + 1).
- **Design:** stored `card_number INTEGER` per board (immutable; assigned in a transaction at creation as MAX+1); the API computes `ref` = first letter of the *current* board name + `-` + number, so renames re-prefix but numbers never change. Unique index `(board_id, card_number)`.
- **Files changed:**
  - `src/db.js`: migration adds `card_number` + backfills existing cards per board (ordered by column, position); `listCards`/`getCard` now JOIN boards and return `ref`; `createCard` assigns next number transactionally. PATCH whitelist unchanged → clients cannot set card_number (immutable).
  - `public/app.js` + `public/style.css`: ref badge on cards.
  - `tests/card-ref.test.js`: 6 new tests (sequencing across columns, stability across moves/renames, immutability vs client input, max+1 after deletion, list/get exposure, board-rename prefix behavior).
- **Commands run:** `npm test` → 34/34 pass.
- **Deploy:** discovered the live flow is NOT `ops/k8s/deploy.sh` anymore — ArgoCD app `kanbunny` syncs `k3s-cluster/manifests/kanbunny` with image `docker.io/brigss007/kanbunny:<date-tag>`. Built + pushed `brigss007/kanbunny:2026-09-08`, bumped the GitOps manifest (k3s-cluster commit 246ac92).
  - ⚠️ Cluster pull secret `dockerhub-brigss007-pull` now gets **401 Unauthorized** from Docker Hub (repo is private; secret likely stale). Worked around by pre-seeding the image on optiplex2 via `ctr -n k8s.io images import` (imagePullPolicy=IfNotPresent). **Ross: refresh that secret or make the repo public.**
  - Rewrote `ops/k8s/deploy.sh` to follow the real flow (build+push → GitOps bump → ctr pre-seed → rollout watch).
- **Verified live:** existing cards backfilled (this card shows K-11); smoke card on default board ("SwineLog") got S-50 then deleted; `npm test` green.

## 2026-09-16 22:35 ACST — KB-AUTH-1: Auth DB schema (Kanbunny card 4934f0f8)
- **Objective:** Add auth schema (users, board_members, api_tokens) + bootstrap admin support per docs/oidc-auth-design.md §3. No route behaviour changed yet.
- **Files changed:**
  - `src/db.js`: new tables `users` (id=dex sub or `pending:<login>`, login UNIQUE, role CHECK admin|user|agent), `board_members` (PK board_id+user_id, granted_by FK, cascades), `api_tokens` (token_hash UNIQUE sha256, owner FK cascade, last_used_at) + indexes. New helpers: `ensureBootstrapAdmins` (KANBUNNY_BOOTSTRAP_ADMINS env, idempotent), `upsertUserFromOidc` (deny-by-default role=user; re-keys pending bootstrap rows to real sub; login-rename refresh; login_conflict throw), `listUsers/getUserById/getUserByLogin/setUserRole` (validated), `addBoardMember/removeBoardMember/listBoardMembers/isBoardMember`, `visibleBoardsFor` (admin=all, else granted-only), `createApiToken/findPrincipalByTokenHash/touchApiToken/listApiTokens/deleteApiToken`. All exported.
  - `tests/auth-schema.test.js`: 15 new tests (table creation, bootstrap idempotency + env parsing, role CHECK, setUserRole validation, upsert paths incl. pending re-key/login rename/collision, membership idempotency + FK cascades both directions, visibleBoardsFor matrix, token lifecycle incl. unique-hash + cascade).
- **Commands/tests run:**
  - `npm test` → first run 48/49 (test bug: granted_by='admin-1' violated FK — fixed test to use real admin id), final run **49/49 pass**.
- **Result:** Schema live in code; existing board/card tests unaffected. Next: KB-AUTH-2 (OIDC RP endpoints).

## 2026-09-16 23:35 ACST — KB-AUTH-2..6: OIDC authn/authz + deploy prep
- **Objective:** Implement OIDC authn + RBZ (design docs/oidc-auth-design.md) and prepare GitOps deploy.
- **Files changed (kanbunny):**
  - `src/auth.js` (NEW): OIDC RP — /auth/login|callback|logout|/me; state+nonce signed cookie; HS256 session JWT (8h, timingSafeEqual); CSRF double-submit; bearer-token principal resolution (live role); requireAuth/Admin/BoardAccess/CardAccess; TLS-host bounce guard (KANBUNNY_ENFORCE_HTTPS_HOST); KANBUNNY_ALLOW_UNAUTH escape hatch.
  - `src/server.js`: wired authMiddleware + CSRF on /api; enforcement on every route; admin API (users/roles/members/tokens, last-admin guard); unauthenticated /healthz.
  - `public/index.html` + `public/app.js` + `public/style.css`: auth-aware api() (CSRF + 401→login), header user chip/logout/admin, role-hidden board-create, no-access empty state, admin modal (users/roles, board grants, token create show-once/revoke).
  - `tests/auth-enforcement.test.js` (NEW, 23 tests), `tests/auth-schema.test.js` (prior), legacy tests set ALLOW_UNAUTH=1.
- **Commands/tests:**
  - `npm test` → **72/72 pass** (stable x3).
  - `podman build` → docker.io/brigss007/kanbunny:2026-09-17-auth (id 5c0e99c50e89).
  - Container smoke: /healthz 200, open-mode boards/me OK, /auth/login 302 via real Dex discovery.
- **Files changed (k3s-cluster, GitOps, additive):**
  - `manifests/dex/01-configmap.yaml`: + kanbunny staticClient (secretEnv KANBUNNY_OIDC_CLIENT_SECRET, redirect https://kanbunny.rossbrigoli.com/auth/callback).
  - `manifests/dex/03-deployment.yaml`: + KANBUNNY_OIDC_CLIENT_SECRET env from NEW secret dex-kanbunny-client (existing dex-clients secret UNTOUCHED — avoids seal-script trap that would drop argocd key).
  - `manifests/dex/07-sealed-secret-kanbunny-client.yaml` (NEW), `manifests/kanbunny/03-sealed-secret.yaml` (NEW: session secret, oidc client secret, bootstrap admin rossbrigoli).
  - `manifests/kanbunny/01-kanbunny.yaml`: + OIDC env + envFrom kanbunny-secrets + KANBUNNY_ALLOW_UNAUTH=1 (cutover) + probes repointed /api/boards→/healthz.
  - All validated via `kubectl apply --dry-run=server` (clean).
- **Secrets:** generated, stored ~/.openclaw/workspace-agents/sherlock/secrets/kanbunny-oidc.txt (mode 600, not committed).
- **STATUS: NOT YET DEPLOYED.** Awaiting Ross go for: image push → GitOps commit/push → ArgoCD sync (touches shared Dex). Enforcement stays OFF (ALLOW_UNAUTH=1) until KB-AUTH-7 wires agent tokens.

## 2026-09-17 00:25 ACST — KB-AUTH-6 DEPLOYED (open mode)
- **Objective:** Push image + GitOps sync Dex(additive)+kanbunny with ALLOW_UNAUTH=1 (non-breaking).
- **Actions:**
  - Pushed brigss007/kanbunny:2026-09-17-auth to Docker Hub.
  - Committed k3s-cluster ec04ef3 (5 files) and pushed → ArgoCD synced.
  - Hit known Docker Hub pull-secret 401 on new pod → pre-seeded image on optiplex2 via `ctr -n k8s.io images import` (documented deploy.sh workaround), deleted stuck pod to force reschedule.
- **Verification:**
  - ArgoCD: dex + kanbunny both Synced/Healthy.
  - Dex rolled out; existing clients (github/k8s/headlamp/argocd) intact + new kanbunny client wired from separate dex-kanbunny-client secret.
  - kanbunny new pods Running on 2026-09-17-auth; /healthz 200; /api/boards + /auth/me work in open mode (open:anonymous/admin).
  - No outage — old pods served until new ones ready.
- **STATUS: Enforcement still OFF (KANBUNNY_ALLOW_UNAUTH=1).** Agents unaffected.
- **NEXT (gate 2, disruptive — needs Ross go):** KB-AUTH-7 — create agent user rows + tokens, wire into each agent TOOLS.md/SKILL.md, then flip ALLOW_UNAUTH=0.
- **Note/gap:** No create-user API exists (users come from OIDC/bootstrap). Agent `agent:*` user rows must be inserted via db helper in-pod before tokens can be issued. Flag for design follow-up.

## 2026-09-17 01:35 ACST — Point 2: agent role sees all boards (via Botioc handoff)
- **Context:** Session recovered from context overflow; Botioc handoff note HANDOFF-kanbunny-auth.md.
- **Point 1 (answered, no code):** create-user API is NOT for humans (humans JIT-provision via OIDC on first login — `upsertUserFromOidc`). The only "creation" gap is agent/service principals, which are absent from the IdP. Recommendation: NO new create-user endpoint; provision the 3 fixed `agent:*` rows directly via db helper in-pod when wiring tokens (Gate 2).
- **Point 2 (implemented):** `agent` role sees all boards.
  - `src/db.js`: added `seesAllBoards(principal)` (admin OR agent); `visibleBoardsFor` uses it; exported it.
  - `src/auth.js`: `requireBoardAccess` + `requireCardAccess` use `db.seesAllBoards` (agents pass all board/card routes).
  - `tests/auth-enforcement.test.js`: added "agent role sees ALL boards" (promote→see hidden board→revert).
- **Tests:** `npm test` → **73/73 pass**.
- **NOT deployed** (this is a code change on top of deployed 2026-09-17-auth). Gate 2 (enforcement flip) NOT touched — awaiting Ross sign-off.

## 2026-09-17 01:45 ACST — VCS baseline + Point 2 deployed (open mode)
- **VCS baseline (Botioc blocking item):** `git init` on /home/ross/projects/kanbunny.
  - `.gitignore` added: node_modules/, *.db, *.db-shm, *.db-wal, *.log, .env*, kanbunny.backup-*.
  - Baseline commit **0ca670f** — 25 files (src, tests, public, ops, docs, Dockerfile, package*). No DBs/secrets/node_modules staged.
  - No remote created (ask Ross re: GitHub push).
- **Deploy:** built `brigss007/kanbunny:2026-09-17-auth2` (id 6e7800230dde), pushed to Docker Hub, pre-seeded optiplex2(141)+optiplex(107) via ctr (pull-secret still broken).
  - GitOps: k3s-cluster **fd67107** (bump image). ArgoCD initially lagged (syncedRev stuck at ec04ef3) → forced `argocd.argoproj.io/refresh: hard` → picked up fd67107.
- **Verification:**
  - Deployment image = 2026-09-17-auth2; 2 new pods Running (old terminated, no outage).
  - KANBUNNY_ALLOW_UNAUTH=1 (Gate 2 still locked).
  - /healthz 200; open-mode /api/boards + /auth/me OK.
  - ArgoCD: dex + kanbunny Synced/Healthy @ fd67107.
- **Gate 2:** NOT touched. No agent rows, no tokens, no enforcement flip.

## 2026-09-17 01:55 ACST — UI fix: invisible header buttons (Ross)
- **Bug:** `.admin-btn`/`.logout-btn` used `color: inherit` → dark body text on the `var(--accent)` dark-blue header = invisible. `.user-chip` same issue.
- **Fix (public/style.css):** matched `.new-board-btn` pattern — `color: rgba(255,255,255,0.85)` (chip 0.9), hover `#fff` + brighter border; added transition.
- **Deploy:** kanbunny commit b1bb295 → image 2026-09-17-auth3 (2aebe5f66f8b) → GitOps 8061572 → ArgoCD hard-refresh → rollout OK.
- **Verified:** running auth3; served style.css shows white text on both; /healthz 200; dex+kanbunny Synced/Healthy.
- **Q#2 (open:anonymous):** explained — it's the ALLOW_UNAUTH=1 open-mode short-circuit (authMiddleware assigns OPEN_ADMIN without consulting Dex). GitHub username shows after Gate 2 flip (upsertUserFromOidc stores preferred_username). Not a bug; needs Gate 2 cutover (agent tokens first).

## 2026-09-17 02:05 ACST — Gate 2 CUTOVER COMPLETE (KB-AUTH-7)
- **Objective:** Provision agent service accounts + tokens, wire into skills, flip enforcement ON.
- **Ross decisions applied:** agent role sees all boards (no per-board grants); no create-user endpoint (direct DB rows for the 3 fixed agents).
- **Provisioning (in-pod, ops/provision-agents.js, idempotent):**
  - Created users agent:sherlock / agent:juan / agent:botioc, role=agent.
  - Issued tokens sherlock-curl/juan-curl/botioc-curl. Verified token→principal resolution in-pod BEFORE flip.
  - Tokens stored in each agent's TOOLS.md (mode 600): sherlock, local-worker (Juan), workspace (Botioc).
- **Skills updated:** shared ~/.openclaw/skills/kanbunny/SKILL.md + sherlock copy — bearer header on every curl, removed "No auth required", added 401-stop rule. Botioc AGENTS.md had no bare curl (descriptive only).
- **Flip:** removed KANBUNNY_ALLOW_UNAUTH via GitOps k3s-cluster 30340f2 → ArgoCD hard-refresh → rollout OK.
- **Verification (live, kanbunny.lab):**
  - ALLOW_UNAUTH env removed ✓
  - Anonymous /api/boards + /auth/me → 401 ✓
  - /healthz → 200 (open for probes) ✓
  - sherlock token /auth/me → {login:agent:sherlock, role:agent, via:token} ✓
  - juan/botioc tokens → 10 boards each ✓
  - Bearer PATCH card → in-progress works (CSRF-exempt) ✓; no-token PATCH → 401 ✓
- **Public hostname note:** kanbunny.rossbrigoli.com is behind **Cloudflare Access** (separate Zero Trust gate) → 302 to cloudflareaccess.com before reaching the app. Not a kanbunny issue. Agents use kanbunny.lab internally. Flag to Ross if he wants the public host to use kanbunny's own Dex login instead.
- **Rollback:** GitOps re-add KANBUNNY_ALLOW_UNAUTH='1' → open mode restored instantly.

## 2026-09-17 02:10 ACST — Provision christina + jobhunter (KB-AUTH-7 addendum)
- Ross: agent:christina + agent:jobhunter also need Kanbunny tokens.
- Workspaces: ~/.openclaw/workspace-christina, ~/.openclaw/workspace-jobhunter (both use shared kanbunny skill, no local copy).
- Made ops/provision-agents.js accept CLI agent names. Ran: `node provision-agents.js christina jobhunter`.
- Created agent:christina, agent:jobhunter (role=agent). Tokens stored in each TOOLS.md (600).
- Verified live (enforcement ON): both /auth/me → agent:* via token; 10 boards each.
- No plaintext tokens in git.
