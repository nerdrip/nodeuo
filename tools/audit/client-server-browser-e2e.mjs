import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { WebSocketServer } from '../../apps/server/node_modules/ws/wrapper.mjs';
import { chromium } from '../../apps/client/node_modules/playwright/index.mjs';
import { config as serverConfig } from '../../apps/server/src/config.js';
import { World } from '../../apps/server/src/world/world.js';
import { NetState } from '../../apps/server/src/net/net-state.js';
import { AuthKeyRegistry } from '../../apps/server/src/net/auth.js';
import { buildHandlers } from '../../apps/server/src/net/handlers.js';
import { CommandRegistry } from '../../apps/server/src/net/commands.js';
import { AccountDB } from '../../apps/server/src/net/accounts.js';

const distRoot = resolve('apps/client/dist');
assert.ok(existsSync(join(distRoot, 'index.html')), 'client dist missing; run build first');
const accountDir = mkdtempSync(join(tmpdir(), 'nodeuo-browser-e2e-'));
const world = new World();
const states = [];
const cfg = { ...serverConfig, port: 0, logPackets: false, huffmanOutgoing: true, devAutoAccept: true };
const authKeys = new AuthKeyRegistry();
const handlers = buildHandlers();
const commands = new CommandRegistry();
const accounts = new AccountDB(accountDir);

const gameHttp = createServer();
const wss = new WebSocketServer({ server: gameHttp, path: '/game' });
wss.on('connection', (ws) => {
  const state = new NetState(ws, { world, authKeys, accounts, config: cfg, handlers, commands, id: states.length + 1 });
  states.push(state);
});
await new Promise((ok, fail) => { gameHttp.once('error', fail); gameHttp.listen(0, '127.0.0.1', ok); });
const gamePort = gameHttp.address().port;

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'], ['.bin', 'application/octet-stream'], ['.wasm', 'application/wasm'],
]);
const web = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
  const file = resolve(distRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(distRoot + sep) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': mime.get(extname(file)) ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});
await new Promise((ok, fail) => { web.once('error', fail); web.listen(0, '127.0.0.1', ok); });
const webUrl = `http://127.0.0.1:${web.address().port}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
const clickTransition = (selector) => page.locator(selector).evaluate((element) => element.click());
try {
  await page.goto(webUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#m-account', { timeout: 30_000 });
  await page.fill('#m-account', 'browser-audit');
  await page.fill('#m-password', 'audit-password');
  await page.locator('details summary').click();
  await page.fill('#m-host', '127.0.0.1');
  await page.fill('#m-port', String(gamePort));
  await page.click('#m-login');
  await page.waitForFunction(() => document.querySelector('#ss-next') || document.querySelector('#cs-new'), null, { timeout: 10_000 });
  await page.waitForTimeout(100);
  // Single-server shards may auto-advance while the selector is being
  // observed. Only click when the selection screen is still mounted.
  if (await page.locator('#cs-new').count() === 0 && await page.locator('#ss-next').count() > 0) {
    await clickTransition('#ss-next');
  }
  await page.waitForSelector('#cs-new', { timeout: 10_000 });
  await clickTransition('#cs-new');
  await page.waitForSelector('#cc-name');
  await page.fill('#cc-name', 'AuditHero');
  await clickTransition('#cc-next');
  await page.waitForSelector('.uo-prof-row');
  await page.locator('.uo-prof-row').first().click();
  await clickTransition('#cc-next');
  await page.waitForSelector('.uo-city-row');
  await page.locator('.uo-city-row').first().click();
  await clickTransition('#cc-finish');

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !states.some((state) => state.mobile && state.stage === 'InWorld')) {
    await new Promise((ok) => setTimeout(ok, 50));
  }
  const state = states.find((entry) => entry.mobile);
  assert.ok(state?.mobile, 'browser did not create and enter a character');
  assert.equal(state.mobile.name, 'AuditHero');
  const before = { x: state.mobile.x, y: state.mobile.y, direction: state.mobile.direction };
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(350);
  const after = { x: state.mobile.x, y: state.mobile.y, direction: state.mobile.direction };
  assert.ok(after.x !== before.x || after.y !== before.y || after.direction !== before.direction,
    `keyboard movement produced no server-side change: ${JSON.stringify(before)}`);
  assert.deepEqual(pageErrors, [], `client page errors: ${pageErrors.join('\n')}`);
} finally {
  await Promise.race([context.close(), new Promise((ok) => setTimeout(ok, 2_000))]);
  await Promise.race([browser.close(), new Promise((ok) => setTimeout(ok, 2_000))]);
  wss.close();
  gameHttp.closeAllConnections?.(); gameHttp.close(); gameHttp.unref?.();
  web.closeAllConnections?.(); web.close(); web.unref?.();
  rmSync(accountDir, { recursive: true, force: true });
}

console.log(`[audit:client-server-e2e] ok sessions=${states.length} character=AuditHero movement=server-confirmed`);
process.exit(0);
