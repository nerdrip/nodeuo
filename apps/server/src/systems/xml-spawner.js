import { resolveStandingZ } from '../world/movement.js';
import { attach as attachXml, dispatch as dispatchXmlAttachment } from './world/xml-attachments.js';
// XmlSpawner — port of ServUO `Scripts/Services/XmlSpawner/`. Allows
// authoring complex spawns: branching tables, conditional respawn rules
// (only at night, only if no players nearby, only once per region cap).
// We mirror the format with a JS object instead of XML.
//
// Spawn template:
//   {
//     id: 'winter-wolves',
//     map: 0, x: 1500, y: 1600, range: 4,
//     count: 5, respawn: 600_000,
//     conditions: { isNight: true, noPlayersWithin: 12 },
//     entries: [
//       { kind: 'wolf', weight: 6 },
//       { kind: 'dire-wolf', weight: 1 },
//     ],
//   }
//
// Caller wires `tickSpawn(world, template, day, now)` once per minute.

const _spawned = new Map();    // templateId → mobile[] currently alive

const PROP_ALIASES = new Map(Object.entries({
  name: 'name',
  title: 'title',
  hue: 'hue',
  body: 'body',
  bodyvalue: 'body',
  itemid: 'itemId',
  item: 'itemId',
  amount: 'amount',
  movable: 'movable',
  visible: 'visible',
  hidden: 'hidden',
  blessed: 'blessed',
  invulnerable: 'invulnerable',
  x: 'x',
  y: 'y',
  z: 'z',
  map: 'map',
  direction: 'direction',
  dir: 'direction',
  hits: 'hp',
  hp: 'hp',
  hitsmax: 'hpMax',
  hpmax: 'hpMax',
  mana: 'mana',
  manamax: 'manaMax',
  stam: 'stam',
  stamina: 'stam',
  stammax: 'stamMax',
  str: 'str',
  dex: 'dex',
  int: 'int',
  fame: 'fame',
  karma: 'karma',
  team: 'team',
  homerange: 'homeRange',
  homex: 'homeX',
  homey: 'homeY',
  homez: 'homeZ',
  rangehome: 'homeRange',
  lootpack: 'lootTable',
  loottable: 'lootTable',
  ai: 'aiBehavior',
  aibehavior: 'aiBehavior',
}));

const ATTACH_ALIASES = new Map(Object.entries({
  xmladdfame: 'add-fame',
  xmladdkarma: 'add-karma',
  xmladdtithing: 'add-tithing',
  xmladdvirtue: 'add-virtue',
  xmlcounter: 'counter',
  xmldata: 'data',
  xmllocalvariable: 'local-variable',
  xmldate: 'date',
  xmldialog: 'dialog',
  xmlfreeze: 'freeze',
  xmlhue: 'hue',
  xmltitle: 'title',
  xmlstr: 'str',
  xmldex: 'dex',
  xmlint: 'int',
  xmllifedrain: 'life-drain',
  xmllightning: 'lightning',
  xmlmagicword: 'magic-word',
  xmlmanadrain: 'mana-drain',
  xmlstamdrain: 'stam-drain',
  xmlfire: 'fire',
  xmlpoison: 'poison',
  xmlmorph: 'morph',
  xmlmessage: 'message',
  xmlrestrictequip: 'restrict-equip',
  lifetime: 'lifetime',
  timedeffect: 'timed-effect',
}));

const COMMAND_HEADS = new Set([
  'SET', 'SETONTHIS', 'SETONTRIGMOB', 'MSG', 'SENDMSG', 'PRIVMSG',
  'SAY', 'SPEECH', 'SOUND', 'DAMAGE', 'ATTACH',
]);

function splitTopLevel(text, sep = '/') {
  const out = [];
  let cur = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < String(text ?? '').length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    if (ch === '}' || ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function parseNumeric(text) {
  const s = String(text ?? '').trim();
  if (!s) return 0;
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseValue(value) {
  if (value == null) return value;
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if (/^\{RND\s*,/i.test(s)) {
    const parts = splitTopLevel(s.replace(/^\{|\}$/g, ''), ',');
    const lo = parseNumeric(parts[1]) ?? 0;
    const hi = parseNumeric(parts[2]) ?? lo;
    return lo + Math.floor(Math.random() * Math.max(1, hi - lo + 1));
  }
  if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);
  if (/^(null|none)$/i.test(s)) return null;
  const n = parseNumeric(s);
  if (n != null && /^-?(0x[0-9a-f]+|\d+)(\.\d+)?$/i.test(s)) return n;
  return s.replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1');
}

function propKey(name) {
  if (!name) return null;
  const raw = String(name).trim();
  const key = raw.toLowerCase().replace(/[\s_-]+/g, '');
  return PROP_ALIASES.get(key) ?? raw[0]?.toLowerCase() + raw.slice(1);
}

function normaliseAttachmentName(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return '';
  const key = raw.toLowerCase().replace(/[\s_-]+/g, '');
  return ATTACH_ALIASES.get(key) ?? raw
    .replace(/^Xml/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

function parseAttachmentArgs(text) {
  const parts = splitTopLevel(text, ',');
  const type = normaliseAttachmentName(parts.shift());
  const opts = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0) opts[p.slice(0, eq).trim()] = parseValue(p.slice(eq + 1));
    else if (opts.amount == null) opts.amount = parseValue(p);
    else if (opts.value == null) opts.value = parseValue(p);
  }
  return { type, opts };
}

export function parseXmlObjectSpec(raw) {
  const parts = splitTopLevel(raw, '/').filter((p) => p.length > 0);
  const head = parts.shift() ?? '';
  const headArgs = splitTopLevel(head, ',');
  let typeName = headArgs.shift()?.trim() ?? '';
  if (COMMAND_HEADS.has(typeName.toUpperCase())) {
    parts.unshift([typeName, ...headArgs].join(','));
    typeName = '';
  }
  const constructorArgs = headArgs.map(parseValue);
  const props = {};
  const attachments = [];
  const actions = [];
  for (let i = 0; i < parts.length;) {
    const token = parts[i++] ?? '';
    const upper = token.toUpperCase();
    if (upper === 'ATTACH') {
      const arg = parts[i++] ?? '';
      attachments.push(parseAttachmentArgs(arg));
      continue;
    }
    if (upper === 'MSG' || upper === 'SENDMSG' || upper === 'PRIVMSG') {
      actions.push({ type: 'message', text: parts[i++] ?? '' });
      continue;
    }
    if (upper === 'SAY' || upper === 'SPEECH') {
      actions.push({ type: 'say', text: parts[i++] ?? '' });
      continue;
    }
    if (upper === 'SOUND') {
      actions.push({ type: 'sound', soundId: parseValue(parts[i++] ?? '0') | 0 });
      continue;
    }
    if (upper === 'DAMAGE') {
      actions.push({ type: 'damage', amount: parseValue(parts[i++] ?? '0') | 0 });
      continue;
    }
    if (upper === 'SETONTRIGMOB' || upper === 'SETONTHIS') {
      const actionProps = {};
      while (i < parts.length) {
        const key = parts[i++];
        const value = parts[i++];
        if (key && value !== undefined) actionProps[propKey(key)] = parseValue(value);
      }
      actions.push({
        type: 'set-props',
        target: upper === 'SETONTRIGMOB' ? 'trigMob' : 'this',
        props: actionProps,
      });
      continue;
    }
    if (upper === 'SET') continue;
    const value = parts[i++];
    const key = propKey(token);
    if (key && value !== undefined) props[key] = parseValue(value);
  }
  return { raw: String(raw ?? ''), typeName, constructorArgs, props, attachments, actions };
}

export function applyXmlProperty(target, name, value, ctx = {}) {
  if (!target || !name) return false;
  const key = propKey(name);
  if (!key) return false;
  const old = { x: target.x, y: target.y, map: target.map };
  target[key] = parseValue(value);
  if ((key === 'x' || key === 'y' || key === 'map') && ctx.world?.sectors?.moveMobile && target.body != null) {
    try { ctx.world.sectors.moveMobile(target, old); } catch { /* advisory */ }
  }
  return true;
}

function runXmlAction(target, action, ctx = {}) {
  if (!target || !action) return false;
  const user = ctx.trigMob ?? ctx.user ?? target;
  switch (String(action.type ?? '').toLowerCase()) {
    case 'message':
      user?.client?.sendSystemMessage?.(String(action.text ?? ''), action.hue);
      return true;
    case 'say':
      ctx.broadcastSpeech?.(target, String(action.text ?? ''));
      target._xmlLastSpeech = String(action.text ?? '');
      return true;
    case 'sound':
      ctx.playSoundNear?.(ctx.world, target, action.soundId | 0);
      target._xmlLastSound = action.soundId | 0;
      return true;
    case 'damage': {
      const amount = action.amount | 0;
      if (amount <= 0) return false;
      if (ctx.damage) ctx.damage(ctx.world, user, amount, target);
      else if (typeof user.hp === 'number') user.hp = Math.max(0, user.hp - amount);
      return true;
    }
    case 'set-props': {
      const dst = action.target === 'trigMob'
        ? (ctx.trigMob ?? ctx.user)
        : target;
      if (!dst) return false;
      for (const [key, value] of Object.entries(action.props ?? {})) {
        applyXmlProperty(dst, key, value, ctx);
      }
      return true;
    }
    default:
      return false;
  }
}

export function applySpawnDirectives(target, ctx = {}) {
  if (!target) return target;
  const entry = ctx.entry ?? {};
  const specs = [];
  if (entry.raw) specs.push(parseXmlObjectSpec(entry.raw));
  if (entry.spec) specs.push(entry.spec);
  for (const spec of specs) {
    for (const [key, value] of Object.entries(spec.props ?? {})) {
      applyXmlProperty(target, key, value, ctx);
    }
    for (const att of spec.attachments ?? []) {
      if (!att?.type) continue;
      attachXml(target, att.type, att.opts ?? {});
    }
    for (const action of spec.actions ?? []) runXmlAction(target, action, ctx);
  }
  for (const [key, value] of Object.entries(entry.props ?? entry.properties ?? {})) {
    applyXmlProperty(target, key, value, ctx);
  }
  for (const att of entry.attachments ?? []) {
    if (!att?.type) continue;
    attachXml(target, normaliseAttachmentName(att.type), att.opts ?? att);
  }
  for (const action of entry.actions ?? []) runXmlAction(target, action, ctx);
  dispatchXmlAttachment(target, 'onSpawn', { ...ctx, target });
  return target;
}

function pickWeighted(entries) {
  const total = entries.reduce((s, e) => s + (e.weight || 1), 0);
  let r = Math.random() * total;
  for (const e of entries) {
    r -= (e.weight || 1);
    if (r <= 0) return e;
  }
  return entries[entries.length - 1];
}

function meetsConditions(world, t, now) {
  const c = t.conditions ?? {};
  if (c.isNight && !world?.isNight?.()) return false;
  if (c.isDay && world?.isNight?.()) return false;
  if (c.noPlayersWithin) {
    for (const m of world?.mobiles?.values?.() ?? []) {
      if (!m.client) continue;
      if (m.map !== t.map) continue;
      const dx = Math.abs(m.x - t.x), dy = Math.abs(m.y - t.y);
      if (Math.max(dx, dy) <= c.noPlayersWithin) return false;
    }
  }
  if (c.fromHour != null && c.toHour != null) {
    const hour = new Date(now).getHours();
    if (c.fromHour <= c.toHour) {
      if (hour < c.fromHour || hour >= c.toHour) return false;
    } else {
      if (hour < c.fromHour && hour >= c.toHour) return false;
    }
  }
  return true;
}

export function tickSpawn(world, template, api, now = Date.now()) {
  if (!template?.id || !world) return;
  const live = _spawned.get(template.id) ?? [];
  // prune dead
  const alive = live.filter((m) => world.mobiles?.get?.(m.serial) && (m.hp ?? 1) > 0);
  if (alive.length >= (template.count | 0)) {
    _spawned.set(template.id, alive);
    return;
  }
  // respawn cooldown — track lastSpawnAt per template
  template._lastSpawnAt ??= 0;
  // Variance: ±25% jitter on respawn so a 600s spawner doesn't
  // emit on a perfect tick boundary (ServUO XmlSpawner spawnVariance).
  const baseRespawn = template.respawn ?? 60_000;
  const variance = template.respawnVariance ?? 0.25;
  const effectiveRespawn = baseRespawn * (1 + (Math.random() * 2 - 1) * variance);
  if (now - template._lastSpawnAt < effectiveRespawn) {
    _spawned.set(template.id, alive);
    return;
  }
  if (!meetsConditions(world, template, now)) {
    _spawned.set(template.id, alive);
    return;
  }
  const e = pickWeighted(template.entries ?? []);
  const r = template.range ?? 0;
  const sx = template.x + Math.floor((Math.random() * (2 * r + 1)) - r);
  const sy = template.y + Math.floor((Math.random() * (2 * r + 1)) - r);
  const map = template.map ?? 0;
  // Use template.z when authored; otherwise walk land+statics so the
  // mob ends up on the visible standing surface instead of clipping
  // through a building floor at z=0.
  let sz = template.z;
  if (sz == null) {
    try {
      const standZ = resolveStandingZ(map, sx, sy, 0);
      sz = Number.isFinite(standZ) ? standZ : 0;
    } catch { sz = 0; }
  }
  const m = api?.spawner?.spawn?.(e.kind, { x: sx, y: sy, z: sz, map });
  if (m) {
    // Loot table injection — if entry or template carries a `lootTable`
    // tag, stamp it on the mob so corpse.dropLoot picks it up. ServUO
    // XmlSpawner uses `LootPack` field for the same role.
    if (e.lootTable || template.lootTable) {
      m.lootTable = e.lootTable ?? template.lootTable;
    }
    // Difficulty override — boosts fame/hpMax so loot-scaling picks up
    // the boss tier (xml-spawner.js for arenas/dungeons used this in
    // ServUO to make miniboss versions of basic mobs).
    if (e.difficulty != null || template.difficulty != null) {
      const mult = e.difficulty ?? template.difficulty;
      m.hpMax = Math.round((m.hpMax ?? 50) * mult);
      m.hp = m.hpMax;
      m.fame = Math.round((m.fame ?? 0) * mult);
    }
    // Properties propagation — supports custom name/title/hue per entry
    // (e.g. "the dread wolf" rename, ghostly hue, blessed flag).
    if (e.name) m.name = e.name;
    if (e.hue != null) m.hue = e.hue;
    if (e.title) m.title = e.title;
    alive.push(m);
    template._lastSpawnAt = now;
  }
  _spawned.set(template.id, alive);
}

/** Force respawn — wipe alive list and reset lastSpawnAt so the next
 *  tickSpawn spawns immediately. ServUO XmlSpawner `Reset` button. */
export function resetSpawner(world, template) {
  if (!template?.id) return 0;
  const live = _spawned.get(template.id) ?? [];
  for (const m of live) {
    try { world?.mobiles?.delete?.(m.serial); }
    catch { /* mob already cleaned */ }
  }
  _spawned.delete(template.id);
  template._lastSpawnAt = 0;
  return live.length;
}

/** Persist spawner state into world.spawnerState (round-trippable). */
export function snapshotSpawners() {
  const out = {};
  for (const [id, live] of _spawned.entries()) {
    out[id] = live.filter((m) => (m.hp ?? 1) > 0).map((m) => m.serial);
  }
  return out;
}

/** Restore from snapshot — re-binds known serials. Skips dead mobs. */
export function restoreSpawners(world, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  for (const [id, serials] of Object.entries(snapshot)) {
    if (!Array.isArray(serials)) continue;
    const live = [];
    for (const s of serials) {
      const m = world?.mobiles?.get?.(s);
      if (m && (m.hp ?? 1) > 0) live.push(m);
    }
    _spawned.set(id, live);
  }
}

export function despawnAll(world, templateId) {
  const live = _spawned.get(templateId);
  if (!live) return 0;
  for (const m of live) world?.mobiles?.delete?.(m.serial);
  _spawned.delete(templateId);
  return live.length;
}
