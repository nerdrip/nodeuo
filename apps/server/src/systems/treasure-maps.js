// Treasure Map system. Mirrors ServUO `TreasureMap.cs` + `TreasureMapChest.cs`:
//
//   1. Decoded map item (graphic 0x14EB / 0x14EC) with level 1..6 and
//      a target (x,y,facet) where the chest spawns.
//   2. Player double-clicks → if Cartography skill ≥ requirement, marks
//      the map as decoded and shows the location.
//   3. Player digs at the marked tile → spawns a TreasureMapChest with
//      level-appropriate loot tier and 3-5 monster guardians.
//   4. Chest is locked + trapped (Magic Lock + level-scaled Magic Trap),
//      remove-trap + lockpicking gates open.
//
// We expose:
//   • createTreasureMap({ level, x, y, map })  — encoded (un-decoded)
//   • decodeTreasureMap(mob, mapItem)           — returns true if Cartography passes
//   • digForTreasure(mob, mapItem)              — runs the dig sequence
//   • spawnTreasureChest(world, level, x, y, map) — builds chest + spawns
//
// Loot tier per level (gold + items + slim chance of artifact):
//   L1: 100-300g   3 magic items
//   L2: 200-500g   4 magic items + reagents
//   L3: 400-800g   6 magic items + 1 gem
//   L4: 600-1200g  8 magic items + 2 gems + tinker tools
//   L5: 1000-1800g 10 magic items + 3 gems + 5% artifact chance
//   L6: 2000-3000g 12 magic items + 5 gems + 15% artifact (Doom-tier)

import { rollChampionScroll } from './power-scrolls.js';

const SKILL_CARTOGRAPHY = 13;
const SKILL_LOCKPICKING = 25;
const SKILL_REMOVE_TRAP = 49;

// Server parity #8 #6 — added level 7 (Stygian "Trove"). ServUO `Trove`
// drops Stygian artifacts + Crystalline Ring; decode needs 105 Carto.
const LEVEL_GOLD = [
  null,
  { lo: 100,  hi: 300  },
  { lo: 200,  hi: 500  },
  { lo: 400,  hi: 800  },
  { lo: 600,  hi: 1200 },
  { lo: 1000, hi: 1800 },
  { lo: 2000, hi: 3000 },
  { lo: 4000, hi: 6000 },     // Trove
];

const LEVEL_REQ_CARTO = [null, 24, 50, 70, 80, 90, 100, 105];

const LEVEL_LOCKPICK_DIFF = [null, 36, 76, 84, 92, 100, 108, 115];
const LEVEL_TRAP_DIFF     = [null, 50, 70, 80, 90, 100, 108, 115];

/** Build a (still-encoded) treasure map item. */
export function createTreasureMap({ level = 1, x, y, map = 1 } = {}) {
  const lvl = Math.max(1, Math.min(7, level | 0));
  return {
    itemId: 0x14EB,                  // OSI 'tattered' map graphic
    name: `Tattered Treasure Map (level ${lvl})`,
    hue: 0,
    weight: 1,
    treasureMap: {
      level: lvl,
      x: x | 0, y: y | 0, map: map | 0,
      decoded: false,
      completed: false,
    },
  };
}

/**
 * Try to decode the map. Returns true on success, false if Cartography is
 * too low. Caller should re-broadcast the item label so the client can
 * update the tooltip ("Decoded — see x,y").
 */
export function decodeTreasureMap(mob, item, deps = {}) {
  const tm = item?.treasureMap;
  if (!tm || tm.decoded) return tm?.decoded === true;
  const skill = deps.effectiveSkill?.(mob, SKILL_CARTOGRAPHY) ?? 0;
  const req   = LEVEL_REQ_CARTO[tm.level] ?? 100;
  if (skill < req) return false;
  tm.decoded = true;
  item.itemId = 0x14EC;          // OSI 'parchment' map graphic
  item.name   = `Decoded Treasure Map (level ${tm.level}) — ${tm.x},${tm.y}`;
  return true;
}

/**
 * Try to dig at the marked tile. Returns {ok, reason}. On success, the
 * caller spawns the chest (use `spawnTreasureChest`). The dig consumes
 * the map.
 */
export function digForTreasure(mob, item) {
  const tm = item?.treasureMap;
  if (!tm)      return { ok: false, reason: 'not-a-map' };
  if (!tm.decoded) return { ok: false, reason: 'not-decoded' };
  if (tm.completed) return { ok: false, reason: 'already-dug' };
  // Range check — must dig within 2 tiles of the marker.
  const dx = Math.abs((mob.x | 0) - tm.x);
  const dy = Math.abs((mob.y | 0) - tm.y);
  if (Math.max(dx, dy) > 2) return { ok: false, reason: 'wrong-spot' };
  if (mob.map !== tm.map)   return { ok: false, reason: 'wrong-map' };
  tm.completed = true;
  return { ok: true, level: tm.level, x: tm.x, y: tm.y, map: tm.map };
}

/**
 * Spawn a treasure chest at the dig location with level-scaled loot.
 * Returns { chest, guardians } so the caller can broadcast.
 *
 * Caller must provide `world.createItem`, `world.createMobile`, and
 * `loot` registry to roll items. Spawns 3-5 guardians: monsters
 * pulled from `kindsByLevel[level]`.
 */
export function spawnTreasureChest(world, level, x, y, map, deps = {}) {
  // Audit #36 P1 #6 — bump clamp to 7. ServUO `TreasureMap.cs` supports
  // 7 levels including Trove (Stygian Abyss artifact pool). Was clamped
  // at 6 — cartography lvl-7 maps from #34 silently demoted to 6.
  const lvl = Math.max(1, Math.min(7, level | 0));
  const goldRange = LEVEL_GOLD[lvl];
  let goldAmount = goldRange.lo + Math.floor(Math.random() * (goldRange.hi - goldRange.lo + 1));
  // Treasure Hunter's Satchel — `treasureBonus` field on a worn
  // satchel grants % bonus to gold + magic count. Caller passes the
  // bonus via `deps.treasureBonus` (0..0.5). Bug-hunt #4 NEW.
  const bonus = Math.max(0, Math.min(0.5, deps.treasureBonus ?? 0));
  if (bonus > 0) goldAmount = Math.floor(goldAmount * (1 + bonus));

  // Audit #33 P1 #3 — trap shape `{damage, level, kind}` matches both
  // the lifecycle script at `items/scripts/world/treasure-chest.js` and
  // the `[disarm` reader. Previously we stamped a scalar `trapped:true`
  // plus `trapDamage` / `trapDifficulty` at top-level; the consumers
  // read `item.trapped.damage * item.trapped.level` and ended up with
  // `0 * 0` — every chest opened without damage and `[disarm` always
  // succeeded for free (level 0 difficulty).
  const chest = world.createItem({
    itemId: 0x09A8,                     // OSI metal chest graphic
    name: `treasure chest (level ${lvl})`,
    container: true,
    locked: true,
    lockpickDifficulty: LEVEL_LOCKPICK_DIFF[lvl],
    trapped: { kind: 'explosion', damage: 5 * lvl, level: lvl,
               difficulty: LEVEL_TRAP_DIFF[lvl] },
    x, y, z: 0, map,
    treasureChestLevel: lvl,
    contents: [],
  });

  // Gold pile inside the chest.
  if (chest.contents) {
    chest.contents.push({
      itemId: 0x0EED, name: 'Gold',
      stackable: true, amount: goldAmount,
    });
  }

  // Magic items — caller passes loot.rollMagicProperties + an item base
  // pool. We use a simple table of weapon/armor base ids per level.
  const magicCount = 2 + lvl + (bonus > 0 ? 1 : 0);    // +1 magic per satchel bonus
  const ITEM_BASES = [0x1B72, 0x1B73, 0x1B74, 0x13B5, 0x13B6, 0x13B7, 0x13F8];
  const rollMagic = deps.rollMagicProperties ?? (() => ({}));
  for (let i = 0; i < magicCount; i++) {
    const base = ITEM_BASES[Math.floor(Math.random() * ITEM_BASES.length)];
    const props = rollMagic({ tier: lvl });
    if (chest.contents) chest.contents.push({ itemId: base, name: 'magic item', ...props });
  }

  // Top-tier scroll chance (L5/L6 only).
  if (lvl >= 5 && Math.random() < (lvl === 6 ? 0.25 : 0.10)) {
    const eligible = [29, 17, 30, 33, 51, 44];
    if (chest.contents) chest.contents.push(rollChampionScroll(eligible));
  }

  // Spawn 3-5 guardians per level.
  const guardCount = 2 + Math.floor(Math.random() * 3);
  const monsterKinds = deps.kindsByLevel?.[lvl] ?? ['skeleton', 'orc', 'troll'];
  const guardians = [];
  for (let i = 0; i < guardCount; i++) {
    const kind = monsterKinds[Math.floor(Math.random() * monsterKinds.length)];
    if (typeof world.createMobileFromKind !== 'function') break;
    const guardian = world.createMobileFromKind?.(kind, {
      x: x + ((i % 3) - 1), y: y + (Math.floor(i / 3) - 1), z: 0, map,
    });
    if (guardian) guardians.push(guardian);
  }

  return { chest, guardians };
}

export const TREASURE_MAP_CONST = Object.freeze({
  LEVEL_REQ_CARTO,
  LEVEL_GOLD,
  LEVEL_LOCKPICK_DIFF,
  LEVEL_TRAP_DIFF,
  SKILL_CARTOGRAPHY, SKILL_LOCKPICKING, SKILL_REMOVE_TRAP,
});
