// Power Scrolls + Stat Scrolls economy. Complements skill-mods.js (which
// owns the persistence + cap math) with the gameplay primitives:
//
//   • createPowerScroll(skillId, cap)  — build a new scroll item
//   • createStatScroll(increment)      — build a new stat scroll item
//   • dropChampionScrolls(world, champ) — drop 12 scrolls (one per top
//     attacker) on a champion boss kill, mirroring ServUO's reward table
//   • registerScrollUseHandler(api)    — `[use <serial>` consumes the scroll
//
// Item shape on the wire matches ServUO's PowerScroll item: itemId 0x14F0
// (ScrollOfPower base graphic), `name = "+5 ${skillName}"` for stat scrolls,
// `+${cap} ${skillName}` for power scrolls.
//
// Scroll caps follow OSI: 105, 110, 115, 120 — value tier ratio is roughly
// 70 / 20 / 8 / 2 percent on champion drops. Stat scrolls are +5/+10/+15/
// +20/+25 with the same ratio family.

import { applySkillScroll, applyStatScroll } from '../world/skill-mods.js';

// itemId 0x14F0 is the canonical OSI PowerScroll base — all ScrollOfWisdom
// variants share the graphic. Stat scrolls reuse the same id with a
// different label.
const POWER_SCROLL_ITEM_ID = 0x14F0;
const STAT_SCROLL_ITEM_ID  = 0x14F0;

/** Skill id → display name. Used to label the scroll. */
const SKILL_NAMES = {
   1: 'Alchemy',
   2: 'Anatomy',
   3: 'Animal Lore',
   4: 'Item Identification',
   5: 'Arms Lore',
   6: 'Parrying',
   7: 'Begging',
   8: 'Blacksmithy',
   9: 'Bowcraft/Fletching',
  10: 'Peacemaking',
  11: 'Camping',
  12: 'Carpentry',
  13: 'Cartography',
  14: 'Cooking',
  15: 'Detect Hidden',
  16: 'Discordance',
  17: 'Evaluating Intelligence',
  18: 'Healing',
  19: 'Fishing',
  20: 'Forensic Evaluation',
  21: 'Herding',
  22: 'Hiding',
  23: 'Provocation',
  24: 'Inscription',
  25: 'Lockpicking',
  26: 'Magery',
  27: 'Resisting Spells',
  28: 'Tactics',
  29: 'Snooping',
  30: 'Musicianship',
  31: 'Poisoning',
  32: 'Archery',
  33: 'Spirit Speak',
  34: 'Stealing',
  35: 'Tailoring',
  36: 'Animal Taming',
  37: 'Taste Identification',
  38: 'Tinkering',
  39: 'Tracking',
  40: 'Veterinary',
  41: 'Swordsmanship',
  42: 'Mace Fighting',
  43: 'Fencing',
  44: 'Wrestling',
  45: 'Lumberjacking',
  46: 'Mining',
  47: 'Meditation',
  48: 'Stealth',
  49: 'Remove Trap',
  50: 'Necromancy',
  51: 'Focus',
  52: 'Chivalry',
  53: 'Bushido',
  54: 'Ninjitsu',
  55: 'Spellweaving',
  56: 'Mysticism',
  57: 'Imbuing',
  58: 'Throwing',
};

const SCROLL_CAPS_TIER = [
  { cap: 105, weight: 70 },
  { cap: 110, weight: 20 },
  { cap: 115, weight:  8 },
  { cap: 120, weight:  2 },
];
const STAT_INCS_TIER = [
  { inc:  5, weight: 70 },
  { inc: 10, weight: 20 },
  { inc: 15, weight:  8 },
  { inc: 20, weight:  2 },
];

function pickWeighted(table, rng) {
  const total = table.reduce((s, t) => s + t.weight, 0);
  let r = rng() * total;
  for (const t of table) {
    r -= t.weight;
    if (r <= 0) return t;
  }
  return table[0];
}

/**
 * Build a power-scroll Item descriptor (NOT yet placed in the world).
 * Caller passes to api.world.createItem() / api.items.placeAt().
 */
export function createPowerScroll(skillId, cap, hue = 0x0481) {
  if (![105, 110, 115, 120].includes(cap)) throw new Error(`invalid scroll cap: ${cap}`);
  const skillName = SKILL_NAMES[skillId] ?? `Skill #${skillId}`;
  return {
    itemId: POWER_SCROLL_ITEM_ID,
    name: `${cap === 120 ? 'Legendary' : 'Greater'} Scroll of ${skillName} (${cap})`,
    hue,
    weight: 1,
    powerScroll: { skillId, cap },
  };
}

/** Build a stat-scroll Item descriptor. */
export function createStatScroll(increment, hue = 0x0480) {
  if (![5, 10, 15, 20, 25].includes(increment)) throw new Error(`invalid stat increment: ${increment}`);
  return {
    itemId: STAT_SCROLL_ITEM_ID,
    name: `Stat Increase Scroll (+${increment})`,
    hue,
    weight: 1,
    statScroll: { increment },
  };
}

/**
 * Roll a scroll for a champion drop. Mix: ~85% power-scroll, ~15% stat
 * scroll. Skill picked from `eligibleSkills` (champion-specific table —
 * Mage Lord drops Magery / Resisting Spells / Eval Int, etc.).
 */
export function rollChampionScroll(eligibleSkills, rng = Math.random) {
  if (rng() < 0.85 && eligibleSkills.length > 0) {
    const sk = eligibleSkills[Math.floor(rng() * eligibleSkills.length)];
    const tier = pickWeighted(SCROLL_CAPS_TIER, rng);
    return createPowerScroll(sk, tier.cap);
  }
  const tier = pickWeighted(STAT_INCS_TIER, rng);
  return createStatScroll(tier.inc);
}

/**
 * Default eligible-skill table per champion type. Server-content can
 * override by calling `setChampionScrollTable(name, skills[])`.
 */
const CHAMPION_SCROLL_TABLES = {
  abyss:           [26, 27, 17, 50, 52],       // Magery, Resist, EvalInt, Necro, Chiv
  vermin:          [28, 41, 42, 43, 6, 44],    // Tactics, Sword, Mace, Fence, Parry, Wrestle
  forestlord:      [3, 36, 21, 50, 45, 46],    // AnimalLore, Taming, Herd, Necro, Lumberjack, Mine
  pestilence:      [26, 50, 31, 49, 18, 40],   // Magery, Necro, Poisoning, RemoveTrap, Healing, Vet
  coldblood:       [28, 41, 32, 6, 42, 44],    // Tactics, Sword, Archery, Parry, Mace, Wrestle
  glade:           [26, 17, 30, 10, 23, 16],   // Magery, EvalInt, Music, Peace, Provoke, Discord
  rikktor:         [28, 41, 32, 42, 44, 43],   // Tactics, Sword, Archery, Mace, Wrestle, Fence
};
const CHAMPION_SCROLL_OVERRIDE = new Map();

export function setChampionScrollTable(name, skills) {
  CHAMPION_SCROLL_OVERRIDE.set(name, skills);
}
export function eligibleScrollSkills(championKind) {
  return CHAMPION_SCROLL_OVERRIDE.get(championKind)
      ?? CHAMPION_SCROLL_TABLES[championKind]
      ?? Object.keys(SKILL_NAMES).map(Number);
}

/**
 * Drop N power-scrolls at the champion's death tile, one per top
 * attacker. Caller provides `topAttackers` (already sorted desc by damage)
 * and the world ref.
 *
 * Returns an array of newly-spawned scroll item refs.
 */
export function dropChampionScrolls(world, champ, topAttackers = [], opts = {}) {
  const kind = opts.kind ?? champ?.kind ?? 'abyss';
  const eligible = eligibleScrollSkills(kind);
  const count = Math.min(topAttackers.length || 12, opts.count ?? 12);
  const out = [];
  for (let i = 0; i < count; i++) {
    const desc = rollChampionScroll(eligible, opts.rng ?? Math.random);
    const it = world.createItem({
      ...desc,
      x: champ.x + ((i % 4) - 2),
      y: champ.y + (Math.floor(i / 4) - 1),
      z: champ.z,
      map: champ.map,
    });
    out.push(it);
  }
  return out;
}

/**
 * Consume a scroll on `mob`. Looks at item.powerScroll / item.statScroll
 * and applies via skill-mods. Returns true if the scroll was actually
 * consumed (cap rose / stat cap rose). Caller should remove the item.
 */
export function consumeScroll(mob, item) {
  // ServUO PowerScroll.OnDoubleClick — a scroll already consumed is a
  // blank artifact and refuses further use. Also: a scroll's cap upgrade
  // is permanent per-character; the scroll itself is removed by the
  // caller after consume(). We flag `_consumed = true` so a player who
  // somehow recovered the item (loot from a trade window cancel after
  // an oddly-timed save) can't double-apply it.
  if (item?._consumed) return false;
  if (item?.powerScroll) {
    const ok = applySkillScroll(mob, item.powerScroll.skillId, item.powerScroll.cap);
    if (ok) item._consumed = true;
    return ok;
  }
  if (item?.statScroll) {
    const ok = applyStatScroll(mob, item.statScroll.increment);
    if (ok) item._consumed = true;
    return ok;
  }
  return false;
}

/**
 * ServUO PowerScroll.OnDragLift — a power-scroll is **bound to its
 * dropper** for the first 30 s after a champion drop (so the killer's
 * party-mates can't snipe it from the ground). After the window
 * elapses anyone can pick it up.
 *
 * Returns true when `mob` is allowed to lift this scroll right now.
 */
export function canLiftScroll(item, mob) {
  if (!item?.powerScroll && !item?.statScroll) return true;
  const owner = item._lootOwnerSerial >>> 0;
  if (!owner) return true;
  if (owner === mob.serial) return true;
  const lockUntil = item._lootLockUntil ?? 0;
  if (lockUntil && Date.now() < lockUntil) return false;
  return true;
}

export const POWER_SCROLL_ITEM = POWER_SCROLL_ITEM_ID;
