// OIDC relying party, sessions, CSRF and authz middleware (KB-AUTH-2/3/4)
// Design: docs/oidc-auth-design.md
const crypto = require('crypto');
const db = require('./db');

const SESSION_COOKIE = 'kb_session';
const CSRF_COOKIE = 'kb_csrf';
const OAUTH_COOKIE = 'kb_oauth';
const SESSION_TTL_SEC = 8 * 3600; // 8h
const STATE_TTL_SEC = 600;        // 10m to complete the redirect roundtrip

// ---------- env ----------
function sessionSecret() {
  return process.env.KANBUNNY_SESSION_SECRET || '';
}
function oidcConfigured() {
  return !!(sessionSecret() && process.env.KANBUNNY_OIDC_CLIENT_SECRET);
}
function allowUnauth() {
  return process.env.KANBUNNY_ALLOW_UNAUTH === '1';
}
function publicBase() {
  return (process.env.KANBUNNY_PUBLIC_BASE || 'https://kanbunny.rossbrigoli.com').replace(/\/+$/, '');
}
function redirectUri() {
  return publicBase() + '/auth/callback';
}

// ---------- cookie helpers ----------
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isSecure(req) {
  const xf = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return xf === 'https' || req.secure === true || process.env.KANBUNNY_COOKIE_SECURE === '1';
}

function cookie(name, value, { httpOnly = true, secure = false, sameSite = 'Lax', path = '/', maxAge = null } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  if (maxAge !== null) c += `; Max-Age=${maxAge}`;
  return c;
}

// ---------- minimal HS256 JWT (sign/verify with timingSafeEqual) ----------
function b64url(input) {
  return Buffer.from(input).toString('base64url');
}
function signPayload(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest();
  return `${header}.${body}.${b64url(sig)}`;
}
function verifyToken(token, secret) {
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  let given;
  try { given = Buffer.from(parts[2], 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
  return payload;
}
function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// ---------- openid-client (lazy singleton; testable) ----------
let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { Issuer } = require('openid-client');
      const issuer = await Issuer.discover(process.env.OIDC_ISSUER || 'https://cloud.rossbrigoli.com/auth');
      return new issuer.Client({
        client_id: process.env.OIDC_CLIENT_ID || 'kanbunny',
        client_secret: process.env.KANBUNNY_OIDC_CLIENT_SECRET,
        redirect_uris: [redirectUri()],
        response_types: ['code'],
      });
    })().catch((e) => {
      clientPromise = null; // allow retry on next request
      throw e;
    });
  }
  return clientPromise;
}
function setClientForTesting(client) {
  clientPromise = client ? Promise.resolve(client) : null;
}

// ---------- principal resolution ----------
const OPEN_ADMIN = { id: 'open:anonymous', login: 'open:anonymous', role: 'admin', via: 'open' };

function getBearerToken(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(kb_[A-Za-z0-9_\-]+)$/i);
  return m ? m[1] : null;
}

// Resolve principal from bearer token (hashed lookup, live role) or session JWT
// (role re-read from DB so demotion/revocation is instant, not TTL-bound).
async function getPrincipal(req) {
  const bearer = getBearerToken(req);
  if (bearer) {
    const hit = await db.findPrincipalByTokenHash(sha256hex(bearer));
    if (!hit) return null;
    await db.touchApiToken(hit.token.id);
    return { id: hit.user.id, login: hit.user.login, role: hit.user.role, via: 'token', tokenId: hit.token.id };
  }
  const sess = parseCookies(req)[SESSION_COOKIE];
  if (!sess) return null;
  const claims = verifyToken(sess, sessionSecret());
  if (!claims || !claims.sub) return null;
  const user = await db.getUserById(claims.sub);
  if (!user) return null;
  return { id: user.id, login: user.login, role: user.role, via: 'session' };
}

// ---------- middleware ----------
async function authMiddleware(req, res, next) {
  if (allowUnauth()) {
    req.principal = OPEN_ADMIN;
    return next();
  }
  req.principal = await getPrincipal(req);
  next();
}

function requireAuth(req, res, next) {
  if (!req.principal) return res.status(401).json({ error: 'unauthenticated', login: '/auth/login' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.principal) return res.status(401).json({ error: 'unauthenticated', login: '/auth/login' });
  if (req.principal.role !== 'admin') return res.status(403).json({ error: 'forbidden', need: 'admin' });
  next();
}

// Board-scoped access: admins and agents pass (agents see all boards per Ross
// 2026-09-17); others need an explicit grant.
// 404 (not 403) for non-granted boards — do not leak board existence.
async function requireBoardAccess(req, res, next) {
  const boardId = req.params.boardId || req.params.id;
  if (!req.principal) return res.status(401).json({ error: 'unauthenticated', login: '/auth/login' });
  if (db.seesAllBoards(req.principal)) return next();
  if (await db.isBoardMember(boardId, req.principal.id)) return next();
  return res.status(404).json({ error: 'not_found' });
}

// For /api/cards/:id* — resolve the card's board, then check access.
async function requireCardAccess(req, res, next) {
  if (!req.principal) return res.status(401).json({ error: 'unauthenticated', login: '/auth/login' });
  if (db.seesAllBoards(req.principal)) return next();
  const card = await db.getCard(req.params.id);
  if (!card) return res.status(404).json({ error: 'not_found' });
  if (await db.isBoardMember(card.board_id, req.principal.id)) return next();
  return res.status(404).json({ error: 'not_found' });
}

// CSRF (double-submit) for cookie-based mutations. Bearer tokens are immune.
function csrfMiddleware(req, res, next) {
  if (allowUnauth()) return next();
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.principal || req.principal.via === 'token') return next();
  const hdr = req.headers['x-kb-csrf'];
  const ck = parseCookies(req)[CSRF_COOKIE];
  if (!hdr || !ck || hdr !== ck) return res.status(403).json({ error: 'csrf_failed' });
  next();
}

// ---------- routes ----------
function safeReturnTo(v) {
  if (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\')) return v;
  return '/';
}

function registerAuthRoutes(app) {
  app.get('/auth/login', async (req, res) => {
    // Browser-only guard: on the plain-HTTP LAN host, bounce to the TLS host.
    // API/Bearer traffic is unaffected (agents never hit /auth/*).
    if (process.env.KANBUNNY_ENFORCE_HTTPS_HOST === '1') {
      const host = String(req.headers.host || '').split(':')[0];
      const pubHost = new URL(publicBase()).host;
      if (host !== pubHost) {
        const next = req.query.next ? '?next=' + encodeURIComponent(req.query.next) : '';
        return res.redirect(302, publicBase() + '/auth/login' + next);
      }
    }
    if (!oidcConfigured()) return res.status(503).json({ error: 'oidc_not_configured' });
    try {
      const client = await getClient();
      const state = crypto.randomBytes(16).toString('hex');
      const nonce = crypto.randomBytes(16).toString('hex');
      const returnTo = safeReturnTo(req.query.next);
      const stateTok = signPayload({ state, nonce, returnTo, exp: nowSec() + STATE_TTL_SEC }, sessionSecret());
      res.setHeader('Set-Cookie', cookie(OAUTH_COOKIE, stateTok, {
        httpOnly: true, secure: isSecure(req), sameSite: 'Lax', maxAge: STATE_TTL_SEC,
      }));
      const url = client.authorizationUrl({
        scope: 'openid profile',
        state,
        nonce,
        redirect_uri: redirectUri(),
      });
      res.redirect(302, url);
    } catch (e) {
      res.status(503).json({ error: 'oidc_unavailable', detail: e.message });
    }
  });

  app.get('/auth/callback', async (req, res) => {
    if (!oidcConfigured()) return res.status(503).json({ error: 'oidc_not_configured' });
    try {
      const stateTok = parseCookies(req)[OAUTH_COOKIE];
      if (!stateTok) return res.status(400).json({ error: 'missing_state' });
      const st = verifyToken(stateTok, sessionSecret());
      if (!st || !st.state || !st.nonce) return res.status(400).json({ error: 'invalid_state' });

      const client = await getClient();
      const params = client.callbackParams(req);
      const tokenSet = await client.callback(redirectUri(), params, { state: st.state, nonce: st.nonce });
      const claims = tokenSet.claims();
      const sub = claims.sub;
      const login = claims.preferred_username || claims.login || null;
      if (!sub || !login) return res.status(400).json({ error: 'missing_claims' });

      let user;
      try {
        user = await db.upsertUserFromOidc(sub, login);
      } catch (e) {
        if (String(e.message).includes('login_conflict')) {
          return res.status(403).json({ error: 'login_conflict' });
        }
        throw e;
      }
      // Bootstrap promotion covers logins added to env after the user row exists.
      if (user.role !== 'admin' && db.bootstrapAdminLogins().includes(login)) {
        user = await db.setUserRole(user.id, 'admin');
      }

      const sessTok = signPayload(
        { sub: user.id, login: user.login, role: user.role, iat: nowSec(), exp: nowSec() + SESSION_TTL_SEC },
        sessionSecret()
      );
      const csrf = crypto.randomBytes(16).toString('hex');
      const secure = isSecure(req);
      res.setHeader('Set-Cookie', [
        cookie(SESSION_COOKIE, sessTok, { httpOnly: true, secure, sameSite: 'Lax', maxAge: SESSION_TTL_SEC }),
        cookie(CSRF_COOKIE, csrf, { httpOnly: false, secure, sameSite: 'Lax', maxAge: SESSION_TTL_SEC }),
        cookie(OAUTH_COOKIE, '', { httpOnly: true, secure, sameSite: 'Lax', maxAge: 0 }),
      ]);
      res.redirect(302, st.returnTo || '/');
    } catch (e) {
      res.status(401).json({ error: 'callback_failed', detail: e.message });
    }
  });

  app.post('/auth/logout', (req, res) => {
    const secure = isSecure(req);
    res.setHeader('Set-Cookie', [
      cookie(SESSION_COOKIE, '', { httpOnly: true, secure, maxAge: 0 }),
      cookie(CSRF_COOKIE, '', { httpOnly: false, secure, maxAge: 0 }),
    ]);
    res.json({ ok: true });
  });

  app.get('/auth/me', requireAuth, (req, res) => {
    res.json({ login: req.principal.login, role: req.principal.role, via: req.principal.via });
  });
}

module.exports = {
  SESSION_COOKIE,
  CSRF_COOKIE,
  OAUTH_COOKIE,
  SESSION_TTL_SEC,
  registerAuthRoutes,
  authMiddleware,
  requireAuth,
  requireAdmin,
  requireBoardAccess,
  requireCardAccess,
  csrfMiddleware,
  getPrincipal,
  getBearerToken,
  signPayload,
  verifyToken,
  sha256hex,
  setClientForTesting,
  parseCookies,
};
