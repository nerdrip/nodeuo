// AOS Attributes + 5-element Resistance system. Mirrors the ServUO
// `AosAttributes` / `AosWeaponAttributes` / `AosArmorAttributes` matrices —
// every magic property an item or mobile can carry, with stacking caps and
// resistance arithmetic.
//
// Two layers:
//   1. AttributesBag — { hitChanceIncrease, swingSpeedIncrease, ... } numeric
//      fields. Items declare their bonus via `item.attributes = {...}`. The
//      mobile's effective totals come from summing all _equipment slots
//      plus the mobile's own `attributes` (used by buff effects).
//   2. ResistanceProfile — { physical, fire, cold, poison, energy } percentages.
//      Damage of a typed kind is reduced by the matching resistance.
//      Caps: each element 0..70 by default (AOS), 75 with hard ceiling. The
//      mobile's effective resistance = base + sum(equipment) clamped to [-100, 70].
//
// Damage type table — `applyResistance(amount, kind, profile)`:
//   physical  = melee unarmed/sword/mace
//   fire      = fireball, flamestrike, immolating-weapon
//   cold      = ice-strike (death-knight), polar-bear breath
//   poison    = poison spell, poison-weapon, drider venom
//   energy    = energy-bolt, lightning, blue-mana

const ATTR_KEYS = Object.freeze([
  // Combat — affects swing chain
  'hitChanceIncrease',     // % to-hit bump
  'swingSpeedIncrease',    // % swing-delay reduction
  'damageIncrease',        // % flat damage bump (post-armor)
  'defenseChanceIncrease', // % defender's evade bump

  // Spellcasting
  'fasterCasting',         // points off cast time (0..4 cap)
  'fasterCastRecovery',    // points off post-cast lockout (0..6 cap)
  'spellDamageIncrease',   // % spell damage bump
  'lowerManaCost',         // % off mana
  'lowerReagentCost',      // % chance to skip reagents
  'manaIncrease',          // flat mana max bump
  'staminaIncrease',       // flat stam max bump
  'hitPointIncrease',      // flat HP max bump

  // Regen
  'regenHits',             // bonus HP/sec
  'regenMana',             // bonus Mana/sec
  'regenStam',             // bonus Stam/sec

  // Misc
  'luckBonus',             // luck for loot
  'enhancePotions',        // % potion strength
  'reflectPhysical',       // % melee dmg reflected to attacker
  'nightSight',            // 0/1 — see at night
  'meditationBonus',       // % bonus meditation rate

  // AOS hit-proc attributes (per ServUO `AosWeaponAttribute`). Roll on
  // every successful swing in combat-formulas.onHitProcs.
  'hitLowerDefense',       // % chance to zero defender's DCI for 8 s
  'hitLowerAttack',        // % chance to zero defender's HCI for 8 s
  'splintering',           // % chance to apply 4-tick bleed DoT
  'velocity',              // % chance ranged-only bonus dmg scaling w/ range
  'damageEater',           // % of melee dmg taken healed back (15 % cap)
  // Audit #30 P2 #8 — Hit-spell weapon procs. Authored by loot.js
  // (Burning / Storms / Force / Harm prefixes) but never consumed.
  // ServUO `BaseWeapon.OnHit` rolls each and casts the named spell
  // on the defender. Caps from ServUO 50 % each.
  'hitFireball',           // % chance fire splash
  'hitLightning',          // % chance energy splash
  'hitMagicArrow',         // % chance energy bolt
  'hitHarm',               // % chance cold sting
  // Audit #34 P2 #5 — additional weapon procs ServUO authors via
  // loot prefixes (Dispelling/Stamina Leech/Weariness) but were
  // consumed nowhere. Caps from ServUO `AosWeaponAttribute`.
  'hitDispel',             // % chance to dispel summoned defender
  'hitStamLeech',          // % chance to leech stam (heals attacker)
  'hitFatigue',            // % chance to drain defender stam
]);

/**
 * AOS-style stacking caps — the maximum effective bonus from gear stacking.
 * Per-piece values still display as authored, but the totals returned by
 * `effectiveAttributes(mob)` are clamped here before consumers read them.
 */
export const ATTR_CAPS = Object.freeze({
  hitChanceIncrease:     45,
  swingSpeedIncrease:    60,
  damageIncrease:        100,
  defenseChanceIncrease: 45,
  fasterCasting:         4,
  fasterCastRecovery:    6,
  spellDamageIncrease:   15,    // stricter cap than damage (spells are stronger baseline)
  lowerManaCost:         40,
  lowerReagentCost:      100,
  manaIncrease:          8,
  staminaIncrease:       8,
  hitPointIncrease:      25,
  regenHits:             18,
  regenMana:             2,
  regenStam:             24,
  luckBonus:             1500,
  enhancePotions:        50,
  reflectPhysical:       15,
  nightSight:            1,
  meditationBonus:       40,
  // AOS hit-proc caps mirror ServUO defaults.
  hitLowerDefense:       50,
  hitLowerAttack:        50,
  splintering:           30,
  velocity:              50,
  damageEater:           15,
  hitFireball:           50,
  hitLightning:          50,
  hitMagicArrow:         50,
  hitHarm:               50,
  hitDispel:             50,
  hitStamLeech:          50,
  hitFatigue:            50,
});

const ELEMENTS = Object.freeze(['physical', 'fire', 'cold', 'poison', 'energy']);
export { ELEMENTS as DAMAGE_ELEMENTS };

/** Resistance per element is clamped to [-100, +70] (PvP cap), or +75 hard ceiling. */
const RES_FLOOR = -100;
const RES_CEIL  = 70;
const RES_CEIL_HARD = 75;

/** Empty bag with all keys at 0 — useful for tests / authors. */
export function emptyAttributes() {
  const o = {};
  for (const k of ATTR_KEYS) o[k] = 0;
  return o;
}

/** Empty resistance profile. */
export function emptyResistance() {
  const o = {};
  for (const e of ELEMENTS) o[e] = 0;
  return o;
}

/** Sum two attribute bags into a fresh object (nondestructive). */
export function sumAttributes(a, b) {
  const out = emptyAttributes();
  for (const k of ATTR_KEYS) out[k] = (a?.[k] | 0) + (b?.[k] | 0);
  return out;
}

/** Sum an array of attribute bags. Tolerates undefined entries. */
export function sumAttributesAll(bags) {
  const out = emptyAttributes();
  for (const bag of bags) {
    if (!bag) continue;
    for (const k of ATTR_KEYS) out[k] = (out[k] | 0) + (bag[k] | 0);
  }
  return out;
}

/** Apply caps. Mutates `bag` in place AND returns it. */
export function clampAttributes(bag, caps = ATTR_CAPS) {
  for (const k of ATTR_KEYS) {
    const cap = caps[k] ?? Infinity;
    if (bag[k] > cap) bag[k] = cap;
  }
  return bag;
}

function activeEquipmentSets(mob) {
  const equip = mob?._equipment;
  if (!Array.isArray(equip)) return [];
  const bySet = new Map();
  for (const piece of equip) {
    if (!piece?.setId) continue;
    const key = String(piece.setId);
    const rec = bySet.get(key) ?? { pieces: 0, need: piece.setPieces ?? 0, sample: piece };
    rec.pieces += 1;
    rec.need = Math.max(rec.need | 0, piece.setPieces ?? 0);
    if (!rec.sample?.setAttributes && !rec.sample?.setResist) rec.sample = piece;
    bySet.set(key, rec);
  }
  const active = [];
  for (const rec of bySet.values()) {
    if (rec.need > 0 && rec.pieces >= rec.need) active.push(rec.sample);
  }
  return active;
}

/**
 * Compute the effective AOS bag for a mobile by walking _equipment + the
 * mobile's intrinsic `attributes` (set by buff effects, paragon, etc.).
 * Caches on `mob._attrBag` keyed by `_attrBagDirty` — callers should set
 * `mob._attrBagDirty = true` after equipping/unequipping or after status
 * effects change, then read via `effectiveAttributes`.
 */
export function effectiveAttributes(mob, caps = ATTR_CAPS) {
  if (!mob) return emptyAttributes();
  const timedMods = Array.isArray(mob._eodonPotionMods) ? mob._eodonPotionMods : null;
  if (mob._attrBag && !mob._attrBagDirty && !timedMods) return mob._attrBag;
  const bags = [mob.attributes];
  const equip = mob._equipment;
  if (Array.isArray(equip)) {
    for (const piece of equip) {
      bags.push(piece?.attributes);
      // Audit #30 P2 #8 — magic loot props live in `_magicProps`, not in
      // `piece.attributes`. Fold them into the bag once the player has
      // identified the item (until then the buffs lie dormant — same
      // ServUO behaviour: unidentified items don't apply attributes).
      if (Array.isArray(piece?._magicProps) && !piece._unidentified) {
        const extra = {};
        for (const p of piece._magicProps) {
          if (p?.kind !== 'attr' || !p.attribute) continue;
          // Authored attribute names use PascalCase ("HitFireball"); the
          // ATTR_KEYS bag is camelCase. Normalize first-letter.
          const key = p.attribute.charAt(0).toLowerCase() + p.attribute.slice(1);
          extra[key] = (extra[key] | 0) + (p.intensity | 0);
        }
        bags.push(extra);
      }
    }
  }
  for (const piece of activeEquipmentSets(mob)) bags.push(piece?.setAttributes);
  if (timedMods) {
    const now = Date.now();
    const eodonAttrs = {};
    for (const mod of timedMods) {
      if (mod?.kind !== 'attr' || !mod.key || (mod.expiresAt ?? 0) <= now) continue;
      eodonAttrs[mod.key] = (eodonAttrs[mod.key] | 0) + (mod.amount | 0);
    }
    bags.push(eodonAttrs);
  }
  const merged = clampAttributes(sumAttributesAll(bags), caps);
  mob._attrBag = merged;
  mob._attrBagDirty = false;
  return merged;
}

/**
 * Compute effective 5-element resistance. Same caching pattern as attributes.
 *
 * Reads `mob.resist` (intrinsic — monsters have these baked into templates)
 * + each `_equipment[i].resist`. Result clamped to [-100, +70] per element.
 */
export function effectiveResistance(mob, hardCap = false) {
  if (!mob) return emptyResistance();
  const timedMods = Array.isArray(mob._eodonPotionMods) ? mob._eodonPotionMods : null;
  if (mob._resBag && !mob._resBagDirty && !timedMods) return mob._resBag;
  const out = emptyResistance();
  const ceil = hardCap ? RES_CEIL_HARD : RES_CEIL;
  const sources = [mob.resist];
  const equip = mob._equipment;
  if (Array.isArray(equip)) {
    for (const piece of equip) sources.push(piece?.resist);
  }
  for (const piece of activeEquipmentSets(mob)) sources.push(piece?.setResist);
  // Audit #30 P1 #3 / #33 P1 #2 — transient resist overlay. The AOS
  // Magic Reflection spell pushes a +10 elemental / -25 physical mod
  // for 60 s via this bag; status-effects clears it on expiry. Renamed
  // from `_resistMods` to `_resistOverlay` in #33 to avoid the
  // name collision with `world/modifiers.js` which uses the same field
  // as a Map<kind|name, mod> — `tickModifiers` walks `_resistMods`
  // expecting a Map and would skip our plain-object form silently
  // (size === undefined). The two systems are now disjoint.
  if (mob._resistOverlay) sources.push(mob._resistOverlay);
  if (timedMods) {
    const now = Date.now();
    const eodonResists = {};
    for (const mod of timedMods) {
      if (mod?.kind !== 'resist' || !mod.key || (mod.expiresAt ?? 0) <= now) continue;
      eodonResists[mod.key] = (eodonResists[mod.key] | 0) + (mod.amount | 0);
    }
    sources.push(eodonResists);
  }
  for (const src of sources) {
    if (!src) continue;
    for (const e of ELEMENTS) out[e] = (out[e] | 0) + (src[e] | 0);
  }
  for (const e of ELEMENTS) {
    if (out[e] > ceil) out[e] = ceil;
    else if (out[e] < RES_FLOOR) out[e] = RES_FLOOR;
  }
  mob._resBag = out;
  mob._resBagDirty = false;
  return out;
}

/**
 * Apply a typed-damage block to a mobile. Returns the post-resistance
 * damage (pre-armor — armor is applied by `combat-formulas.applyArmor` for
 * pure physical, or skipped for typed elements which are pre-mitigated by
 * resistance only).
 *
 * `breakdown` like { physical: 70, fire: 30 } is normalized so it sums to
 * the requested `total` damage (allows partial conversions for elemental
 * weapons, e.g. 50% physical + 50% fire). Defaults to 100% physical.
 */
export function applyResistanceTyped(total, breakdown, mob) {
  const res = effectiveResistance(mob);
  const dist = breakdown ?? { physical: 100 };
  let pctSum = 0;
  for (const e of ELEMENTS) pctSum += (dist[e] | 0);
  if (pctSum <= 0) pctSum = 100;  // safety
  let dealt = 0;
  for (const e of ELEMENTS) {
    const share = (dist[e] | 0) / pctSum;
    if (share === 0) continue;
    const raw = total * share;
    const reduction = Math.max(-1, Math.min(1, (res[e] | 0) / 100));
    dealt += raw * (1 - reduction);
  }
  return Math.max(0, Math.floor(dealt));
}

/**
 * Mark the mobile's attribute / resistance cache stale. Call after any
 * mutation to _equipment or to mob.attributes/mob.resist.
 */
export function markAttrDirty(mob) {
  if (!mob) return;
  mob._attrBagDirty = true;
  mob._resBagDirty = true;
}

/** Helpful exports for test / introspection. */
export const ATTRIBUTE_KEYS = ATTR_KEYS;
