import { afterEach, describe, expect, it } from 'vitest';
import { startAdminServer } from '../src/admin/admin-server.js';

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('admin HTTP session authorization', () => {
  it('sets browser hardening headers on public and authenticated surfaces', async () => {
    const accounts = { accounts: new Map(), authenticate: () => ({ ok: false, reason: 'disabled' }) };
    const server = startAdminServer({
      port: 0,
      host: '127.0.0.1',
      accounts,
      sharedCtx: { world: { mobiles: new Map(), items: new Map() } },
      scriptsDir: process.cwd(),
      saveDir: process.cwd(),
    });
    servers.push(server);
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('permissions-policy')).toContain('camera=()');
  });

  it('allows authenticated workbenches to be framed only by the same admin origin', async () => {
    const account = { username: 'admin', accessLevel: 'Admin', banned: false, characters: [] };
    const accounts = {
      accounts: new Map([['admin', account]]),
      authenticate: (username, password) => username === 'admin' && password === 'secret'
        ? { ok: true, account } : { ok: false, reason: 'bad credentials' },
    };
    const server = startAdminServer({
      port: 0, host: '127.0.0.1', accounts,
      sharedCtx: { world: { mobiles: new Map(), items: new Map() } },
      scriptsDir: process.cwd(), saveDir: process.cwd(),
    });
    servers.push(server);
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'secret' }),
    });
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];

    for (const path of ['/data-editor', '/editor']) {
      const response = await fetch(`${base}${path}`, { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
      expect(response.headers.get('content-security-policy')).toContain("frame-src 'self'");
    }
    const studio = await fetch(`${base}/studio`, { headers: { cookie } });
    expect(studio.status).toBe(200);
    expect(studio.headers.get('x-frame-options')).toBe('DENY');
    expect(studio.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const docs = await fetch(`${base}/docs`, { headers: { cookie } });
    expect(docs.status).toBe(200);
    expect(docs.headers.get('x-frame-options')).toBe('DENY');
    expect(docs.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const shell = await fetch(`${base}/`, { headers: { cookie } });
    expect(shell.headers.get('x-frame-options')).toBe('DENY');
    expect(shell.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('invalidates an account-backed session immediately after demotion', async () => {
    const account = {
      username: 'admin', accessLevel: 'Admin', banned: false, characters: [],
    };
    const accounts = {
      accounts: new Map([['admin', account]]),
      authenticate(username, password) {
        return username === 'admin' && password === 'secret'
          ? { ok: true, account }
          : { ok: false, reason: 'bad credentials' };
      },
    };
    const server = startAdminServer({
      port: 0,
      host: '127.0.0.1',
      accounts,
      sharedCtx: { world: { mobiles: new Map(), items: new Map() } },
      scriptsDir: process.cwd(),
      saveDir: process.cwd(),
    });
    servers.push(server);
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'secret' }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    expect((await fetch(`${base}/api/world/stats`, { headers: { cookie } })).status).toBe(200);

    account.accessLevel = 'Player';
    expect((await fetch(`${base}/api/world/stats`, { headers: { cookie } })).status).toBe(401);
  });

  it('rejects malformed JSON without invoking authentication', async () => {
    const authenticate = () => { throw new Error('must not authenticate malformed input'); };
    const server = startAdminServer({
      port: 0,
      host: '127.0.0.1',
      accounts: { accounts: new Map(), authenticate },
      sharedCtx: { world: { mobiles: new Map(), items: new Map() } },
      scriptsDir: process.cwd(),
      saveDir: process.cwd(),
    });
    servers.push(server);
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid JSON body' });
  });

  it('enforces staff RBAC and emits correlation/ETag metadata', async () => {
    const account = {
      username: 'helper', accessLevel: 'Counselor', banned: false, characters: [],
    };
    const accounts = {
      accounts: new Map([['helper', account]]),
      authenticate(username, password) {
        return username === 'helper' && password === 'secret'
          ? { ok: true, account }
          : { ok: false, reason: 'bad credentials' };
      },
    };
    const server = startAdminServer({
      port: 0, host: '127.0.0.1', accounts,
      sharedCtx: { world: { mobiles: new Map(), items: new Map() } },
      scriptsDir: process.cwd(), saveDir: process.cwd(),
    });
    servers.push(server);
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'helper', password: 'secret' }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    const first = await fetch(`${base}/api/studio/catalog`, {
      headers: { cookie, 'x-request-id': 'rbac-test-1' },
    });
    expect(first.status).toBe(200);
    expect(first.headers.get('x-correlation-id')).toBe('rbac-test-1');
    expect(first.headers.get('etag')).toMatch(/^".+"$/);
    const cached = await fetch(`${base}/api/studio/catalog`, {
      headers: { cookie, 'if-none-match': first.headers.get('etag') },
    });
    expect(cached.status).toBe(304);
    const metrics = await fetch(`${base}/api/operations/client-metrics`, {
      method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ view: '/#dashboard', tableRows: 12 }),
    });
    expect(metrics.status).toBe(200);
    const mutationHeaders = { cookie, origin: base, 'content-type': 'application/json', 'x-idempotency-key': 'metrics-wave2-0001' };
    const mutationBody = JSON.stringify({ view: '/#items', tableRows: 100_000 });
    const firstMutation = await fetch(`${base}/api/operations/client-metrics`, { method: 'POST', headers: mutationHeaders, body: mutationBody });
    const replayMutation = await fetch(`${base}/api/operations/client-metrics`, { method: 'POST', headers: mutationHeaders, body: mutationBody });
    expect(firstMutation.status).toBe(200);
    expect(replayMutation.status).toBe(200);
    expect(replayMutation.headers.get('x-idempotency-replay')).toBe('1');
    const conflictMutation = await fetch(`${base}/api/operations/client-metrics`, { method: 'POST', headers: mutationHeaders,
      body: JSON.stringify({ view: '/#items', tableRows: 1 }) });
    expect(conflictMutation.status).toBe(409);
    expect(await conflictMutation.json()).toMatchObject({ conflict: true });
    const write = await fetch(`${base}/api/scripts/reload`, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ error: 'forbidden', accessLevel: 'Counselor' });
  });

  it('requires same-origin proof when refreshing authentication freshness', async () => {
    const account = { username: 'admin', accessLevel: 'Admin', banned: false, characters: [] };
    const accounts = { accounts: new Map([['admin', account]]), authenticate: (username, password) => username === 'admin' && password === 'secret' ? { ok: true, account } : { ok: false } };
    const server = startAdminServer({ port: 0, host: '127.0.0.1', accounts,
      sharedCtx: { world: { mobiles: new Map(), items: new Map() } }, scriptsDir: process.cwd(), saveDir: process.cwd() });
    servers.push(server); if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'secret' }) });
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    expect((await fetch(`${base}/api/auth/reauth`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'secret' }) })).status).toBe(403);
    expect((await fetch(`${base}/api/auth/reauth`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'secret' }) })).status).toBe(200);
  });
});
