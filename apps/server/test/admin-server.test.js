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
});
