// Electron main process. Spawns a single window that hosts the launcher UI
// and proxies child-process control (start/stop) plus log streams via IPC.
//
// Each "service" is a named pnpm command we can spawn. Output (stdout +
// stderr) is fanned out to all renderer windows via `service:log` IPC
// events. Stopping a service kills the whole process tree on Windows
// so a parent `cmd /c pnpm ...` doesn't orphan its node child.

const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

// Repo root = three dirs above this file (apps/control-panel/src/main.cjs).
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Canonical defaults — match the values hard-coded in tools/bats/*.bat so the
// GUI launcher and the shell launchers behave identically out of the box.
// Renderer reads these via the `defaults` IPC call to pre-fill its Settings
// form (placeholder + value); user overrides flow back via env-override.
const DEFAULTS = Object.freeze({
  UO_SRC:             'D:\\Games\\Electronic Arts\\Ultima Online Classic',
  UO_HOST:            '0.0.0.0',
  UO_PORT:            '2593',
  UO_TCP_PORT:        '2594',
  UO_ADMIN_HOST:      '127.0.0.1',
  UO_ADMIN_PORT:      '2596',
  UO_ADMIN_USER:      'admin',
  UO_ADMIN_PASS:      'admin',
  UO_BRIDGE_HOST:     '127.0.0.1',
  UO_BRIDGE_PORT:     '2595',
  UO_BRIDGE_DEFAULT:  '',                 // empty = open relay; client picks target
  UO_SHARD_NAME:      'UO-Node',
  UO_HUFFMAN:         '1',
  UO_DEV_AUTO_ACCEPT: '1',
  KTX2_TOKTX:         '',                 // optional absolute path to toktx.exe
});

/**
 * Service catalogue. Each entry knows its label (tab + button text), the
 * command to run, env vars to inject, and `ports` (TCP ports the service
 * will bind). `group` puts the button into a labelled toolbar section.
 *
 * `ports` is the source of truth for two safety features:
 *   1. PRE-KILL: before spawning, force-free every listed port (kills any
 *      leftover/orphan process that's still holding it — Vite is the
 *      classic offender, it detaches from process tree on Windows).
 *   2. MUTUAL EXCLUSION: if a different running service shares ANY port
 *      with the one we're starting, auto-stop it first. This is what
 *      makes `server` and `admin` (both UO_PORT) feel like radio buttons
 *      in the UI — clicking either silently swaps the other off without
 *      the operator having to chase down a port-in-use error.
 */
const SERVICES = {
  // ---- SERVER ---------------------------------------------------------
  // WS-only by default. Raw-TCP listener (port 2594) for legacy UO
  // clients (Razor/CUO desktop) is opt-in via the toolbar "TCP 2594"
  // checkbox — when checked, the renderer injects UO_TCP_PORT into the
  // env override on click. Marcin reported surprise port-2594 traffic
  // when he only wanted browser play; the checkbox keeps the default
  // narrow ("no surprise listeners") while still letting native clients
  // connect with one extra click.
  //
  // Note: ports list includes 2594 defensively so pre-start sweeps and
  // stop-time port-kills cover the TCP listener whenever the checkbox
  // happens to be enabled. If 2594 isn't bound, killByPort is a no-op.
  'server': {
    group: 'server',
    label: 'Start Server',
    cmd: 'pnpm', args: ['--filter', '@uo/server', 'dev'],
    env: {
      UO_HOST: DEFAULTS.UO_HOST,
      UO_PORT: DEFAULTS.UO_PORT,
    },
    ports: [Number(DEFAULTS.UO_PORT), Number(DEFAULTS.UO_TCP_PORT)],
    info: `WS ${DEFAULTS.UO_PORT}. Browser play. Tick "TCP ${DEFAULTS.UO_TCP_PORT}" in the toolbar to also accept ClassicUO/Razor/OSI clients. Mutually exclusive with "Server + Admin" — they share UO_PORT.`,
  },
  // ---- ADMIN (hidden — co-started by CLIENT's "+ Admin" toggle) ------
  // Same pnpm filter as 'server' but adds the admin-panel env so the
  // panel listens on UO_ADMIN_PORT alongside game traffic. Originally
  // surfaced as its own "Server + Admin" toolbar button alongside the
  // plain server, but Marcin: "teraz już nie odpalamy w jednym batem
  // server i admin więc to jest niepotrzebne" — admin is now co-started
  // by the CLIENT group (via `coStart: ['admin']` below + the renderer's
  // "+ Admin" checkbox), so the standalone button is redundant.
  // We keep the SERVICE entry (with `hidden: true` so the renderer
  // skips drawing a button) so:
  //   • the co-start path can still spawn it
  //   • `running.has('admin')` mutual exclusion vs 'server' still works
  //   • an operator can `pnpm --filter @uo/server dev` with these env
  //     vars set manually if they're bypassing the launcher
  'admin': {
    group: 'admin',
    hidden: true,
    label: 'Server + Admin',
    cmd: 'pnpm', args: ['--filter', '@uo/server', 'dev'],
    env: {
      UO_HOST: DEFAULTS.UO_HOST,
      UO_PORT: DEFAULTS.UO_PORT,
      UO_ADMIN_HOST: DEFAULTS.UO_ADMIN_HOST,
      UO_ADMIN_PORT: DEFAULTS.UO_ADMIN_PORT,
      UO_ADMIN_USER: DEFAULTS.UO_ADMIN_USER,
      UO_ADMIN_PASS: DEFAULTS.UO_ADMIN_PASS,
    },
    ports: [Number(DEFAULTS.UO_PORT), Number(DEFAULTS.UO_TCP_PORT), Number(DEFAULTS.UO_ADMIN_PORT)],
    info: `Co-started by Browser Client when "+ Admin" is ticked. Admin panel at http://${DEFAULTS.UO_ADMIN_HOST}:${DEFAULTS.UO_ADMIN_PORT}/ (user=${DEFAULTS.UO_ADMIN_USER}, pass=${DEFAULTS.UO_ADMIN_PASS}).`,
  },
  // ---- CLIENT ---------------------------------------------------------
  // Co-starts the `admin` service so an admin account that logs into
  // the in-game client can open the admin panel in a second browser
  // tab without us asking them to also start a separate button. The
  // game client surfaces an "Open Admin Panel" link on login (gated by
  // `accessLevel === Admin`) that points at the co-started admin port.
  // Marcin: "odpalenie klienta automatem ma odpalać admina".
  'client': {
    group: 'client',
    label: 'Start Web Client',
    cmd: 'pnpm', args: ['--filter', '@uo/client', 'dev'],
    ports: [5173],
    info: `Vite dev on http://localhost:5173. Admin server is co-started by the SERVER group's "+ Admin" toggle (admin is part of @uo/server, not @uo/client).`,
  },
  // ---- ASSETS ---------------------------------------------------------
  'extract': {
    group: 'assets',
    label: 'Extract Assets',
    cmd: 'node', args: ['packages/extractor/extract.js', '--src', DEFAULTS.UO_SRC, '--out', 'apps/client/public/assets'],
    env: { UO_SRC: DEFAULTS.UO_SRC },
    ports: [],                                 // no listener
    exclusiveGroup: 'assets-write',
    requiresUoSource: ['anim.mul', 'anim.idx', 'Bodyconv.def', 'Body.def', 'mobtypes.txt'],
    info: `One-shot selectable UO mul/uop -> apps/client/public/assets. Open Scope to choose any of 23 asset steps, the animation-only preset, optional ServUO data and KTX2. Source: ${DEFAULTS.UO_SRC}.`,
    oneShot: true,
  },
  'ktx2-tool-install': {
    group: 'tools',
    label: 'Install KTX2 Tool',
    cmd: 'node', args: ['packages/extractor/ktx2-tool.js', '--install'],
    env: {},
    ports: [],
    info: 'Download/install Khronos KTX-Software so the toktx encoder is available for KTX2 atlas compression.',
    oneShot: true,
  },
  'ktx2-tool-check': {
    group: 'tools',
    label: 'Check KTX2 Tool',
    cmd: 'node', args: ['packages/extractor/ktx2-tool.js', '--check'],
    env: {},
    ports: [],
    info: 'Check whether the toktx encoder is available and print the path/version.',
    oneShot: true,
  },
  // ---- DEPENDENCIES ---------------------------------------------------
  'deps-install': {
    group: 'deps',
    label: 'Install Project Deps',
    cmd: 'pnpm', args: ['install'],
    env: {},
    ports: [],
    info: 'Run pnpm install for the whole workspace. Use after pulling the repo or changing package.json.',
    oneShot: true,
  },
  'deps-update': {
    group: 'deps',
    label: 'Update Project Deps',
    cmd: 'pnpm', args: ['update', '-r'],
    env: {},
    ports: [],
    info: 'Run pnpm update -r for the workspace. This can update pnpm-lock.yaml according to package.json ranges.',
    oneShot: true,
  },
  // ---- BRIDGE (hidden — auto-started via Client TCP toggle) -----------
  // The browser client → raw-TCP shard bridge. No longer rendered as a
  // separate button group; the Client toolbar's "TCP" checkbox starts
  // this service automatically alongside Vite. Listed here (with
  // `hidden: true` so the renderer skips drawing a button) so the IPC
  // start path can still spawn it. The reverse-proxy "bridge-in"
  // variant was removed entirely — it was a niche reverse-proxy that
  // nobody used in practice; if anyone needs it back, run
  // `pnpm --filter @uo/bridge start:debug` with UO_BRIDGE_DIRECTION=in
  // from the shell.
  'bridge-out': {
    group: 'bridge',
    hidden: true,
    label: 'Client TCP Bridge',
    cmd: 'pnpm', args: ['--filter', '@uo/bridge', 'start:debug'],
    env: {
      UO_BRIDGE_HOST: DEFAULTS.UO_BRIDGE_HOST,
      UO_BRIDGE_PORT: DEFAULTS.UO_BRIDGE_PORT,
      UO_BRIDGE_DIRECTION: 'out',
      // Always-on hex dump in the bridge tab — the operator wants to
      // SEE what's flowing (Marcin: "żeby było widać co wysyła klient").
      // 64 bytes per chunk is enough to read the opcode + name fields
      // of every UO packet header.
      UO_BRIDGE_DEBUG: '1',
      UO_BRIDGE_DEBUG_BYTES: '64',
    },
    ports: [Number(DEFAULTS.UO_BRIDGE_PORT)],
    info: 'Auto-started when Server / Admin / Client TCP toggle is on. Browser opens ws://localhost:2595/bridge?target=host:port; bridge opens raw TCP to it. Hex-dump enabled so the tab shows every packet.',
  },
};

/** @type {Map<string, { proc: import('child_process').ChildProcess }>} */
const running = new Map();

let mainWin = null;

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1180, height: 760,
    title: 'UO-Node Control Panel',
    autoHideMenuBar: true,
    backgroundColor: '#1a1410',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWin.loadFile(path.join(__dirname, 'renderer.html'));
  // Stop every running service when the window closes — avoids orphaned
  // node processes hanging around after the launcher quits.
  mainWin.on('closed', () => {
    for (const id of [...running.keys()]) stopService(id);
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const id of [...running.keys()]) stopService(id);
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC -------------------------------------------------------------------

ipcMain.handle('defaults', () => DEFAULTS);

ipcMain.handle('list-services', () => {
  // Filter to plain values (no callable refs) so the IPC marshaller is
  // happy. Add `running` flag so the UI can render correct button state.
  const out = {};
  for (const [id, s] of Object.entries(SERVICES)) {
    out[id] = {
      label: s.label,
      group: s.group ?? 'other',
      info: s.info,
      env: s.env || {},
      oneShot: !!s.oneShot,
      hidden: !!s.hidden,
      coStart: Array.isArray(s.coStart) ? [...s.coStart] : [],
      running: running.has(id),
    };
  }
  return out;
});

ipcMain.handle('start-service', (_e, { id, envOverride, options }) => {
  return startService(id, envOverride || {}, options || {});
});

ipcMain.handle('stop-service', (_e, { id }) => {
  stopService(id);
  return { ok: true };
});

ipcMain.handle('stop-all', () => {
  stopAll();
  return { ok: true };
});

ipcMain.handle('kill-port', (_e, { port }) => {
  killByPort(Number(port));
  return { ok: true };
});

ipcMain.handle('open-url', (_e, { url }) => {
  const { shell } = require('electron');
  shell.openExternal(url);
  return { ok: true };
});

// Renderer-side fetches are deliberately sandboxed and cannot reliably probe
// localhost from a file:// Electron page (CORS varies between Electron
// versions). Keep the probe in the main process, restrict it to loopback, and
// expose only a tiny status object. The launcher uses this before opening the
// admin panel so a stale browser shell cannot masquerade as a working editor.
ipcMain.handle('probe-http', (_e, { url, timeoutMs } = {}) => {
  return probeLoopbackHttp(url, timeoutMs);
});

ipcMain.handle('choose-directory', async (_e, { defaultPath } = {}) => {
  const result = await dialog.showOpenDialog(mainWin, {
    title: 'Select Ultima Online Classic folder',
    defaultPath: defaultPath || DEFAULTS.UO_SRC,
    properties: ['openDirectory'],
  });
  return { ok: !result.canceled, path: result.filePaths?.[0] ?? null };
});

// ---- service spawn ---------------------------------------------------------

function probeLoopbackHttp(rawUrl, timeoutMs = 1_500) {
  let url;
  try { url = new URL(String(rawUrl ?? '')); }
  catch { return Promise.resolve({ ok: false, error: 'invalid URL' }); }
  if (!['http:', 'https:'].includes(url.protocol)
      || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    return Promise.resolve({ ok: false, error: 'only loopback HTTP probes are allowed' });
  }
  const client = url.protocol === 'https:' ? https : http;
  const boundedTimeout = Math.max(100, Math.min(10_000, Number(timeoutMs) || 1_500));
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = client.request(url, {
      method: 'GET',
      headers: { accept: 'text/plain', connection: 'close' },
    }, (response) => {
      response.resume();
      finish({
        ok: response.statusCode >= 200 && response.statusCode < 400,
        status: response.statusCode ?? 0,
      });
    });
    request.setTimeout(boundedTimeout, () => {
      request.destroy(new Error(`timeout after ${boundedTimeout}ms`));
    });
    request.on('error', (error) => finish({ ok: false, error: error.message }));
    request.end();
  });
}

function startService(id, envOverride, options = {}) {
  const s = SERVICES[id];
  if (!s) return { ok: false, error: `Unknown service: ${id}` };
  if (running.has(id)) return { ok: false, error: `${s.label} is already running.` };

  if (s.exclusiveGroup) {
    for (const otherId of running.keys()) {
      if (SERVICES[otherId]?.exclusiveGroup !== s.exclusiveGroup) continue;
      const error = `Cannot start ${s.label}: ${SERVICES[otherId].label} is still writing the asset directory.`;
      emitLog(id, `[launcher] ${error}\n`, true);
      return { ok: false, error };
    }
  }

  // Co-start dependencies: services that declare `coStart: ['admin', …]`
  // pull their friends up first. Marcin: "odpalenie klienta ma odpalać
  // admina" — Browser Client lists `admin` here so the panel is live on
  // :2596 by the time the player logs in and the in-game UI surfaces
  // the "Open Admin Panel" link. Each co-start runs through this same
  // entrypoint so mutual exclusion + port pre-kill apply normally.
  //
  // `options.skipCoStart` lets the renderer override the default per
  // click — the CLIENT group's "+ Admin" checkbox passes
  // `skipCoStart: ['admin']` when unticked so the operator can spin up
  // a thin Vite without the admin server attached. Persists in the
  // renderer's localStorage so the choice survives launcher restarts.
  const skipSet = new Set(Array.isArray(options.skipCoStart) ? options.skipCoStart : []);
  if (Array.isArray(s.coStart)) {
    // Diagnostic — log what we got from the IPC + what we'll do.
    // Marcin: "tick nie odpala admina" — without these two lines we
    // couldn't tell whether the renderer was forgetting to send the
    // toggle state or whether main.cjs was misreading it.
    emitLog(id, `[launcher] co-start list for "${id}" = [${s.coStart.join(', ')}]; skipCoStart from renderer = [${[...skipSet].join(', ') || '(none)'}]`);
    for (const otherId of s.coStart) {
      if (skipSet.has(otherId)) {
        emitLog(id, `[launcher] co-start: skipping "${otherId}" (operator opt-out)`);
        continue;
      }
      if (!SERVICES[otherId]) {
        emitLog(id, `[launcher] co-start: WARN — no SERVICES entry for "${otherId}"`);
        continue;
      }
      if (running.has(otherId)) {
        emitLog(id, `[launcher] co-start: "${otherId}" already running, skip spawn`);
        continue;
      }
      emitLog(id, `[launcher] co-start: bringing up "${otherId}" alongside "${id}"`);
      startService(otherId, envOverride);
    }
  }

  // Mutual exclusion: any RUNNING service that binds the same port as
  // the one we're starting gets stopped first. This is what makes the
  // 'server' / 'admin' pair behave like radio buttons in the UI —
  // clicking either silently swaps the other off. It also stops the
  // less-obvious case (e.g. starting 'admin' while a stale 'server'
  // is still cleaning up its port) from producing the cryptic
  // "EADDRINUSE" the operator would otherwise have to chase.
  //
  // Co-started services are excluded from this swap — they were just
  // brought up by us above, killing them would defeat the coStart.
  const wantPorts = new Set(s.ports || []);
  const coStarted = new Set(Array.isArray(s.coStart) ? s.coStart : []);
  for (const [otherId, _entry] of running) {
    if (otherId === id) continue;
    if (coStarted.has(otherId)) continue;
    const other = SERVICES[otherId];
    if (!other?.ports?.length) continue;
    const overlap = other.ports.some((p) => wantPorts.has(p));
    if (overlap) {
      emitLog(id, `[launcher] auto-stopping "${otherId}" (port conflict on ${other.ports.filter((p) => wantPorts.has(p)).join(', ')})`);
      stopService(otherId);
    }
  }

  // Pre-kill known ports — sweeps any orphaned listener (typically Vite
  // detaching from the process tree on Windows + surviving a panel
  // close) BEFORE the spawn so the new process gets a clean bind.
  // Without this, restarting Browser Client after the previous run
  // crashed would always fail with "Port 5173 already in use".
  for (const port of (s.ports || [])) {
    killByPort(port);
  }

  const env = { ...process.env, ...(s.env || {}), ...envOverride };
  if (Array.isArray(s.requiresUoSource)) {
    const onlyArgIndex = Array.isArray(options.extraArgs)
      ? options.extraArgs.indexOf('--only')
      : -1;
    const selectedSteps = onlyArgIndex >= 0
      ? String(options.extraArgs[onlyArgIndex + 1] ?? '').split(',').map((step) => step.trim()).filter(Boolean)
      : null;
    const isServUOStep = (step) => step === 'decoration'
      || step === 'xmlspawner'
      || step.startsWith('servuo-');
    // The checkbox UI can run a narrow asset subset or only the in-repo
    // ServUO refresh. UO_SRC is needed only when at least one selected step
    // actually reads retail client files; KTX2 works on existing output.
    const needsUoSource = selectedSteps == null
      || selectedSteps.some((step) => step !== 'ktx2' && !isServUOStep(step));
    const needsAnimationConfig = selectedSteps == null || selectedSteps.includes('anim');
    if (!needsUoSource) {
      emitLog(id, '[launcher] extraction preflight — selected steps do not read UO_SRC.\n');
    }
    const source = String(env.UO_SRC ?? '').trim();
    let sourceNames = null;
    if (needsUoSource && source && fs.existsSync(source)) {
      try { sourceNames = new Set(fs.readdirSync(source).map((name) => name.toLowerCase())); }
      catch { sourceNames = null; }
    }
    const requiredFiles = needsAnimationConfig ? s.requiresUoSource : [];
    const missing = !needsUoSource
      ? []
      : !sourceNames
        ? [...requiredFiles]
        : requiredFiles.filter((name) => !sourceNames.has(name.toLowerCase()));
    if (needsUoSource && (!sourceNames || missing.length)) {
      const error = !source || !fs.existsSync(source)
        ? `UO_SRC does not exist: ${source || '(empty)'}`
        : `UO_SRC is incomplete; missing: ${missing.join(', ')}`;
      emitLog(id, `[launcher] extraction preflight failed — ${error}\n`, true);
      return { ok: false, error };
    }
    if (needsUoSource) emitLog(id, `[launcher] extraction preflight OK — ${source}\n`);
    if (needsAnimationConfig && ![...(sourceNames ?? [])].some((name) => /^animationframe.*\.uop$/i.test(name))) {
      emitLog(id, '[launcher] warning: no AnimationFrame*.uop files; modern bodies may have only legacy fallback art.\n', true);
    }
    if (needsAnimationConfig && !sourceNames?.has('animationsequence.uop')) {
      emitLog(id, '[launcher] warning: AnimationSequence.uop is absent; modern action remaps will use identity groups.\n', true);
    }
  }
  const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
  const onlyIndex = extraArgs.indexOf('--only');
  const onlySteps = onlyIndex >= 0
    ? String(extraArgs[onlyIndex + 1] ?? '').split(',').map((step) => step.trim())
    : [];
  const wantsKtx2 = id === 'extract'
    && (extraArgs.includes('--ktx2') || onlySteps.includes('ktx2'));
  if (wantsKtx2) {
    const toktx = findToktxFast(env.KTX2_TOKTX, env);
    if (!toktx) {
      const error = 'KTX2 is selected, but toktx is unavailable. Use TOOLS -> Install KTX2 Tool, configure KTX2_TOKTX, or untick KTX2.';
      emitLog(id, `[launcher] ${error}\n`, true);
      return { ok: false, error };
    }
    emitLog(id, `[launcher] KTX2 tool preflight OK — ${toktx}\n`);
  }
  // Args may carry tokens we want to substitute from the resolved env
  // (extractor's --src argument, mainly). Replace any literal default
  // path with the merged value so a UO_SRC override actually changes
  // where the extractor reads from.
  let args = s.args.map((a) => {
    if (a === DEFAULTS.UO_SRC && env.UO_SRC) return env.UO_SRC;
    return a;
  });
  // `options.extraArgs` carries the explicit checkbox scope (`--only`),
  // optional KTX2 post-processing and future per-launch flags. The renderer
  // sends an explicit list even for a full pass, so the visible selection is
  // always the source of truth for what the extractor will touch.
  if (Array.isArray(options.extraArgs) && options.extraArgs.length) {
    args = [...args, ...options.extraArgs];
    emitLog(id, `[launcher] extraArgs from renderer: [${options.extraArgs.join(', ')}]`);
  }
  // pnpm.cmd on Windows is a .cmd shim; spawning needs shell:true so cmd
  // resolves it. shell:true also handles env-var-based PATH lookup
  // (npm/pnpm aren't always in process.env.PATH for GUI-launched apps).
  //
  // BUT shell:true also splits args on whitespace, so a path like
  //   D:\Games\Electronic Arts\Ultima Online Classic
  // gets parsed as four separate args by the shell. Quote each arg
  // that contains a space using the platform-native syntax (Windows
  // cmd.exe accepts double quotes, POSIX sh accepts the same +
  // backslash-escaping). The simple `"…"` wrapping below is the same
  // strategy npm/yarn use when invoking child commands.
  const quotedArgs = args.map((a) => {
    if (typeof a !== 'string') return String(a);
    if (!/[\s"]/.test(a)) return a;             // no whitespace, no quotes needed
    // Escape any embedded double quotes (rare; UO paths don't contain them
    // but keep the helper general).
    return `"${a.replace(/"/g, process.platform === 'win32' ? '\\"' : '\\"')}"`;
  });
  const proc = spawn(s.cmd, quotedArgs, {
    cwd: REPO_ROOT,
    env,
    shell: true,
    windowsHide: true,
  });
  running.set(id, { proc });
  emitLog(id, `[launcher] starting ${s.cmd} ${quotedArgs.join(' ')} (cwd=${REPO_ROOT})`);
  emitLog(id, `[launcher] env override: ${Object.keys(envOverride).join(', ') || '(none)'}`);

  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => emitLog(id, chunk));
  proc.stderr.on('data', (chunk) => emitLog(id, chunk, true));
  proc.on('exit', (code, signal) => {
    emitLog(id, `[launcher] exited code=${code} signal=${signal ?? ''}`);
    running.delete(id);
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('service:state', { id, running: false });
    }
  });
  proc.on('error', (error) => {
    emitLog(id, `[launcher] spawn failed: ${error.message}\n`, true);
    running.delete(id);
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('service:state', { id, running: false });
    }
  });
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('service:state', { id, running: true });
  }
  return { ok: true, pid: proc.pid };
}

/**
 * Fast launcher-side KTX2 preflight. The extractor's comprehensive lookup is
 * useful as a CLI diagnostic, but recursively scanning Program Files from a
 * synchronous Electron IPC handler can freeze the whole window for a minute.
 * The panel only checks explicit config, PATH and its own installer directory.
 */
function findToktxFast(preferred, env) {
  const configured = String(preferred ?? '').trim();
  const candidates = [];
  if (configured) candidates.push(configured);
  // These are the same installation roots used by ktx2-tool.js, but each is
  // already narrowed to a KTX-specific directory. Searching inside them is
  // fast and recognises the normal Khronos installer location without the
  // minute-long freeze caused by scanning all of Program Files.
  const roots = [
    path.join(REPO_ROOT, 'tools', 'ktx-software'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'KTX-Software'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Khronos Group', 'KTX-Software'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'KTX-Software'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'KTX-Software'),
  ].filter(Boolean);
  for (const root of roots) {
    const found = findFileLimited(root, 'toktx.exe', 5);
    if (found) candidates.push(found);
  }
  candidates.push('toktx');
  for (const command of [...new Set(candidates)]) {
    if ((/[\\/]/.test(command) || /\.exe$/i.test(command)) && !fs.existsSync(command)) continue;
    const check = spawnSync(command, ['--version'], {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2500,
    });
    if (!check.error && check.status === 0) return command;
  }
  return null;
}

function findFileLimited(root, fileName, depth) {
  if (depth < 0 || !fs.existsSync(root)) return null;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return null; }
  const direct = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase());
  if (direct) return path.join(root, direct.name);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = findFileLimited(path.join(root, entry.name), fileName, depth - 1);
    if (nested) return nested;
  }
  return null;
}

function stopService(id) {
  const e = running.get(id);
  if (!e) return;
  emitLog(id, `[launcher] stopping pid=${e.proc.pid}...`);
  // Try a GRACEFUL shutdown first via the admin HTTP endpoint —
  // ServUO-style. This triggers our SIGINT handler, runs final
  // `saveWorldSync` + `saveHousesSync` + `saveBazaarSync`, then
  // exits cleanly. On Windows, `taskkill /f` (used below as a
  // fallback) is equivalent to SIGKILL and SKIPS the SIGINT
  // handler — user report 2026-05-18 "przedmioty z plecaka nie
  // zachowują się po wyłączeniu servera" was the symptom of that.
  const adminPort = (SERVICES[id]?.env?.UO_ADMIN_PORT)
                 ?? (SERVICES[id]?.coStartEnv?.UO_ADMIN_PORT)
                 ?? DEFAULTS.UO_ADMIN_PORT;
  const adminUser = SERVICES[id]?.env?.UO_ADMIN_USER ?? DEFAULTS.UO_ADMIN_USER;
  const adminPass = SERVICES[id]?.env?.UO_ADMIN_PASS ?? DEFAULTS.UO_ADMIN_PASS;
  const isServer = SERVICES[id]?.group === 'server' || SERVICES[id]?.group === 'admin';
  const finishKill = () => {
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(e.proc.pid), '/f', '/t'], { windowsHide: true });
        // Best-effort port kill — vite et al. occasionally detach.
        for (const port of (SERVICES[id]?.ports ?? [])) {
          killByPort(port);
        }
      } catch (err) {
        emitLog(id, `[launcher] taskkill failed: ${err.message}`, true);
      }
    } else {
      try { e.proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
  };
  if (isServer && adminPort) {
    const auth = Buffer.from(`${adminUser}:${adminPass}`).toString('base64');
    emitLog(id, `[launcher] graceful POST /api/world/shutdown (admin:${adminPort})`);
    try {
      const req = require('node:http').request({
        host: '127.0.0.1', port: Number(adminPort), method: 'POST',
        path: '/api/world/shutdown', timeout: 1500,
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Length': 0 },
      }, (res) => {
        emitLog(id, `[launcher] graceful shutdown ack (HTTP ${res.statusCode}). Waiting 5s for final save…`);
        // Final save can take a few seconds on a populated shard.
        // taskkill /f kicks in afterwards as a safety net in case the
        // shutdown handler hangs.
        setTimeout(finishKill, 5_000);
      });
      req.on('error', () => {
        emitLog(id, '[launcher] graceful endpoint unreachable — falling back to taskkill');
        finishKill();
      });
      req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } });
      req.end();
      return;     // finishKill scheduled by HTTP callback
    } catch (err) {
      emitLog(id, `[launcher] graceful attempt threw: ${err.message} — taskkill`, true);
    }
  }
  finishKill();
}

/** Force-kill any process holding `port` (Windows only). Synchronous —
 *  the start path needs the kill to complete BEFORE the new spawn so
 *  the new process gets a clean bind. The async netstat pipe used to
 *  race the spawn and the new process would still see "EADDRINUSE". */
function killByPort(port) {
  if (process.platform !== 'win32') return;
  const { execSync } = require('node:child_process');
  let buf = '';
  try {
    buf = execSync(`netstat -ano | findstr :${port}`, {
      windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return;                  // findstr exits 1 when no match — that's the happy path
  }
  const pids = new Set();
  for (const line of buf.split('\n')) {
    const m = /LISTENING\s+(\d+)/.exec(line);
    if (m) pids.add(m[1]);
  }
  for (const pid of pids) {
    try {
      execSync(`taskkill /pid ${pid} /f /t`, { windowsHide: true, stdio: 'ignore' });
    } catch { /* PID already gone — fine */ }
  }
}

/** Kill EVERY tracked service. UI exposes a "Stop all" button. */
function stopAll() {
  for (const id of [...running.keys()]) stopService(id);
}

function emitLog(id, chunk, isErr = false) {
  if (!mainWin || mainWin.isDestroyed()) return;
  // Strip ANSI escape codes — our renderer is plain HTML, the colour
  // codes look like garbage there.
  const clean = String(chunk).replace(/\x1b\[[0-9;]*m/g, '');
  mainWin.webContents.send('service:log', { id, text: clean, err: isErr });
}

// Bring extractor logs through too.
void fs;
