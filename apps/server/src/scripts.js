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
import { runtimeGovernor } from './systems/runtime-governor.js';

// File discovery is deterministic but comparatively expensive on Windows
// (hundreds of synchronous stat calls). Keep the immutable sorted manifest
// between reloads; the recursive watcher invalidates it before a changed file
// is activated. This removes the scan from ordinary admin/manual reloads.
const SCRIPT_MANIFEST_CACHE = new Map();
export const scriptExecutionLimits = {
  maxCallbackMs: positiveIntEnv('UO_SCRIPT_CALLBACK_MAX_MS', 25),
  maxCallbacksPerSecond: positiveIntEnv('UO_SCRIPT_CALLBACKS_PER_SECOND', 5000),
};

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
    this.verboseLoads = /^(1|true|yes)$/i.test(String(process.env.UO_SCRIPT_LOG_EACH ?? ''));
    this.importConcurrency = positiveIntEnv('UO_SCRIPT_IMPORT_CONCURRENCY', 24);
    this.initTimeoutMs = positiveIntEnv('UO_SCRIPT_INIT_TIMEOUT_MS', 250);
    this.profile = { scanMs: 0, importMs: 0, initMs: 0, totalMs: 0, files: 0, loaded: 0,
      skipped: 0, failed: 0, errors: [], slowest: [], lastLoadAt: 0, reason: 'startup' };
    this.reloadHistory = [];
    this.dependencyGraph = { dependencies: new Map(), dependents: new Map(), files: 0, builtAt: 0 };
  }

  configureExecutionLimits(limits = {}) {
    if (Number.isFinite(Number(limits.maxCallbackMs))) {
      scriptExecutionLimits.maxCallbackMs = Math.max(1, Math.min(10_000, Number(limits.maxCallbackMs)));
    }
    if (Number.isFinite(Number(limits.maxCallbacksPerSecond))) {
      scriptExecutionLimits.maxCallbacksPerSecond = Math.max(10, Math.min(1_000_000,
        Math.round(Number(limits.maxCallbacksPerSecond))));
    }
    return { ...scriptExecutionLimits };
  }

  /** Invalidate file discovery after an editor creates, archives or restores
   * a script. The watcher normally does this too, but explicit editor writes
   * must remain correct even when the platform coalesces filesystem events. */
  invalidateManifest() {
    SCRIPT_MANIFEST_CACHE.delete(path.resolve(this.scriptsDir));
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
    const startedAt = performance.now();
    const previousLoaded = this.loaded.slice();
    let skipped = 0;
    let failed = 0;
    const errors = [];
    this._extendWatchQuietWindow();
    try {
      if (!fs.existsSync(this.scriptsDir)) {
        this.api.log(`scripts dir not found: ${this.scriptsDir}`);
        return;
      }
      const scanStarted = performance.now();
      const files = scriptManifest(this.scriptsDir);
      const scanMs = performance.now() - scanStarted;
      const importStarted = performance.now();
      const imported = [];
      const stamp = Date.now();
      // Dynamic imports are I/O-heavy and independent. Import in bounded
      // batches, then initialise in the original sorted order so command/
      // content registration remains deterministic. The previous serial
      // await paid 400+ event-loop round trips on every cold start.
      for (let start = 0; start < files.length; start += this.importConcurrency) {
        const batch = files.slice(start, start + this.importConcurrency);
        const results = await Promise.all(batch.map(async (file, index) => {
          const t0 = performance.now();
          try {
            const url = `${pathToFileURL(file).href}?t=${stamp}`;
            return { file, order: start + index, mod: await import(url), importMs: performance.now() - t0 };
          } catch (error) {
            return { file, order: start + index, error, importMs: performance.now() - t0 };
          }
        }));
        imported.push(...results);
      }
      const importMs = performance.now() - importStarted;
      const initStarted = performance.now();
      const timings = [];
      imported.sort((a, b) => a.order - b.order);
      const importFailures = imported.filter((entry) => entry.error);
      // Keep the running generation alive if any candidate module cannot
      // even be imported. Previously a single syntax error disposed all 385
      // working scripts before discovery reached the broken file.
      if (previousLoaded.length && importFailures.length) {
        const first = importFailures[0];
        this.profile = {
          scanMs: Math.round(scanMs), importMs: Math.round(importMs), initMs: 0,
          totalMs: Math.round(performance.now() - startedAt), files: files.length,
          loaded: previousLoaded.length, skipped: 0, failed: importFailures.length,
          errors: importFailures.slice(0, 100).map((entry) => ({
            file: this._rel(entry.file), phase: 'import', message: entry.error.message,
            stack: String(entry.error.stack ?? '').slice(0, 4000),
          })),
          lastLoadAt: Date.now(), reason: request.reason, slowest: [], rolledBack: true,
        };
        throw new Error(`script reload rejected before activation: ${this._rel(first.file)}: ${first.error.message}`);
      }
      await this._dispose();
      this.audit.clear();
      for (const entry of imported) {
        const { file } = entry;
        try {
          if (entry.error) throw entry.error;
          const mod = entry.mod;
          const fn = mod.default;
          if (typeof fn !== 'function') {
            skipped++;
            if (this.verboseLoads) this.api.log(`script ${this._rel(file)}: no default export, skipping`);
            continue;
          }
          const scoped = createScopedScriptApi(this.api, this._rel(file));
          const initOneStarted = performance.now();
          let initError = null;
          const maybeDisposer = safeCall(fn, scoped.api, (e) => {
            initError = e;
            this.api.log(`script ${this._rel(file)} threw during init: ${e.message}`);
          });
          if (!initError && performance.now() - initOneStarted > this.initTimeoutMs) {
            initError = new Error(`initialization exceeded ${this.initTimeoutMs}ms budget`);
          }
          const disposer = composeDisposer(maybeDisposer, scoped.lifecycle);
          if (initError) {
            failed++;
            errors.push({ file: this._rel(file), phase: 'init', message: initError.message, stack: String(initError.stack ?? '').slice(0, 4000) });
            this.api.log(`script ${this._rel(file)} failed during init: ${initError.message}`);
            safeCall(disposer, undefined, () => {});
            continue;
          }
          this.loaded.push({
            file,
            disposer,
            initializer: fn,
            exports: Object.keys(mod),
            lifecycle: scoped.lifecycle,
          });
          timings.push({ file: this._rel(file), ms: entry.importMs + performance.now() - initOneStarted });
          if (this.verboseLoads) this.api.log(`script loaded: ${this._rel(file)}`);
        } catch (e) {
          failed++;
          errors.push({ file: this._rel(file), phase: entry.error ? 'import' : 'init', message: e.message, stack: String(e.stack ?? '').slice(0, 4000) });
          this.api.log(`script ${this._rel(file)} failed: ${e.message}`);
        }
      }
      const initMs = performance.now() - initStarted;
      const elapsedMs = Math.round(performance.now() - startedAt);
      this.profile = {
        scanMs: Math.round(scanMs), importMs: Math.round(importMs), initMs: Math.round(initMs),
        totalMs: elapsedMs, files: files.length, loaded: this.loaded.length, skipped, failed,
        errors: errors.slice(0, 100), lastLoadAt: Date.now(), reason: request.reason,
        slowest: timings.sort((a, b) => b.ms - a.ms).slice(0, 12)
          .map((entry) => ({ file: entry.file, ms: Math.round(entry.ms) })),
      };
      let activationError = null;
      if (previousLoaded.length && failed > 0) {
        activationError = new Error(`script reload activation failed in ${failed} module(s)`);
      }
      try { this.audit.assertClean(); }
      catch (error) { activationError = error; }
      if (activationError && previousLoaded.length) {
        await this._dispose();
        const restored = this._restoreLoaded(previousLoaded);
        this.profile.loaded = restored;
        this.profile.rolledBack = true;
        this.api.log(`script reload rolled back: restored ${restored}/${previousLoaded.length} previous modules`);
        throw activationError;
      }
      if (activationError) throw activationError;
      this._rebuildDependencyGraph();
      const reason = request.reason && request.reason !== 'manual' ? `, reason=${request.reason}` : '';
      const skippedLabel = skipped > 0 ? `${skipped} skipped (no default export)` : '0 skipped';
      this.api.log(`scripts ready: ${this.loaded.length} loaded, ${skippedLabel}, ${failed} failed in ${elapsedMs}ms (scan=${this.profile.scanMs}, import=${this.profile.importMs}, init=${this.profile.initMs}, concurrency=${this.importConcurrency})${reason}`);
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
    const reloadStarted = performance.now();
    const rememberReload = (result) => {
      const entry = { at: Date.now(), rel: String(rel), ms: Math.round(performance.now() - reloadStarted), ...result };
      this.reloadHistory.push(entry);
      if (this.reloadHistory.length > 100) this.reloadHistory.splice(0, this.reloadHistory.length - 100);
      return entry;
    };
    if (this._loadChain) await this._loadChain;
    const target = path.resolve(this.scriptsDir, rel.replace(/[\\/]/g, path.sep));
    const scriptsRoot = path.resolve(this.scriptsDir);
    if (!target.startsWith(`${scriptsRoot}${path.sep}`)) {
      return rememberReload({ ok: false, error: 'script path is outside scripts directory', phase: 'validate' });
    }
    this.invalidateManifest();
    const label = this._rel(target);
    this.audit.clearLabel(label);
    if (!fs.existsSync(target)) {
      return rememberReload({ ok: false, error: `script not found: ${rel}`, phase: 'validate' });
    }
    // Import and validate before touching the active implementation. Syntax
    // errors and missing exports therefore leave the live shard unchanged.
    let mod;
    try { mod = await import(`${pathToFileURL(target).href}?t=${Date.now()}`); }
    catch (error) { return rememberReload({ ok: false, error: error.message, phase: 'import', rolledBack: false }); }
    const fn = mod.default;
    if (typeof fn !== 'function') return rememberReload({ ok: false, error: 'no default export', phase: 'validate', rolledBack: false });
    // Find the loaded entry (path comparison is forgiving — runtime
    // stores absolute paths, callers may pass either separator).
    const idx = this.loaded.findIndex((s) => path.resolve(s.file) === target);
    const previous = idx >= 0 ? this.loaded[idx] : null;
    if (idx >= 0) {
      const s = this.loaded[idx];
      if (s.disposer) {
        safeCall(s.disposer, undefined, (e) => {
          this.api.log(`script ${this._rel(s.file)} disposer threw: ${e.message}`);
        });
      }
      this.loaded.splice(idx, 1);
    }
    try {
      const scoped = createScopedScriptApi(this.api, label);
      let initError = null;
      const initStarted = performance.now();
      const maybeDisposer = safeCall(fn, scoped.api, (e) => {
        initError = e;
        this.api.log(`script ${this._rel(target)} threw during reloadOne: ${e.message}`);
      });
      if (!initError && performance.now() - initStarted > this.initTimeoutMs) {
        initError = new Error(`initialization exceeded ${this.initTimeoutMs}ms budget`);
      }
      const disposer = composeDisposer(maybeDisposer, scoped.lifecycle);
      if (initError) {
        safeCall(disposer, undefined, () => {});
        throw initError;
      }
      this.loaded.push({
        file: target,
        disposer,
        initializer: fn,
        exports: Object.keys(mod),
        lifecycle: scoped.lifecycle,
      });
      this.api.log(`script reloaded: ${this._rel(target)}`);
      this._emitReloaded();
      this.audit.assertClean({ label });
      return rememberReload({ ok: true, rel: this._rel(target), phase: 'activate',
        initMs: Math.round(performance.now() - initStarted), exports: Object.keys(mod) });
    } catch (e) {
      // Restore the previous initializer after a partial activation failure.
      // Scoped lifecycle disposal above has already removed every command,
      // listener and timer owned by the failed candidate.
      let rolledBack = false;
      if (typeof previous?.initializer === 'function') {
        try {
          const scoped = createScopedScriptApi(this.api, label);
          let restoreError = null;
          const maybeDisposer = safeCall(previous.initializer, scoped.api, (error) => { restoreError = error; });
          if (restoreError) throw restoreError;
          this.loaded.push({ ...previous, disposer: composeDisposer(maybeDisposer, scoped.lifecycle), lifecycle: scoped.lifecycle });
          rolledBack = true;
        } catch (restoreError) {
          this.api.log(`script ${label} rollback failed: ${restoreError.message}`);
        }
      }
      return rememberReload({ ok: false, error: e.message, phase: 'activate', rolledBack });
    }
  }

  _rebuildDependencyGraph() {
    this.dependencyGraph = buildScriptDependencyGraph(this.scriptsDir);
    return this.dependencyGraph;
  }

  /** Reload a changed module plus every active root importing it. Versioned
   * sibling modules propagate cache busting through the affected chain, so
   * Node's ESM cache cannot retain an old helper implementation. */
  async reloadAffected(rel) {
    if (this._loadChain) await this._loadChain;
    const started = performance.now();
    const root = path.resolve(this.scriptsDir);
    const target = path.resolve(root, String(rel).replace(/[\\/]/g, path.sep));
    if (!target.startsWith(`${root}${path.sep}`) || !fs.existsSync(target)) {
      return { ok: false, error: 'script not found or outside scripts directory', phase: 'validate' };
    }
    const graph = this._rebuildDependencyGraph();
    const closure = affectedDependencyClosure(graph, target);
    const previousAll = this.loaded.slice();
    const active = previousAll.filter((entry) => closure.has(path.resolve(entry.file)));
    if (active.length === 0) {
      return { ok: true, rel: this._rel(target), affected: [], skipped: true,
        reason: 'changed module has no active script dependents', ms: Math.round(performance.now() - started) };
    }
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const variants = new Map();
    for (const original of closure) {
      if (fs.existsSync(original)) variants.set(original, original.replace(/\.js$/i, `.nodeuo-hot-${stamp}.mjs`));
    }
    const temporaryFiles = [];
    try {
      for (const [original, temporary] of variants) {
        const source = fs.readFileSync(original, 'utf8');
        fs.writeFileSync(temporary, rewriteAffectedImports(source, original, variants), 'utf8');
        temporaryFiles.push(temporary);
      }
      const candidates = [];
      for (const previous of active) {
        const temporary = variants.get(path.resolve(previous.file));
        if (!temporary) throw new Error(`missing hot-reload variant for ${this._rel(previous.file)}`);
        const mod = await import(`${pathToFileURL(temporary).href}?v=${stamp}`);
        if (typeof mod.default !== 'function') throw new Error(`${this._rel(previous.file)} has no default export`);
        candidates.push({ previous, mod, fn: mod.default });
      }
      // Validate every import before releasing any live registration.
      for (let index = active.length - 1; index >= 0; index--) {
        const entry = active[index];
        if (entry.disposer) safeCall(entry.disposer, undefined,
          (error) => this.api.log(`script ${this._rel(entry.file)} disposer threw: ${error.message}`));
        this.audit.clearLabel(this._rel(entry.file));
      }
      const activated = [];
      try {
        for (const candidate of candidates) {
          const label = this._rel(candidate.previous.file);
          const scoped = createScopedScriptApi(this.api, label);
          let initError = null;
          const initStarted = performance.now();
          const maybeDisposer = safeCall(candidate.fn, scoped.api, (error) => { initError = error; });
          if (!initError && performance.now() - initStarted > this.initTimeoutMs) {
            initError = new Error(`initialization exceeded ${this.initTimeoutMs}ms budget`);
          }
          const disposer = composeDisposer(maybeDisposer, scoped.lifecycle);
          if (initError) { safeCall(disposer, undefined, () => {}); throw initError; }
          activated.push({ ...candidate.previous, disposer, initializer: candidate.fn,
            exports: Object.keys(candidate.mod), lifecycle: scoped.lifecycle });
          this.audit.assertClean({ label });
        }
        const replacements = new Map(activated.map((entry) => [path.resolve(entry.file), entry]));
        this.loaded = previousAll.map((entry) => replacements.get(path.resolve(entry.file)) ?? entry);
      } catch (activationError) {
        for (let index = activated.length - 1; index >= 0; index--) {
          safeCall(activated[index].disposer, undefined, () => {});
        }
        const restored = [];
        for (const previous of active) {
          const label = this._rel(previous.file);
          const scoped = createScopedScriptApi(this.api, label);
          let restoreError = null;
          const maybeDisposer = safeCall(previous.initializer, scoped.api, (error) => { restoreError = error; });
          if (restoreError) {
            throw new Error(
              `reload failed (${activationError.message}); rollback failed (${restoreError.message})`,
              { cause: activationError },
            );
          }
          restored.push({ ...previous, disposer: composeDisposer(maybeDisposer, scoped.lifecycle), lifecycle: scoped.lifecycle });
        }
        const restoreMap = new Map(restored.map((entry) => [path.resolve(entry.file), entry]));
        this.loaded = previousAll.map((entry) => restoreMap.get(path.resolve(entry.file)) ?? entry);
        return { ok: false, error: activationError.message, phase: 'activate', rolledBack: true,
          affected: active.map((entry) => this._rel(entry.file)), ms: Math.round(performance.now() - started) };
      }
      this._emitReloaded();
      const result = { ok: true, rel: this._rel(target), phase: 'activate',
        affected: active.map((entry) => this._rel(entry.file)), modules: closure.size,
        ms: Math.round(performance.now() - started) };
      this.reloadHistory.push({ at: Date.now(), ...result });
      if (this.reloadHistory.length > 100) this.reloadHistory.splice(0, this.reloadHistory.length - 100);
      this.api.log(`script dependency reload: ${result.affected.length} active / ${result.modules} module(s) from ${result.rel}`);
      return result;
    } catch (error) {
      return { ok: false, error: error.message, phase: 'import', rolledBack: false,
        affected: active.map((entry) => this._rel(entry.file)), ms: Math.round(performance.now() - started) };
    } finally {
      for (const temporary of temporaryFiles) {
        try { fs.unlinkSync(temporary); } catch { /* best effort */ }
      }
      this._extendWatchQuietWindow();
    }
  }

  async dryRunOne(rel) {
    const target = path.resolve(this.scriptsDir, String(rel).replace(/[\\/]/g, path.sep));
    if (!target.startsWith(path.resolve(this.scriptsDir) + path.sep) || !fs.existsSync(target)) {
      return { ok: false, error: 'script not found or outside scripts directory' };
    }
    const started = performance.now();
    try {
      const mod = await import(`${pathToFileURL(target).href}?dry=${Date.now()}`);
      if (typeof mod.default !== 'function') return { ok: false, error: 'no default export', exports: Object.keys(mod) };
      return { ok: true, rel: this._rel(target), exports: Object.keys(mod), ms: Math.round(performance.now() - started) };
    } catch (error) { return { ok: false, error: error.message, ms: Math.round(performance.now() - started) }; }
  }

  /** Operator control without unregistering resources. Paused/quarantined
   * scripts keep their ownership graph intact while every guarded callback is
   * rejected at the cheapest common gate; resume is therefore instant. */
  async control(rel, action, { durationMs } = {}) {
    const normalized = String(rel ?? '').replace(/\\/g, '/');
    const entry = this.loaded.find((row) => this._rel(row.file) === normalized);
    if (!entry) return { ok: false, error: 'loaded script not found' };
    if (action === 'dry-run') return this.dryRunOne(normalized);
    if (action === 'reload') return this.reloadAffected(normalized);
    if (action === 'pause') entry.lifecycle?.pause?.(durationMs, 'operator');
    else if (action === 'quarantine') entry.lifecycle?.pause?.(null, 'quarantine');
    else if (action === 'resume') entry.lifecycle?.resume?.();
    else if (action === 'reset-stats') entry.lifecycle?.resetStats?.();
    else return { ok: false, error: 'unsupported script action' };
    return { ok: true, rel: normalized, action, resources: entry.lifecycle?.stats?.() ?? null };
  }

  diagnostics() {
    return {
      loaded: this.loaded.length,
      owners: this.loaded.map((entry) => ({ file: this._rel(entry.file), exports: entry.exports ?? [], resources: entry.lifecycle?.stats?.() ?? null })),
      profile: { ...this.profile },
      reloadHistory: this.reloadHistory.slice(-100),
      dependencies: {
        files: this.dependencyGraph.files,
        edges: [...this.dependencyGraph.dependencies.values()].reduce((sum, rows) => sum + rows.size, 0),
        builtAt: this.dependencyGraph.builtAt,
      },
      watching: !!this._watcher,
    };
  }

  /** Enable debounced file-watch hot-reload. No-op if already watching. */
  watch() {
    if (this._watcher) return;
    if (!fs.existsSync(this.scriptsDir)) return;
    try {
      this._watcher = fs.watch(this.scriptsDir, { recursive: true }, (_ev, filename) => {
        const changed = normalizeWatchScriptFilename(this.scriptsDir, filename);
        if (!changed) return;
        SCRIPT_MANIFEST_CACHE.delete(path.resolve(this.scriptsDir));
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

  /** Stop watching and release every script-owned timer/listener/command. */
  async dispose() {
    this.stop();
    if (this._loadChain) await this._loadChain;
    await this._dispose();
  }

  _scheduleWatchReload(changed) {
    if (this._reloadTimer) clearTimeout(this._reloadTimer);
    this._reloadTimer = setTimeout(() => {
      this._reloadTimer = null;
      if (this._loadChain || Date.now() < this._watchQuietUntil) {
        this._logSuppressedWatchChange(changed);
        return;
      }
      this.api.log(`reloading affected scripts (changed: ${changed})`);
      const reload = this.reloadAffected(changed)
        .catch((e) => this.api.log(`reload failed: ${e.message}`));
      const tracked = reload.finally(() => {
        if (this._loadChain === tracked) this._loadChain = null;
      });
      this._loadChain = tracked;
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

  _restoreLoaded(entries) {
    let restored = 0;
    this.loaded = [];
    for (const previous of entries) {
      if (typeof previous?.initializer !== 'function') continue;
      const label = this._rel(previous.file);
      const scoped = createScopedScriptApi(this.api, label);
      let initError = null;
      const maybeDisposer = safeCall(previous.initializer, scoped.api, (error) => { initError = error; });
      const disposer = composeDisposer(maybeDisposer, scoped.lifecycle);
      if (initError) {
        safeCall(disposer, undefined, () => {});
        this.api.log(`script ${label} rollback failed: ${initError.message}`);
        continue;
      }
      this.loaded.push({ ...previous, disposer, lifecycle: scoped.lifecycle });
      restored++;
    }
    return restored;
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

function collectAllJavaScript(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.includes('.nodeuo-hot-')) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) collectAllJavaScript(file, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(path.resolve(file));
  }
  return out;
}

function resolveLocalImport(importer, specifier, root) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [base, `${base}.js`, path.join(base, 'index.js')];
  for (const candidate of candidates) {
    const absolute = path.resolve(candidate);
    if (!absolute.startsWith(`${root}${path.sep}`) || !fs.existsSync(absolute)) continue;
    try { if (fs.statSync(absolute).isFile()) return absolute; } catch { /* race */ }
  }
  return null;
}

function importSpecifiers(source) {
  const found = new Set();
  const patterns = [
    /\b(?:import|export)\s+[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) found.add(match[1]);
  }
  return found;
}

export function buildScriptDependencyGraph(scriptsDir) {
  const root = path.resolve(scriptsDir);
  const files = collectAllJavaScript(root).sort();
  const dependencies = new Map();
  const dependents = new Map();
  for (const file of files) {
    const rows = new Set();
    let source = '';
    try { source = fs.readFileSync(file, 'utf8'); } catch { /* disappearing watch file */ }
    for (const specifier of importSpecifiers(source)) {
      const resolved = resolveLocalImport(file, specifier, root);
      if (!resolved) continue;
      rows.add(resolved);
      const reverse = dependents.get(resolved) ?? new Set();
      reverse.add(file); dependents.set(resolved, reverse);
    }
    dependencies.set(file, rows);
  }
  return { dependencies, dependents, files: files.length, builtAt: Date.now(), root };
}

export function affectedDependencyClosure(graph, changedFile) {
  const closure = new Set();
  const queue = [path.resolve(changedFile)];
  while (queue.length) {
    const file = queue.shift();
    if (closure.has(file)) continue;
    closure.add(file);
    for (const dependent of graph.dependents.get(file) ?? []) queue.push(dependent);
  }
  return closure;
}

function rewriteAffectedImports(source, importer, variants) {
  const replaceSpecifier = (specifier) => {
    if (variants.size === 0) return specifier;
    // Every variant belongs to one scripts tree; walk upward until the local
    // import resolver can use the known affected target set directly.
    const base = path.resolve(path.dirname(importer), specifier);
    const candidates = [base, `${base}.js`, path.join(base, 'index.js')].map((file) => path.resolve(file));
    const original = candidates.find((file) => variants.has(file));
    if (!original) return specifier;
    let relative = path.relative(path.dirname(importer), variants.get(original)).replace(/\\/g, '/');
    if (!relative.startsWith('.')) relative = `./${relative}`;
    return relative;
  };
  return source
    .replace(/(\b(?:import|export)\s+[^'";]*?\bfrom\s*)(['"])([^'"]+)(\2)/g,
      (whole, prefix, quote, specifier) => `${prefix}${quote}${replaceSpecifier(specifier)}${quote}`)
    .replace(/(\bimport\s*\(\s*)(['"])([^'"]+)(\2)(\s*\))/g,
      (whole, prefix, quote, specifier, _closingQuote, suffix) => `${prefix}${quote}${replaceSpecifier(specifier)}${quote}${suffix}`)
    .replace(/(\bimport\s*)(['"])([^'"]+)(\2)/g,
      (whole, prefix, quote, specifier) => `${prefix}${quote}${replaceSpecifier(specifier)}${quote}`);
}

function collectScriptFiles(dir, out = [], root = dir) {
  const names = fs.readdirSync(dir).sort();
  for (const name of names) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    // Item lifecycle implementations are factories, not top-level runtime
    // scripts. data.js registers them once through the explicit manifest in
    // items/scripts/index.js. Invoking every factory again as a standalone
    // script registered its companion commands twice (trash, rental vendor,
    // house teleporters, ...), while not actually registering the returned
    // item-script object. Keep hot-reload watching the files, but load this
    // subtree only through its canonical manifest.
    if (st.isDirectory() && rel === 'items/scripts') continue;
    // spells/index.js is the canonical data-driven manifest and imports all
    // 155 effect modules itself. Loading every circle/school file again as a
    // standalone runtime script only produced "no default function" skips
    // and dominated cold-start module parsing.
    if (st.isDirectory() && rel.startsWith('spells/')) continue;
    if (st.isDirectory()) collectScriptFiles(full, out, root);
    else if (st.isFile() && full.endsWith('.js')) out.push(full);
  }
  return out;
}

export function scriptManifest(dir, { refresh = false } = {}) {
  const root = path.resolve(dir);
  if (!refresh) {
    const cached = SCRIPT_MANIFEST_CACHE.get(root);
    if (cached) return cached.slice();
  }
  const files = collectScriptFiles(root).sort();
  SCRIPT_MANIFEST_CACHE.set(root, Object.freeze(files.slice()));
  return files;
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
    // Preserve Array.isArray and typed-array brand checks. Capability auditing
    // is useful for named service objects, not numeric collection elements.
    if (Array.isArray(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
    if (seen.has(value)) return seen.get(value);
    // Proxy a fresh, extensible shadow instead of the original object.
    // Many engine capabilities are Object.freeze()'d and several expose Map /
    // Set instances. Proxying those values directly violates the invariant for
    // non-configurable data properties, while unbound Map methods throw
    // "incompatible receiver". A shadow lets us audit reads without changing
    // the runtime object's identity/descriptor contract.
    const shadow = {};
    const proxy = new Proxy(shadow, {
      get(_target, prop) {
        if (typeof prop === 'symbol') {
          const symbolValue = Reflect.get(value, prop, value);
          return typeof symbolValue === 'function' ? symbolValue.bind(value) : symbolValue;
        }
        if (prop === 'then' || prop === 'inspect' || prop === 'toJSON') {
          const special = Reflect.get(value, prop, value);
          return typeof special === 'function' ? special.bind(value) : special;
        }
        if (!Reflect.has(value, prop)) {
          recordMissing(label, `${apiPath}.${String(prop)}`);
          return undefined;
        }
        const next = Reflect.get(value, prop, value);
        if (typeof next === 'function') return next.bind(value);
        return wrapObject(next, label, `${apiPath}.${String(prop)}`, seen);
      },
      has(_target, prop) {
        if (typeof prop !== 'symbol' && !Reflect.has(value, prop)) {
          recordMissing(label, `${apiPath}.${String(prop)}`);
        }
        return Reflect.has(value, prop);
      },
      ownKeys() {
        return Reflect.ownKeys(value);
      },
      getOwnPropertyDescriptor(_target, prop) {
        const desc = Reflect.getOwnPropertyDescriptor(value, prop);
        return desc ? { ...desc, configurable: true } : undefined;
      },
      getPrototypeOf() {
        return Reflect.getPrototypeOf(value);
      },
      set(_target, prop, next) {
        return Reflect.set(value, prop, next, value);
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
      const sampleLimit = positiveIntEnv('UO_SCRIPT_AUDIT_SAMPLE_LIMIT', 12);
      const sample = findings.slice(0, sampleLimit)
        .map((entry) => `- ${entry.label}: ${entry.message}`)
        .join('\n');
      const suffix = findings.length > sampleLimit ? `\n... ${findings.length - sampleLimit} more` : '';
      throw new Error(`Script API audit failed (${findings.length} finding${findings.length === 1 ? '' : 's'}):\n${sample}${suffix}`);
    },
  };
}

function createScopedScriptApi(baseApi, label) {
  const lifecycle = createScriptLifecycle(label, baseApi);
  const commands = createScopedCommands(baseApi.commands, lifecycle, label);
  const catalog = createScopedCatalog(baseApi.catalog, lifecycle);
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
      if (prop === 'catalog' && catalog) return catalog;
      if (prop === 'log' && scopedLog) return scopedLog;
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value) {
      if (prop === 'lifecycle' || prop === 'commands' || prop === 'catalog' || prop === 'log') return false;
      return Reflect.set(target, prop, value);
    },
    has(target, prop) {
      return prop === 'lifecycle' || prop === 'log' || (prop === 'commands' && commands)
        || (prop === 'catalog' && catalog) || Reflect.has(target, prop);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop === 'lifecycle') {
        return { configurable: true, enumerable: true, value: lifecycle };
      }
      if (prop === 'commands' && commands) {
        return { configurable: true, enumerable: true, value: commands };
      }
      if (prop === 'catalog' && catalog) {
        return { configurable: true, enumerable: true, value: catalog };
      }
      if (prop === 'log' && scopedLog) {
        return { configurable: true, enumerable: true, value: scopedLog };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    ownKeys(target) {
      return [...new Set([...Reflect.ownKeys(target), 'commands', 'catalog', 'lifecycle', 'log'])];
    },
  });
  return { api: baseApi.scriptAudit?.wrap?.(api, label) ?? api, lifecycle };
}

function createScopedCatalog(baseCatalog, lifecycle) {
  const baseItems = baseCatalog?.items;
  if (!baseItems?.registerItem || !baseItems?.unregisterItem) return baseCatalog ?? null;
  const owned = [];
  lifecycle.onDispose(() => {
    for (let index = owned.length - 1; index >= 0; index--) {
      const definition = owned[index];
      try { baseItems.unregisterItem(definition.definitionId, definition); }
      catch { /* registry optional during shutdown */ }
    }
    owned.length = 0;
  });
  const items = new Proxy(baseItems, {
    get(target, prop, receiver) {
      if (prop === 'registerItem') {
        return (definition) => {
          const registered = target.registerItem(definition);
          if (registered?.definitionId) owned.push(registered);
          return registered;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return new Proxy(baseCatalog, {
    get(target, prop, receiver) {
      if (prop === 'items') return items;
      return Reflect.get(target, prop, receiver);
    },
  });
}

function createScopedCommands(baseCommands, lifecycle, label) {
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
          const ownedSpec = spec && typeof spec === 'object'
            ? {
                ...spec,
                run: typeof spec.run === 'function'
                  ? lifecycle.guard(`command:${spec.name ?? 'unknown'}`, spec.run)
                  : spec.run,
                [Symbol.for('nodeuo.commandOwner')]: label,
              }
            : spec;
          const result = target.register.call(target, ownedSpec, ...args);
          // CommandRegistry returns false for a rejected collision. Tracking
          // that name as owned by this script would make its disposer remove
          // the *first*, valid implementation during a reload.
          if (result !== false && spec?.name != null) {
            registered.set(commandKey(spec.name), spec.name);
          }
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
  const resourceKinds = new Map();
  const callbackStats = new Map();
  let callbackWindowAt = performance.now();
  let callbackWindowCount = 0;
  let timerSequence = 0;
  let disposed = false;
  let manualPauseUntil = 0;
  let pausedReason = null;

  const finishCallback = (row, started, error = null) => {
    const elapsed = performance.now() - started;
    row.totalMs += elapsed;
    row.maxMs = Math.max(row.maxMs, elapsed);
    runtimeGovernor.watchdog.record(`script:${label}:${row.kind}`, elapsed);
    if (elapsed > scriptExecutionLimits.maxCallbackMs) {
      row.slowCalls++;
      row.consecutiveSlow++;
      if (row.consecutiveSlow >= 3 && row.circuitUntil <= Date.now()) {
        row.circuitTrips++;
        row.circuitUntil = Date.now() + Math.min(60_000, 2_000 * (row.circuitTrips + 1));
        row.consecutiveSlow = 0;
        log(`script ${label} lifecycle ${row.kind} exceeded ${scriptExecutionLimits.maxCallbackMs}ms repeatedly; paused until ${new Date(row.circuitUntil).toISOString()}`);
      }
    } else row.consecutiveSlow = 0;
    if (!error) { row.consecutiveErrors = 0; return; }
    row.errors++;
    row.consecutiveErrors++;
    log(`script ${label} lifecycle ${row.kind} threw: ${error.message}`);
    if (row.consecutiveErrors >= 3) {
      row.circuitTrips++;
      row.circuitUntil = Date.now() + Math.min(60_000, 5_000 * (row.circuitTrips + 1));
      row.consecutiveErrors = 0;
      log(`script ${label} lifecycle ${row.kind} paused until ${new Date(row.circuitUntil).toISOString()}`);
    }
  };

  const runCallback = (kind, fn, args) => {
    if (disposed) return undefined;
    const key = String(kind);
    const row = callbackStats.get(key) ?? {
      kind: key, calls: 0, errors: 0, skipped: 0, consecutiveErrors: 0,
      circuitTrips: 0, circuitUntil: 0, totalMs: 0, maxMs: 0,
      slowCalls: 0, consecutiveSlow: 0, quotaSkips: 0,
    };
    callbackStats.set(key, row);
    if (manualPauseUntil > Date.now()) { row.skipped++; return undefined; }
    if (manualPauseUntil && manualPauseUntil <= Date.now()) {
      manualPauseUntil = 0;
      pausedReason = null;
    }
    if (row.circuitUntil > Date.now()) { row.skipped++; return undefined; }
    const callbackNow = performance.now();
    if (callbackNow - callbackWindowAt >= 1000) {
      callbackWindowAt = callbackNow; callbackWindowCount = 0;
    }
    if (callbackWindowCount >= scriptExecutionLimits.maxCallbacksPerSecond) {
      row.skipped++; row.quotaSkips++;
      return undefined;
    }
    callbackWindowCount++;
    row.calls++;
    const started = performance.now();
    let result;
    try { result = fn(...args); }
    catch (error) {
      finishCallback(row, started, error instanceof Error ? error : new Error(String(error)));
      return undefined;
    }
    if (result && typeof result.then === 'function') {
      return Promise.resolve(result).then((value) => {
        finishCallback(row, started);
        return value;
      }, (error) => {
        finishCallback(row, started, error instanceof Error ? error : new Error(String(error)));
        return undefined;
      });
    }
    finishCallback(row, started);
    return result;
  };

  const onDispose = (fn, kind = 'resource') => {
    if (typeof fn !== 'function') return () => {};
    if (disposed) {
      safeCall(fn, undefined, (e) => log(`script ${label} lifecycle disposer threw: ${e.message}`));
      return () => {};
    }
    const key = String(kind);
    resourceKinds.set(key, (resourceKinds.get(key) ?? 0) + 1);
    const tracked = () => {
      if (!tracked.active) return;
      tracked.active = false;
      resourceKinds.set(key, Math.max(0, (resourceKinds.get(key) ?? 1) - 1));
      return fn();
    };
    tracked.active = true;
    disposers.push(tracked);
    return tracked;
  };

  const lifecycle = {
    onDispose,

    pause(durationMs = null, reason = 'operator') {
      manualPauseUntil = durationMs == null
        ? Number.MAX_SAFE_INTEGER
        : Date.now() + Math.max(1000, Math.min(7 * 24 * 60 * 60_000, Number(durationMs) || 60_000));
      pausedReason = String(reason).slice(0, 64);
      return lifecycle.stats();
    },

    resume() {
      manualPauseUntil = 0;
      pausedReason = null;
      for (const row of callbackStats.values()) {
        row.circuitUntil = 0;
        row.consecutiveErrors = 0;
        row.consecutiveSlow = 0;
      }
      return lifecycle.stats();
    },

    resetStats() {
      callbackStats.clear();
      callbackWindowAt = performance.now();
      callbackWindowCount = 0;
      return lifecycle.stats();
    },

    guard(kind, fn) {
      if (typeof fn !== 'function') return fn;
      return (...args) => runCallback(kind, fn, args);
    },

    command(spec) {
      if (!spec?.name || !baseApi.commands?.register) return null;
      const ownedSpec = {
        ...spec,
        run: typeof spec.run === 'function'
          ? lifecycle.guard(`command:${spec.name}`, spec.run)
          : spec.run,
        [Symbol.for('nodeuo.commandOwner')]: label,
      };
      const result = baseApi.commands.register(ownedSpec);
      if (result === false) return null;
      onDispose(() => {
        try { baseApi.commands?.unregister?.(spec.name); } catch { /* registry optional */ }
      }, 'command');
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
      const guardedHandler = lifecycle.guard(`event:${eventName}`, handler);
      const unsub = source.on(eventName, guardedHandler);
      const cleanup = typeof unsub === 'function'
        ? unsub
        : () => source.off?.(eventName, guardedHandler);
      const trackedCleanup = onDispose(() => {
        try { cleanup?.(); } catch { /* event bus optional */ }
      }, 'listener');
      return trackedCleanup;
    },

    setTimeout(fn, delay, ...args) {
      const scheduler = baseApi.scheduler ?? baseApi.ctx?.scheduler;
      const handle = scheduler?.once
        ? scheduler.once(`script:${label}:timeout:${++timerSequence}`, delay, () => runCallback('timeout', fn, args))
        : setTimeout(() => runCallback('timeout', fn, args), delay);
      handle.unref?.();
      onDispose(() => typeof handle?.cancel === 'function' ? handle.cancel() : clearTimeout(handle), 'timeout');
      return handle;
    },

    setInterval(fn, delay, ...args) {
      const scheduler = baseApi.scheduler ?? baseApi.ctx?.scheduler;
      const handle = scheduler?.every
        ? scheduler.every(`script:${label}:interval:${++timerSequence}`, delay, () => runCallback('interval', fn, args))
        : setInterval(() => runCallback('interval', fn, args), delay);
      handle.unref?.();
      onDispose(() => typeof handle?.cancel === 'function' ? handle.cancel() : clearInterval(handle), 'interval');
      return handle;
    },

    setImmediate(fn, ...args) {
      const scheduler = baseApi.scheduler ?? baseApi.ctx?.scheduler;
      const handle = scheduler?.once
        ? scheduler.once(`script:${label}:immediate:${++timerSequence}`, 0, () => runCallback('immediate', fn, args))
        : setImmediate(() => runCallback('immediate', fn, args));
      handle.unref?.();
      onDispose(() => typeof handle?.cancel === 'function' ? handle.cancel() : clearImmediate(handle), 'immediate');
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

    stats() {
      return { disposed, paused: manualPauseUntil > Date.now(), pausedReason,
        pausedUntil: manualPauseUntil || 0,
        total: [...resourceKinds.values()].reduce((sum, count) => sum + count, 0),
        limits: { ...scriptExecutionLimits },
        byKind: Object.fromEntries(resourceKinds),
        callbacks: [...callbackStats.values()].map((row) => ({
          ...row,
          totalMs: Number(row.totalMs.toFixed(3)),
          maxMs: Number(row.maxMs.toFixed(3)),
        })),
      };
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
