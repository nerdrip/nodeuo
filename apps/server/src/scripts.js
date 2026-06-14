// Scripts loader with hot-reload + error isolation.
//
// Each script in `apps/scripts/src/**.js` exports `default (api) => disposer`.
// Reload lifecycle:
//   1. On startup: recursively collect files, import each, call default.
//   2. On file change (or manual `reload()` call): run all disposers in
//      reverse order, then reload everything fresh.
//
// Isolation: each script import + invocation is wrapped in try/catch so a
// single broken file cannot crash the server. True VM-level isolation
// (`isolated-vm` / `vm.SourceTextModule`) is deferred until we support
// untrusted userscripts; in the current model scripts are first-party.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {Object} ScriptAPI
 * @property {import('./world/world.js').World} world
 * @property {import('./net/commands.js').CommandRegistry} commands
 * @property {typeof import('./world/items.js')} items
 * @property {typeof import('./world/templates.js')} [templates]
 * @property {import('./world/ai.js').AIScheduler} [ai]
 * @property {{ request: (state: any, cb: (picked: any) => void, opts?: any) => void }} [targeting]
 * @property {typeof import('@uo/protocol')} [protocol]
 * @property {ReturnType<typeof import('./world/query-api.js').createWorldQueryApi>} [query]
 * @property {ReturnType<typeof import('./world/ops-api.js').createWorldOpsApi>} [ops]
 * @property {ReturnType<typeof import('./script-game-api.js').createScriptGameApi>} [game]
 * @property {{ register: Function, unregister: Function, get: Function, all: Function, dispatch: Function }} [itemScripts]
 * @property {{ pickForMob: Function, pickMonster: Function }} [names]
 * @property {typeof import('./notoriety.js')} [notoriety]
 * @property {typeof import('./poison.js')} [poison]
 * @property {typeof import('./regen.js')} [regen]
 * @property {Record<string, any>} [systems]
 * @property {ReturnType<typeof createScriptLifecycle>} [lifecycle]
 * @property {(msg: string) => void} log
 */

/**
 * @typedef {Object} LoadedScript
 * @property {string} file
 * @property {(() => unknown) | undefined} disposer
 */

/** Script runtime that holds current loaded scripts and watches for changes. */
export class ScriptRuntime {
  /**
   * @param {string} scriptsDir
   * @param {ScriptAPI} api
   */
  constructor(scriptsDir, api) {
    this.scriptsDir = scriptsDir;
    this.audit = createScriptAudit(api?.scriptAudit);
    this.api = api ?? {};
    this.api.scriptAudit = this.audit;
    /** @type {LoadedScript[]} */
    this.loaded = [];
    /** @type {fs.FSWatcher | null} */
    this._watcher = null;
    /** @type {NodeJS.Timeout | null} */
    this._reloadTimer = null;
    /** @type {Promise<void> | null} */
    this._loadChain = null;
    /** @type {{ reason: string, emitEvent: boolean } | null} */
    this._pendingLoadRequest = null;
    this._watchQuietUntil = 0;
    this._lastSuppressedWatchLogAt = 0;
    this._watchDebounceMs = positiveIntEnv('UO_SCRIPT_WATCH_DEBOUNCE_MS', 600);
    this._watchQuietMs = positiveIntEnv('UO_SCRIPT_WATCH_QUIET_MS', 1200);
  }

  /** Load (or reload) all scripts. */
  async load(options = {}) {
    const request = normalizeLoadRequest(options);
    if (this._loadChain) {
      this._pendingLoadRequest = mergeLoadRequests(this._pendingLoadRequest, request);
      return this._loadChain;
    }
    this._loadChain = this._drainLoadQueue(request).finally(() => {
      this._loadChain = null;
    });
    return this._loadChain;
  }

  async _drainLoadQueue(firstRequest) {
    let request = firstRequest;
    while (request) {
      this._pendingLoadRequest = null;
      await this._loadOnce(request);
      if (request.emitEvent) this._emitReloaded();
      request = this._pendingLoadRequest;
    }
  }

  async _loadOnce(request) {
    this._extendWatchQuietWindow();
    try {
      await this._dispose();
      this.audit.clear();
      if (!fs.existsSync(this.scriptsDir)) {
        this.api.log(`scripts dir not found: ${this.scriptsDir}`);
        return;
      }
      const files = collectScriptFiles(this.scriptsDir);
      for (const file of files) {
        try {
          // Cache-bust so re-imports actually re-run the module top-level.
          const url = `${pathToFileURL(file).href}?t=${Date.now()}`;
          const mod = await import(url);
          const fn = mod.default;
          if (typeof fn !== 'function') {
            this.api.log(`script ${this._rel(file)}: no default export, skipping`);
            continue;
          }
          const scoped = createScopedScriptApi(this.api, this._rel(file));
          const maybeDisposer = safeCall(fn, scoped.api, (e) => {
            this.api.log(`script ${this._rel(file)} threw during init: ${e.message}`);
          });
          this.loaded.push({
            file,
            disposer: composeDisposer(maybeDisposer, scoped.lifecycle),
          });
          this.api.log(`script loaded: ${this._rel(file)}`);
        } catch (e) {
          this.api.log(`script ${this._rel(file)} failed: ${e.message}`);
        }
      }
      this.audit.assertClean();
      if (request.reason && request.reason !== 'manual') {
        this.api.log(`scripts reload complete (${request.reason}): ${this.loaded.length} loaded`);
      }
    } finally {
      this._extendWatchQuietWindow();
    }
  }

  /**
   * Reload a single script by its relative path under `scriptsDir`
   * (forward-slash form, e.g. `npcs/templates/townspeople.js`). Disposes
   * the matching entry first (so its registry mutations roll back), then
   * re-imports + re-runs `default()`. Returns `{ ok, error? }`.
   *
   * Useful for `[reload <name>]` and the admin panel's per-file reload
   * button — full `load()` reload disposes everything, which is heavier
   * than necessary when only one file changed.
   */
  async reloadOne(rel) {
    if (this._loadChain) await this._loadChain;
    const target = path.resolve(this.scriptsDir, rel.replace(/[\\/]/g, path.sep));
    const label = this._rel(target);
    this.audit.clearLabel(label);
    // Find the loaded entry (path comparison is forgiving — runtime
    // stores absolute paths, callers may pass either separator).
    const idx = this.loaded.findIndex((s) => path.resolve(s.file) === target);
    if (idx >= 0) {
      const s = this.loaded[idx];
      if (s.disposer) {
        safeCall(s.disposer, undefined, (e) => {
          this.api.log(`script ${this._rel(s.file)} disposer threw: ${e.message}`);
        });
      }
      this.loaded.splice(idx, 1);
    }
    if (!fs.existsSync(target)) {
      return { ok: false, error: `script not found: ${rel}` };
    }
    try {
      const url = `${pathToFileURL(target).href}?t=${Date.now()}`;
      const mod = await import(url);
      const fn = mod.default;
      if (typeof fn !== 'function') {
        return { ok: false, error: 'no default export' };
      }
      const scoped = createScopedScriptApi(this.api, label);
      const maybeDisposer = safeCall(fn, scoped.api, (e) => {
        this.api.log(`script ${this._rel(target)} threw during reloadOne: ${e.message}`);
      });
      this.loaded.push({
        file: target,
        disposer: composeDisposer(maybeDisposer, scoped.lifecycle),
      });
      this.api.log(`script reloaded: ${this._rel(target)}`);
      this._emitReloaded();
      this.audit.assertClean({ label });
      return { ok: true, rel: this._rel(target) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** Enable debounced file-watch hot-reload. No-op if already watching. */
  watch() {
    if (this._watcher) return;
    if (!fs.existsSync(this.scriptsDir)) return;
    try {
      this._watcher = fs.watch(this.scriptsDir, { recursive: true }, (_ev, filename) => {
        const changed = normalizeWatchScriptFilename(this.scriptsDir, filename);
        if (!changed) return;
        if (this._loadChain || Date.now() < this._watchQuietUntil) {
          this._logSuppressedWatchChange(changed);
          return;
        }
        this._scheduleWatchReload(changed);
      });
      this.api.log(`watching ${this.scriptsDir}`);
    } catch (e) {
      this.api.log(`file watch unavailable: ${e.message}`);
    }
  }

  stop() {
    if (this._watcher) { this._watcher.close(); this._watcher = null; }
    if (this._reloadTimer) { clearTimeout(this._reloadTimer); this._reloadTimer = null; }
  }

  _scheduleWatchReload(changed) {
    if (this._reloadTimer) clearTimeout(this._reloadTimer);
    this._reloadTimer = setTimeout(() => {
      this._reloadTimer = null;
      if (this._loadChain || Date.now() < this._watchQuietUntil) {
        this._logSuppressedWatchChange(changed);
        return;
      }
      this.api.log(`reloading scripts (changed: ${changed})`);
      this.load({ reason: `watch:${changed}`, emitEvent: true })
        .catch((e) => this.api.log(`reload failed: ${e.message}`));
    }, this._watchDebounceMs);
    this._reloadTimer.unref?.();
  }

  _extendWatchQuietWindow() {
    this._watchQuietUntil = Date.now() + this._watchQuietMs;
  }

  _logSuppressedWatchChange(changed) {
    const now = Date.now();
    if (now - this._lastSuppressedWatchLogAt < 2000) return;
    this._lastSuppressedWatchLogAt = now;
    this.api.log(`ignored script watch event during reload quiet window: ${changed}`);
  }

  _emitReloaded() {
    try { this.api.world?.events?.emit?.('scripts:reloaded'); } catch { /* event bus optional */ }
  }

  async _dispose() {
    for (let i = this.loaded.length - 1; i >= 0; i--) {
      const s = this.loaded[i];
      if (!s.disposer) continue;
      safeCall(s.disposer, undefined, (e) => {
        this.api.log(`script ${this._rel(s.file)} disposer threw: ${e.message}`);
      });
    }
    this.loaded = [];
  }

  _rel(file) { return path.relative(this.scriptsDir, file); }
}

/**
 * Load scripts once. Returns the runtime so the caller can trigger `load()`
 * again or `watch()` later.
 *
 * @param {string} scriptsDir
 * @param {ScriptAPI} api
 * @returns {Promise<ScriptRuntime>}
 */
export async function loadScripts(scriptsDir, api) {
  const rt = new ScriptRuntime(scriptsDir, api);
  await rt.load();
  return rt;
}

function normalizeLoadRequest(options = {}) {
  return {
    reason: String(options.reason || 'manual'),
    emitEvent: Boolean(options.emitEvent),
  };
}

function mergeLoadRequests(current, next) {
  if (!current) return next;
  return {
    reason: current.reason === next.reason ? current.reason : `${current.reason}+${next.reason}`,
    emitEvent: current.emitEvent || next.emitEvent,
  };
}

function positiveIntEnv(name, fallback) {
  const value = Number.parseInt(String(process.env[name] ?? ''), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeWatchScriptFilename(scriptsDir, filename) {
  if (!filename) return null;
  const raw = Buffer.isBuffer(filename) ? filename.toString('utf8') : String(filename);
  if (!raw.trim()) return null;
  const full = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(scriptsDir, raw);
  const rel = path.relative(scriptsDir, full).replace(/\\/g, '/');
  if (!rel || rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) return null;
  if (!rel.endsWith('.js')) return null;
  if (rel.endsWith('.d.js') || rel.endsWith('.min.js.map')) return null;
  if (/(^|\/)(node_modules|\.git|dist|coverage|tmp|\.tmp)(\/|$)/i.test(rel)) return null;
  if (/(^|\/)[^/]*(?:~|\.swp|\.tmp)$/.test(rel)) return null;
  return rel;
}

function collectScriptFiles(dir, out = []) {
  const names = fs.readdirSync(dir).sort();
  for (const name of names) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) collectScriptFiles(full, out);
    else if (st.isFile() && full.endsWith('.js')) out.push(full);
  }
  return out;
}

function safeCall(fn, arg, onError) {
  try {
    return arg === undefined ? fn() : fn(arg);
  } catch (e) {
    onError(e instanceof Error ? e : new Error(String(e)));
    return undefined;
  }
}

const DEFAULT_SCRIPT_AUDIT_PATTERN = /\b(engine API missing|missing api|missing api deps|not wired|unavailable; skipping|registration skipped|registerItem missing|registerRecipe[^\n]*missing|protocol helpers missing|system not wired)\b/i;

function createScriptAudit(options = {}) {
  const enabled = options.enabled ?? process.env.UO_SCRIPT_AUDIT === '1';
  const failOnWarnings = options.failOnWarnings ?? (
    process.env.UO_SCRIPT_AUDIT_FAIL == null
      ? enabled
      : process.env.UO_SCRIPT_AUDIT_FAIL !== '0'
  );
  const pattern = options.pattern ?? DEFAULT_SCRIPT_AUDIT_PATTERN;
  const warnings = [];
  const missingCapabilities = [];
  const missingKeys = new Set();

  const recordMissing = (label, apiPath) => {
    if (!enabled || !label || !apiPath) return;
    const key = `${label}\0${apiPath}`;
    if (missingKeys.has(key)) return;
    missingKeys.add(key);
    missingCapabilities.push({ label, path: apiPath });
  };

  const wrapObject = (value, label, apiPath, seen) => {
    if (!enabled || !value || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    const proxy = new Proxy(value, {
      get(target, prop, receiver) {
        if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
        if (prop === 'then' || prop === 'inspect' || prop === 'toJSON') {
          return Reflect.get(target, prop, receiver);
        }
        if (!Reflect.has(target, prop)) {
          recordMissing(label, `${apiPath}.${String(prop)}`);
          return undefined;
        }
        const next = Reflect.get(target, prop, receiver);
        return wrapObject(next, label, `${apiPath}.${String(prop)}`, seen);
      },
      has(target, prop) {
        if (typeof prop !== 'symbol' && !Reflect.has(target, prop)) {
          recordMissing(label, `${apiPath}.${String(prop)}`);
        }
        return Reflect.has(target, prop);
      },
    });
    seen.set(value, proxy);
    return proxy;
  };

  return {
    enabled,
    failOnWarnings,
    warnings,
    missingCapabilities,

    clear() {
      warnings.length = 0;
      missingCapabilities.length = 0;
      missingKeys.clear();
    },

    clearLabel(label) {
      for (let i = warnings.length - 1; i >= 0; i--) {
        if (warnings[i].label === label) warnings.splice(i, 1);
      }
      for (let i = missingCapabilities.length - 1; i >= 0; i--) {
        if (missingCapabilities[i].label === label) {
          missingKeys.delete(`${label}\0${missingCapabilities[i].path}`);
          missingCapabilities.splice(i, 1);
        }
      }
    },

    record(label, message) {
      if (!enabled) return;
      const text = String(message ?? '');
      if (!pattern.test(text)) return;
      warnings.push({ label, message: text });
    },

    wrap(api, label) {
      return wrapObject(api, label, 'api', new WeakMap());
    },

    report(scope = {}) {
      const scopedWarnings = scope.label
        ? warnings.filter((entry) => entry.label === scope.label)
        : warnings;
      const scopedMissing = scope.label
        ? missingCapabilities.filter((entry) => entry.label === scope.label)
        : missingCapabilities;
      return {
        warnings: scopedWarnings.slice(),
        missingCapabilities: scopedMissing.slice(),
        summary: {
          warnings: scopedWarnings.length,
          missingCapabilities: scopedMissing.length,
        },
      };
    },

    assertClean(scope = {}) {
      if (!enabled || !failOnWarnings) return;
      const report = this.report(scope);
      const findings = [
        ...report.warnings.map((entry) => ({
          label: entry.label,
          message: entry.message,
        })),
        ...report.missingCapabilities.map((entry) => ({
          label: entry.label,
          message: `missing capability: ${entry.path}`,
        })),
      ];
      if (findings.length === 0) return;
      const sample = findings.slice(0, 12)
        .map((entry) => `- ${entry.label}: ${entry.message}`)
        .join('\n');
      const suffix = findings.length > 12 ? `\n... ${findings.length - 12} more` : '';
      throw new Error(`Script API audit failed (${findings.length} finding${findings.length === 1 ? '' : 's'}):\n${sample}${suffix}`);
    },
  };
}

function createScopedScriptApi(baseApi, label) {
  const lifecycle = createScriptLifecycle(label, baseApi);
  const commands = createScopedCommands(baseApi.commands, lifecycle);
  const baseLog = baseApi.log;
  const scopedLog = typeof baseLog === 'function'
    ? (msg, ...args) => {
        const text = args.length > 0 ? [msg, ...args].map(String).join(' ') : String(msg);
        baseApi.scriptAudit?.record?.(label, text);
        return baseLog(text);
      }
    : undefined;
  const api = new Proxy(baseApi, {
    get(target, prop, receiver) {
      if (prop === 'lifecycle') return lifecycle;
      if (prop === 'commands' && commands) return commands;
      if (prop === 'log' && scopedLog) return scopedLog;
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value) {
      if (prop === 'lifecycle' || prop === 'commands' || prop === 'log') return false;
      return Reflect.set(target, prop, value);
    },
    has(target, prop) {
      return prop === 'lifecycle' || prop === 'log' || (prop === 'commands' && commands) || Reflect.has(target, prop);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop === 'lifecycle') {
        return { configurable: true, enumerable: true, value: lifecycle };
      }
      if (prop === 'commands' && commands) {
        return { configurable: true, enumerable: true, value: commands };
      }
      if (prop === 'log' && scopedLog) {
        return { configurable: true, enumerable: true, value: scopedLog };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    ownKeys(target) {
      return [...new Set([...Reflect.ownKeys(target), 'commands', 'lifecycle', 'log'])];
    },
  });
  return { api: baseApi.scriptAudit?.wrap?.(api, label) ?? api, lifecycle };
}

function createScopedCommands(baseCommands, lifecycle) {
  if (!baseCommands) return null;
  const registered = new Map();
  const commandKey = (name) => String(name).toLowerCase();

  lifecycle.onDispose(() => {
    const names = Array.from(registered.values()).reverse();
    registered.clear();
    for (const name of names) {
      try { baseCommands.unregister?.(name); } catch { /* registry optional */ }
    }
  });

  return new Proxy(baseCommands, {
    get(target, prop, receiver) {
      if (prop === 'register' && typeof target.register === 'function') {
        return (spec, ...args) => {
          const result = target.register.call(target, spec, ...args);
          if (spec?.name != null) registered.set(commandKey(spec.name), spec.name);
          return result;
        };
      }
      if (prop === 'unregister' && typeof target.unregister === 'function') {
        return (name, ...args) => {
          const result = target.unregister.call(target, name, ...args);
          if (name != null) registered.delete(commandKey(name));
          return result;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, prop, value, receiver) {
      return Reflect.set(target, prop, value, receiver);
    },
  });
}

function createScriptLifecycle(label, baseApi = {}) {
  const log = baseApi.log ?? (() => {});
  const disposers = [];
  let disposed = false;

  const runTimer = (kind, fn, args) => {
    safeCall(() => fn(...args), undefined, (e) => {
      log(`script ${label} lifecycle ${kind} threw: ${e.message}`);
    });
  };

  const onDispose = (fn) => {
    if (typeof fn !== 'function') return () => {};
    if (disposed) {
      safeCall(fn, undefined, (e) => log(`script ${label} lifecycle disposer threw: ${e.message}`));
      return () => {};
    }
    disposers.push(fn);
    return () => {
      const idx = disposers.indexOf(fn);
      if (idx >= 0) disposers.splice(idx, 1);
    };
  };

  const lifecycle = {
    onDispose,

    command(spec) {
      if (!spec?.name || !baseApi.commands?.register) return null;
      baseApi.commands.register(spec);
      onDispose(() => {
        try { baseApi.commands?.unregister?.(spec.name); } catch { /* registry optional */ }
      });
      return spec;
    },

    commands(specs = []) {
      const out = [];
      for (const spec of specs) {
        const registered = lifecycle.command(spec);
        if (registered) out.push(registered);
      }
      return out;
    },

    event(sourceOrName, eventNameOrHandler, maybeHandler) {
      const source = typeof sourceOrName === 'string'
        ? baseApi.world?.events
        : sourceOrName;
      const eventName = typeof sourceOrName === 'string'
        ? sourceOrName
        : eventNameOrHandler;
      const handler = typeof sourceOrName === 'string'
        ? eventNameOrHandler
        : maybeHandler;
      if (!source?.on || typeof eventName !== 'string' || typeof handler !== 'function') {
        return () => {};
      }
      const unsub = source.on(eventName, handler);
      const cleanup = typeof unsub === 'function'
        ? unsub
        : () => source.off?.(eventName, handler);
      onDispose(() => {
        try { cleanup?.(); } catch { /* event bus optional */ }
      });
      return cleanup;
    },

    setTimeout(fn, delay, ...args) {
      const handle = setTimeout(() => runTimer('timeout', fn, args), delay);
      handle.unref?.();
      onDispose(() => clearTimeout(handle));
      return handle;
    },

    setInterval(fn, delay, ...args) {
      const handle = setInterval(() => runTimer('interval', fn, args), delay);
      handle.unref?.();
      onDispose(() => clearInterval(handle));
      return handle;
    },

    setImmediate(fn, ...args) {
      const handle = setImmediate(() => runTimer('immediate', fn, args));
      handle.unref?.();
      onDispose(() => clearImmediate(handle));
      return handle;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (let i = disposers.length - 1; i >= 0; i--) {
        safeCall(disposers[i], undefined, (e) => {
          log(`script ${label} lifecycle disposer threw: ${e.message}`);
        });
      }
      disposers.length = 0;
    },
  };

  lifecycle.timeout = lifecycle.setTimeout;
  lifecycle.interval = lifecycle.setInterval;
  lifecycle.immediate = lifecycle.setImmediate;
  return Object.freeze(lifecycle);
}

function composeDisposer(maybeDisposer, lifecycle) {
  const scriptDisposer = typeof maybeDisposer === 'function' ? maybeDisposer : null;
  if (!scriptDisposer && !lifecycle) return undefined;
  return () => {
    try {
      scriptDisposer?.();
    } finally {
      lifecycle?.dispose?.();
    }
  };
}
