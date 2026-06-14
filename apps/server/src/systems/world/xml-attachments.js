// XmlAttachments — port of ServUO `Services/XmlSpawner/XmlSpawner Core/
// XmlAttachments/`. Lightweight stamped-on hooks for items + mobs.
//
// ServUO has 60+ attachment types; we cover the common ~15 that almost
// every shard uses + provide an open `register(name, factory)` so
// custom ones can be added without touching this file.
//
// Each attachment is a small object stamped onto `target._xmlAttach[name]`.
// The attachment owner ticks them (via `tickAttachments(world)`) and
// can dispatch events (onAttack, onDeath, onLoot etc).
//
// Persisted: attachments live on the item/mob and survive save/load
// because they're plain JSON-serializable bags.

import { destroyItem } from '../../world/items.js';
import { effectiveSkill } from '../../combat-formulas.js';

const _factories = new Map();

function cleanOpts(opts) {
  if (!opts || typeof opts !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(opts)) {
    if (typeof v === 'function') continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function rehydrateAttachment(att) {
  if (!att?.type) return att;
  const factory = _factories.get(att.type);
  if (!factory) return att;
  const fresh = factory(att.opts ?? att);
  for (const [key, value] of Object.entries(fresh)) {
    if (typeof value === 'function' && typeof att[key] !== 'function') {
      att[key] = value;
    }
  }
  return att;
}

function adjustNumber(host, key, delta) {
  if (!host || !key) return;
  host[key] = (host[key] | 0) + (delta | 0);
}

/**
 * Register an attachment factory.
 * @param {string} name
 * @param {(opts:object) => object} factory   Returns the runtime state object.
 */
export function registerAttachment(name, factory) {
  if (!name || typeof factory !== 'function') return;
  _factories.set(String(name), factory);
}

export function listAttachments() { return Array.from(_factories.keys()); }

/** Attach a new instance to `target`. */
export function attach(target, name, opts = {}) {
  if (!target || !_factories.has(name)) return null;
  target._xmlAttach ??= {};
  const inst = _factories.get(name)(opts);
  inst.type = name;
  inst.opts = cleanOpts(opts);
  inst.createdAt = Date.now();
  target._xmlAttach[name] = inst;
  try { inst.onCreate?.(target, opts); }
  catch (e) { console.error(`[xml-attach ${name}.onCreate]`, e?.message ?? e); }
  return inst;
}

export function detach(target, name) {
  if (!target?._xmlAttach) return false;
  return delete target._xmlAttach[name];
}

export function get(target, name) {
  return target?._xmlAttach?.[name] ?? null;
}

/** Dispatch an event to every attachment on `target` that listens. */
export function dispatch(target, event, payload) {
  const bag = target?._xmlAttach;
  if (!bag) return;
  for (const a of Object.values(bag)) {
    rehydrateAttachment(a);
    const fn = a?.[event];
    if (typeof fn === 'function') {
      try { fn.call(a, target, payload); }
      catch (e) { console.error(`[xml-attach ${a.type}.${event}]`, e?.message ?? e); }
    }
  }
}

/** Tick all attachments shard-wide (called from main loop). */
export function tickAttachments(world, now = Date.now()) {
  if (!world) return;
  const visit = (target) => {
    const bag = target._xmlAttach;
    if (!bag) return;
    for (const [key, a] of Object.entries(bag)) {
      rehydrateAttachment(a);
      // Lifetime: if `expiresAt` set and reached, auto-detach.
      if (a.expiresAt && now >= a.expiresAt) {
        try { a.onExpire?.(target); }
        catch (e) { console.error(`[xml-attach ${a.type}.onExpire]`, e?.message ?? e); }
        delete bag[key];
        continue;
      }
      if (a.tickIntervalMs && now - (a._lastTick ?? 0) >= a.tickIntervalMs) {
        a._lastTick = now;
        try { a.onTick?.(target, now); }
        catch (e) { console.error(`[xml-attach ${a.type}.onTick]`, e?.message ?? e); }
      }
    }
  };
  for (const m of world.mobiles.values()) visit(m);
  for (const i of world.items.values()) visit(i);
}

// =====================================================================
//  Built-in attachments (~12 most-used ServUO XmlAttachments)
// =====================================================================

// Counter — generic int counter with optional max + onMax callback.
registerAttachment('counter', ({ value = 0, max = Infinity, onMax = null } = {}) => ({
  value, max, onMaxFlag: false,
  bump(delta = 1) {
    this.value += delta;
    if (this.value >= this.max && !this.onMaxFlag) {
      this.onMaxFlag = true;
      onMax?.(this.value);
    }
  },
}));

// Data / local variable — generic named value bag used by XmlSpawner
// quests and switches.
registerAttachment('data', ({ key = 'value', value = null } = {}) => ({
  key, value,
  onCreate(host) {
    host._xmlData ??= {};
    host._xmlData[key] = value;
  },
}));
registerAttachment('local-variable', ({ key = 'value', value = null } = {}) => ({
  key, value,
  onCreate(host) {
    host._xmlData ??= {};
    host._xmlData[key] = value;
  },
}));

// Stat / appearance modifiers. These mirror the common XmlStr,
// XmlDex, XmlInt, XmlHue and XmlTitle attachments as persistent,
// JSON-round-trippable state.
registerAttachment('str', ({ amount = 0 } = {}) => ({
  amount: amount | 0,
  onCreate(host) { adjustNumber(host, 'str', this.amount); },
  onExpire(host) { adjustNumber(host, 'str', -this.amount); },
}));
registerAttachment('dex', ({ amount = 0 } = {}) => ({
  amount: amount | 0,
  onCreate(host) { adjustNumber(host, 'dex', this.amount); },
  onExpire(host) { adjustNumber(host, 'dex', -this.amount); },
}));
registerAttachment('int', ({ amount = 0 } = {}) => ({
  amount: amount | 0,
  onCreate(host) { adjustNumber(host, 'int', this.amount); },
  onExpire(host) { adjustNumber(host, 'int', -this.amount); },
}));
registerAttachment('hue', ({ hue = 0 } = {}) => ({
  hue: hue | 0,
  onCreate(host) { if (host) host.hue = this.hue; },
}));
registerAttachment('title', ({ title = '' } = {}) => ({
  title: String(title),
  onCreate(host) { if (host) host.title = this.title; },
}));

// Lifetime — auto-detach (and optionally destroy host) after `ms`.
registerAttachment('lifetime', ({ ms = 60_000, destroyHost = false } = {}) => ({
  expiresAt: Date.now() + ms,
  onExpire(host) {
    if (destroyHost && host?.serial != null) {
      try {
        const world = globalThis.__world ?? host._world;
        if (host.body != null) world?.destroyMobile?.(host.serial);
        else destroyItem(world, host.serial);
      } catch { /* ignore — best effort */ }
    }
  },
}));

// TimedEffect — fires `onTick(host)` at fixed cadence until expiry.
registerAttachment('timed-effect', ({ tickIntervalMs = 1000, ms = 30_000, onTick = null } = {}) => ({
  tickIntervalMs,
  expiresAt: Date.now() + ms,
  onTick(host, now) { onTick?.(host, now); },
}));

// AddFame / AddKarma / AddTithing — single-shot stat tag.
registerAttachment('add-fame', ({ amount = 100 } = {}) => ({
  applyOn: 'onUse',
  onUse(host) { if (host && typeof host.fame === 'number') host.fame += amount; },
}));
registerAttachment('add-karma', ({ amount = 100 } = {}) => ({
  applyOn: 'onUse',
  onUse(host) { if (host && typeof host.karma === 'number') host.karma += amount; },
}));
registerAttachment('add-tithing', ({ amount = 100 } = {}) => ({
  applyOn: 'onUse',
  onUse(host) { if (host && typeof host.tithingPoints === 'number') host.tithingPoints += amount; },
}));

// AddVirtue — increase a virtue track value by N.
registerAttachment('add-virtue', ({ virtue = 'compassion', amount = 100 } = {}) => ({
  applyOn: 'onUse',
  onUse(host) { if (host?.virtues) host.virtues[virtue] = (host.virtues[virtue] | 0) + amount; },
}));

// Dialog — speak a fixed line on first interaction (1-shot).
registerAttachment('dialog', ({ text = '', once = true } = {}) => ({
  spoken: false,
  onUse(host) {
    if (!host?.client && !host?._broadcastSpeech) return;
    if (once && this.spoken) return;
    this.spoken = true;
    if (host._broadcastSpeech) host._broadcastSpeech(text);
    else host.client?.sendSystemMessage?.(text);
  },
}));

// Freeze — set `_frozen = true` on host for `ms` then release.
registerAttachment('freeze', ({ ms = 5000 } = {}) => ({
  expiresAt: Date.now() + ms,
  onCreate(host) { if (host) host._frozen = true; },
  onExpire(host) { if (host) host._frozen = false; },
}));

// Lightning — single-shot lightning effect when used.
registerAttachment('lightning', ({ damage = 12 } = {}) => ({
  applyOn: 'onUse',
  onUse(host, evt) {
    if (!evt?.user) return;
    if (typeof evt.user.hp === 'number') evt.user.hp = Math.max(0, evt.user.hp - damage);
  },
}));

registerAttachment('message', ({ text = '', hue = 0x35 } = {}) => ({
  text: String(text),
  hue: hue | 0,
  onUse(host, evt) {
    const target = evt?.user ?? host;
    target?.client?.sendSystemMessage?.(this.text, this.hue);
  },
}));

// LifeDrain — damage attacker on hit + heal host.
registerAttachment('life-drain', ({ pct = 0.10 } = {}) => ({
  onAttacked(host, evt) {
    const attacker = evt?.attacker;
    if (!attacker || typeof attacker.hp !== 'number') return;
    const dmg = Math.floor((attacker.hpMax ?? 100) * pct);
    attacker.hp = Math.max(0, attacker.hp - dmg);
    if (typeof host.hp === 'number') host.hp = Math.min(host.hpMax ?? host.hp, host.hp + dmg);
  },
}));

registerAttachment('mana-drain', ({ amount = 10 } = {}) => ({
  amount: amount | 0,
  onAttacked(_host, evt) {
    const attacker = evt?.attacker;
    if (!attacker) return;
    attacker.mana = Math.max(0, (attacker.mana ?? 0) - this.amount);
  },
}));

registerAttachment('stam-drain', ({ amount = 10 } = {}) => ({
  amount: amount | 0,
  onAttacked(_host, evt) {
    const attacker = evt?.attacker;
    if (!attacker) return;
    attacker.stam = Math.max(0, (attacker.stam ?? 0) - this.amount);
  },
}));

registerAttachment('fire', ({ damage = 5, ms = 5000 } = {}) => ({
  damage: damage | 0,
  expiresAt: Date.now() + (ms | 0),
  onCreate(host) {
    host._burnUntil = Math.max(host._burnUntil ?? 0, this.expiresAt);
    host._burnDmg = Math.max(host._burnDmg ?? 0, this.damage);
  },
}));

registerAttachment('poison', ({ level = 1, ms = 30_000 } = {}) => ({
  level: Math.max(1, level | 0),
  expiresAt: Date.now() + (ms | 0),
  onCreate(host) {
    host.poisoned = true;
    host.poisonLevel = this.level;
    host._poisonExpiresAt = this.expiresAt;
  },
  onExpire(host) {
    host.poisoned = false;
    host.poisonLevel = 0;
    host._poisonExpiresAt = 0;
  },
}));

registerAttachment('morph', ({ body = null, hue = null, ms = 60_000 } = {}) => ({
  body: body == null ? null : body | 0,
  hue: hue == null ? null : hue | 0,
  expiresAt: Date.now() + (ms | 0),
  onCreate(host) {
    if (!host) return;
    this.oldBody = host.body;
    this.oldHue = host.hue;
    if (this.body != null) host.body = this.body;
    if (this.hue != null) host.hue = this.hue;
  },
  onExpire(host) {
    if (!host) return;
    if (this.oldBody != null) host.body = this.oldBody;
    if (this.oldHue != null) host.hue = this.oldHue;
  },
}));

// MagicWord — speech-trigger: when host hears `word`, fire `onTrigger`.
registerAttachment('magic-word', ({ word = '', onTrigger = null } = {}) => ({
  word: String(word).toLowerCase(),
  onSpeech(host, evt) {
    if (!evt?.text || !this.word) return;
    if (String(evt.text).toLowerCase().includes(this.word)) {
      onTrigger?.(host, evt);
    }
  },
}));

// Date — exposes `daysSinceCreated()` etc. for date-gated content.
registerAttachment('date', ({ ms = 0 } = {}) => ({
  createdAt: Date.now() - (ms | 0),
  daysSinceCreated(now = Date.now()) {
    return Math.floor((now - this.createdAt) / 86_400_000);
  },
}));

// RestrictEquip — block equip unless mob meets predicate (race / faction).
registerAttachment('restrict-equip', ({ race = null, faction = null, minSkill = null } = {}) => ({
  canEquip(_host, evt) {
    const mob = evt?.user;
    if (!mob) return true;
    if (race && mob.race !== race) return false;
    if (faction && mob._faction !== faction) return false;
    if (minSkill && effectiveSkill(mob, minSkill.id) < minSkill.value) return false;
    return true;
  },
}));

export const XML_ATTACH_BUILTIN = Object.freeze([
  'counter', 'data', 'local-variable',
  'str', 'dex', 'int', 'hue', 'title',
  'lifetime', 'timed-effect',
  'add-fame', 'add-karma', 'add-tithing', 'add-virtue',
  'dialog', 'freeze', 'lightning', 'message', 'life-drain',
  'mana-drain', 'stam-drain', 'fire', 'poison', 'morph', 'magic-word',
  'date', 'restrict-equip',
]);
