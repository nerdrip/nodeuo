import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { WebSocketServer } from '../../apps/server/node_modules/ws/wrapper.mjs';
import { chromium } from '../../apps/client/node_modules/playwright/index.mjs';
import { config as serverConfig } from '../../apps/server/src/config.js';
import { World } from '../../apps/server/src/world/world.js';
import { NetState } from '../../apps/server/src/net/net-state.js';
import { AuthKeyRegistry } from '../../apps/server/src/net/auth.js';
import { buildHandlers, refreshSurroundings } from '../../apps/server/src/net/handlers.js';
import { CommandRegistry } from '../../apps/server/src/net/commands.js';
import { AccountDB } from '../../apps/server/src/net/accounts.js';
import { displayContextMenu } from '../../packages/protocol/src/packets/context-menu.js';

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
  const size = statSync(file).size;
  const headers = {
    'content-type': mime.get(extname(file)) ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'accept-ranges': 'bytes',
  };
  const range = String(req.headers.range ?? '').match(/^bytes=(\d+)-(\d*)$/);
  if (range) {
    const start = Number(range[1]);
    const end = Math.min(size - 1, range[2] ? Number(range[2]) : size - 1);
    if (!Number.isSafeInteger(start) || start < 0 || start >= size || end < start) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` }); res.end(); return;
    }
    res.writeHead(206, {
      ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1,
    });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  createReadStream(file).pipe(res);
});
await new Promise((ok, fail) => { web.once('error', fail); web.listen(0, '127.0.0.1', ok); });
const webUrl = `http://127.0.0.1:${web.address().port}`;

const browser = await chromium.launch({ headless: true });
// Matches the 2048x732 report so short-wide layout regressions (hotbar over
// canvas, undersized restored viewport) are exercised verbatim.
const context = await browser.newContext({ viewport: { width: 2048, height: 732 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
const clickTransition = (selector) => page.locator(selector).evaluate((element) => element.click());
try {
  await page.goto(`${webUrl}?runtimeAudit=1`, { waitUntil: 'domcontentloaded' });
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
  // A fixed first step is not reliable: the canonical New Haven spawn can
  // legitimately have a blocked tile on one side. Exercise the CUO turn-then-
  // walk cadence in every cardinal direction until the server confirms a
  // coordinate change. This still fails when keyboard input, 0x02 handling,
  // cadence or all collision resolution is broken; it no longer mistakes one
  // blocked destination for a movement regression.
  const movementKeys = ['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown'];
  let after = before;
  for (const key of movementKeys) {
    await page.keyboard.press(key); // turn (or step when already facing)
    await page.waitForTimeout(150);
    await page.keyboard.press(key); // commit the step after the turn delay
    await page.waitForTimeout(450);
    after = { x: state.mobile.x, y: state.mobile.y, direction: state.mobile.direction };
    if (after.x !== before.x || after.y !== before.y) break;
  }
  assert.ok(after.x !== before.x || after.y !== before.y,
    `keyboard movement produced no server-confirmed step: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);

  // Responsive workspace: the world mask must be centered with useful rails
  // on both sides instead of restoring the obsolete 680x480 top-left window.
  const viewport = await page.evaluate(() => {
    const c = globalThis.__uo?.camera;
    return c ? { x: c.viewX, y: c.viewY, w: c.viewW, h: c.viewH, screenW: innerWidth } : null;
  });
  assert.ok(viewport && viewport.x > 200 && viewport.screenW - viewport.x - viewport.w > 200,
    `game viewport is not centered between rails: ${JSON.stringify(viewport)}`);
  assert.ok(Math.abs(viewport.w / viewport.h - 1.6) < 0.03,
    `game viewport aspect drifted: ${JSON.stringify(viewport)}`);

  // Start RMB walking inside the world, then move the pointer into the left
  // rail. Movement must stay armed until mouseup.
  await page.mouse.move(viewport.x + viewport.w * 0.70, viewport.y + viewport.h * 0.65);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(8, viewport.y + viewport.h * 0.65, { steps: 4 });
  await page.waitForTimeout(150);
  const outsideWalk = await page.evaluate(() => ({
    held: !!globalThis.__uo?.gc?.scene?._mouseHeld,
    inside: !!globalThis.__uo?.gc?.scene?._mouseInside,
  }));
  await page.mouse.up({ button: 'right' });
  assert.deepEqual(outsideWalk, { held: true, inside: true },
    'RMB walking must remain active after the pointer leaves the world viewport');

  // Exact coordinate regression from the reported Trinsic river artefact.
  // The screenshot remains as a human-inspectable audit artefact.
  state.mobile.x = 1914;
  state.mobile.y = 2861;
  state.mobile.z = 20;
  state.mobile.map = 1;
  world.sectors?.moveMobile?.(state.mobile);
  refreshSurroundings(state);
  await page.waitForTimeout(2500);

  // Open a deterministic two-spell book through the same event path used by
  // the 0xBF/0x1B packet. This catches native-art sizing and page-coordinate
  // regressions without depending on the test character's starter items.
  await page.evaluate(() => {
    // Magery ids 61 and 62 (Summon Daemon / Earth Elemental) live in the
    // high half of the offset=1 bitmap at bits 28 and 29.
    globalThis.__uo.bus.emit('spellbook:content', {
      serial: 0x7f000001,
      offset: 1,
      hi: 0x30000000,
      lo: 0,
    });
    const book = globalThis.__uo.gc.scene?._ui?.findGump((g) => g.type === 'spellbook');
    book?.setPosition?.(270, 42);
    book?._gotoPage?.(5);
  });
  // Shimmers are intentional while the atlas streams in, but visual QA must
  // capture the resolved art rather than a random intermediate frame.
  await page.waitForFunction(() => {
    const book = globalThis.__uo.gc.scene?._ui?.findGump((g) => g.type === 'spellbook');
    if (!book) return false;
    const visit = (control) => {
      if (control && '_sprite' in control && control.gumpId != null && !control._sprite) return false;
      return (control?.children ?? []).every(visit);
    };
    return visit(book);
  }, null, { timeout: 10_000 });

  const visualState = await page.evaluate(() => {
    const scene = globalThis.__uo.gc.scene;
    const book = scene?._ui?.findGump((g) => g.type === 'spellbook');
    const visuals = scene?._tiles?.visuals ?? scene?._tiles?._visuals ?? [];
    const chunks = visuals instanceof Map ? [...visuals.values()] : [...visuals];
    const waters = chunks.flatMap((chunk) => chunk?._water ?? []);
    const extremeLandMeshes = chunks.flatMap((chunk) => chunk?._sprites ?? [])
      .filter((sprite) => (sprite?._uoLandCornerDelta ?? 0) >= 25)
      .map((sprite) => [sprite._uoLandX, sprite._uoLandY, sprite._uoLandCornerDelta]);
    const first = waters[0]?.overlay;
    return {
      book: book ? {
        width: book.width,
        height: book.height,
        page: book._activePage,
        maxPage: book._maxPage,
        known: [...book._known],
        icons: book._icons.length,
        leftCorner: [book._cornerLeft?.x, book._cornerLeft?.y, book._cornerLeft?.width, book._cornerLeft?.height],
        rightCorner: [book._cornerRight?.x, book._cornerRight?.y, book._cornerRight?.width, book._cornerRight?.height],
      } : null,
      waterCount: waters.length,
      waterScale: first ? [first.scale.x, first.scale.y] : null,
      extremeLandMeshes,
    };
  });
  assert.deepEqual(visualState.book?.known, [61, 62], `spellbook mask mismatch: ${JSON.stringify(visualState)}`);
  assert.equal(visualState.book?.width, 406, 'spellbook must keep ClassicUO native width');
  assert.equal(visualState.book?.height, 229, 'spellbook must keep ClassicUO native height');
  assert.equal(visualState.book?.page, 5, 'spellbook detail spread should follow four Magery index spreads');
  assert.equal(visualState.book?.maxPage, 5, 'two known spells should share one detail spread');
  assert.equal(visualState.book?.icons, 2, 'spellbook must not build unknown spell detail icons');
  assert.deepEqual(visualState.book?.leftCorner, [50, 8, 37, 27], 'left page curl drifted from ClassicUO');
  assert.deepEqual(visualState.book?.rightCorner, [321, 8, 36, 27], 'right page curl drifted from ClassicUO');
  assert.ok(visualState.waterCount > 0, `no wet-static water overlays at Trinsic river: ${JSON.stringify(visualState)}`);
  assert.ok(visualState.extremeLandMeshes.some(([, , delta]) => delta >= 35),
    `Trinsic coastline cliff was flattened instead of meshed: ${JSON.stringify(visualState.extremeLandMeshes)}`);
  assert.ok(visualState.waterScale, 'animated water has no measurable overlay scale');

  // Verify the real server -> client 0xBF/0x14 wire layout.  The previous
  // v2 writer swapped/truncated cliloc and response id, which produced the
  // raw `#...` rows seen below Use.  Anchor coordinates originate in DOM
  // pixels and must be converted to logical UI coordinates exactly once.
  await page.evaluate(() => globalThis.__uo.bus.emit('popup:anchor', { x: 1240, y: 320 }));
  state.send(displayContextMenu({
    serial: state.mobile.serial,
    entries: [
      { responseId: 1, cliloc: 3006132, flags: 0 },
      { responseId: 2, cliloc: 1062761, flags: 0 },
    ],
  }));
  await page.waitForFunction(() => {
    const popup = globalThis.__uo.gc.scene?._ui?.findGump((g) => g.type === 'popup-menu');
    return popup?._labels?.length === 2;
  });
  const popupState = await page.evaluate(() => {
    const ui = globalThis.__uo.gc.scene?._ui;
    const popup = ui?.findGump((g) => g.type === 'popup-menu');
    return popup ? {
      labels: [...popup._labels],
      x: popup.x,
      y: popup.y,
      expected: ui.screenToLogical(1240, 320),
    } : null;
  });
  assert.deepEqual(popupState?.labels, ['Use', 'Properties'],
    `canonical context menu clilocs decoded incorrectly: ${JSON.stringify(popupState)}`);
  assert.ok(Math.abs(popupState.x - popupState.expected.x) <= 1
      && Math.abs(popupState.y - popupState.expected.y) <= 1,
  `context menu did not open at the click: ${JSON.stringify(popupState)}`);
  await page.waitForTimeout(250);
  const laterWaterScale = await page.evaluate(() => {
    const scene = globalThis.__uo.gc.scene;
    const visuals = scene?._tiles?.visuals ?? scene?._tiles?._visuals ?? [];
    const chunks = visuals instanceof Map ? [...visuals.values()] : [...visuals];
    const first = chunks.flatMap((chunk) => chunk?._water ?? [])[0]?.overlay;
    return first ? [first.scale.x, first.scale.y] : null;
  });
  assert.notDeepEqual(laterWaterScale, visualState.waterScale, 'water overlay should animate over time');
  const streamedAssets = await page.evaluate(() => {
    const resources = performance.getEntriesByType('resource');
    const summarize = (pattern) => {
      const rows = resources.filter((entry) => pattern.test(new URL(entry.name).pathname));
      return {
        requests: rows.length,
        decodedBytes: rows.reduce((sum, entry) => sum + (entry.decodedBodySize || 0), 0),
        maxResponseBytes: Math.max(0, ...rows.map((entry) => entry.decodedBodySize || 0)),
      };
    };
    return {
      map: summarize(/\/map\d+\.bin$/),
      statics: summarize(/\/statics\d+\.bin$/),
    };
  });
  assert.ok(streamedAssets.map.requests > 0 && streamedAssets.map.maxResponseBytes <= 196 * 64,
    `map slabs were not range-streamed: ${JSON.stringify(streamedAssets)}`);
  assert.ok(streamedAssets.statics.requests > 0 && streamedAssets.statics.maxResponseBytes <= 512 * 1024,
    `statics slabs were not range-streamed: ${JSON.stringify(streamedAssets)}`);
  if (process.env.UO_KEEP_AUDIT_SCREENSHOTS === '1') {
    await page.screenshot({
      path: resolve('apps/client/.screenshots/runtime-audit/trinsic-coast-spellbook-1914-2861.png'),
      fullPage: true,
    });
  }
  assert.deepEqual(pageErrors, [], `client page errors: ${pageErrors.join('\n')}`);
} finally {
  await Promise.race([context.close(), new Promise((ok) => setTimeout(ok, 2_000))]);
  await Promise.race([browser.close(), new Promise((ok) => setTimeout(ok, 2_000))]);
  wss.close();
  gameHttp.closeAllConnections?.(); gameHttp.close(); gameHttp.unref?.();
  web.closeAllConnections?.(); web.close(); web.unref?.();
  rmSync(accountDir, { recursive: true, force: true });
}

console.log(`[audit:client-server-e2e] ok sessions=${states.length} character=AuditHero movement=server-confirmed map=range-streamed`);
process.exit(0);
