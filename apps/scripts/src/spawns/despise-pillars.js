// Despise — Good / Evil alignment buffs + Despise champion encounter.
//
// SOURCE OF TRUTH lives in `data/world/spawns/despise-pillars.json`
// (pillar coords + per-alignment aura effects + pulse cadence). Edit
// the JSON to add a pillar or tweak the aura buff.
//
// Mechanic: each pillar pulses every `pulseMs` and applies its `effects`
// to every nearby aligned player (`mob._despiseAlignment === alignment`).
// Wired by `items/scripts/world/simple-items.js > despise-ankh` which
// sets the alignment flag on touch.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { allItems, allMobiles, nearbyClients } from '../_spatial.js';
import { canCreateItem, createItem, destroyItemBySerial } from '../_items.js';
import { registerWorldContentSeed } from '../_world-content.js';
import { itemBySerial } from '../_entities.js';
const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../data/world/spawns/despise-pillars.json');

let CONFIG = { pulseMs: 5000, auraRadius: 6, pillars: [] };
try { CONFIG = JSON.parse(fs.readFileSync(DATA, 'utf8')); }
catch (e) { console.warn('[despise-pillars] load failed:', e.message); }

let _interval = null;
/** @type {Array<{def:any, item:any}>} */
const _placed = [];

function placePillar(api, def) {
  if (!canCreateItem(api, api.world)) return null;
  try {
    const item = createItem(api, api.world, {
      itemId: 0x0E14,                  // Tall stone pillar
      x: def.x, y: def.y, z: def.z, map: def.map,
      name: def.name, hue: def.hue, movable: false,
    });
    if (item) {
      item[def.tag] = true;
      item._worldContentSeed = 'despise-pillars';
    }
    return item;
  } catch (e) {
    api.log?.(`[despise] pillar place failed: ${e.message}`);
    return null;
  }
}

function pulseAura(api, pillar, def) {
  if (!pillar) return;
  const r2 = CONFIG.auraRadius * CONFIG.auraRadius;
  for (const m of allMobiles(api)) {
    if (!m.client) continue;
    if (m.map !== pillar.map) continue;
    const dx = m.x - pillar.x;
    const dy = m.y - pillar.y;
    if (dx * dx + dy * dy > r2) continue;
    if (m._despiseAlignment !== def.alignment) continue;
    for (const eff of def.effects) {
      const built = { ...eff, durationMs: CONFIG.pulseMs + (eff.durationMsAddPulse ?? 0) };
      delete built.durationMsAddPulse;
      try { api.statusEffects?.apply?.(m, built); }
      catch { /* status effects optional */ }
    }
  }
  // Visual pulse
  const pkt = api.protocol?.graphicalEffect?.({
    kind: 0x03,
    from: pillar.serial, to: pillar.serial,
    itemId: 0x373A,
    fromX: pillar.x, fromY: pillar.y, fromZ: pillar.z,
    toX:   pillar.x, toY:   pillar.y, toZ:   pillar.z,
    speed: 10, duration: 15, hue: pillar.hue, blendMode: 0,
  });
  if (pkt) for (const c of nearbyClients(api.world, pillar)) c.client.send(pkt);
}

export default function register(api) {
  if (!api.world || !api.items) return () => {};
  const applyPillars = (opts = {}) => {
    const facets = opts.facets ? new Set(opts.facets) : null;
    if (!facets) _placed.length = 0;
    let added = 0; let failed = 0;
    for (const def of CONFIG.pillars) {
      if (facets && !facets.has(def.map)) continue;
      let item = [...allItems(api)].find((candidate) =>
        (candidate[def.tag] || candidate.name === def.name) &&
        candidate.map === def.map && candidate.x === def.x &&
        candidate.y === def.y && candidate.z === def.z);
      if (!item) {
        item = placePillar(api, def);
        if (item) added++;
        else failed++;
      } else {
        item[def.tag] = true;
        item._worldContentSeed = 'despise-pillars';
      }
      if (item && !_placed.some((row) => row.def.tag === def.tag)) _placed.push({ def, item });
    }
    return { added, failed };
  };
  const removePillars = (opts = {}) => {
    const facets = opts.facets ? new Set(opts.facets) : null;
    const serials = new Set();
    for (const item of allItems(api)) {
      const canonical = CONFIG.pillars.some((def) =>
        (item[def.tag] || item.name === def.name) && item.map === def.map &&
        item.x === def.x && item.y === def.y && item.z === def.z &&
        (!facets || facets.has(def.map)));
      if ((item._worldContentSeed === 'despise-pillars' && (!facets || facets.has(item.map))) || canonical) {
        serials.add(item.serial >>> 0);
      }
    }
    for (const { item } of _placed) {
      if (!facets || facets.has(item.map)) serials.add(item.serial >>> 0);
    }
    let removed = 0;
    for (const serial of serials) {
      try { if (itemBySerial(api, serial)) { destroyItemBySerial(api, serial); removed++; } }
      catch (error) { api.log?.(`[despise] pillar remove failed: ${error.message}`); }
    }
    if (facets) {
      for (let i = _placed.length - 1; i >= 0; i--) {
        if (facets.has(_placed[i].item.map)) _placed.splice(i, 1);
      }
    } else _placed.length = 0;
    return { removed };
  };
  const unregisterSeed = registerWorldContentSeed(api, 'despise-pillars', {
    apply: applyPillars,
    remove: removePillars,
  });

  // Defer populated-world restoration until the item store is ready. A clean
  // shard keeps the seed registered without placing physical objects.
  const defer = api.lifecycle?.setImmediate ?? setImmediate;
  if (api.world._createWorldDone !== false) defer(applyPillars);

  _interval = api.lifecycle?.setInterval?.(() => {
    for (const { def, item } of _placed) pulseAura(api, item, def);
  }, CONFIG.pulseMs) ?? setInterval(() => {
    for (const { def, item } of _placed) pulseAura(api, item, def);
  }, CONFIG.pulseMs);
  _interval.unref?.();

  return () => {
    unregisterSeed();
    if (!api.lifecycle && _interval) clearInterval(_interval);
    _interval = null;
    _placed.length = 0;
  };
}
