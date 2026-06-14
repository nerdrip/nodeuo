// FAZA DD — peerless dungeon bosses (Mondain's Legacy / Stygian Abyss).
//
// In ServUO a peerless is a one-of-a-kind dungeon boss locked behind
// a quest-key altar. Players gather a fixed list of keys, drop them on
// the altar, and the altar teleports the party into a sealed arena
// where the boss spawns. Once the boss dies, the altar enters a
// cooldown so the same arena can't be farmed back-to-back.
//
// We ship the irreducible core: a registry of arena definitions
// (`registerArena`) + altar hooks (`tryUnlock`, `markFinished`,
// `isOnCooldown`). The actual altar tile is a lifecycle script
// (`apps/scripts/src/items/scripts/world/peerless-altar.js`) that
// forwards its onUse to this module. Spawning the boss + teleporting
// the party is handled by the script using world / templates APIs
// that are already exposed.
//
// Cooldown lives in-process. A persisted version would land in
// world.systems.peerless on save (out of scope for MVP).

import { destroyItem } from '../../world/items.js';

/** @type {Map<string, ArenaDef>} */
const arenas = new Map();

/** @type {Map<string, number>} arena name → next-available timestamp ms */
const cooldowns = new Map();

/**
 * @typedef {Object} ArenaDef
 * @property {string} name              identifier used by altar's `arenaName`
 * @property {string[]} requiredKeys    item names (matched against item.name)
 * @property {string} bossKind          monsters.json kind to spawn
 * @property {{x:number, y:number, z:number, map:number}} spawnAt
 * @property {{x:number, y:number, z:number, map:number}} teleportTo
 * @property {number} [cooldownMs]      default 60 minutes
 */

const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

/** @param {ArenaDef} def */
export function registerArena(def) {
  if (!def?.name) throw new Error('peerless arena needs a name');
  arenas.set(def.name, def);
}

/** @param {string} name */
export function getArena(name) {
  return arenas.get(name) ?? null;
}

/** @returns {string[]} */
export function listArenas() {
  return [...arenas.keys()];
}

/** Test/admin helper — wipe registry. */
export function _resetArenasForTest() {
  arenas.clear();
  cooldowns.clear();
}

/**
 * Check whether the altar is in cooldown after a recent boss death.
 * @param {string} arenaName
 * @param {number} [now]   override for tests
 * @returns {boolean}
 */
export function isOnCooldown(arenaName, now = Date.now()) {
  const until = cooldowns.get(arenaName) | 0;
  return until > now;
}

/**
 * Mark the arena as just-finished (boss dead). Caller is the boss-death
 * hook in the script that spawned the boss.
 *
 * @param {string} arenaName
 * @param {number} [now]   override for tests
 */
export function markFinished(arenaName, now = Date.now()) {
  const def = arenas.get(arenaName);
  if (!def) return;
  cooldowns.set(arenaName, now + (def.cooldownMs ?? DEFAULT_COOLDOWN_MS));
}

/**
 * Attempt to unlock an arena. Looks at items in `world.items` whose
 * `parent === altar.serial` (i.e. dropped on the altar) and validates
 * that every required key is present. On success: consumes the keys,
 * returns `{ ok: true, def }`. On failure: returns `{ ok: false, reason }`.
 *
 * @param {*} world
 * @param {*} altar          the altar item (must have `arenaName`)
 * @returns {{ok:true, def:ArenaDef}|{ok:false, reason:string}}
 */
export function tryUnlock(world, altar) {
  const def = arenas.get(altar?.arenaName);
  if (!def) return { ok: false, reason: 'no-arena-registered' };
  if (isOnCooldown(def.name)) return { ok: false, reason: 'cooldown' };
  // Walk only items parented to the altar via reverse index — typical
  // altar has ≤6 quest-key items.
  const dropped = [];
  const idx = world._childrenByParent?.get?.(altar.serial);
  if (idx) {
    for (const s of idx) {
      const it = world.items.get(s);
      if (it && it.parent === altar.serial) dropped.push(it);
    }
  } else {
    for (const it of world.items.values()) {
      if (it.parent === altar.serial) dropped.push(it);
    }
  }
  // Match each required key against a dropped item by name.
  const remaining = [...def.requiredKeys];
  const consumed = [];
  for (const it of dropped) {
    const idx = remaining.indexOf(it.name);
    if (idx >= 0) {
      remaining.splice(idx, 1);
      consumed.push(it);
    }
  }
  if (remaining.length > 0) {
    return { ok: false, reason: `missing-keys:${remaining.join(',')}` };
  }
  // Consume the keys through the lifecycle path so altar children,
  // sectors and onDestroy hooks cannot leak stale references.
  for (const it of consumed) {
    try { destroyItem(world, it.serial); }
    catch { /* already consumed */ }
  }
  return { ok: true, def };
}
