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
import { fileURLToPath } from 'node:url';
import { buildHandlers } from './routes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_FILE = path.join(HERE, 'admin-ui.html');
const LOGIN_FILE = path.join(HERE, 'login.html');
const EDITOR_FILE = path.join(HERE, 'editor.html');
const DATA_EDITOR_FILE = path.join(HERE, 'data-editor.html');
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

  /** @type {Map<string, { account: string, expires: number }>} */
  const sessions = new Map();
  // Cleanup expired tokens every 5 min — cheap, avoids unbounded growth.
  setInterval(() => {
    const now = Date.now();
    for (const [tok, s] of sessions) if (s.expires < now) sessions.delete(tok);
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
      if (r.account.accessLevel !== 'Admin') {
        return { ok: false, reason: `account "${username}" is ${r.account.accessLevel}, not Admin` };
      }
      return { ok: true, account: username, accessLevel: 'Admin', source: 'account' };
    }
    return { ok: false, reason: 'invalid credentials' };
  }

  /** Issue a fresh session token + return cookie value. */
  function makeSession(account) {
    const tok = crypto.randomBytes(32).toString('hex');
    sessions.set(tok, { account, expires: Date.now() + SESSION_TTL_MS });
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
    s.expires = Date.now() + SESSION_TTL_MS;       // sliding TTL
    return { token: m[1], account: s.account };
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Health probe (no auth) — useful for monitoring.
      if (req.method === 'GET' && req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok'); return;
      }

      // Login page (no auth needed) and root.
      if (req.method === 'GET' && (req.url === '/login' || req.url === '/login.html')) {
        try {
          const html = fs.readFileSync(LOGIN_FILE, 'utf8');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
          res.end(html);
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
          const html = fs.readFileSync(UI_FILE, 'utf8');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
          res.end(html);
        } catch { res.writeHead(500); res.end('admin-ui.html missing'); }
        return;
      }

      // Full-screen isometric editor — auth-gated, served as a single
      // HTML page that talks to the same /api/* routes via fetch.
      if (req.method === 'GET' && (req.url === '/editor' || req.url === '/editor.html' || req.url?.startsWith('/editor?'))) {
        if (!readSession(req)) { res.writeHead(302, { location: '/login' }); res.end(); return; }
        try {
          const html = fs.readFileSync(EDITOR_FILE, 'utf8');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
          res.end(html);
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
          const html = fs.readFileSync(DATA_EDITOR_FILE, 'utf8');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
          res.end(html);
        } catch { res.writeHead(500); res.end('data-editor.html missing'); }
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
        res.writeHead(200, {
          'content-type': mime,
          'content-length': st.size,
          'cache-control': 'public, max-age=3600',
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
        const tok = makeSession(r.account);
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
          accessLevel: acc?.accessLevel ?? 'Admin',
          characters,
        });
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
        let body = null;
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') {
          body = await readBody(req);
        }
        try {
          const result = await handler.run({
            req, res, params: handler.params, query: u.searchParams, body,
            session: sess,
          });
          if (result !== undefined && !res.writableEnded) json(res, 200, result);
        } catch (e) {
          console.error(`[admin] ${route} threw:`, e);
          if (!res.writableEnded) json(res, 500, { error: 'handler-threw', message: e?.message ?? String(e) });
        }
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (e) {
      console.error('[admin] dispatch failed:', e);
      try { res.writeHead(500); res.end('internal error'); } catch { /* socket dead */ }
    }
  });

  server.listen(port, host, () => {
    console.log(`[admin] panel on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/  (login at /login)`);
  });
  return server;
}

// ---- helpers ---------------------------------------------------------------

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, replacerForBigInt));
}

function replacerForBigInt(_k, v) {
  if (typeof v === 'bigint') return v.toString();
  return v;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const MAX = 8 * 1024 * 1024;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX) { req.destroy(new Error('payload too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve(null); return; }
      try { resolve(JSON.parse(raw)); }
      catch { resolve({ _raw: raw }); }
    });
    req.on('error', reject);
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
