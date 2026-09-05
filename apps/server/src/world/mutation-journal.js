import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { EntityDirty } from './interest-management.js';
import {
  sqliteCheckpointSync,
  sqliteDiagnosticsSync,
  writeWorldBatchSync,
} from './sqlite-store.js';

const journalsByDirectory = new Map();
const SKIP_KEYS = new Set(['client', '_world']);

function fallbackEncode(entity) {
  const seen = new WeakSet();
  return JSON.parse(JSON.stringify(entity, (key, value) => {
    if (SKIP_KEYS.has(key) || typeof value === 'function') return undefined;
    if (typeof value === 'bigint') return { $bigint: String(value) };
    if (value instanceof Set) return { $set: [...value] };
    if (value instanceof Map) return { $map: [...value] };
    if (value && typeof value === 'object') {
      if (seen.has(value)) return undefined;
      seen.add(value);
    }
    return value;
  }));
}

function mobileBelongsToPlayer(world, mobile) {
  if (mobile?.isPlayer || mobile?.client) return true;
  let owner = Number(mobile?.controlMaster) >>> 0;
  const visited = new Set();
  while (owner && visited.size < 64 && !visited.has(owner)) {
    visited.add(owner);
    const parent = world?.mobiles?.get(owner);
    if (!parent) return false;
    if (parent.isPlayer || parent.client) return true;
    owner = Number(parent.controlMaster) >>> 0;
  }
  return false;
}

function itemBelongsToPlayer(world, item) {
  let parent = Number(item?.parent) >>> 0;
  const visited = new Set();
  while (parent && visited.size < 256 && !visited.has(parent)) {
    visited.add(parent);
    const mobile = world?.mobiles?.get(parent);
    if (mobile) return mobileBelongsToPlayer(world, mobile);
    const container = world?.items?.get(parent);
    if (!container) return false;
    parent = Number(container.parent) >>> 0;
  }
  return false;
}

export class WorldMutationJournal {
  constructor(saveDir, {
    enabled = process.env.UO_INCREMENTAL_WAL !== '0',
    flushIntervalMs = Number(process.env.UO_WAL_FLUSH_MS ?? 250),
    batchSize = Number(process.env.UO_SQLITE_BATCH_SIZE ?? 2048),
    serializeMobile = fallbackEncode,
    serializeItem = fallbackEncode,
    serializeMeta = () => ({}),
  } = {}) {
    this.saveDir = path.resolve(saveDir);
    this.enabled = enabled === true;
    this.flushIntervalMs = Math.max(25, flushIntervalMs | 0);
    this.batchSize = Math.max(64, Math.min(16_384, batchSize | 0));
    this.serializeMobile = serializeMobile;
    this.serializeItem = serializeItem;
    this.serializeMeta = serializeMeta;
    this.sequence = 0;
    this.pending = new Map();
    this.world = null;
    this.scheduler = null;
    this._unsubscribe = null;
    this._timer = null;
    this._worker = null;
    this._rpcId = 0;
    this._rpcPending = new Map();
    this._writeTail = Promise.resolve();
    this._closed = false;
    this.metaDirty = false;
    this.stats = {
      queued: 0, coalesced: 0, written: 0, removed: 0, bytes: 0, flushes: 0,
      checkpoints: 0, lastFlushMs: 0, lastError: null,
    };
    journalsByDirectory.set(this.saveDir, this);
  }

  recover() {
    // SQLite replays its own WAL while opening the database.
    return { recovered: 0, corruptLines: 0 };
  }

  attach(world, scheduler = null) {
    this._stopTimer();
    this.world = world;
    this.scheduler = scheduler;
    this._closed = false;
    world.mutationJournal = this;
    if (!this.enabled) return this;
    this._unsubscribe = world.interest?.onDirty?.((serial, mask, kind, revision) => {
      this.queue(serial, mask, kind, revision);
    });
    const flush = () => {
      this.flushAsync(this.batchSize).catch((error) => {
        this.stats.lastError = String(error?.message ?? error).slice(0, 1000);
      });
    };
    this._timer = scheduler?.every
      ? scheduler.every('world-sqlite-wal', this.flushIntervalMs, flush)
      : setInterval(flush, this.flushIntervalMs);
    this._timer?.unref?.();
    return this;
  }

  configure({ flushIntervalMs, batchSize } = {}) {
    let restart = false;
    if (Number.isFinite(Number(flushIntervalMs))) {
      const next = Math.max(25, Math.min(60_000, Number(flushIntervalMs) | 0));
      restart = next !== this.flushIntervalMs;
      this.flushIntervalMs = next;
    }
    if (Number.isFinite(Number(batchSize))) {
      this.batchSize = Math.max(64, Math.min(16_384, Number(batchSize) | 0));
    }
    if (restart && this.world) this.attach(this.world, this.scheduler);
    return this.snapshot();
  }

  queue(serialLike, mask = EntityDirty.All, kind = 'entity', revision = 0) {
    if (!this.enabled || this._closed) return false;
    const serial = Number(serialLike) >>> 0;
    if (!serial || (kind !== 'mobile' && kind !== 'item')) return false;
    const key = `${kind}:${serial}`;
    const previous = this.pending.get(key);
    if (previous) this.stats.coalesced++;
    this.pending.delete(key);
    this.pending.set(key, {
      serial,
      kind,
      mask: ((previous?.mask ?? 0) | Number(mask)) >>> 0,
      revision: Math.max(previous?.revision ?? 0, Number(revision) || 0),
      sequence: ++this.sequence,
    });
    this.stats.queued++;
    return true;
  }

  /** Queue registry/config metadata for the next entity transaction. */
  markMetaDirty() {
    if (!this.enabled || this._closed || !this.world) return false;
    this.metaDirty = true;
    return true;
  }

  _workerForWrites() {
    if (this._worker) return this._worker;
    const here = path.dirname(fileURLToPath(import.meta.url));
    const worker = new Worker(path.join(here, 'sqlite-persistence-worker.js'));
    worker.on('message', (message) => {
      const pending = this._rpcPending.get(message?.id);
      if (!pending) return;
      this._rpcPending.delete(message.id);
      if (this._rpcPending.size === 0) worker.unref();
      if (message.ok) pending.resolve(message.result ?? {});
      else pending.reject(new Error(message.error ?? 'SQLite persistence worker failed'));
    });
    worker.on('error', (error) => {
      this.stats.lastError = String(error?.message ?? error).slice(0, 1000);
      for (const pending of this._rpcPending.values()) pending.reject(error);
      this._rpcPending.clear();
      this._worker = null;
    });
    worker.unref();
    this._worker = worker;
    return worker;
  }

  _rpc(operation, extra = {}) {
    const worker = this._workerForWrites();
    worker.ref();
    const id = ++this._rpcId;
    return new Promise((resolve, reject) => {
      this._rpcPending.set(id, { resolve, reject });
      try { worker.postMessage({ id, operation, saveDir: this.saveDir, ...extra }); }
      catch (error) { this._rpcPending.delete(id); reject(error); }
    });
  }

  _takeBatch(limit) {
    const rows = [];
    const removals = [];
    const keys = [];
    for (const [key, pending] of this.pending) {
      const entity = pending.kind === 'mobile'
        ? this.world?.mobiles?.get(pending.serial)
        : this.world?.items?.get(pending.serial);
      // EntityDirty.All intentionally includes the Removed bit, so existence
      // in the authoritative World map—not the mask alone—decides DELETE.
      if (!entity) {
        removals.push(pending.serial);
      } else {
        const data = pending.kind === 'mobile'
          ? this.serializeMobile(entity)
          : this.serializeItem(entity);
        rows.push({
          kind: pending.kind,
          revision: pending.revision || pending.sequence,
          playerOwned: pending.kind === 'mobile'
            ? mobileBelongsToPlayer(this.world, entity)
            : itemBelongsToPlayer(this.world, entity),
          data,
        });
      }
      keys.push(key);
      if (keys.length >= limit) break;
    }
    for (const key of keys) this.pending.delete(key);
    return { rows, removals, keys };
  }

  _restoreBatch(batch) {
    for (const row of batch?.rows ?? []) {
      this.queue(row.data.serial, EntityDirty.All, row.kind, row.revision);
    }
    for (const serial of batch?.removals ?? []) {
      const kind = serial >= 0x40000000 ? 'item' : 'mobile';
      this.queue(serial, EntityDirty.Removed, kind);
    }
  }

  _meta() {
    return {
      version: 1,
      serials: {
        nextMobile: this.world?.serial?.nextMobile,
        nextItem: this.world?.serial?.nextItem,
      },
      worldMeta: this.serializeMeta(this.world),
    };
  }

  _enqueue(task) {
    const next = this._writeTail.catch(() => {}).then(task);
    this._writeTail = next;
    return next;
  }

  flushAsync(limit = this.batchSize) {
    if (!this.enabled || !this.world || (this.pending.size === 0 && !this.metaDirty)) {
      return Promise.resolve({ rows: 0, removals: 0, bytes: 0, ms: 0 });
    }
    return this._enqueue(async () => {
      const started = performance.now();
      const batch = this._takeBatch(Math.max(1, limit | 0));
      const writesMeta = this.metaDirty;
      if (writesMeta) {
        this.metaDirty = false;
        batch.generation = Math.max(1, (this.world._saveGeneration | 0) + 1);
        this.world._saveGeneration = batch.generation;
        batch.meta = this._meta();
      }
      if (!batch.keys.length && !writesMeta) return { rows: 0, removals: 0, bytes: 0, ms: 0 };
      try {
        const result = await this._rpc('write', { batch });
        this.stats.written += result.rows ?? 0;
        this.stats.removed += result.removals ?? 0;
        this.stats.bytes += result.bytes ?? 0;
        this.stats.flushes++;
        this.stats.lastFlushMs = Number((performance.now() - started).toFixed(3));
        this.stats.lastError = null;
        return result;
      } catch (error) {
        this._restoreBatch(batch);
        if (writesMeta) this.metaDirty = true;
        this.stats.lastError = String(error?.message ?? error).slice(0, 1000);
        throw error;
      }
    });
  }

  flushAllAsync({ includeMeta = true } = {}) {
    if (!this.enabled || !this.world) return Promise.resolve({ rows: 0, removals: 0, bytes: 0, ms: 0 });
    return this._enqueue(async () => {
      const started = performance.now();
      const total = { rows: 0, removals: 0, bytes: 0, ms: 0 };
      let inFlight = null;
      try {
        do {
          inFlight = this._takeBatch(this.batchSize);
          if (!inFlight.keys.length) break;
          const result = await this._rpc('write', { batch: inFlight });
          total.rows += result.rows ?? 0;
          total.removals += result.removals ?? 0;
          total.bytes += result.bytes ?? 0;
          this.stats.written += result.rows ?? 0;
          this.stats.removed += result.removals ?? 0;
          this.stats.flushes++;
          inFlight = null;
          await new Promise((resolve) => setImmediate(resolve));
        } while (this.pending.size > 0);
        if (includeMeta) {
          const generation = Math.max(1, (this.world._saveGeneration | 0) + 1);
          this.world._saveGeneration = generation;
          await this._rpc('write', { batch: { meta: this._meta(), generation } });
          this.metaDirty = false;
        }
      } catch (error) {
        this._restoreBatch(inFlight);
        if (includeMeta) this.metaDirty = true;
        this.stats.lastError = String(error?.message ?? error).slice(0, 1000);
        throw error;
      }
      total.ms = Number((performance.now() - started).toFixed(3));
      this.stats.bytes += total.bytes;
      this.stats.lastFlushMs = total.ms;
      this.stats.lastError = null;
      return total;
    });
  }

  flushSync(limit = Infinity, { includeMeta = false } = {}) {
    if (!this.enabled || !this.world) return { rows: 0, removals: 0, bytes: 0, ms: 0 };
    const batch = this._takeBatch(Number.isFinite(limit) ? Math.max(1, limit | 0) : Number.MAX_SAFE_INTEGER);
    if (includeMeta) {
      const generation = Math.max(1, (this.world._saveGeneration | 0) + 1);
      this.world._saveGeneration = generation;
      batch.meta = this._meta();
      batch.generation = generation;
    }
    if (!batch.keys.length && !batch.meta) return { rows: 0, removals: 0, bytes: 0, ms: 0 };
    const result = writeWorldBatchSync(this.saveDir, batch);
    if (batch.meta) this.metaDirty = false;
    this.stats.written += result.rows ?? 0;
    this.stats.removed += result.removals ?? 0;
    this.stats.bytes += result.bytes ?? 0;
    this.stats.flushes++;
    this.stats.lastFlushMs = result.ms ?? 0;
    return result;
  }

  beginCheckpoint() {
    while (this.pending.size) this.flushSync(this.batchSize);
    return this.sequence;
  }

  commitCheckpoint() {
    const result = sqliteCheckpointSync(this.saveDir, 'PASSIVE');
    this.stats.checkpoints++;
    return result;
  }

  waitForIdle() { return this._writeTail.catch(() => {}); }

  _stopTimer() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (typeof this._timer?.cancel === 'function') this._timer.cancel();
    else if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async closeAsync() {
    this._stopTimer();
    if (this.world && this.enabled) await this.flushAllAsync({ includeMeta: true });
    try {
      if (this._worker) await this._rpc('checkpoint', { mode: 'TRUNCATE' });
      if (this._worker) await this._rpc('close');
    } finally {
      await this._worker?.terminate?.();
      this._worker = null;
      this._closed = true;
    }
  }

  close() {
    this._stopTimer();
    if (this.world && this.enabled && (this.pending.size || this.metaDirty)) {
      this.flushSync(Infinity, { includeMeta: true });
    }
    this._closed = true;
  }

  snapshot() {
    let database = null;
    try { database = sqliteDiagnosticsSync(this.saveDir); } catch { /* database may be busy */ }
    return {
      ...this.stats,
      enabled: this.enabled,
      pending: this.pending.size,
      sequence: this.sequence,
      flushIntervalMs: this.flushIntervalMs,
      batchSize: this.batchSize,
      database,
    };
  }
}

export function createWorldMutationJournal(saveDir, options) {
  return new WorldMutationJournal(saveDir, options);
}

export function mutationJournalDiagnostics(saveDir) {
  return journalsByDirectory.get(path.resolve(saveDir))?.snapshot?.() ?? null;
}
