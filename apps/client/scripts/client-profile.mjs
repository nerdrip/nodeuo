import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const host = process.env.PROFILE_HOST || '127.0.0.1';
const vitePort = Number.parseInt(process.env.PROFILE_PORT || '5173', 10);
const cdpPort = Number.parseInt(process.env.PROFILE_CDP_PORT || '9222', 10);
const durationMs = Math.max(1000, Number.parseInt(process.env.PROFILE_MS || '15000', 10));
const noServer = process.env.PROFILE_NO_SERVER === '1';
const targetUrl = process.env.PROFILE_URL || `http://${host}:${vitePort}/`;
const traceCategories = process.env.PROFILE_CATEGORIES
  || [
    'devtools.timeline',
    'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.frame',
    'disabled-by-default-devtools.timeline.invalidationTracking',
    'v8',
    'disabled-by-default-v8.cpu_profiler',
    'blink',
  ].join(',');

function log(msg) {
  console.log(`[client:profile] ${msg}`);
}

function fail(msg) {
  console.error(`[client:profile] ${msg}`);
  process.exit(1);
}

function browserCandidates() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  if (process.platform === 'win32') {
    const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
    const pfx86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    candidates.push(
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pfx86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pfx86, 'Microsoft\\Edge\\Application\\msedge.exe'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    );
  }
  return candidates.filter(Boolean);
}

function findBrowser() {
  for (const candidate of browserCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function spawnProcess(command, args, opts = {}) {
  const child = spawn(command, args, {
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
    stdio: opts.stdio || 'pipe',
    shell: false,
    windowsHide: true,
  });
  child.on('error', (err) => {
    console.error(`[client:profile] ${command} failed: ${err.message}`);
  });
  return child;
}

function pnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

async function waitForHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw lastErr || new Error(`timeout waiting for ${url}`);
}

async function waitForOpenSocket(ws) {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP websocket open timeout')), 10000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('CDP websocket error'));
    }, { once: true });
  });
}

async function connectCdp(wsUrl) {
  if (typeof WebSocket !== 'function') {
    fail('global WebSocket is not available in this Node build. Use Node 22+ or provide a browser trace manually.');
  }
  const ws = new WebSocket(wsUrl);
  await waitForOpenSocket(ws);
  let nextId = 1;
  const pending = new Map();
  const traceEvents = [];
  let traceDone = null;
  const traceComplete = new Promise((resolve) => { traceDone = resolve; });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result ?? {});
      return;
    }
    if (msg.method === 'Tracing.dataCollected') {
      for (const ev of msg.params?.value ?? []) traceEvents.push(ev);
    } else if (msg.method === 'Tracing.tracingComplete') {
      traceDone();
    }
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, 15000);
      });
    },
    async stopTrace() {
      await this.send('Tracing.end');
      await traceComplete;
      return traceEvents;
    },
    close() {
      try { ws.close(); } catch { /* ignore */ }
    },
  };
}

async function main() {
  let vite = null;
  let browser = null;
  let cdp = null;

  const cleanup = () => {
    try { cdp?.close?.(); } catch { /* ignore */ }
    try { browser?.kill?.(); } catch { /* ignore */ }
    try { vite?.kill?.(); } catch { /* ignore */ }
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  try {
    if (!noServer) {
      log(`starting Vite on ${host}:${vitePort}`);
      vite = spawnProcess(pnpmCommand(), ['exec', 'vite', '--host', host, '--port', String(vitePort), '--strictPort'], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      vite.stdout?.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) console.log(text);
      });
      vite.stderr?.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) console.error(text);
      });
      await waitForHttp(targetUrl, 20000);
    }

    const browserPath = findBrowser();
    if (!browserPath) {
      fail('Chrome/Edge/Chromium was not found. Set CHROME_PATH to the browser executable.');
    }

    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'uo-client-profile-'));
    log(`launching browser: ${browserPath}`);
    browser = spawnProcess(browserPath, [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      'about:blank',
    ], { stdio: 'ignore' });

    await waitForHttp(`http://${host}:${cdpPort}/json/version`, 15000);
    let targets = await (await waitForHttp(`http://${host}:${cdpPort}/json/list`, 5000)).json();
    let page = targets.find((t) => t.type === 'page');
    if (!page?.webSocketDebuggerUrl) fail('no debuggable page target found');

    cdp = await connectCdp(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Performance.enable');
    await cdp.send('Tracing.start', {
      categories: traceCategories,
      transferMode: 'ReportEvents',
      options: 'sampling-frequency=10000',
    });
    log(`recording ${durationMs}ms at ${targetUrl}`);
    await cdp.send('Page.navigate', { url: targetUrl });
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    const metrics = await cdp.send('Performance.getMetrics');
    const traceEvents = await cdp.stopTrace();

    const outDir = path.resolve(process.cwd(), '.profiles');
    await mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tracePath = path.join(outDir, `client-trace-${stamp}.json`);
    const metricsPath = path.join(outDir, `client-metrics-${stamp}.json`);
    await writeFile(tracePath, JSON.stringify({ traceEvents }, null, 0));
    await writeFile(metricsPath, JSON.stringify(metrics, null, 2));
    log(`trace: ${tracePath}`);
    log(`metrics: ${metricsPath}`);
  } finally {
    cleanup();
  }
}

main().catch((err) => fail(err?.stack || err?.message || String(err)));
