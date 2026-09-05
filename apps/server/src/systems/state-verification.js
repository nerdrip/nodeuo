import crypto from 'node:crypto';

const CHECKPOINT_LIMIT = 64;
const ENTITY_FIELDS = Object.freeze([
  'serial', 'kind', 'name', 'body', 'itemId', 'hue', 'amount', 'x', 'y', 'z', 'map',
  'direction', 'flags', 'notoriety', 'hp', 'hpMax', 'mana', 'manaMax', 'stam', 'stamMax',
  'gold', 'parent', 'layer', 'dead', 'hidden', 'frozen', 'combatant', 'targetSerial',
]);

function projection(entity, type) {
  const row = { type };
  for (const field of ENTITY_FIELDS) {
    const value = entity?.[field];
    if (value == null || typeof value === 'function' || typeof value === 'object') continue;
    if (typeof value === 'number' && !Number.isFinite(value)) row[field] = null;
    else row[field] = value;
  }
  return row;
}

function sortedEntities(world) {
  const rows = [];
  for (const mobile of world?.mobiles?.values?.() ?? []) rows.push(projection(mobile, 'mobile'));
  for (const item of world?.items?.values?.() ?? []) rows.push(projection(item, 'item'));
  rows.sort((a, b) => (a.serial >>> 0) - (b.serial >>> 0) || a.type.localeCompare(b.type));
  return rows;
}

function digestRows(rows) {
  const total = crypto.createHash('sha256');
  const mobile = crypto.createHash('sha256');
  const item = crypto.createHash('sha256');
  for (const row of rows) {
    const line = `${JSON.stringify(row)}\n`;
    total.update(line);
    (row.type === 'mobile' ? mobile : item).update(line);
  }
  return {
    state: `sha256:${total.digest('hex')}`,
    mobiles: `sha256:${mobile.digest('hex')}`,
    items: `sha256:${item.digest('hex')}`,
  };
}

export function fingerprintWorld(world) {
  const rows = sortedEntities(world);
  return {
    ...digestRows(rows),
    counts: {
      mobiles: world?.mobiles?.size ?? 0,
      items: world?.items?.size ?? 0,
    },
  };
}

function ownerChain(world, item, limit = 32) {
  const seen = new Set([item?.serial >>> 0]);
  let parent = item?.parent;
  for (let depth = 0; parent != null && depth < limit; depth++) {
    const serial = Number(parent) >>> 0;
    if (!serial) return { depth };
    if (seen.has(serial)) return { cycle: true, serial };
    seen.add(serial);
    const mobile = world?.mobiles?.get?.(serial);
    if (mobile) return { mobile, depth: depth + 1 };
    const next = world?.items?.get?.(serial);
    if (!next) return { missing: serial, depth: depth + 1 };
    parent = next.parent;
  }
  return { depth: seen.size - 1 };
}

export function scanWorldInvariants(world, { limit = 5000 } = {}) {
  const issues = [];
  const add = (severity, code, serial, detail) => {
    if (issues.length < limit) issues.push({ severity, code, serial: Number(serial) >>> 0 || null, detail });
  };
  for (const [serial, mobile] of world?.mobiles ?? []) {
    if (world.items?.has?.(serial)) add('error', 'serial-collision', serial, 'serial is used by a mobile and an item');
    if (![mobile.x, mobile.y, mobile.z, mobile.map].every(Number.isFinite)) {
      add('error', 'mobile-position', serial, 'mobile has a non-finite coordinate');
    }
    for (const [value, maximum, name] of [
      [mobile.hp, mobile.hpMax, 'hp'], [mobile.mana, mobile.manaMax, 'mana'], [mobile.stam, mobile.stamMax, 'stam'],
    ]) {
      if (Number.isFinite(value) && Number.isFinite(maximum) && (value < 0 || value > maximum)) {
        add('warning', 'vital-range', serial, `${name} ${value} is outside 0..${maximum}`);
      }
    }
    if (Number.isFinite(mobile.gold) && mobile.gold < 0) add('error', 'negative-gold', serial, `mobile gold is ${mobile.gold}`);
  }
  for (const [serial, item] of world?.items ?? []) {
    if (!Number.isFinite(item.amount) || item.amount < 0) add('error', 'item-amount', serial, `invalid amount ${item.amount}`);
    const chain = ownerChain(world, item);
    if (chain.cycle) add('error', 'container-cycle', serial, `container chain cycles through ${chain.serial}`);
    if (chain.missing) add('error', 'missing-parent', serial, `parent ${chain.missing} does not exist`);
    if ((Number(item.parent) >>> 0) !== 0 && !world?._childrenByParent?.get?.(item.parent)?.has?.(serial)) {
      add('error', 'reverse-index-missing', serial, `parent ${item.parent} does not index this item`);
    }
  }
  for (const [parent, children] of world?._childrenByParent ?? []) {
    for (const serial of children) {
      const item = world.items?.get?.(serial);
      if (!item) add('error', 'reverse-index-phantom', serial, `parent ${parent} references a missing item`);
      else if (item.parent !== parent) add('error', 'reverse-index-parent', serial, `indexed by ${parent}, entity says ${item.parent}`);
    }
  }
  const counts = issues.reduce((out, issue) => {
    out[issue.severity] = (out[issue.severity] ?? 0) + 1;
    return out;
  }, {});
  return { ok: !(counts.error > 0), counts, issues,
    scanned: { mobiles: world?.mobiles?.size ?? 0, items: world?.items?.size ?? 0 } };
}

export function compareStateCheckpoints(reference, candidate) {
  const components = ['state', 'mobiles', 'items'];
  const mismatches = components.filter((key) => reference?.fingerprint?.[key] !== candidate?.fingerprint?.[key])
    .map((component) => ({ component,
      reference: reference?.fingerprint?.[component] ?? null,
      candidate: candidate?.fingerprint?.[component] ?? null }));
  return { ok: mismatches.length === 0, mismatches };
}

export class WorldVerificationService {
  constructor(world) {
    this.world = world;
    this.checkpoints = [];
    this.running = null;
  }

  checkpoint(label = 'manual') {
    const started = performance.now();
    const value = {
      id: crypto.randomUUID(), label: String(label).slice(0, 96), at: Date.now(),
      fingerprint: fingerprintWorld(this.world), invariants: scanWorldInvariants(this.world),
    };
    value.durationMs = Number((performance.now() - started).toFixed(3));
    this.checkpoints.push(value);
    if (this.checkpoints.length > CHECKPOINT_LIMIT) this.checkpoints.splice(0, this.checkpoints.length - CHECKPOINT_LIMIT);
    return structuredClone(value);
  }

  checkpointAsync(label = 'manual') {
    if (this.running) return this.running;
    this.running = new Promise((resolve) => setImmediate(resolve)).then(() => this.checkpoint(label))
      .finally(() => { this.running = null; });
    return this.running;
  }

  compare(referenceId, candidateId) {
    const reference = this.checkpoints.find((row) => row.id === referenceId);
    const candidate = this.checkpoints.find((row) => row.id === candidateId) ?? this.checkpoint('comparison-candidate');
    if (!reference) return { ok: false, error: 'reference checkpoint not found' };
    return { ...compareStateCheckpoints(reference, candidate), reference, candidate };
  }

  snapshot(limit = 20) {
    return { running: !!this.running,
      checkpoints: this.checkpoints.slice(-Math.max(1, Math.min(CHECKPOINT_LIMIT, Number(limit) | 0 || 20))).reverse() };
  }
}
