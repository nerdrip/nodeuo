import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const GOLD_ITEM_IDS = new Set([0x0eed, 0x0eee, 0x0eef]);
const ZERO_HASH = '0'.repeat(64);

function canonicalPostings(postings) {
  return postings.map((row) => ({ account: String(row.account).slice(0, 160),
    delta: Number(row.delta), asset: String(row.asset ?? 'gold').slice(0, 32) }));
}

function recordHash(previousHash, record) {
  return crypto.createHash('sha256').update(previousHash).update(JSON.stringify(record)).digest('hex');
}

function ownerAccount(world, parent) {
  let serial = Number(parent) >>> 0;
  const seen = new Set();
  for (let depth = 0; serial && depth < 32; depth++) {
    if (seen.has(serial)) return 'invalid:container-cycle';
    seen.add(serial);
    const mobile = world?.mobiles?.get?.(serial);
    if (mobile) return `mobile:${mobile.accountName ?? mobile.client?.accountName ?? mobile.serial}`;
    const item = world?.items?.get?.(serial);
    if (!item) return `container:${serial}`;
    serial = Number(item.parent) >>> 0;
  }
  return serial ? 'invalid:container-depth' : 'world:ground';
}

export class EconomyTransactionLedger {
  constructor(file, { maxMemoryRecords = 20_000 } = {}) {
    this.file = path.resolve(file);
    this.maxMemoryRecords = Math.max(100, Math.min(100_000, Number(maxMemoryRecords) | 0));
    this.records = [];
    this.pending = [];
    this.sequence = 0;
    this.lastHash = ZERO_HASH;
    this.anomalies = [];
    this.itemState = new Map();
    this.mobileState = new Map();
    this._unsubscribe = null;
    this._timer = null;
    this.stats = { written: 0, bytes: 0, rejected: 0, observed: 0, lastError: null };
    this._load();
  }

  _load() {
    let text;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (error) {
      if (error.code !== 'ENOENT') this.stats.lastError = error.message;
      return;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        this.records.push(record);
        this.sequence = Math.max(this.sequence, Number(record.sequence) || 0);
        this.lastHash = String(record.hash ?? this.lastHash);
      } catch { this.anomalies.push({ code: 'corrupt-record', at: Date.now() }); }
    }
    const verification = this.verify();
    if (!verification.ok) {
      this.anomalies.push({ code: 'invalid-hash-chain', at: Date.now(), failures: verification.failures });
      this.stats.lastError = 'economy ledger hash-chain verification failed';
    }
    if (this.records.length > this.maxMemoryRecords) this.records.splice(0, this.records.length - this.maxMemoryRecords);
  }

  record(postings, { kind = 'transfer', actor = null, reference = null, metadata = null, at = Date.now() } = {}) {
    const normalized = canonicalPostings(Array.isArray(postings) ? postings : [])
      .filter((row) => row.account && Number.isSafeInteger(row.delta) && row.delta !== 0);
    const balance = normalized.reduce((sum, row) => sum + row.delta, 0);
    if (normalized.length < 2 || balance !== 0) {
      this.stats.rejected++;
      return { ok: false, error: 'ledger transaction must contain at least two balanced integer postings', balance };
    }
    const body = {
      version: 1, sequence: ++this.sequence, id: crypto.randomUUID(), at: Number(at) || Date.now(),
      kind: String(kind).slice(0, 64), actor: actor == null ? null : String(actor).slice(0, 160),
      reference: reference == null ? null : String(reference).slice(0, 160),
      postings: normalized, metadata: metadata && typeof metadata === 'object' ? metadata : null,
      previousHash: this.lastHash,
    };
    const hash = recordHash(this.lastHash, body);
    const record = Object.freeze({ ...body, hash });
    this.lastHash = hash; this.records.push(record); this.pending.push(record);
    if (this.records.length > this.maxMemoryRecords) this.records.splice(0, this.records.length - this.maxMemoryRecords);
    const largest = Math.max(...normalized.map((row) => Math.abs(row.delta)));
    if (largest >= 10_000_000) this.anomalies.push({ at: body.at, code: 'large-transfer', transactionId: body.id, amount: largest });
    if (this.anomalies.length > 1000) this.anomalies.splice(0, this.anomalies.length - 1000);
    return { ok: true, receipt: record };
  }

  attach(world, scheduler = null) {
    this.world = world;
    this.itemState.clear(); this.mobileState.clear();
    for (const item of world?.items?.values?.() ?? []) if (GOLD_ITEM_IDS.has(item.itemId)) {
      this.itemState.set(item.serial >>> 0, { amount: Math.max(0, item.amount | 0), account: ownerAccount(world, item.parent) });
    }
    for (const mobile of world?.mobiles?.values?.() ?? []) {
      this.mobileState.set(mobile.serial >>> 0, Math.max(0, mobile.gold | 0));
    }
    this._unsubscribe = world?.interest?.onDirty?.((serial, _mask, kind) => {
      if (kind === 'item') this.observeItem(serial);
      else if (kind === 'mobile') this.observeMobile(serial);
    });
    const poll = () => {
      for (const mobile of world?.onlineMobiles?.() ?? []) this.observeMobile(mobile.serial);
      this.flush();
    };
    this._timer = scheduler?.every ? scheduler.every('economy-ledger', 1000, poll) : setInterval(poll, 1000);
    this._timer?.unref?.();
    return this;
  }

  observeItem(serialLike) {
    const serial = Number(serialLike) >>> 0;
    const before = this.itemState.get(serial);
    const item = this.world?.items?.get?.(serial);
    const after = item && GOLD_ITEM_IDS.has(item.itemId)
      ? { amount: Math.max(0, item.amount | 0), account: ownerAccount(this.world, item.parent) } : null;
    if (!before && !after) return false;
    if (before?.amount === after?.amount && before?.account === after?.account) return false;
    const postings = [];
    if (before?.amount) postings.push({ account: before.account, delta: -before.amount });
    if (after?.amount) postings.push({ account: after.account, delta: after.amount });
    const external = (before?.amount ?? 0) - (after?.amount ?? 0);
    if (external) postings.push({ account: external > 0 ? 'system:burn' : 'system:mint', delta: external });
    if (after) this.itemState.set(serial, after); else this.itemState.delete(serial);
    if (postings.length >= 2) this.record(postings, { kind: 'gold-item-observed', reference: `item:${serial}`,
      metadata: { before, after } });
    this.stats.observed++;
    return true;
  }

  observeMobile(serialLike) {
    const serial = Number(serialLike) >>> 0;
    const mobile = this.world?.mobiles?.get?.(serial);
    const before = this.mobileState.get(serial);
    const after = mobile ? Math.max(0, mobile.gold | 0) : null;
    if (before == null && after == null) return false;
    if (before === after) return false;
    const account = `mobile:${mobile?.accountName ?? mobile?.client?.accountName ?? serial}`;
    const delta = (after ?? 0) - (before ?? 0);
    if (after == null) this.mobileState.delete(serial); else this.mobileState.set(serial, after);
    if (delta) this.record([
      { account, delta }, { account: delta > 0 ? 'system:mint' : 'system:burn', delta: -delta },
    ], { kind: 'mobile-gold-observed', reference: `mobile:${serial}` });
    this.stats.observed++;
    return true;
  }

  reconcile() {
    let changes = 0;
    const currentItems = new Set();
    for (const item of this.world?.items?.values?.() ?? []) if (GOLD_ITEM_IDS.has(item.itemId)) {
      currentItems.add(item.serial >>> 0); changes += this.observeItem(item.serial) ? 1 : 0;
    }
    for (const serial of [...this.itemState.keys()]) if (!currentItems.has(serial)) changes += this.observeItem(serial) ? 1 : 0;
    const currentMobiles = new Set();
    for (const mobile of this.world?.mobiles?.values?.() ?? []) {
      currentMobiles.add(mobile.serial >>> 0); changes += this.observeMobile(mobile.serial) ? 1 : 0;
    }
    for (const serial of [...this.mobileState.keys()]) if (!currentMobiles.has(serial)) changes += this.observeMobile(serial) ? 1 : 0;
    return { ok: true, changes, trackedItems: this.itemState.size, trackedMobiles: this.mobileState.size };
  }

  flush() {
    if (!this.pending.length) return { records: 0, bytes: 0 };
    const rows = this.pending.splice(0);
    const text = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, text, { encoding: 'utf8', mode: 0o600 });
      const bytes = Buffer.byteLength(text); this.stats.written += rows.length; this.stats.bytes += bytes;
      this.stats.lastError = null; return { records: rows.length, bytes };
    } catch (error) {
      this.pending.unshift(...rows); this.stats.lastError = error.message;
      return { records: 0, bytes: 0, error: error.message };
    }
  }

  verify(records = this.records) {
    let previous = records[0]?.previousHash ?? ZERO_HASH;
    const failures = [];
    for (const row of records) {
      const { hash, ...body } = row;
      const expected = recordHash(previous, body);
      if (row.previousHash !== previous || hash !== expected) failures.push({ sequence: row.sequence, expected, actual: hash });
      previous = hash;
    }
    return { ok: failures.length === 0, checked: records.length, failures: failures.slice(0, 100) };
  }

  receipts({ account, id, limit = 100 } = {}) {
    const count = Math.max(1, Math.min(1000, Number(limit) | 0 || 100));
    return this.records.filter((row) => (!id || row.id === id)
      && (!account || row.postings.some((posting) => posting.account === account))).slice(-count).reverse();
  }

  snapshot() {
    return { ...this.stats, sequence: this.sequence, lastHash: this.lastHash,
      pending: this.pending.length, recordsInMemory: this.records.length,
      anomalies: this.anomalies.slice(-100).reverse(), verification: this.verify() };
  }

  close() {
    this._unsubscribe?.(); this._unsubscribe = null;
    if (typeof this._timer?.cancel === 'function') this._timer.cancel(); else if (this._timer) clearInterval(this._timer);
    this._timer = null; this.flush();
  }
}
