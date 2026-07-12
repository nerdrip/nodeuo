import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const outputRoot = fileURLToPath(new URL('../.screenshots/runtime-audit/', import.meta.url));
const full = process.argv.includes('--full') || process.env.NODEUO_AUDIT_FULL === '1';
const optionsAudit = process.argv.includes('--options');
const cycles = full ? 20 : 3;
assert.ok(existsSync(resolve(distRoot, 'index.html')), 'client dist missing; run build first');

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'], ['.ktx2', 'image/ktx2'], ['.bin', 'application/octet-stream'],
  ['.wasm', 'application/wasm'], ['.svg', 'image/svg+xml'],
]);

const server = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = resolve(distRoot, `.${requested}`);
  if (!file.startsWith(resolve(distRoot) + sep) || !existsSync(file)) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': mime.get(extname(file)) ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(res);
});
await new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveListen);
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error?.stack ?? error)));

const heaps = [];
try {
  for (let i = 0; i < cycles; i++) {
    await page.goto(`${baseUrl}${optionsAudit ? '?runtimeAudit=1' : ''}`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForTimeout(250);
    const state = await page.evaluate(() => ({
      bodyText: document.body?.innerText ?? '',
      canvasCount: document.querySelectorAll('canvas').length,
      heap: performance.memory?.usedJSHeapSize ?? 0,
      width: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    assert.ok(state.bodyText.length > 0 || state.canvasCount > 0, `cycle ${i}: app rendered no UI`);
    assert.ok(state.width <= state.viewport + 2, `cycle ${i}: login/main flow causes horizontal overflow`);
    if (state.heap > 0) heaps.push(state.heap);
  }
  mkdirSync(outputRoot, { recursive: true });
  await page.screenshot({ path: resolve(outputRoot, 'login-runtime.png'), fullPage: true });
  if (optionsAudit) {
    await page.waitForFunction(() => !!globalThis.__uo?.gc?.app?.stage, null, { timeout: 30_000 });
    const chunk = readdirSync(resolve(distRoot, 'assets'))
      .find((name) => /^options-gump-.*\.js$/.test(name));
    assert.ok(chunk, 'OptionsGump production chunk missing');
    const audit = await page.evaluate(async (chunkName) => {
      const mod = await import(`/assets/${chunkName}`);
      const gump = new mod.OptionsGump();
      document.querySelector('#dom-ui')?.style?.setProperty('display', 'none');
      gump.node.zIndex = 999999;
      globalThis.__uo.gc.app.stage.addChild(gump.node);
      globalThis.__uo.gc.app.stage.sortableChildren = true;
      globalThis.__uo.gc.app.stage.sortChildren();
      globalThis.__optionsAuditGump = gump;
      return {
        width: gump.width,
        height: gump.height,
        tabs: gump._tabButtons.length,
        contentX: gump._contentScroll.x,
        contentWidth: gump._contentScroll.width,
      };
    }, chunk);
    assert.equal(audit.width, 900);
    assert.equal(audit.tabs, 12);
    assert.ok(audit.contentX >= 180 && audit.contentWidth >= 680);
    await page.waitForTimeout(800);
    await page.screenshot({ path: resolve(outputRoot, 'options-runtime.png'), fullPage: true });
    await page.evaluate(() => globalThis.__optionsAuditGump?._showTab?.('graphics'));
    await page.waitForTimeout(150);
    const tabAudit = await page.evaluate(() => globalThis.__optionsAuditGump._tabButtons.map(({ ctrl }) => ({
      label: ctrl._label,
      visible: ctrl.node.visible && !ctrl.node.destroyed,
      labelVisible: ctrl._lbl.node.visible && !ctrl._lbl.node.destroyed,
      labelWidth: ctrl._lbl.width,
      alpha: ctrl._lbl.node.alpha,
    })));
    assert.equal(tabAudit.every((tab) => tab.visible && tab.labelVisible && tab.labelWidth > 0), true,
      `Options sidebar lost a label: ${JSON.stringify(tabAudit)}`);
    await page.screenshot({ path: resolve(outputRoot, 'options-graphics-runtime.png'), fullPage: true });
  }
  assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.slice(0, 5).join('\n')}`);
  if (heaps.length > 1) {
    const growth = heaps.at(-1) - heaps[0];
    const allowance = full ? 96 * 1024 * 1024 : 48 * 1024 * 1024;
    assert.ok(growth < allowance, `heap grew ${(growth / 1024 / 1024).toFixed(1)} MiB across ${cycles} reloads`);
  }
} finally {
  await context.close();
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}

console.log(`[audit:browser-runtime] ok cycles=${cycles} heapSamples=${heaps.length} output=${outputRoot}`);
