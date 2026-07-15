import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const host = process.env.PROFILE_HOST || '127.0.0.1';
const previewBuild = process.env.PROFILE_PREVIEW === '1';
const vitePort = Number.parseInt(process.env.PROFILE_PORT || (previewBuild ? '4173' : '5173'), 10);
const durationMs = Math.max(1000, Number.parseInt(process.env.PROFILE_MS || '5000', 10));
const noServer = process.env.PROFILE_NO_SERVER === '1';
const targetUrl = process.env.PROFILE_URL || `http://${host}:${vitePort}/`;

const log = (message) => console.log(`[client:profile] ${message}`);

async function waitForHttp(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw lastError ?? new Error(`timeout waiting for ${url}`);
}

function startVite() {
  // Spawn Vite through Node directly. On Windows a pnpm.cmd shell wrapper
  // outlived the profiler when a trace timed out and left port 5173 occupied.
  const cli = path.resolve(process.cwd(), 'node_modules/vite/bin/vite.js');
  const child = spawn(process.execPath, [
    cli,
    ...(previewBuild ? ['preview'] : []),
    '--host', host, '--port', String(vitePort), '--strictPort',
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => { const text = String(chunk).trim(); if (text) console.log(text); });
  child.stderr.on('data', (chunk) => { const text = String(chunk).trim(); if (text) console.error(text); });
  return child;
}

async function main() {
  let vite;
  let browser;
  const cleanup = async () => {
    try { await browser?.close(); } catch { /* already closed */ }
    try { vite?.kill('SIGTERM'); } catch { /* already closed */ }
  };
  process.once('SIGINT', () => { void cleanup().finally(() => process.exit(130)); });
  process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(143)); });

  try {
    if (!noServer) {
      log(`starting Vite on ${host}:${vitePort}`);
      vite = startVite();
      await waitForHttp(targetUrl);
    }

    browser = await chromium.launch({
      headless: process.env.PROFILE_HEADFUL !== '1',
      args: [
        '--disable-background-networking',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
      ],
    });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    const pageErrors = [];
    const failedRequests = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)));
    page.on('requestfailed', (request) => failedRequests.push({
      url: request.url(), error: request.failure()?.errorText ?? 'failed',
    }));
    await page.addInitScript(() => {
      globalThis.__uoProfileLongTasks = [];
      try {
        new globalThis.PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            globalThis.__uoProfileLongTasks.push({ startTime: entry.startTime, duration: entry.duration });
          }
        }).observe({ type: 'longtask', buffered: true });
      } catch { /* unsupported browser */ }
    });

    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    log(`recording ${durationMs}ms at ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('[data-login-step]'), null, { timeout: 30_000 });
    await page.waitForTimeout(durationMs);

    const protocolMetrics = await cdp.send('Performance.getMetrics');
    const browserMetrics = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0]?.toJSON?.() ?? null;
      const resources = performance.getEntriesByType('resource')
        .map((entry) => ({
          name: entry.name,
          initiatorType: entry.initiatorType,
          duration: entry.duration,
          transferSize: entry.transferSize,
          decodedBodySize: entry.decodedBodySize,
        }))
        .sort((a, b) => b.duration - a.duration);
      const longTasks = globalThis.__uoProfileLongTasks ?? [];
      return {
        navigation,
        resourceCount: resources.length,
        transferBytes: resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
        decodedBytes: resources.reduce((sum, entry) => sum + (entry.decodedBodySize || 0), 0),
        slowestResources: resources.slice(0, 30),
        longTasks,
        longTaskTotalMs: longTasks.reduce((sum, entry) => sum + entry.duration, 0),
      };
    });

    const result = {
      version: 2,
      generatedAt: new Date().toISOString(),
      url: targetUrl,
      durationMs,
      browserMetrics,
      protocolMetrics: Object.fromEntries(protocolMetrics.metrics.map(({ name, value }) => [name, value])),
      pageErrors,
      failedRequests,
    };
    const outDir = path.resolve(process.cwd(), '.profiles');
    const output = path.join(outDir, 'client-profile-latest.json');
    await mkdir(outDir, { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2));
    log(`metrics: ${output}`);
    log(`${browserMetrics.resourceCount} resources, ${browserMetrics.longTasks.length} long tasks, ${Math.round(browserMetrics.transferBytes / 1024)} KiB transferred`);
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(`[client:profile] ${error?.stack ?? error}`);
  process.exitCode = 1;
});
