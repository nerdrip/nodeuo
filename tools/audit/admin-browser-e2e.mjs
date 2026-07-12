import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '../../apps/client/node_modules/playwright/index.mjs';
import { startAdminServer } from '../../apps/server/src/admin/admin-server.js';
import { World } from '../../apps/server/src/world/world.js';

/* global ed -- global lexical binding provided by admin/editor.html */

const saveDir = mkdtempSync(join(tmpdir(), 'nodeuo-admin-e2e-'));
const account = { username: 'admin', accessLevel: 'Admin', banned: false, characters: [] };
const accounts = {
  accounts: new Map([['admin', account]]),
  authenticate: (username, password) => username === 'admin' && password === 'audit-secret'
    ? { ok: true, account }
    : { ok: false, reason: 'bad credentials' },
};
const world = new World();
world.createMobile({ name: 'browser-audit-admin', x: 1495, y: 1625, map: 1 });
const server = startAdminServer({
  port: 0, host: '127.0.0.1', accounts, sharedCtx: { world },
  scriptsDir: resolve('apps/scripts/src'), saveDir,
});
if (!server.listening) await new Promise((ok) => server.once('listening', ok));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const pageErrors = [];
const serverErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('response', (response) => { if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('#u', 'admin');
  await page.fill('#p', 'audit-secret');
  await Promise.all([page.waitForURL(`${base}/`), page.click('#btn')]);
  await page.waitForSelector('nav#tabs');
  for (const tab of ['dashboard', 'accounts', 'characters', 'items', 'spawners', 'operations']) {
    await page.click(`[data-tab="${tab}"]`);
    await page.waitForTimeout(75);
    assert.ok((await page.locator('#main').innerText()).trim().length > 0, `admin tab ${tab} rendered empty`);
  }
  await page.goto(`${base}/editor`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#cv');
  await page.waitForTimeout(500);
  const editor = await page.evaluate(() => ({
    canvas: !!document.querySelector('#cv'),
    palette: !!document.querySelector('#palette'),
    spawnerButton: !!document.querySelector('#add-spawner'),
    overflow: document.documentElement.scrollWidth - innerWidth,
  }));
  assert.equal(editor.canvas, true);
  assert.equal(editor.palette, true);
  assert.ok(editor.overflow <= 2, `iso editor horizontal overflow ${editor.overflow}px`);
  const history = await page.evaluate(() => {
    ed.pendingAdds = [];
    ed.undoStack = []; ed.redoStack = [];
    ed.recordHistory();
    ed.pendingAdds.push({ _id: 1, x: 10, y: 20, z: 0, itemId: 1, hue: 0 });
    ed.undoPending();
    const afterUndo = ed.pendingAdds.length;
    ed.redoPending();
    return { afterUndo, afterRedo: ed.pendingAdds.length };
  });
  assert.deepEqual(history, { afterUndo: 0, afterRedo: 1 });
  assert.deepEqual(pageErrors, [], `admin page errors: ${pageErrors.join('\n')}`);
  assert.deepEqual(serverErrors, [], `admin HTTP 5xx responses: ${serverErrors.join('\n')}`);
} finally {
  await context.close();
  await browser.close();
  await new Promise((ok) => server.close(ok));
  rmSync(saveDir, { recursive: true, force: true });
}

console.log('[audit:admin-browser-e2e] ok tabs=6 editor=iso');
