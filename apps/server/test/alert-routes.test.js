import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAlertRoutes } from '../src/admin/alert-routes.js';

const cleanup = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of cleanup.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('admin alert routes', () => {
  it('validates webhook transport and suppresses duplicate alerts during cooldown', async () => {
    const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-alerts-'));
    cleanup.push(saveDir);
    const routes = [];
    registerAlertRoutes(routes, { saveDir });
    const put = routes.find((route) => route.method === 'PUT');
    const get = routes.find((route) => route.method === 'GET');
    expect(put.run({ body: { notifications: { webhookUrl: 'http://remote.invalid/hook' } } })).toMatchObject({ error: expect.any(String) });

    const fetch = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    expect(put.run({ body: { memoryMB: 0, notifications: {
      enabled: true, webhookUrl: 'http://127.0.0.1/hook', cooldownMs: 10_000,
    } } })).toMatchObject({ ok: true });

    expect(get.run().active).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'memory' })]));
    get.run();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(get.run().delivery.suppressed).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(path.join(saveDir, 'admin-alert-notifications.json'), 'utf8')))
      .toMatchObject({ enabled: true, cooldownMs: 10_000 });
  });
});
