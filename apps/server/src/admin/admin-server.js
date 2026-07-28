// Admin web panel HTTP server.
//
// Spins up a tiny http listener on a separate port (UO_ADMIN_PORT, default
// 2596) that serves a single-page admin UI plus a JSON REST API.
//
// Auth model: cookie-based session token bound to a shard Admin account.
//   POST /api/auth/login {username, password}      → sets `uo_admin` cookie
//   POST /api/auth/logout                          → clears it
//   GET  /api/auth/me                              → who am I + characters
// Every other endpoint requires a valid `uo_admin` cookie. Tokens are
// random 32-byte hex, kept in-memory, swept after 8 h idle. No password
// is stored — only the account name + cached accessLevel.
//
// First-run convenience: env `UO_ADMIN_USER`/`UO_ADMIN_PASS` still
// authenticate as if they were a shard account named UO_ADMIN_USER with
// Admin level. Useful when the shard account file is empty or you
// don't want to tie the panel to gameplay credentials.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { buildHandlers } from './routes.js';
import * as operational from '../systems/operational-diagnostics.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_FILE = path.join(HERE, 'admin-ui.html');
const LOGIN_FILE = path.join(HERE, 'login.html');
const EDITOR_FILE = path.join(HERE, 'editor.html');
const DATA_EDITOR_FILE = path.join(HERE, 'data-editor.html');
const STUDIO_FILE = path.join(HERE, 'studio.html');
const DOCS_FILE = path.join(HERE, 'docs.html');
const ADMIN_ASSETS_DIR = HERE;
// Public extractor output (atlases, tiledata, map blocks). Served as
// read-only static so the iso editor in /editor can reuse the same art
// the client uses, without depending on Vite running.
const CLIENT_ASSETS_DIR = path.resolve(HERE, '..', '..', '..', 'client', 'public', 'assets');
// Shared browser-safe ESM modules (iso math, tiledata flag constants,
// notoriety hue table) live in `apps/client/src/shared/`. Both the in-
// game client and the admin editor `import` them — one source of truth
// for iso projection and the small handful of pure-data helpers that
// would otherwise drift between the two surfaces. Marcin: "uwspólnij
// komponenty które mogą być". Path-traversal guarded same as /assets/.
const SHARED_DIR = path.resolve(HERE, '..', '..', '..', 'client', 'src', 'shared');
const COOKIE_NAME = 'uo_admin';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;       // 8 h
// Admin audit #3 — per-IP login rate limit bucket. Cleaned by sessions
// sweeper below. Map<ip, { count, windowStart, until }>.
const _loginBuckets = new Map();
const ACCESS_RANK = Object.freeze({ Player: 0, Counselor: 1, Counsellor: 1, Seer: 2, GameMaster: 3, GM: 3, Admin: 4 });
const FRESH_AUTH_MS = 5 * 60 * 1000;
const EMBEDDABLE_ADMIN_PATHS = new Set([
  '/editor', '/editor.html',
  '/data-editor', '/data-editor.html',
]);

function accessRank(level) { return ACCESS_RANK[String(level)] ?? 0; }
function requiredRank(method, pathname) {
  if (pathname === '/api/preferences' || pathname === '/api/operations/client-metrics') return 1;
  if (method === 'GET') return 1;
  if (pathname.startsWith('/api/accounts') || pathname === '/api/world/shutdown'
      || pathname.startsWith('/api/backups/restore') || pathname.startsWith('/api/migrations/apply')
      || pathname.startsWith('/api/feature-flags')) return 4;
  if (pathname === '/api/me/teleport' || pathname === '/api/world/broadcast'
      || pathname.endsWith('/teleport') || pathname.endsWith('/kick')) return 2;
  return 3;
}
function requiresFreshAuth(method, pathname) {
  return method !== 'GET' && (pathname.startsWith('/api/accounts')
    || pathname.startsWith('/api/world/cmd') || pathname === '/api/world/shutdown'
    || pathname.startsWith('/api/backups/restore') || pathname.startsWith('/api/migrations/apply')
    || pathname.startsWith('/api/feature-flags'));
}
function scopesFor(level) {
  const rank = accessRank(level);
  return { view: rank >= 1, operate: rank >= 2, edit: rank >= 3, administer: rank >= 4 };
}
function safeAuditValue(value, depth = 0) {
  if (depth > 2) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 12).map((entry) => safeAuditValue(entry, depth + 1));
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 120) : value;
  const out = {};
  for (const [key, entry] of Object.entries(value).slice(0, 24)) {
    out[key] = ['password', 'secret', 'token', 'cookie'].some((word) => key.toLowerCase().includes(word))
      ? '[REDACTED]' : safeAuditValue(entry, depth + 1);
  }
  return out;
}
function etagForText(jsonText) {
  return '"' + crypto.createHash('sha256').update(jsonText).digest('base64url').slice(0, 22) + '"';
}

function applySecurityHeaders(req, res) {
  const wsOrigin = req.headers.host ? `ws://${req.headers.host} wss://${req.headers.host}` : 'ws: wss:';
  let pathname = '';
  try { pathname = new URL(req.url || '/', 'http://admin.local').pathname; }
  catch { pathname = ''; }
  // The map and data workbenches are deliberately embedded by the
  // same-origin admin shell. DENY/'none' made Chrome replace every iframe
  // with its grey blocked-page icon even though opening the exact URL in a
  // new tab worked. Content Studio is intentionally a top-level route: its
  // dense three-column workspace benefits from the full viewport and no
  // longer depends on iframe policy. Keep every other page non-frameable and
  // never allow a foreign origin to embed an editor.
  const sameOriginWorkbench = req.method === 'GET' && EMBEDDABLE_ADMIN_PATHS.has(pathname);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', sameOriginWorkbench ? 'SAMEORIGIN' : 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  // The admin surfaces are deliberately self-contained HTML files with
  // inline style/script blocks. Keep those two explicit allowances while
  // denying plugins, framing, foreign assets and foreign form targets.
  res.setHeader('content-security-policy', [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    `frame-ancestors ${sameOriginWorkbench ? "'self'" : "'none'"}`,
    "frame-src 'self'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${wsOrigin}`,
    "worker-src 'self' blob:",
  ].join('; '));
}

// Mime types for the static asset route — keep tiny, only what /assets
// actually contains.
const ASSET_MIMES = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.bin':  'application/octet-stream',
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
  '.wav':  'audio/wav',
  '.svg':  'image/svg+xml',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
};

/**
 * @param {{
 *   sharedCtx: any,
 *   scriptRuntime: any,
 *   scriptsDir: string,
 *   saveDir: string,
 *   persistence: any,
 *   accounts: any,
 *   port?: number,
 *   host?: string,
 *   user?: string,
 *   pass?: string,
 * }} opts
 */
export function startAdminServer(opts) {
  const port = opts.port ?? Number(process.env.UO_ADMIN_PORT ?? 2596);
  const host = opts.host ?? process.env.UO_ADMIN_HOST ?? '127.0.0.1';
  const envUser = opts.user ?? process.env.UO_ADMIN_USER ?? 'admin';
  const envPass = opts.pass ?? process.env.UO_ADMIN_PASS ?? '';
  const accountsApi = opts.accounts;
  // The panel is made of a few self-contained files. Production keeps an
  // immutable in-process snapshot. Development revalidates mtime so HTML/CSS
  // fixes appear after refresh instead of requiring a shard restart; these
  // stat calls happen only on admin navigation/static requests, never in the
  // game tick or renderer hot path.
  const staticCache = new Map();
  const revalidateStaticFiles = process.env.NODE_ENV !== 'production';
  function cachedStatic(file) {
    let entry = staticCache.get(file);
    const mtimeMs = revalidateStaticFiles ? fs.statSync(file).mtimeMs : 0;
    if (!entry || (revalidateStaticFiles && entry.mtimeMs !== mtimeMs)) {
      const body = fs.readFileSync(file);
      entry = { body, etag: etagForText(body), length: body.length, mtimeMs };
      staticCache.set(file, entry);
    }
    return entry;
  }
  function sendCachedStatic(req, res, file, contentType, cacheControl = 'private, no-cache') {
    const entry = cachedStatic(file);
    res.setHeader('etag', entry.etag);
    res.setHeader('cache-control', cacheControl);
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304);
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': entry.length,
    });
    res.end(entry.body);
  }
  if (host !== '127.0.0.1' && host !== '::1' && !process.env.UO_ADMIN_HTTPS_TERMINATED) {
    console.warn('[admin] panel is bound beyond localhost over plain HTTP; terminate TLS in front of it and set UO_ADMIN_HTTPS_TERMINATED=1');
  }

  /** @type {Map<string, { account: string, source: 'env'|'account', accessLevel:string, expires:number, freshUntil:number }>} */
  const sessions = new Map();
  const idempotency = new Map();
  // Cleanup expired tokens every 5 min — cheap, avoids unbounded growth.
  setInterval(() => {
    const now = Date.now();
    for (const [tok, s] of sessions) if (s.expires < now) sessions.delete(tok);
    for (const [key, entry] of idempotency) if (entry.expires < now) idempotency.delete(key);
  }, 5 * 60 * 1000).unref?.();

  const handlers = buildHandlers({
    sharedCtx: opts.sharedCtx,
    scriptRuntime: opts.scriptRuntime,
    scriptsDir: opts.scriptsDir,
    saveDir: opts.saveDir,
    persistence: opts.persistence,
    accounts: accountsApi,
    sessions,
  });

  /** Auth: try env credential first, then shard account; require Admin. */
  function tryLogin(username, password) {
    if (envPass && username === envUser && password === envPass) {
      return { ok: true, account: username, accessLevel: 'Admin', source: 'env' };
    }
    if (accountsApi?.authenticate) {
      const r = accountsApi.authenticate(username, password, { autoCreate: false });
      if (!r.ok) return { ok: false, reason: r.reason };
      if (accessRank(r.account.accessLevel) < 1) {
        return { ok: false, reason: `account "${username}" has no panel role` };
      }
      return { ok: true, account: username, accessLevel: r.account.accessLevel, source: 'account' };
    }
    return { ok: false, reason: 'invalid credentials' };
  }

  /** Issue a fresh session token + return cookie value. */
  function makeSession(account, source = 'account', accessLevel = 'Admin') {
    const tok = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    sessions.set(tok, {
      account, source, accessLevel,
      expires: now + SESSION_TTL_MS,
      freshUntil: now + FRESH_AUTH_MS,
    });
    return tok;
  }

  /** Resolve cookie → session, or null. Refreshes idle timeout on hit. */
  function readSession(req) {
    const cookieHeader = req.headers.cookie || '';
    const m = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([0-9a-f]+)`).exec(cookieHeader);
    if (!m) return null;
    const s = sessions.get(m[1]);
    if (!s) return null;
    if (s.expires < Date.now()) { sessions.delete(m[1]); return null; }
    // Account-backed sessions lose authority immediately after the account is
    // banned, deleted or demoted. Environment credentials remain independent
    // by design so the operator can recover a broken account database.
    if (s.source !== 'env') {
      const account = accountsApi?.accounts?.get?.(String(s.account).toLowerCase());
      if (!account || account.banned || accessRank(account.accessLevel) < 1) {
        sessions.delete(m[1]);
        return null;
      }
      s.accessLevel = account.accessLevel;
    }
    s.expires = Date.now() + SESSION_TTL_MS;       // sliding TTL
    return {
      token: m[1], account: s.account, source: s.source,
      accessLevel: s.accessLevel, freshUntil: s.freshUntil,
    };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const incomingId = String(req.headers['x-request-id'] ?? '');
      const correlationId = /^[a-zA-Z0-9._:-]{1,96}$/.test(incomingId)
        ? incomingId : crypto.randomUUID();
      req.adminCorrelationId = correlationId;
      res.uoAcceptEncoding = String(req.headers['accept-encoding'] ?? '');
      res.setHeader('x-correlation-id', correlationId);
      applySecurityHeaders(req, res);
      // Health probe (no auth) — useful for monitoring.
      if (req.method === 'GET' && req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok'); return;
      }

      // Login page (no auth needed) and root.
      if (req.method === 'GET' && (req.url === '/login' || req.url === '/login.html')) {
        try {
          sendCachedStatic(req, res, LOGIN_FILE, 'text/html; charset=utf-8');
        } catch {
          res.writeHead(500); res.end('login.html missing');
        }
        return;
      }
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        // Root: gate on session — redirect to /login if not authed.
        if (!readSession(req)) {
          res.writeHead(302, { location: '/login' }); res.end(); return;
        }
        try {
          sendCachedStatic(req, res, UI_FILE, 'text/html; charset=utf-8');
        } catch { res.writeHead(500); res.end('admin-ui.html missing'); }
        return;
      }

      // Full-screen isometric editor — auth-gated, served as a single
      // HTML page that talks to the same /api/* routes via fetch.
      if (req.method === 'GET' && (req.url === '/editor' || req.url === '/editor.html' || req.url?.startsWith('/editor?'))) {
        if (!readSession(req)) { res.writeHead(302, { location: '/login' }); res.end(); return; }
        try {
          sendCachedStatic(req, res, EDITOR_FILE, 'text/html; charset=utf-8');
        } catch { res.writeHead(500); res.end('editor.html missing'); }
        return;
      }

      // Data editor — tree-view JSON browser/editor for the
      // apps/scripts/src/data/*.json catalog (items, recipes, monsters,
      // spawners, regions, decorations, etc). Same session gate as the
      // iso editor.
      if (req.method === 'GET' && (req.url === '/data-editor' || req.url === '/data-editor.html' || req.url?.startsWith('/data-editor?'))) {
        if (!readSession(req)) { res.writeHead(302, { location: '/login' }); res.end(); return; }
        try {
          sendCachedStatic(req, res, DATA_EDITOR_FILE, 'text/html; charset=utf-8');
        } catch { res.writeHead(500); res.end('data-editor.html missing'); }
        return;
      }

      if (req.method === 'GET' && (req.url === '/studio' || req.url === '/studio.html' || req.url?.startsWith('/studio?'))) {
        if (!readSession(req)) { res.writeHead(302, { location: '/login' }); res.end(); return; }
        try {
          sendCachedStatic(req, res, STUDIO_FILE, 'text/html; charset=utf-8');
        } catch { res.writeHead(500); res.end('studio.html missing'); }
        return;
      }

      if (req.method === 'GET' && (req.url === '/docs' || req.url === '/docs.html' || req.url?.startsWith('/docs?'))) {
        if (!readSession(req)) { res.writeHead(302, { location: '/login' }); res.end(); return; }
        try {
          sendCachedStatic(req, res, DOCS_FILE, 'text/html; charset=utf-8');
        } catch { res.writeHead(500); res.end('docs.html missing'); }
        return;
      }

      // Shared admin design-system/runtime. Use an explicit allowlist because
      // the same directory also contains private server-side modules.
      if (req.method === 'GET' && req.url?.startsWith('/admin-assets/')) {
        const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.replace('/admin-assets/', ''));
        if (!new Set(['admin.css', 'admin-core.js', 'map-worker.js', 'studio-workbenches.js']).has(name)) {
          res.writeHead(404); res.end('not found'); return;
        }
        if (name !== 'admin.css' && !readSession(req)) {
          res.writeHead(401); res.end('unauthorized'); return;
        }
        const full = path.join(ADMIN_ASSETS_DIR, name);
        try {
          sendCachedStatic(
            req, res, full,
            name.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8',
          );
        } catch { res.writeHead(404); res.end('not found'); }
        return;
      }

      // Shared ESM passthrough — exposes `apps/client/src/shared/*.js`
      // so the admin editor can `import { worldToScreen } from
      // '/shared/iso.js'` instead of inlining a copy that drifts. Same
      // session gate as /assets/. We deliberately ONLY expose the
      // `shared/` subtree (not the whole client src) so a future
      // refactor that moves a shared file OUT of the directory makes
      // the leak loud, not silent.
      if (req.method === 'GET' && req.url?.startsWith('/shared/')) {
        if (!readSession(req)) { res.writeHead(401); res.end('unauthorized'); return; }
        const reqPath = new URL(req.url, 'http://x').pathname;
        const rel = decodeURIComponent(reqPath.replace(/^\/shared\//, ''));
        if (rel.includes('..') || rel.includes('\0')) { res.writeHead(400); res.end('bad path'); return; }
        const full = path.join(SHARED_DIR, rel);
        if (!full.startsWith(SHARED_DIR)) { res.writeHead(400); res.end('bad path'); return; }
        let st = null;
        try { st = fs.statSync(full); } catch { res.writeHead(404); res.end('not found'); return; }
        if (!st.isFile()) { res.writeHead(404); res.end('not a file'); return; }
        const ext = path.extname(full).toLowerCase();
        const mime = ASSET_MIMES[ext] ?? 'application/octet-stream';
        res.writeHead(200, {
          'content-type': mime,
          'content-length': st.size,
          // Short cache: shared modules change as we evolve them; we
          // want a refresh to pick up the new code without operators
          // having to clear browser cache. 60 s is enough to coalesce
          // a burst of imports during a single page load.
          'cache-control': 'public, max-age=60',
        });
        fs.createReadStream(full).pipe(res);
        return;
      }

      // Static asset passthrough — serves the extractor output from
      // apps/client/public/assets so the iso editor can fetch atlases
      // without a separate dev server. Path-traversal guarded.
      if (req.method === 'GET' && req.url?.startsWith('/assets/')) {
        if (!readSession(req)) { res.writeHead(401); res.end('unauthorized'); return; }
        const reqPath = new URL(req.url, 'http://x').pathname;
        const rel = decodeURIComponent(reqPath.replace(/^\/assets\//, ''));
        // Reject any traversal — must stay inside CLIENT_ASSETS_DIR.
        if (rel.includes('..') || rel.includes('\0')) { res.writeHead(400); res.end('bad path'); return; }
        const full = path.join(CLIENT_ASSETS_DIR, rel);
        if (!full.startsWith(CLIENT_ASSETS_DIR)) { res.writeHead(400); res.end('bad path'); return; }
        let st = null;
        try { st = fs.statSync(full); } catch { res.writeHead(404); res.end('not found'); return; }
        if (!st.isFile()) { res.writeHead(404); res.end('not a file'); return; }
        const ext = path.extname(full).toLowerCase();
        const mime = ASSET_MIMES[ext] ?? 'application/octet-stream';
        const etag = `W/"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`;
        res.setHeader('etag', etag);
        res.setHeader('cache-control', 'public, max-age=3600');
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304); res.end(); return;
        }
        const compressible = st.size >= 4096 && ['.json', '.js', '.mjs', '.css', '.svg'].includes(ext);
        const accepted = String(req.headers['accept-encoding'] ?? '');
        if (compressible && /(?:^|,|\s)br(?:\s|,|$)/i.test(accepted)) {
          res.writeHead(200, {
            'content-type': mime, 'content-encoding': 'br', vary: 'accept-encoding',
          });
          fs.createReadStream(full).pipe(zlib.createBrotliCompress({
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: st.size },
          })).pipe(res);
          return;
        }
        if (compressible && /(?:^|,|\s)gzip(?:\s|,|$)/i.test(accepted)) {
          res.writeHead(200, {
            'content-type': mime, 'content-encoding': 'gzip', vary: 'accept-encoding',
          });
          fs.createReadStream(full).pipe(zlib.createGzip({ level: 3 })).pipe(res);
          return;
        }
        res.writeHead(200, {
          'content-type': mime,
          'content-length': st.size,
        });
        fs.createReadStream(full).pipe(res);
        return;
      }

      // Auth endpoints — handled inline (don't need the route table).
      if (req.url === '/api/auth/login' && req.method === 'POST') {
        // Admin audit #3 — per-IP login rate limit. 5 failed attempts
        // in a 5-min window → 60s lockout. scrypt is ~70ms so brute
        // force on a weak pass over LAN would still complete in hours.
        const ip = (req.socket?.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
        const now = Date.now();
        const bucket = _loginBuckets.get(ip) ?? { count: 0, windowStart: now, until: 0 };
        if (bucket.until > now) {
          res.setHeader('retry-after', Math.ceil((bucket.until - now) / 1000));
          json(res, 429, { error: 'too many attempts, try again later' });
          return;
        }
        if (now - bucket.windowStart > 5 * 60_000) {
          bucket.windowStart = now;
          bucket.count = 0;
        }
        const body = await readBody(req);
        const { username, password } = body || {};
        if (!username || !password) {
          json(res, 400, { error: 'username + password required' }); return;
        }
        const r = tryLogin(String(username), String(password));
        if (!r.ok) {
          bucket.count += 1;
          if (bucket.count >= 5) bucket.until = now + 60_000;
          _loginBuckets.set(ip, bucket);
          json(res, 401, { error: 'unauthorized', reason: r.reason });
          return;
        }
        // Success — clear bucket.
        _loginBuckets.delete(ip);
        const tok = makeSession(r.account, r.source, r.accessLevel);
        res.setHeader('set-cookie',
          `${COOKIE_NAME}=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`);
        json(res, 200, { ok: true, account: r.account, source: r.source });
        return;
      }
      if (req.url === '/api/auth/logout' && req.method === 'POST') {
        const sess = readSession(req);
        if (sess) sessions.delete(sess.token);
        res.setHeader('set-cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
        json(res, 200, { ok: true }); return;
      }
      if (req.url === '/api/auth/me' && req.method === 'GET') {
        const sess = readSession(req);
        if (!sess) { json(res, 401, { error: 'no session' }); return; }
        const acc = accountsApi?.accounts?.get?.(sess.account.toLowerCase());
        const characters = (acc?.characters ?? [])
          .map((c, i) => c ? { slot: i, name: c.name, mobileSerial: c.mobileSerial } : null)
          .filter(Boolean);
        json(res, 200, {
          account: sess.account,
          accessLevel: sess.accessLevel ?? acc?.accessLevel ?? 'Admin',
          scopes: scopesFor(sess.accessLevel ?? acc?.accessLevel ?? 'Admin'),
          freshAuthUntil: sess.freshUntil,
          characters,
        });
        return;
      }
      if (req.url === '/api/auth/reauth' && req.method === 'POST') {
        const sess = readSession(req);
        if (!sess) { json(res, 401, { error: 'no session' }); return; }
        const ownHost = req.headers.host ?? '';
        const origin = req.headers.origin || req.headers.referer || '';
        try {
          if (!origin || new URL(origin, `http://${ownHost}`).host !== ownHost) {
            json(res, 403, { error: 'same-origin reauthentication required' }); return;
          }
        } catch { json(res, 403, { error: 'invalid Origin header' }); return; }
        const body = await readBody(req);
        const verified = tryLogin(sess.account, String(body?.password ?? ''));
        if (!verified.ok || verified.account.toLowerCase() !== sess.account.toLowerCase()) {
          json(res, 401, { error: 'reauthentication failed' }); return;
        }
        const stored = sessions.get(sess.token);
        stored.freshUntil = Date.now() + FRESH_AUTH_MS;
        operational.recordAudit('admin.reauth', { actor: sess.account, target: 'admin-panel' });
        json(res, 200, { ok: true, freshAuthUntil: stored.freshUntil });
        return;
      }

      // API
      if (req.url?.startsWith('/api/')) {
        const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const route = `${req.method} ${u.pathname}`;
        const handler = matchRoute(handlers, route);
        if (!handler) { json(res, 404, { error: 'route not found', route }); return; }
        const sess = readSession(req);
        if (!sess) { json(res, 401, { error: 'unauthorized', reason: 'no session — POST /api/auth/login first' }); return; }
        const needed = requiredRank(req.method, u.pathname);
        if (accessRank(sess.accessLevel) < needed) {
          operational.recordAudit('admin.denied', {
            actor: sess.account, target: u.pathname,
            detail: `needs-rank=${needed}`, ok: false,
          });
          json(res, 403, { error: 'forbidden', requiredRank: needed, accessLevel: sess.accessLevel });
          return;
        }
        // CSRF / cross-origin defence for mutating verbs. SameSite=Lax
        // already blocks classic CSRF, but an XSS on any localhost site
        // could still call us. Require Origin (or Referer) to match
        // the panel's own host on POST/PUT/PATCH/DELETE. Bug-hunt #2 C4.
        if (req.method !== 'GET') {
          const ownHost = req.headers.host ?? '';
          const origin = req.headers.origin || req.headers.referer || '';
          // Bug-hunt #10 #12: was `if (origin) { ... }` — a request with
          // NO Origin header (curl, custom client, header-stripping
          // service-worker) silently bypassed the check. Defense in
          // depth: require Origin/Referer on every mutating verb.
          if (!origin) {
            json(res, 403, { error: 'missing Origin header on mutating verb' });
            return;
          }
          try {
            const oHost = new URL(origin, `http://${ownHost}`).host;
            if (oHost !== ownHost) {
              json(res, 403, { error: 'cross-origin write rejected', origin, expected: ownHost });
              return;
            }
          } catch {
            json(res, 403, { error: 'invalid Origin header' });
            return;
          }
        }
        if (requiresFreshAuth(req.method, u.pathname) && Number(sess.freshUntil) < Date.now()) {
          json(res, 428, { error: 'fresh authentication required', reauth: '/api/auth/reauth' });
          return;
        }
        let body = null;
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') {
          body = await readBody(req);
        }
        let idempotencyEntryKey = '';
        let idempotencyFingerprint = '';
        if (req.method !== 'GET') {
          const key = String(req.headers['x-idempotency-key'] ?? '');
          if (key && !/^[a-zA-Z0-9._:-]{8,160}$/.test(key)) {
            json(res, 400, { error: 'invalid idempotency key' }); return;
          }
          if (key) {
            idempotencyEntryKey = `${sess.account}:${key}`;
            idempotencyFingerprint = crypto.createHash('sha256')
              .update(`${req.method}\n${u.pathname}\n${JSON.stringify(body, replacerForBigInt)}`)
              .digest('base64url');
            const replay = idempotency.get(idempotencyEntryKey);
            if (replay) {
              if (replay.fingerprint !== idempotencyFingerprint) {
                json(res, 409, { error: 'idempotency key was already used for another mutation', conflict: true }); return;
              }
              res.setHeader('x-idempotency-replay', '1');
              json(res, replay.status, replay.result); return;
            }
          }
        }
        const requestStartedAt = performance.now();
        try {
          const result = await handler.run({
            req, res, params: handler.params, query: u.searchParams, body,
            session: sess,
          });
          operational.recordAdminRequest(route, performance.now() - requestStartedAt, result?.error ? 400 : 200);
          if (result !== undefined && !res.writableEnded) {
            let serializedResult = null;
            if (req.method === 'GET') {
              // Serialize once: previously ETag generation and `json()` each
              // walked large editor/map responses independently.
              serializedResult = JSON.stringify(result, replacerForBigInt);
              const etag = etagForText(serializedResult);
              res.setHeader('etag', etag);
              res.setHeader('cache-control', 'private, no-cache');
              if (req.headers['if-none-match'] === etag) {
                res.writeHead(304); res.end(); return;
              }
            } else {
              operational.recordAudit('admin.mutation', {
                actor: sess.account,
                target: `${req.method} ${u.pathname}`,
                detail: JSON.stringify({
                  correlationId: req.adminCorrelationId,
                  undoId: result?.auditUndoId ?? result?.undoId ?? null,
                  before: result?.before ?? null,
                  after: result?.after ?? safeAuditValue(body),
                  ok: !result?.error,
                }),
                ok: !result?.error,
              });
            }
            const status = result?.error ? (result.conflict ? 409 : 400) : 200;
            if (idempotencyEntryKey) {
              idempotency.set(idempotencyEntryKey, {
                fingerprint: idempotencyFingerprint, status, result, expires: Date.now() + 5 * 60_000,
              });
              while (idempotency.size > 4096) idempotency.delete(idempotency.keys().next().value);
            }
            json(res, status, result, serializedResult);
          }
        } catch (e) {
          operational.recordAdminRequest(route, performance.now() - requestStartedAt, 500);
          console.error(`[admin] ${route} threw:`, e);
          if (!res.writableEnded) json(res, 500, { error: 'handler-threw', message: e?.message ?? String(e) });
        }
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (e) {
      const status = Number(e?.statusCode) || 500;
      // Expected request errors are returned as structured 4xx responses.
      if (status >= 500) console.error('[admin] dispatch failed:', e);
      try {
        if (status === 400 || status === 413 || status === 415) {
          json(res, status, { error: e.message });
        } else {
          res.writeHead(500); res.end('internal error');
        }
      } catch { /* socket dead */ }
    }
  });

  server.listen(port, host, () => {
    console.log(`[admin] panel on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/  (login at /login)`);
  });
  return server;
}

// ---- helpers ---------------------------------------------------------------

function json(res, status, body, serialized = null) {
  const payload = serialized ?? JSON.stringify(body, replacerForBigInt);
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  const accepted = res.uoAcceptEncoding ?? '';
  if (payload.length >= 4096 && /(?:^|,|\s)br(?:\s|,|$)/i.test(accepted)) {
    headers['content-encoding'] = 'br';
    headers.vary = 'accept-encoding';
    res.writeHead(status, headers);
    Readable.from([payload]).pipe(zlib.createBrotliCompress({
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(payload),
      },
    })).pipe(res);
    return;
  }
  if (payload.length >= 4096 && /(?:^|,|\s)gzip(?:\s|,|$)/i.test(accepted)) {
    headers['content-encoding'] = 'gzip';
    headers.vary = 'accept-encoding';
    res.writeHead(status, headers);
    Readable.from([payload]).pipe(zlib.createGzip({ level: 3 })).pipe(res);
    return;
  }
  headers['content-length'] = Buffer.byteLength(payload);
  res.writeHead(status, headers);
  res.end(payload);
}

function replacerForBigInt(_k, v) {
  if (typeof v === 'bigint') return v.toString();
  return v;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const MAX = 8 * 1024 * 1024;
    req.on('data', (c) => {
      if (settled) return;
      total += c.length;
      if (total > MAX) {
        settled = true;
        const error = new Error('payload too large');
        error.statusCode = 413;
        reject(error);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve(null); return; }
      try { resolve(JSON.parse(raw)); }
      catch {
        const error = new Error('invalid JSON body');
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function matchRoute(handlers, route) {
  const [method, rawPath] = route.split(' ');
  for (const h of handlers) {
    if (h.method !== method) continue;
    const params = matchPattern(h.path, rawPath);
    if (params) return { run: h.run, params };
  }
  return null;
}

function matchPattern(pattern, actual) {
  const pp = pattern.split('/').filter(Boolean);
  const ap = actual.split('/').filter(Boolean);
  if (pp.length !== ap.length) return null;
  const out = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) out[pp[i].slice(1)] = decodeURIComponent(ap[i]);
    else if (pp[i] !== ap[i]) return null;
  }
  return out;
}
