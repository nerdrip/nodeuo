// Cross-system runtime governor: bounded/coalesced work queues, phase
// watchdogs, revision-aware caches and lifecycle diagnostics. It is protocol
// agnostic and therefore safe for classic UO clients.

export class CoalescingWorkQueue {
  constructor({ budgetMs = 4, maxItems = 4096, now = () => performance.now() } = {}) {
    this.budgetMs = Math.max(0.25, Number(budgetMs) || 4);
    this.maxItems = Math.max(16, maxItems | 0);
    this._now = now;
    this._queues = [[], [], [], []];
    this._pending = new Map();
    this.stats = { enqueued: 0, coalesced: 0, completed: 0, failed: 0, dropped: 0, lastMs: 0, maxMs: 0 };
  }
  enqueue(key, run, { priority = 2, sector = '' } = {}) {
    const id = String(key);
    const previous = this._pending.get(id);
    if (previous) {
      previous.run = run;
      previous.sector = sector;
      previous.priority = Math.min(previous.priority, priority | 0);
      this.stats.coalesced++;
      return false;
    }
    if (this._pending.size >= this.maxItems) {
      this.stats.dropped++;
      return false;
    }
    const task = { key: id, run, priority: Math.max(0, Math.min(3, priority | 0)), sector };
    this._pending.set(id, task);
    this._queues[task.priority].push(task);
    this.stats.enqueued++;
    return true;
  }
  drain(budgetMs = this.budgetMs) {
    const started = this._now();
    const deadline = started + Math.max(0.25, Number(budgetMs) || this.budgetMs);
    let count = 0;
    let previousSector = null;
    while (this._now() <= deadline) {
      const task = this._take(previousSector);
      if (!task) break;
      if (this._pending.get(task.key) !== task) continue;
      this._pending.delete(task.key);
      previousSector = task.sector;
      try { task.run(); this.stats.completed++; }
      catch { this.stats.failed++; }
      count++;
    }
    const elapsed = Math.max(0, this._now() - started);
    this.stats.lastMs = elapsed; this.stats.maxMs = Math.max(this.stats.maxMs, elapsed);
    return count;
  }
  _take(previousSector) {
    for (const queue of this._queues) {
      if (!queue.length) continue;
      let index = 0;
      if (previousSector && queue.length > 1) {
        const different = queue.findIndex((task) => task.sector !== previousSector);
        if (different >= 0) index = different;
      }
      return queue.splice(index, 1)[0];
    }
    return null;
  }
  get size() { return this._pending.size; }
  snapshot() { return { ...this.stats, pending: this.size, budgetMs: this.budgetMs, maxItems: this.maxItems }; }
}

export class RevisionCache {
  constructor({ max = 4096 } = {}) {
    this.max = Math.max(16, max | 0);
    this._map = new Map();
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }
  get(key, revision) {
    const row = this._map.get(key);
    if (!row || row.revision !== revision) { this.stats.misses++; return undefined; }
    this._map.delete(key); this._map.set(key, row); this.stats.hits++;
    return row.value;
  }
  set(key, revision, value) {
    this._map.delete(key); this._map.set(key, { revision, value });
    while (this._map.size > this.max) { this._map.delete(this._map.keys().next().value); this.stats.evictions++; }
    return value;
  }
  clear() { this._map.clear(); }
  snapshot() { return { ...this.stats, size: this._map.size, max: this.max }; }
}

export class PhaseWatchdog {
  constructor({ slowMs = 25, history = 600 } = {}) {
    this.slowMs = Math.max(1, Number(slowMs) || 25);
    this.historyLimit = Math.max(32, history | 0);
    this.phases = new Map();
    this.slow = [];
  }
  measure(name, callback) {
    const started = performance.now();
    try { return callback(); }
    finally { this.record(name, performance.now() - started); }
  }
  async measureAsync(name, callback) {
    const started = performance.now();
    try { return await callback(); }
    finally { this.record(name, performance.now() - started); }
  }
  record(name, durationMs) {
    const key = String(name || 'unknown');
    const ms = Math.max(0, Number(durationMs) || 0);
    const row = this.phases.get(key) ?? { name: key, calls: 0, totalMs: 0, maxMs: 0, skipped: 0, histogram: [0, 0, 0, 0, 0] };
    row.calls++; row.totalMs += ms; row.maxMs = Math.max(row.maxMs, ms);
    const bucket = ms < 1 ? 0 : ms < 5 ? 1 : ms < 16 ? 2 : ms < 50 ? 3 : 4;
    row.histogram[bucket]++; this.phases.set(key, row);
    if (ms >= this.slowMs) {
      this.slow.push({ at: Date.now(), name: key, ms: Number(ms.toFixed(3)) });
      if (this.slow.length > this.historyLimit) this.slow.shift();
    }
  }
  skip(name, count = 1) {
    const key = String(name || 'unknown');
    const row = this.phases.get(key) ?? { name: key, calls: 0, totalMs: 0, maxMs: 0, skipped: 0, histogram: [0, 0, 0, 0, 0] };
    row.skipped += Math.max(1, count | 0); this.phases.set(key, row);
  }
  snapshot() {
    const slowest = [...this.slow].sort((a, b) => b.ms - a.ms || b.at - a.at).slice(0, 20);
    return {
      phases: [...this.phases.values()].map((row) => ({ ...row, histogram: [...row.histogram],
        averageMs: row.calls ? Number((row.totalMs / row.calls).toFixed(3)) : 0 }))
        .sort((a, b) => b.totalMs - a.totalMs),
      slow: this.slow.slice(-100),
      // Top-N is separate from chronological history so the admin profiler
      // can immediately identify the most expensive script-owned callback.
      slowest,
    };
  }
}

export class LifecycleRegistry {
  constructor() { this._owners = new Map(); this.history = []; }
  own(owner, disposer, kind = 'resource') {
    if (typeof disposer !== 'function') return disposer;
    const list = this._owners.get(owner) ?? [];
    list.push({ disposer, kind }); this._owners.set(owner, list);
    return disposer;
  }
  dispose(owner) {
    const list = this._owners.get(owner) ?? [];
    const errors = [];
    for (let i = list.length - 1; i >= 0; i--) {
      try { list[i].disposer(); } catch (error) { errors.push(String(error?.message ?? error)); }
    }
    this._owners.delete(owner);
    this.history.push({ at: Date.now(), owner: String(owner), disposed: list.length, errors });
    if (this.history.length > 200) this.history.shift();
    return { disposed: list.length, errors };
  }
  async transaction(owner, prepare, activate) {
    const started = performance.now();
    let staged;
    try {
      staged = await prepare();
      const value = await activate(staged, (disposer, kind) => this.own(owner, disposer, kind));
      this.history.push({ at: Date.now(), owner: String(owner), ok: true, ms: performance.now() - started });
      return { ok: true, value };
    } catch (error) {
      this.dispose(owner);
      try { await staged?.rollback?.(); } catch {}
      this.history.push({ at: Date.now(), owner: String(owner), ok: false, error: String(error?.message ?? error), ms: performance.now() - started });
      return { ok: false, error };
    }
  }
  stats() { return { owners: this._owners.size, resources: [...this._owners.values()].reduce((n, rows) => n + rows.length, 0), history: this.history.slice(-50) }; }
}

export function commandRegistryAudit(commands = []) {
  const rows = Array.isArray(commands) ? commands : [...(commands?.values?.() ?? [])];
  const normalized = new Map();
  const issues = [];
  for (const command of rows) {
    const name = String(command?.name ?? '').trim();
    const key = name.toLowerCase().replace(/[\s_-]+/g, '');
    if (!name) issues.push({ kind: 'missing-name' });
    if (!command?.access) issues.push({ kind: 'missing-access', name });
    if (!command?.description && !command?.usage && !command?.help) issues.push({ kind: 'missing-help', name });
    if (normalized.has(key)) issues.push({ kind: 'normalized-conflict', name, other: normalized.get(key) });
    else normalized.set(key, name);
  }
  return { ok: issues.length === 0, count: rows.length, issues };
}

export function fuzzySuggestions(input, names, limit = 5) {
  const query = String(input ?? '').toLowerCase();
  const distance = (a, b) => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let diagonal = row[0]; row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const old = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)); diagonal = old;
      }
    }
    return row[b.length];
  };
  return [...names].map((name) => ({ name, score: distance(query, String(name).toLowerCase()) }))
    .sort((a, b) => a.score - b.score || String(a.name).localeCompare(String(b.name))).slice(0, Math.max(1, limit | 0));
}

export class HealthState {
  constructor() { this.live = true; this.readyChecks = new Map(); this.shuttingDown = false; }
  set(name, ok, detail = '') { this.readyChecks.set(String(name), { ok: !!ok, detail: String(detail), at: Date.now() }); }
  beginShutdown() { if (this.shuttingDown) return false; this.shuttingDown = true; return true; }
  snapshot() {
    const checks = Object.fromEntries(this.readyChecks);
    return { live: this.live, ready: !this.shuttingDown && [...this.readyChecks.values()].every((row) => row.ok),
      shuttingDown: this.shuttingDown, checks };
  }
}

export class AdaptiveBudget {
  constructor({ base = 256, min = 16, max = base, targetTickMs = 25 } = {}) {
    this.base = Math.max(1, base | 0); this.min = Math.max(1, Math.min(this.base, min | 0));
    this.max = Math.max(this.base, max | 0); this.targetTickMs = Math.max(1, Number(targetTickMs) || 25);
    this.current = this.base; this.tickEmaMs = 0; this.skipped = 0;
  }
  observe(tickMs) {
    const ms = Math.max(0, Number(tickMs) || 0); this.tickEmaMs = this.tickEmaMs ? this.tickEmaMs * .9 + ms * .1 : ms;
    if (this.tickEmaMs > this.targetTickMs * 1.25) this.current = Math.max(this.min, Math.floor(this.current * .8));
    else if (this.tickEmaMs < this.targetTickMs * .7) this.current = Math.min(this.max, this.current + Math.max(1, Math.ceil(this.base * .04)));
    return this.current;
  }
  noteSkipped(count = 1) { this.skipped += Math.max(0, count | 0); }
  snapshot() { return { base: this.base, min: this.min, max: this.max, current: this.current, tickEmaMs: Number(this.tickEmaMs.toFixed(3)), skipped: this.skipped }; }
}

export class TypedSpatialRegistry {
  constructor({ sectorShift = 3 } = {}) { this.sectorShift = sectorShift | 0; this.types = new Map(); this.reverse = new Map(); this.revision = 1; }
  _key(map, x, y) { return `${map | 0}:${(x | 0) >> this.sectorShift}:${(y | 0) >> this.sectorShift}`; }
  add(type, id, position, value = id) {
    this.remove(type, id); const typeKey = String(type); const key = this._key(position.map, position.x, position.y);
    const bySector = this.types.get(typeKey) ?? new Map(); const bucket = bySector.get(key) ?? new Map();
    bucket.set(id, value); bySector.set(key, bucket); this.types.set(typeKey, bySector); this.reverse.set(`${typeKey}:${id}`, key); this.revision++; return value;
  }
  remove(type, id) {
    const typeKey = String(type); const reverseKey = `${typeKey}:${id}`; const key = this.reverse.get(reverseKey); if (!key) return false;
    const bySector = this.types.get(typeKey); const bucket = bySector?.get(key); bucket?.delete(id);
    if (bucket?.size === 0) bySector.delete(key); if (bySector?.size === 0) this.types.delete(typeKey);
    this.reverse.delete(reverseKey); this.revision++; return true;
  }
  *near(type, position, range = 0) {
    const bySector = this.types.get(String(type)); if (!bySector) return;
    const sx0 = ((position.x - range) | 0) >> this.sectorShift; const sy0 = ((position.y - range) | 0) >> this.sectorShift;
    const sx1 = ((position.x + range) | 0) >> this.sectorShift; const sy1 = ((position.y + range) | 0) >> this.sectorShift;
    for (let sx = sx0; sx <= sx1; sx++) for (let sy = sy0; sy <= sy1; sy++) for (const value of bySector.get(`${position.map | 0}:${sx}:${sy}`)?.values?.() ?? []) yield value;
  }
  validate() {
    const orphaned = [];
    for (const [reverseKey, sector] of this.reverse) {
      const split = reverseKey.indexOf(':'); const type = reverseKey.slice(0, split); const id = reverseKey.slice(split + 1);
      const bucket = this.types.get(type)?.get(sector); if (![...bucket?.keys?.() ?? []].some((key) => String(key) === id)) orphaned.push(reverseKey);
    }
    return { ok: orphaned.length === 0, orphaned, types: Object.fromEntries([...this.types].map(([type, sectors]) => [type, [...sectors.values()].reduce((sum, bucket) => sum + bucket.size, 0)])), revision: this.revision };
  }
}

export class TransactionJournal {
  constructor({ limit = 2000 } = {}) { this.limit = Math.max(100, limit | 0); this.active = new Map(); this.history = []; this.parentAudit = []; this.duplicates = 0; this.rollbacks = 0; this.sequence = 0; }
  begin(kind, details = {}) {
    const id = `${String(kind)}:${Date.now().toString(36)}:${(++this.sequence).toString(36)}`;
    const tx = { id, kind: String(kind), startedAt: Date.now(), events: [], details: { ...details }, itemSerials: new Set() };
    this.active.set(id, tx); return tx;
  }
  event(tx, name, details = {}) { if (tx && this.active.get(tx.id) === tx) tx.events.push({ at: Date.now(), name: String(name), details: { ...details } }); }
  item(tx, serial, action, details = {}) {
    if (!tx || this.active.get(tx.id) !== tx) return false; const key = serial >>> 0;
    if (action === 'create' && tx.itemSerials.has(key)) this.duplicates++;
    tx.itemSerials.add(key); this.event(tx, `item.${action}`, { serial: key, ...details }); return true;
  }
  auditParent(item, before, after) {
    this.parentAudit.push({ at: Date.now(), serial: item?.serial >>> 0,
      before: before == null ? null : before >>> 0, after: after == null ? null : after >>> 0,
      layer: item?.layer | 0 });
    if (this.parentAudit.length > this.limit) this.parentAudit.splice(0, this.parentAudit.length - this.limit);
  }
  _finish(tx, ok, reason = '') {
    if (!tx || !this.active.delete(tx.id)) return null;
    const row = { id: tx.id, kind: tx.kind, ok, reason: String(reason), startedAt: tx.startedAt, endedAt: Date.now(), durationMs: Date.now() - tx.startedAt, events: tx.events, details: tx.details };
    this.history.push(row); if (this.history.length > this.limit) this.history.splice(0, this.history.length - this.limit); return row;
  }
  commit(tx) { return this._finish(tx, true); }
  rollback(tx, reason) { this.rollbacks++; return this._finish(tx, false, reason); }
  snapshot() { return { active: this.active.size, duplicates: this.duplicates, rollbacks: this.rollbacks,
    parentAudit: this.parentAudit.slice(-100), history: this.history.slice(-100) }; }
}

export class DeterministicRuntime {
  constructor(seed = 0x4e6f6465, now = 0) { this.seed = seed >>> 0 || 1; this.nowMs = Number(now) || 0; }
  random() { let x = this.seed; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.seed = x >>> 0 || 1; return this.seed / 0x100000000; }
  now() { return this.nowMs; }
  advance(ms) { this.nowMs += Math.max(0, Number(ms) || 0); return this.nowMs; }
  snapshot() { return { seed: this.seed, nowMs: this.nowMs }; }
  restore(snapshot) { this.seed = snapshot.seed >>> 0 || 1; this.nowMs = Number(snapshot.nowMs) || 0; }
}

export class StartupProfiler {
  constructor() { this.startedAt = performance.now(); this.phases = []; }
  measure(name, callback) { const started = performance.now(); try { return callback(); } finally { this.phases.push({ name: String(name), ms: Number((performance.now() - started).toFixed(3)) }); } }
  async measureAsync(name, callback) { const started = performance.now(); try { return await callback(); } finally { this.phases.push({ name: String(name), ms: Number((performance.now() - started).toFixed(3)) }); } }
  snapshot() { return { totalMs: Number((performance.now() - this.startedAt).toFixed(3)), phases: [...this.phases] }; }
}

export const runtimeGovernor = Object.freeze({
  visibility: new CoalescingWorkQueue({ budgetMs: 5 }),
  background: new CoalescingWorkQueue({ budgetMs: 4 }),
  visibilityCache: new RevisionCache({ max: 8192 }),
  watchdog: new PhaseWatchdog(),
  lifecycle: new LifecycleRegistry(),
  health: new HealthState(),
  budgets: Object.freeze({ visibility: new AdaptiveBudget({ base: 512, min: 64 }), ai: new AdaptiveBudget({ base: 256, min: 24 }), spawners: new AdaptiveBudget({ base: 256, min: 16 }) }),
  spatial: new TypedSpatialRegistry(),
  transactions: new TransactionJournal(),
  startup: new StartupProfiler(),
});
runtimeGovernor.health.set('startup', false, 'server is starting');

export function buildServerQualityReport({ world, diagnostics, commands, scripts } = {}) {
  return {
    generatedAt: new Date().toISOString(),
    health: runtimeGovernor.health.snapshot(),
    queues: { visibility: runtimeGovernor.visibility.snapshot(), background: runtimeGovernor.background.snapshot() },
    watchdog: runtimeGovernor.watchdog.snapshot(),
    cache: runtimeGovernor.visibilityCache.snapshot(),
    sectors: world?.sectors?.stats?.() ?? null,
    sectorIntegrity: world?.sectors?.validate?.(world) ?? null,
    commands: commandRegistryAudit(commands),
    scripts: scripts?.diagnostics?.() ?? runtimeGovernor.lifecycle.stats(),
    budgets: Object.fromEntries(Object.entries(runtimeGovernor.budgets).map(([key, value]) => [key, value.snapshot()])),
    spatial: runtimeGovernor.spatial.validate(),
    transactions: runtimeGovernor.transactions.snapshot(),
    startup: runtimeGovernor.startup.snapshot(),
    diagnostics: diagnostics?.runtimeSnapshot?.() ?? null,
  };
}

export function serverQualityReportMarkdown(report) {
  const phases = report?.watchdog?.phases ?? [];
  return [
    '# NodeUO server quality report', '',
    `Generated: ${report?.generatedAt ?? new Date().toISOString()}`,
    `Health: ${report?.health?.ready ? 'ready' : report?.health?.live ? 'degraded' : 'down'}`,
    `Sector index: ${report?.sectorIntegrity?.ok ? 'consistent' : 'requires attention'} (${report?.sectors?.sectors ?? 0} sectors)`,
    `Visibility queue: ${report?.queues?.visibility?.pending ?? 0} pending; ${report?.queues?.visibility?.coalesced ?? 0} coalesced`,
    `Watchdog phases: ${phases.length}; slow samples: ${report?.watchdog?.slow?.length ?? 0}`,
    `Open transactions: ${report?.transactions?.active ?? 0}; rollbacks: ${report?.transactions?.rollbacks ?? 0}`, '',
  ].join('\n');
}
