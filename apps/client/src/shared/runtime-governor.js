// Runtime budgets shared by asset streaming, render queues and diagnostics.
// The browser exposes only coarse hardware hints; keep every value bounded
// and deterministic so privacy-reduced browsers still receive sane defaults.

const MIB = 1024 * 1024;

function taskAbortError(reason) {
  if (reason) return reason;
  const error = new Error('Aborted'); error.name = 'AbortError'; return error;
}

/** Run non-frame-critical work through the browser Scheduling API when it is
 * available. The fallback preserves cancellation and delay semantics without
 * adding a dependency or changing behavior in older browsers. */
export function postPrioritizedTask(run, { priority = 'background', delay = 0, signal } = {}) {
  if (typeof run !== 'function') return Promise.reject(new TypeError('task run must be a function'));
  if (signal?.aborted) return Promise.reject(taskAbortError(signal.reason));
  if (globalThis.scheduler?.postTask) return globalThis.scheduler.postTask(run, { priority, delay, signal });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', abort);
      try { resolve(run()); } catch (error) { reject(error); }
    }, Math.max(0, Number(delay) || 0));
    const abort = () => {
      clearTimeout(timer);
      reject(taskAbortError(signal.reason));
    };
    signal?.addEventListener?.('abort', abort, { once: true });
  });
}

export function createClientRuntimeProfile(env = globalThis) {
  const memory = Math.max(1, Math.min(16, Number(env?.navigator?.deviceMemory) || 4));
  const cores = Math.max(2, Math.min(16, Number(env?.navigator?.hardwareConcurrency) || 4));
  const tier = memory <= 2 || cores <= 2 ? 'low' : memory >= 8 && cores >= 8 ? 'high' : 'balanced';
  const scale = tier === 'low' ? 0.5 : tier === 'high' ? 1.35 : 1;
  const integer = (base, floor = 1) => Math.max(floor, Math.round(base * scale));
  return Object.freeze({
    tier, memoryGiB: memory, cores,
    atlasPages: integer(96, 32),
    atlasBytes: integer(768 * MIB, 192 * MIB),
    cacheLimits: Object.freeze({
      land: integer(4096, 1536), static: integer(4096, 1536),
      gump: integer(2048, 768), anim: integer(8192, 3072), mobile: integer(8192, 3072),
      texmap: integer(1024, 384),
    }),
    chunkPopulates: tier === 'low' ? 1 : tier === 'high' ? 4 : 3,
    mountBatch: tier === 'low' ? 12 : tier === 'high' ? 48 : 32,
    frameBudgetMs: tier === 'low' ? 3 : tier === 'high' ? 6 : 4.5,
    inactiveTrimMs: 45_000,
    inactiveAnimationFps: tier === 'low' ? 2 : 5,
    decodeConcurrency: tier === 'low' ? 2 : tier === 'high' ? 6 : 4,
    chunkSoftLimit: integer(176, 96),
    chunkHardLimit: integer(240, 128),
  });
}

export const clientRuntimeProfile = createClientRuntimeProfile();

export class FrameTaskScheduler {
  constructor({ now = () => performance.now(), budgetMs = clientRuntimeProfile.frameBudgetMs } = {}) {
    this._now = now;
    this.budgetMs = Math.max(0.25, Number(budgetMs) || 4);
    this._queues = [[], [], [], []];
    this._heads = [0, 0, 0, 0];
    this._byKey = new Map();
    this._baseBudgetMs = this.budgetMs;
    this._frameEmaMs = 16.7;
    this.stats = { queued: 0, completed: 0, cancelled: 0, failed: 0, lastMs: 0, maxMs: 0 };
  }

  schedule(key, run, { priority = 2, owner = null } = {}) {
    if (typeof run !== 'function') throw new TypeError('task run must be a function');
    const normalizedKey = String(key);
    const previous = this._byKey.get(normalizedKey);
    if (previous) {
      previous.cancelled = true;
      this.stats.cancelled++;
    }
    const task = { key: normalizedKey, run, owner, cancelled: false };
    this._byKey.set(normalizedKey, task);
    this._queues[Math.max(0, Math.min(3, priority | 0))].push(task);
    this.stats.queued = this._byKey.size;
    return () => this.cancel(normalizedKey);
  }

  cancel(key) {
    const task = this._byKey.get(String(key));
    if (!task) return false;
    task.cancelled = true;
    this._byKey.delete(task.key);
    this.stats.cancelled++;
    this.stats.queued = this._byKey.size;
    return true;
  }

  cancelOwner(owner) {
    let count = 0;
    for (const task of this._byKey.values()) {
      if (task.owner !== owner) continue;
      task.cancelled = true;
      this._byKey.delete(task.key);
      count++;
    }
    this.stats.cancelled += count;
    this.stats.queued = this._byKey.size;
    return count;
  }

  drain(budgetMs = this.budgetMs) {
    const start = this._now();
    const deadline = start + Math.max(0.25, Number(budgetMs) || this.budgetMs);
    let completed = 0;
    while (this._now() <= deadline) {
      const task = this._take();
      if (!task) break;
      if (task.cancelled || this._byKey.get(task.key) !== task) continue;
      this._byKey.delete(task.key);
      try { task.run(); this.stats.completed++; }
      catch { this.stats.failed++; }
      completed++;
    }
    const elapsed = Math.max(0, this._now() - start);
    this.stats.lastMs = elapsed;
    this.stats.maxMs = Math.max(this.stats.maxMs, elapsed);
    this.stats.queued = this._byKey.size;
    return completed;
  }

  observeFrame(frameMs) {
    const ms = Math.max(1, Math.min(250, Number(frameMs) || 16.7));
    this._frameEmaMs = this._frameEmaMs * 0.9 + ms * 0.1;
    this.budgetMs = this._frameEmaMs > 24
      ? Math.max(0.5, this._baseBudgetMs * 0.4)
      : this._frameEmaMs < 18
        ? this._baseBudgetMs
        : Math.max(0.75, this._baseBudgetMs * 0.7);
    return this.budgetMs;
  }

  _take() {
    for (let priority = 0; priority < this._queues.length; priority++) {
      const queue = this._queues[priority];
      while (this._heads[priority] < queue.length) {
        const task = queue[this._heads[priority]++];
        if (this._heads[priority] > 1024 && this._heads[priority] * 2 >= queue.length) {
          this._queues[priority] = queue.slice(this._heads[priority]);
          this._heads[priority] = 0;
        }
        if (!task.cancelled) return task;
      }
      queue.length = 0;
      this._heads[priority] = 0;
    }
    return null;
  }
}

// Runtime quality is a pressure state layered on top of the hardware profile.
// It never changes persistent user preferences: renderers consult it only when
// their option is set to Automatic. Downgrades are immediate; recovery needs
// several healthy windows to prevent oscillation around a threshold.
export class AdaptiveQualityController {
  constructor({ sampleSize = 240, evaluateEvery = 60, recoveryWindows = 3 } = {}) {
    this.sampleSize = Math.max(60, Math.min(1_200, sampleSize | 0));
    this.evaluateEvery = Math.max(10, Math.min(this.sampleSize, evaluateEvery | 0));
    this.recoveryWindows = Math.max(2, Math.min(12, recoveryWindows | 0));
    this._frames = new Float32Array(this.sampleSize);
    this._head = 0;
    this._count = 0;
    this._sinceEvaluation = 0;
    this._healthyWindows = 0;
    this.level = 'nominal';
    this.transitions = 0;
    this.lastEvaluation = {
      level: this.level, samples: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0,
      longFrameRate: 0, qualityScale: 1, changed: false,
    };
  }

  observeFrame(frameMs, at = performance.now()) {
    const ms = Number(frameMs);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    this._frames[this._head] = Math.min(1_000, ms);
    this._head = (this._head + 1) % this.sampleSize;
    this._count = Math.min(this.sampleSize, this._count + 1);
    if (++this._sinceEvaluation < this.evaluateEvery || this._count < this.evaluateEvery) return null;
    this._sinceEvaluation = 0;
    return this.evaluate(at);
  }

  evaluate(at = performance.now()) {
    const values = [];
    for (let offset = 0; offset < this._count; offset++) {
      const index = (this._head - 1 - offset + this.sampleSize) % this.sampleSize;
      values.push(this._frames[index]);
    }
    values.sort((a, b) => a - b);
    const pick = (fraction) => values.length
      ? values[Math.max(0, Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1))]
      : 0;
    const p50Ms = pick(.5); const p95Ms = pick(.95); const p99Ms = pick(.99);
    const longFrameRate = values.length ? values.reduce((sum, value) => sum + (value >= 50 ? 1 : 0), 0) / values.length : 0;
    let desired = 'nominal';
    if (p95Ms > 40 || p99Ms > 80 || longFrameRate >= .08) desired = 'critical';
    else if (p95Ms > 23 || p99Ms > 40 || longFrameRate >= .02) desired = 'degraded';
    const order = { nominal: 0, degraded: 1, critical: 2 };
    const previous = this.level;
    if (order[desired] > order[this.level]) {
      this.level = desired;
      this._healthyWindows = 0;
    } else if (desired === 'nominal' && this.level !== 'nominal' && p95Ms < 18 && p99Ms < 25 && longFrameRate === 0) {
      this._healthyWindows++;
      if (this._healthyWindows >= this.recoveryWindows) {
        this.level = this.level === 'critical' ? 'degraded' : 'nominal';
        this._healthyWindows = 0;
      }
    } else if (desired !== 'nominal') {
      this._healthyWindows = 0;
    }
    const changed = previous !== this.level;
    if (changed) this.transitions++;
    this.lastEvaluation = {
      at: Number(at) || 0,
      level: this.level,
      previous,
      samples: values.length,
      p50Ms: Number(p50Ms.toFixed(2)),
      p95Ms: Number(p95Ms.toFixed(2)),
      p99Ms: Number(p99Ms.toFixed(2)),
      longFrameRate: Number(longFrameRate.toFixed(4)),
      qualityScale: this.qualityScale(),
      healthyWindows: this._healthyWindows,
      transitions: this.transitions,
      changed,
    };
    return this.lastEvaluation;
  }

  qualityScale() { return this.level === 'critical' ? .4 : this.level === 'degraded' ? .7 : 1; }
  snapshot() { return { ...this.lastEvaluation, level: this.level, qualityScale: this.qualityScale(), transitions: this.transitions }; }
}

export const clientPerformanceGovernor = new AdaptiveQualityController();

/** Fill-rate governor for dense scenes. Resolution changes are deliberately
 * rare and hysteretic; nominal mode always returns to pixel-perfect 1×. */
export class AdaptiveRenderScale {
  constructor({ minScale = .75, changeCooldownMs = 2000 } = {}) {
    this.minScale = Math.max(.5, Math.min(1, Number(minScale) || .75));
    this.changeCooldownMs = Math.max(250, changeCooldownMs | 0);
    this.scale = 1;
    this.lastChangedAt = 0;
    this.transitions = 0;
  }

  observe(level, at = performance.now()) {
    const desired = level === 'critical' ? this.minScale : level === 'degraded' ? Math.max(.9, this.minScale) : 1;
    if (desired === this.scale || at - this.lastChangedAt < this.changeCooldownMs) return null;
    const previous = this.scale;
    this.scale = desired; this.lastChangedAt = at; this.transitions++;
    return { previous, scale: this.scale, level, transitions: this.transitions };
  }

  snapshot() { return { scale: this.scale, minScale: this.minScale, transitions: this.transitions }; }
}

export class ResourceTelemetry {
  constructor() {
    this._counters = new Map();
    this._missing = new Map();
  }
  note(kind, result) {
    const key = String(kind || 'unknown');
    const row = this._counters.get(key) ?? { hits: 0, misses: 0, evictions: 0, requests: 0 };
    row.requests++;
    if (result === 'hit') row.hits++;
    else if (result === 'miss') row.misses++;
    else if (result === 'evict') row.evictions++;
    this._counters.set(key, row);
  }
  missing(kind, id, context = '') {
    const key = `${kind}:${id}`;
    const row = this._missing.get(key) ?? { kind: String(kind), id: Number(id), count: 0, context: '' };
    row.count++;
    if (context) row.context = String(context).slice(0, 160);
    this._missing.set(key, row);
    return row.count === 1;
  }
  snapshot() {
    return {
      resources: Object.fromEntries([...this._counters].map(([key, value]) => [key, { ...value }])),
      missing: [...this._missing.values()].map((row) => ({ ...row })).sort((a, b) => b.count - a.count),
    };
  }
  exportMissing() { return this.snapshot().missing; }
}

export class AsyncGenerationOwner {
  constructor() { this.generation = 1; this.disposed = false; }
  capture() { return this.generation; }
  valid(generation) { return !this.disposed && generation === this.generation; }
  invalidate() { this.generation++; return this.generation; }
  dispose() { this.disposed = true; this.generation++; }
  guard(generation, callback) { return (...args) => this.valid(generation) ? callback(...args) : undefined; }
}

/** Bounded async work pool shared by decoding/loading call sites. Jobs are
 * FIFO, keyed jobs deduplicate, and a caller may cancel work that has not
 * started yet. The pool never expands concurrency after construction. */
export class AsyncWorkPool {
  constructor(limit = clientRuntimeProfile.decodeConcurrency) {
    this.limit = Math.max(1, Math.min(16, limit | 0 || 1));
    this.active = 0;
    this._queues = [[], [], [], []];
    this._heads = [0, 0, 0, 0];
    this._byKey = new Map();
    this.stats = { queued: 0, active: 0, completed: 0, failed: 0, cancelled: 0, maxActive: 0 };
  }

  run(key, job, { priority = 2 } = {}) {
    const normalized = String(key);
    const existing = this._byKey.get(normalized);
    if (existing) return existing.promise;
    let resolve; let reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    const entry = { key: normalized, job, resolve, reject, promise, cancelled: false, started: false,
      priority: Math.max(0, Math.min(3, priority | 0)) };
    this._byKey.set(normalized, entry);
    this._queues[entry.priority].push(entry);
    this._refreshStats();
    this._pump();
    return promise;
  }

  cancel(key) {
    const entry = this._byKey.get(String(key));
    if (!entry || entry.started) return false;
    entry.cancelled = true;
    this._byKey.delete(entry.key);
    this.stats.cancelled++;
    entry.resolve(null);
    this._refreshStats();
    return true;
  }

  _pump() {
    while (this.active < this.limit) {
      const entry = this._take();
      if (!entry) break;
      if (entry.cancelled || this._byKey.get(entry.key) !== entry) continue;
      entry.started = true;
      this.active++;
      this.stats.maxActive = Math.max(this.stats.maxActive, this.active);
      Promise.resolve().then(entry.job).then((value) => {
        this.stats.completed++; entry.resolve(value);
      }, (error) => {
        this.stats.failed++; entry.reject(error);
      }).finally(() => {
        this.active = Math.max(0, this.active - 1);
        if (this._byKey.get(entry.key) === entry) this._byKey.delete(entry.key);
        this._refreshStats();
        this._pump();
      });
    }
    this._refreshStats();
  }

  _take() {
    for (let priority = 0; priority < this._queues.length; priority++) {
      const queue = this._queues[priority];
      while (this._heads[priority] < queue.length) {
        const entry = queue[this._heads[priority]++];
        if (this._heads[priority] > 1024 && this._heads[priority] * 2 >= queue.length) {
          this._queues[priority] = queue.slice(this._heads[priority]);
          this._heads[priority] = 0;
        }
        if (!entry.cancelled) return entry;
      }
      queue.length = 0;
      this._heads[priority] = 0;
    }
    return null;
  }

  _refreshStats() {
    this.stats.active = this.active;
    this.stats.queued = this._byKey.size - this.active;
  }
}

export function validateTextureRegion(region, page = {}) {
  const x = Number(region?.x ?? region?.u); const y = Number(region?.y ?? region?.v);
  const width = Number(region?.width ?? region?.w); const height = Number(region?.height ?? region?.h);
  const pageWidth = Number(page?.width); const pageHeight = Number(page?.height);
  const finite = [x, y, width, height].every(Number.isFinite);
  const positive = width > 0 && height > 0 && x >= 0 && y >= 0;
  const inside = !Number.isFinite(pageWidth) || !Number.isFinite(pageHeight)
    || (x + width <= pageWidth && y + height <= pageHeight);
  return { ok: finite && positive && inside, finite, positive, inside, x, y, width, height };
}

export class SessionEpoch {
  constructor() { this.value = 1; }
  advance() { this.value = this.value >= Number.MAX_SAFE_INTEGER ? 1 : this.value + 1; return this.value; }
  capture() { return this.value; }
  valid(epoch) { return epoch === this.value; }
  guard(epoch, fn) { return (...args) => this.valid(epoch) ? fn(...args) : undefined; }
}

export function clampLayoutRect(rect, viewport, minVisible = 32) {
  const vw = Math.max(1, Number(viewport?.width) || 1);
  const vh = Math.max(1, Number(viewport?.height) || 1);
  const width = Math.max(1, Math.min(vw, Number(rect?.width) || 1));
  const height = Math.max(1, Math.min(vh, Number(rect?.height) || 1));
  const visible = Math.max(1, Math.min(minVisible, width, height));
  return {
    x: Math.round(Math.max(-width + visible, Math.min(vw - visible, Number(rect?.x) || 0))),
    y: Math.round(Math.max(0, Math.min(vh - visible, Number(rect?.y) || 0))),
    width: Math.round(width), height: Math.round(height),
  };
}

export function migrateLayoutScale(rect, fromScale, toScale, viewport) {
  const ratio = Math.max(0.25, Number(fromScale) || 1) / Math.max(0.25, Number(toScale) || 1);
  return clampLayoutRect({
    x: (Number(rect?.x) || 0) * ratio,
    y: (Number(rect?.y) || 0) * ratio,
    width: (Number(rect?.width) || 1) * ratio,
    height: (Number(rect?.height) || 1) * ratio,
  }, viewport);
}

export function buildClientQualityReport({ profile = clientRuntimeProfile, assets, scheduler, scene,
  performanceGovernor = clientPerformanceGovernor } = {}) {
  return {
    generatedAt: new Date().toISOString(),
    runtime: { ...profile, cacheLimits: { ...profile.cacheLimits } },
    assets: assets?.diagnosticsSnapshot?.() ?? assets?.atlasPageStats ?? null,
    scheduler: scheduler?.stats ? { ...scheduler.stats } : null,
    performance: performanceGovernor?.snapshot?.() ?? null,
    scene: scene ? {
      listeners: scene._unsubs?.length ?? 0,
      timers: scene._timers?.size ?? 0,
      chunks: scene._tiles?.visuals?.size ?? 0,
      items: scene._tiles?.items?.size ?? 0,
      streaming: scene._tiles?.diagnosticsSnapshot?.() ?? null,
    } : null,
  };
}

export function clientQualityReportMarkdown(report) {
  const runtime = report?.runtime ?? {};
  const streaming = report?.scene?.streaming ?? {};
  const missing = report?.assets?.telemetry?.missing?.length ?? report?.assets?.missing?.length ?? 0;
  return [
    '# NodeUO client quality report', '',
    `Generated: ${report?.generatedAt ?? new Date().toISOString()}`,
    `Runtime tier: ${runtime.tier ?? 'unknown'} (${runtime.memoryGiB ?? '?'} GiB, ${runtime.cores ?? '?'} cores)`,
    `Chunks: ${streaming.chunks ?? report?.scene?.chunks ?? 0}; queued: ${streaming.queuedChunks ?? 0}; active: ${streaming.activePopulates ?? 0}`,
    `Missing assets: ${missing}`,
    `Scheduler queue: ${report?.scheduler?.queued ?? 0}; max work: ${Number(report?.scheduler?.maxMs ?? 0).toFixed(2)} ms`, '',
  ].join('\n');
}
