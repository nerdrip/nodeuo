import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const outputRoot = fileURLToPath(new URL('../.screenshots/browser-matrix/', import.meta.url));
const full = process.argv.includes('--full') || process.env.NODEUO_AUDIT_FULL === '1';
assert.ok(existsSync(resolve(distRoot, 'index.html')), 'client dist missing; run build first');

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'], ['.bin', 'application/octet-stream'], ['.wasm', 'application/wasm'],
]);
const server = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
  const file = resolve(distRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(resolve(distRoot) + sep) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': mime.get(extname(file)) ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
const url = `http://127.0.0.1:${server.address().port}`;
mkdirSync(outputRoot, { recursive: true });

const engines = full ? [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]] : [['chromium', chromium]];
const viewports = full
  ? [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }]
  : [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }];
const results = [];
const bestEffortClose = async (promise, timeoutMs = 3_000) => {
  await Promise.race([Promise.resolve(promise).catch(() => {}), new Promise((ok) => setTimeout(ok, timeoutMs))]);
};
try {
  for (const [name, engine] of engines) {
    const browser = await engine.launch({ headless: true });
    try {
      // Reuse one browser context per engine so atlas responses remain in the
      // HTTP cache. A fresh context per viewport turned this layout audit into
      // twelve cold-start asset benchmarks and needlessly took minutes.
      const context = await browser.newContext({ viewport: viewports[0], deviceScaleFactor: 1 });
      if (name !== 'chromium') {
        await context.route('**/assets/*.{png,jpg,jpeg,webp,ktx2,mp3,ogg,wav}', (route) => route.abort());
      }
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      let loaded = false;
      for (const viewport of viewports) {
        console.log(`[audit:browser-matrix] ${name} ${viewport.width}x${viewport.height}`);
        await page.setViewportSize(viewport);
        errors.length = 0;
        if (!loaded) {
          // One cold boot per engine; subsequent scenarios exercise the real
          // resize path without destroying and recreating Pixi/WebGL state.
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
          await page.waitForSelector('#m-account', { timeout: 30_000 });
          loaded = true;
        }
        await page.evaluate(() => new Promise((resolveReady) => requestAnimationFrame(() => requestAnimationFrame(resolveReady))));
        const audit = await page.evaluate(() => {
          const controls = [...document.querySelectorAll('input,select,textarea,button')];
          const unlabeled = controls.filter((el) => {
            if (el.getAttribute('aria-label') || el.getAttribute('title')) return false;
            if (el.tagName === 'BUTTON' && el.textContent?.trim()) return false;
            return !el.id || ![...document.querySelectorAll('label')].some((label) => label.htmlFor === el.id);
          }).map((el) => `${el.tagName.toLowerCase()}#${el.id}`);
          const tinyTargets = controls.filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24);
          }).map((el) => `${el.tagName.toLowerCase()}#${el.id}`);
          return {
            overflowX: document.documentElement.scrollWidth - innerWidth,
            overflowY: document.documentElement.scrollHeight - innerHeight,
            unlabeled,
            tinyTargets,
            canvasCount: document.querySelectorAll('canvas').length,
          };
        });
        assert.deepEqual(errors, [], `${name} ${viewport.width}x${viewport.height}: page errors`);
        assert.ok(audit.overflowX <= 2, `${name}: horizontal overflow ${audit.overflowX}px`);
        assert.deepEqual(audit.unlabeled, [], `${name}: unlabeled controls ${audit.unlabeled.join(', ')}`);
        assert.deepEqual(audit.tinyTargets, [], `${name}: undersized controls ${audit.tinyTargets.join(', ')}`);
        await page.focus('#m-account');
        await page.keyboard.press('Tab');
        const focused = await page.evaluate(() => document.activeElement?.id ?? '');
        assert.equal(focused, 'm-password', `${name}: keyboard focus order skipped password field`);
        await page.screenshot({ path: resolve(outputRoot, `${name}-${viewport.width}x${viewport.height}.png`) });
        results.push({ browser: name, viewport, ...audit, focused });
      }
      await bestEffortClose(context.close());
    } finally { await bestEffortClose(browser.close()); }
  }
} finally {
  server.closeIdleConnections?.();
  const closed = new Promise((ok) => server.close(ok));
  server.closeAllConnections?.();
  // Some Windows WebKit builds leave an already-detached keep-alive handle
  // whose close callback never fires. All browser contexts are closed above;
  // cap teardown so the audit result cannot hang indefinitely on that handle.
  await Promise.race([closed, new Promise((ok) => setTimeout(ok, 2_000))]);
  server.unref?.();
}

console.log(`[audit:browser-matrix] ok browsers=${new Set(results.map((r) => r.browser)).size} scenarios=${results.length}`);
// WebKit for Windows occasionally leaves its Playwright transport handle
// referenced even after browser.close resolves/times out. At this point every
// assertion and screenshot is complete and all local servers were closed.
process.exit(0);
