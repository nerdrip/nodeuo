// FAZA CB — shared NPC spawn helper.
//
// Centralises the "create mobile + apply default clothing + broadcast
// mobileIncoming" pipeline that every NPC-spawning script needs. Before
// this file:
//
//   - Bankers and Trainers were spawned but NEVER broadcast — invisible
//     until the player walked away and back (BUGFIX #44).
//   - Different NPCs had subtly different broadcast loops; some
//     forgot to send equipment, some forgot to filter by map.
//   - NPCs spawned naked (BUGFIX #44 again — the user complaint
//     "npc powinny mieć jakieś ubrania po zrobieniu").
//
// Now every NPC goes through `spawnNPC(api, sender, opts)` and looks the
// part on day one.

import { applyOutfit } from '../../items/behaviors/clothing-presets.js';
import { equipped } from '../../_inventory.js';
import { allMobiles } from '../../_spatial.js';
import { createMobile } from '../../_mobiles.js';

/** Heuristic: an article-prefixed name like "a banker" / "an alchemist"
 *  is generic — replace it with a personal name from the pool. Anything
 *  else (caller passed "Lord British" or "Hawkins") wins as-is. */
function looksGeneric(name) {
  if (!name) return true;
  const lower = name.toLowerCase();
  return lower.startsWith('a ') || lower.startsWith('an ') || lower.startsWith('the ');
}

/**
 * Default outfit per kind. Wardrobe presets live in
 * apps/scripts/src/items/clothing-presets.js — we reference them by name
 * so a balance pass on the preset table propagates to every NPC.
 */
const KIND_OUTFIT = {
  banker:  'noble',
  trainer: 'mage',
  healer:  'mage',
  vendor:  'noble',
  guard:   'warrior',
  crier:   'peasant',
};

/**
 * @param {import('@uo/server/src/scripts.js').ScriptAPI} api
 * @param {*} sender    the GM/player whose feet we spawn at (used for x/y/z/map)
 * @param {Object} opts
 * @param {string}  opts.name
 * @param {number}  opts.body
 * @param {number}  [opts.hue]
 * @param {number}  [opts.notoriety]   default 7 (Invulnerable yellow)
 * @param {boolean} [opts.invulnerable]   default true
 * @param {string}  [opts.kind]        for default-outfit lookup
 * @param {string}  [opts.outfit]      preset name override (peasant|warrior|mage|noble|bandit|pirate)
 * @param {string[]} [opts.keywords]   speech-listen keywords; sets _listensToSpeech
 * @param {string}  [opts.behavior]    AI behavior name to attach via api.ai.attach
 * @param {Object}  [opts.fields]      extra fields to copy onto the mob (teaches, vendorKind, etc.)
 * @returns {*}                        the freshly-spawned mob
 */
export function spawnNPC(api, sender, opts) {
  const world = api.world;
  // Personal name: if the caller passed a generic article-name
  // ("a banker") or omitted name entirely, pick from the human pool.
  // Named callers (regional NPCs, Lord British, quest-givers) win.
  let displayName = opts.name;
  if (looksGeneric(displayName)) {
    const picked = api.names?.pickForMob?.({ body: opts.body });
    if (picked) displayName = picked;
  }
  const mob = createMobile(api, world, {
    name: displayName,
    body: opts.body,
    hue: opts.hue ?? 0,
    x: sender.x, y: sender.y, z: sender.z,
    map: sender.map ?? 1,
    notoriety: opts.notoriety ?? 7,
    invulnerable: opts.invulnerable ?? true,
    direction: sender.direction ?? 0,
    hp: opts.hp ?? 100, hpMax: opts.hpMax ?? opts.hp ?? 100,
  });

  // Copy any extra runtime fields (teaches, vendorKind, _profileBody, etc.)
  if (opts.fields) {
    for (const [k, v] of Object.entries(opts.fields)) mob[k] = v;
  }

  // Speech-listen flag + keywords. Without `_listensToSpeech` the speech
  // dispatcher in handlers.js drops chat before the AI sees it (FAZA AY
  // bugfix #15), so AI behaviours never get to react.
  if (opts.keywords && opts.keywords.length) {
    mob._listensToSpeech = true;
    mob._speechKeywords = opts.keywords;
  }

  // Default outfit. Skips silently when no preset is registered yet
  // (cold boot before items.json loaded).
  const presetName = opts.outfit ?? KIND_OUTFIT[opts.kind] ?? 'peasant';
  if (api.templates && presetName) {
    try {
      // Build the per-piece list inline so we don't pull the full
      // CREATOR_PRESETS table; this keeps the spawn helper self-contained.
      // We call applyOutfit which handles the layered equip + broadcast
      // of equipUpdate per piece.
      const preset = OUTFIT_TABLE[presetName] ?? OUTFIT_TABLE.peasant;
      applyOutfit(api, world, mob, preset);
      // Fire onCreate for any scripted clothing piece.
      for (const it of equipped(api, mob)) {
        api.itemScripts?.dispatch?.(world, it, 'onCreate');
      }
    } catch (e) {
      api.log?.(`spawn: outfit ${presetName} failed: ${e.message}`);
    }
  }

  // Attach AI.
  if (opts.behavior && api.ai) {
    try { api.ai.attach(mob, opts.behavior); }
    catch (e) { api.log?.(`spawn: attach ${opts.behavior} failed: ${e.message}`); }
  }

  // Broadcast — every nearby client must see the mob (with equipment) or
  // the NPC is invisible until they walk away and back.
  if (api.protocol?.mobileIncoming) {
    const equipment = [];
    for (const it of equipped(api, mob)) {
      equipment.push({
        serial: it.serial, itemId: it.itemId,
        layer: it.layer, hue: it.hue ?? 0,
      });
    }
    const incoming = api.protocol.mobileIncoming({
      serial: mob.serial, body: mob.body,
      x: mob.x, y: mob.y, z: mob.z,
      direction: mob.direction ?? 0, hue: mob.hue ?? 0,
      flags: mob.flags ?? 0, notoriety: mob.notoriety ?? 1,
      equipment,
    });
    // BUGFIX #65 (FAZA CW): the previous loop filtered by map only —
    // missing the canon UO 18-tile visibility radius. An NPC spawned
    // in Britain would emit a mobileIncoming to every player on the
    // SAME facet regardless of distance. Add the radius check.
    for (const other of allMobiles({ world })) {
      if (!other.client) continue;
      if (other.map !== mob.map) continue;
      if (Math.abs(other.x - mob.x) > 18 || Math.abs(other.y - mob.y) > 18) continue;
      other.client.send(incoming);
    }
  }

  return mob;
}

/**
 * Outfit catalogue mirrors `apps/scripts/src/items/clothing-presets.js`.
 * Inlined here to avoid a circular import between npcs/_spawn.js and
 * items/clothing-presets.js (which imports from server packages).
 */
const OUTFIT_TABLE = {
  peasant: [
    { template: 'shirt',      layer:  5, hue: 904 },
    { template: 'long-pants', layer:  4, hue: 954 },
    { template: 'sandals',    layer:  3, hue: 1107 },
  ],
  warrior: [
    { template: 'leather-tunic',    layer: 13 },
    { template: 'leather-leggings', layer: 24 },
    { template: 'leather-cap',      layer:  6 },
    { template: 'boots',            layer:  3 },
    { template: 'cloak',            layer: 20, hue: 0x21 },
  ],
  mage: [
    { template: 'fancy-shirt', layer:  5, hue: 1109 },
    { template: 'long-pants',  layer:  4, hue:   38 },
    { template: 'robe',        layer: 22, hue:   38 },
    { template: 'wizard-hat',  layer:  6, hue:   38 },
    { template: 'shoes',       layer:  3, hue:   68 },
  ],
  noble: [
    { template: 'doublet',       layer:  5, hue:   68 },
    { template: 'long-pants',    layer:  4, hue: 1175 },
    { template: 'shoes',         layer:  3, hue:   68 },
    { template: 'cloak',         layer: 20, hue: 1175 },
    { template: 'feathered-hat', layer:  6 },
  ],
  bandit: [
    { template: 'shirt',       layer:  5, hue: 37 },
    { template: 'short-pants', layer:  4, hue: 38 },
    { template: 'bandana',     layer:  6, hue: 37 },
    { template: 'boots',       layer:  3 },
    { template: 'body-sash',   layer: 12, hue: 37 },
  ],
};

export const _OUTFIT_TABLE_FOR_TEST = OUTFIT_TABLE;
