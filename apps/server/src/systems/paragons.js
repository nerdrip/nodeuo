// PHASE CY — paragon mob templates.
//
// ServUO's `BaseCreature.IsParagon` flag (Mondain's Legacy) tags ~5% of
// natural spawns as elite "paragon" variants:
//   - 4× HP / 2× str / 2× damage
//   - bright orange hue (0x501)
//   - "a paragon …" name prefix
//   - bonus loot drop (separate paragon chest, ~25 % more gold)
//
// Tameable creatures don't paragon-spawn (they aren't worth taming
// at boss tier, and the pet would inherit the orange hue forever).
// Champion bosses + ML peerless aren't double-buffed (they're already
// elite); we filter by `cfg.boss` flag.
//
// Persistence: `mob.paragon` is in MOBILE_EXT_KEYS so the flag round-
// trips through the JSON snapshot — server restart keeps the buff.

import { normalizeSkillValue } from '../combat-formulas.js';

const PARAGON_HUE = 0x0501;        // bright orange (ServUO `Paragon.Hue`)
const PARAGON_NAME_PREFIX = 'a paragon ';
// Audit #43 P2-2 — ServUO `Services/Paragon.cs:32-40` scalars: HP×5,
// Str×1.05, Dex×1.20, Int×1.20, all skills×1.20, speed/1.20, Fame×1.40,
// Karma×1.40, Damage+5 (additive), Mana/Stam refilled. Was: HP×4 (too
// low) + Str×2 (wildly OP) + nothing else.
const HP_MULT = 5;
const STR_MULT = 1.05;
const DEX_MULT = 1.20;
const INT_MULT = 1.20;
const SKILL_MULT = 1.20;
const FAME_MULT = 1.40;
const KARMA_MULT = 1.40;
const DAMAGE_BONUS_ADD = 5;
const DEFAULT_CHANCE = 0.05;       // 5% (fallback when fame unknown)
// Audit #31 P2 #6 — ServUO `Services/Paragon.cs:11` `Maps = { Map.Ilshenar }`.
// Paragons spawn ONLY on Ilshenar (map 2). Earlier impl rolled on every
// facet — a Felucca dragon could paragonize, off-spec.
const ILSHENAR_MAP = 2;

/**
 * Roll the paragon dice and tag `mob` if it lands. No-op for tame /
 * boss / already-paragon creatures. Mutates the mob in place; caller
 * must broadcast the resulting body/hue if relevant.
 *
 * @param {*} mob
 * @param {*} cfg     monster registry config
 * @param {{chance?:number, force?:boolean}} [opts]
 * @returns {boolean} true when the mob was upgraded
 */
export function maybeParagon(mob, cfg, opts = {}) {
  if (!mob) return false;
  if (mob.paragon) return false;                 // already
  if (cfg?.tameable) return false;
  if (cfg?.boss) return false;
  if (mob.controlMaster) return false;           // tamed pets never paragon
  // Audit #31 P2 #6 — Ilshenar-only map gate.
  if (!opts.force && (mob.map | 0) !== ILSHENAR_MAP) return false;
  if (!opts.force) {
    // ServUO formula: `chance = 1 / round(20 - fame/3200)`. High-fame
    // critters (Balron @ 22500) → 1/13. Low-fame fauna (Cow) → 1/20.
    // Falls back to the flat 5 % when no fame is configured.
    const fame = Math.min(32000, (cfg?.fame ?? mob.fame ?? 0) | 0);
    const denom = Math.max(1, Math.round(20 - fame / 3200));
    const chance = fame > 0 ? 1 / denom : (opts.chance ?? DEFAULT_CHANCE);
    if (Math.random() >= chance) return false;
  }
  paragonize(mob);
  return true;
}

/** Force-tag a mob as paragon (used by admin command + tests). */
export function paragonize(mob) {
  if (!mob) return;
  mob.paragon = true;
  // Save the original name so [info / persistence / lore lookups can
  // recover it cleanly if the player wants to "un-paragon" later.
  if (mob._origName == null) mob._origName = mob.name ?? '';
  if (mob._origHue == null) mob._origHue = mob.hue ?? 0;
  // Apply stat multipliers — keep it idempotent by reading from the
  // saved originals when present.
  const baseHp  = mob._origHpMax ??= mob.hpMax | 0;
  const baseStr = mob._origStr   ??= mob.str | 0;
  const baseDex = mob._origDex   ??= mob.dex | 0;
  const baseInt = mob._origInt   ??= mob.int | 0;
  const baseFame  = mob._origFame  ??= (mob.fame | 0);
  const baseKarma = mob._origKarma ??= (mob.karma | 0);
  mob.hpMax = Math.max(1, Math.floor(baseHp * HP_MULT));
  mob.hp = mob.hpMax;
  mob.str = Math.max(1, Math.floor(baseStr * STR_MULT));
  mob.dex = Math.max(1, Math.floor(baseDex * DEX_MULT));
  mob.int = Math.max(1, Math.floor(baseInt * INT_MULT));
  mob.fame  = Math.min(32000, Math.floor(baseFame  * FAME_MULT));
  mob.karma = Math.max(-32000, Math.min(32000, Math.floor(baseKarma * KARMA_MULT)));
  // Skills ×1.20 — snapshot originals into _origSkills so unparagonize
  // can restore. Only scale the values that exist.
  if (mob.skills && !mob._origSkills) {
    mob._origSkills = Object.create(null);
    for (const k of Object.keys(mob.skills)) {
      mob._origSkills[k] = mob.skills[k];
      mob.skills[k] = Math.floor(normalizeSkillValue(mob.skills[k]) * SKILL_MULT);
    }
  }
  // Damage bonus — additive in ServUO. Combat-formulas reads
  // `mob._paragonDmgBonus` and adds it to weapon damage roll.
  mob._paragonDmgBonus = DAMAGE_BONUS_ADD;
  // Refill mana / stam to max so the paragon casts immediately.
  mob.mana = mob.manaMax ?? mob.mana ?? 0;
  mob.stam = mob.stamMax ?? mob.stam ?? 0;
  mob.hue = PARAGON_HUE;
  if (!String(mob.name ?? '').startsWith(PARAGON_NAME_PREFIX.trim())) {
    mob.name = PARAGON_NAME_PREFIX + (mob._origName || 'creature');
  }
}

/** Reverse a paragonize (used when admin commands strip the flag). */
export function unparagonize(mob) {
  if (!mob?.paragon) return;
  mob.paragon = false;
  if (mob._origHue != null) { mob.hue = mob._origHue; delete mob._origHue; }
  if (mob._origName != null) { mob.name = mob._origName; delete mob._origName; }
  if (mob._origHpMax != null) { mob.hpMax = mob._origHpMax; mob.hp = mob.hpMax; delete mob._origHpMax; }
  if (mob._origStr != null) { mob.str = mob._origStr; delete mob._origStr; }
  if (mob._origDex != null) { mob.dex = mob._origDex; delete mob._origDex; }
  if (mob._origInt != null) { mob.int = mob._origInt; delete mob._origInt; }
  if (mob._origFame  != null) { mob.fame  = mob._origFame;  delete mob._origFame; }
  if (mob._origKarma != null) { mob.karma = mob._origKarma; delete mob._origKarma; }
  if (mob._origSkills) {
    for (const k of Object.keys(mob._origSkills)) mob.skills[k] = mob._origSkills[k];
    delete mob._origSkills;
  }
  mob._paragonDmgBonus = 0;
}

/**
 * Loot multiplier — corpse.dropLoot can read this to scale gold/items
 * on a paragon kill. Default 1.5× gold pile.
 */
export function paragonLootMultiplier(mob) {
  return mob?.paragon ? 1.5 : 1.0;
}

/**
 * BUGFIX #70 — broadcast a hue/name change after retroactive paragonize.
 * `paragonize` on a freshly-spawned mob is fine (the spawn caller emits
 * the first 0x78 mobileIncoming with the new hue), but [paragon admin
 * toggle and any late upgrade leaves observers with the old hue/name
 * until the next mob movement. Re-broadcast 0x78 mobileIncoming so the
 * change is visible immediately.
 *
 * @param {*} api    script API (needs api.protocol.mobileIncoming)
 * @param {*} world  world handle
 * @param {*} mob    the mobile that was just (un)paragoned
 */
export function broadcastParagonChange(api, world, mob) {
  if (!mob || !api?.protocol?.mobileIncoming || !world?.mobiles) return;
  const incoming = api.protocol.mobileIncoming({
    serial: mob.serial, body: mob.body,
    x: mob.x, y: mob.y, z: mob.z,
    direction: mob.direction, hue: mob.hue,
    flags: mob.flags, notoriety: mob.notoriety,
    equipment: [],
  });
  // Sector-aware fan-out — paragon spawns are rare (1-2/min) but
  // each previously walked all 11.7k mobiles. Bug-hunt #4 C.
  const sectors = world.sectors;
  if (sectors?.mobileSerialsNear) {
    for (const s of sectors.mobileSerialsNear(mob.map, mob.x, mob.y, 18)) {
      const other = world.mobiles.get(s);
      if (!other?.client || other.map !== mob.map) continue;
      if (Math.abs(other.x - mob.x) > 18 || Math.abs(other.y - mob.y) > 18) continue;
      other.client.send(incoming);
    }
    return;
  }
  for (const other of world.mobiles.values()) {
    if (!other.client) continue;
    if (other.map !== mob.map) continue;
    if (Math.abs(other.x - mob.x) > 18 || Math.abs(other.y - mob.y) > 18) continue;
    other.client.send(incoming);
  }
}

export const _PARAGON_CONST = Object.freeze({
  PARAGON_HUE, PARAGON_NAME_PREFIX, HP_MULT, STR_MULT, DEFAULT_CHANCE,
});
