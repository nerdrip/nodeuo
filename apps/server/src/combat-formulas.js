// Combat formulas — pure functions used by both player auto-attack and the
// monster AI behavior. Modeled on ServUO mechanics but simplified: we only
// keep the inputs we actually have on a mobile (`str`, `dex`, `stam`,
// numeric skills 0..120, optional `armor`/`weapon` fields). Anything more
// elaborate (damage type, slayers, hit-spell properties, racial bonuses)
// can be layered on top later by passing extra fields through `attacker`/
// `defender` objects.
//
// AOS magic-properties (HCI/DCI/SSI/LMC/SDI/etc.) are sourced from
// `world/attributes.js`. The bag is computed lazily and cached on the
// mobile until equipment changes; we read the merged bag via
// `effectiveAttributes(mob)`. Resistance split (phys/fire/cold/poison/
// energy) routes through `applyResistanceTyped` from the same module.

import { effectiveAttributes, applyResistanceTyped } from './world/attributes.js';

function _attrs(mob) {
  try { return effectiveAttributes(mob); }
  catch { return null; }
}
//
// Skill scale: values are stored on the mobile as plain integers 0..120
// (matches `apps/server/src/net/handlers.js` starter-skill template). The
// network protocol multiplies by 10 on the wire — that's a serializer
// concern, not a gameplay one.

/** Skill ids that count as a primary weapon skill. */
export const WEAPON_SKILLS = Object.freeze({
  WRESTLING: 44,
  SWORDSMANSHIP: 41,
  MACE_FIGHTING: 42,
  FENCING: 43,
  ARCHERY: 32,
  THROWING: 58,
});
export const SKILL_TACTICS  = 28;
export const SKILL_ANATOMY  = 2;
export const SKILL_PARRYING = 6;
export const SKILL_BUSHIDO  = 53;

const WEAPON_SKILL_LIST = Object.values(WEAPON_SKILLS);

/** Normalize legacy saves that stored skills as OSI-style tenths
 *  (`1000` for 100.0) into the runtime's 0..120 scale. */
export function normalizeSkillValue(value) {
  const n = Number(value) || 0;
  return n > 120 ? n / 10 : n;
}

/** Read a skill value from a mobile, defaulting to 0. Tolerates string ids
 *  (the persistence layer round-trips skills via JSON, which keys-as-strings). */
export function effectiveSkill(mob, skillId) {
  if (!mob || !mob.skills) return 0;
  const direct = mob.skills[skillId];
  if (typeof direct === 'number') return normalizeSkillValue(direct);
  const str = mob.skills[String(skillId)];
  return typeof str === 'number' ? normalizeSkillValue(str) : 0;
}

/**
 * The highest-rated weapon skill on this mobile. Monsters typically have no
 * skills dict at all; in that case we fall back to a body-based estimate
 * (`mob.weaponSkill ?? 50`) so they're not auto-defeated by every player.
 */
export function effectiveWeaponSkill(mob) {
  if (!mob) return 0;
  // A wielded weapon always selects its authored combat skill. The old
  // "highest weapon skill" shortcut let a 120 Swords character fire a bow
  // with Swords instead of Archery and made weapon swaps meaningless.
  const wieldedSkill = Number(mob._weapon?.skill);
  if (Number.isFinite(wieldedSkill) && wieldedSkill >= 0) {
    const selected = effectiveSkill(mob, wieldedSkill);
    if (selected > 0) return selected;
  }
  if (mob.skills) {
    let best = 0;
    for (const id of WEAPON_SKILL_LIST) {
      const v = effectiveSkill(mob, id);
      if (v > best) best = v;
    }
    if (best > 0) return best;
  }
  return mob.weaponSkill ?? 0;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** ServUO Race enum — derived from body id since we don't carry race
 *  as a separate field. Players only: monsters get null. */
export const Race = Object.freeze({ HUMAN: 'human', ELF: 'elf', GARGOYLE: 'gargoyle' });

export function raceOf(mob) {
  if (!mob || !mob.client) return null;
  const b = mob.body | 0;
  if (b === 0x25D || b === 0x25E) return Race.ELF;
  if (b === 0x29A || b === 0x29B || b === 0x666 || b === 0x667) return Race.GARGOYLE;
  if (b === 0x190 || b === 0x191) return Race.HUMAN;
  return null;
}

/** Racial bonuses (ServUO Mobile.cs / Race.cs).
 *    Human:    + 20% chance to ignore strength reqs on weapons + 'Jack of
 *              all Trades' (small skill bonus) — modelled as 1.05× attack.
 *    Elf:     +20 max int, +20% mana regen, night-sight always on.
 *    Gargoyle: +5% damage with melee, +25% throwing damage. Cannot ride
 *              mounts. */
export function racialDamageMul(attacker, _defender) {
  const r = raceOf(attacker);
  if (!r) return 1;
  if (r === Race.HUMAN) return 1.05;  // Jack of All Trades blanket
  if (r === Race.GARGOYLE) {
    // Throwing skill (id 58) → +25%, otherwise +5% melee.
    const usingThrow = effectiveSkill(attacker, WEAPON_SKILLS.THROWING)
      > effectiveSkill(attacker, WEAPON_SKILLS.SWORDSMANSHIP);
    return usingThrow ? 1.25 : 1.05;
  }
  return 1;
}

export function racialManaRegenMul(mob) {
  return raceOf(mob) === Race.ELF ? 1.2 : 1;
}

/** Cheap O(N) check across mob.effects (typically <5 entries). */
function hasEffect(mob, name) {
  const list = mob?.effects;
  if (!list || list.length === 0) return false;
  for (let i = 0; i < list.length; i++) if (list[i]?.name === name) return true;
  return false;
}

/**
 * Probability that `attacker` lands a swing on `defender`. ServUO core
 * formula: `(atk+50) / (2*(def+50))`, clamped to [2%, 100%]. Defender uses
 * Parrying when it's higher than their primary weapon skill (rough proxy
 * for "shield up").
 *
 * Status-effect modifiers (applied AFTER the base roll):
 *   - defender 'evasion' (Bushido)         → forced miss (chance = 0.02)
 *   - attacker 'lightning-strike' (Bushido)→ guaranteed hit
 *   - attacker 'focus-attack' (Ninjitsu)
 *     while hidden                          → guaranteed hit
 *   - defender 'discord'                   → -15% to defender skill (already
 *                                             baked into the (atk - def) maths)
 *
 * @returns {number} probability in [0.02, 1.0]
 */
export function hitChance(attacker, defender) {
  if (hasEffect(defender, 'evasion')) return 0.02;
  // Bushido Evasion special-move + spell — both stamp `_evasionUntil`.
  // Reduces attacker hit chance to 2% for the buff window. Bug-hunt #6 P2 #4.
  // NB: Date.now() is > 2³¹, so `| 0` would truncate to a negative int —
  // use a plain numeric compare. (Tripped by the post-#15 test pass.)
  const nowMs = Date.now();
  if ((defender?._evasionUntil ?? 0) > nowMs) return 0.02;
  // Peacemaking — bards calm a target into a no-swing window. ServUO
  // `Peacemaking.OnTarget` sets `_peacefulUntil`; gated attackers
  // mis-fire. Bug-hunt #6 P1 #1.
  if ((attacker?._peacefulUntil ?? 0) > nowMs) return 0;
  // Disarm — recently-disarmed target can't even swing back. Bug-hunt
  // #6 P2 #3.
  if ((attacker?._disarmedUntil ?? 0) > nowMs) return 0;
  if (hasEffect(attacker, 'lightning-strike')) return 1.0;
  if (hasEffect(attacker, 'focus-attack') && attacker?.hidden) return 1.0;

  const a = effectiveWeaponSkill(attacker);
  const dWeapon = effectiveWeaponSkill(defender);
  // BUGFIX #125 (FAZA HK): the previous code applied the defender's
  // Parrying skill regardless of whether they actually had a shield
  // equipped. ServUO `Mobile.cs::CheckShield` requires a shield item
  // (BaseShield) on layer 2 (left hand) AND no two-handed weapon
  // wielded. Without the shield, parry skill must NOT count.
  // We surface the gate via `defender._hasShield` flag — the equip
  // path (handlers.handleWearItem) sets it when an item with
  // `shield: true` template lands on layer 2.
  const dParry  = defender?._hasShield
    ? effectiveSkill(defender, SKILL_PARRYING)
    : 0;
  // Discord eats 15% of the defender's defensive skill budget for the buff
  // duration. Because we read the unmodified skill above, apply the cut as
  // a multiplier on the picked defensive value.
  const discordMul = hasEffect(defender, 'discord') ? 0.85 : 1.0;
  const d = Math.max(dWeapon, dParry) * discordMul;
  let chance = clamp((a + 50) / ((d + 50) * 2), 0.02, 1.0);
  // AOS Hit-Chance / Defense-Chance increase. Both come from
  // `effectiveAttributes(mob)` (already capped at 45). They scale the
  // raw skill ratio by `(1 + hci/100) / (1 + dci/100)` — the standard
  // ServUO `WeaponAttributes.HitChanceIncrease` arithmetic.
  const atkAttrs = _attrs(attacker);
  const defAttrs = _attrs(defender);
  let hci = (atkAttrs?.hitChanceIncrease | 0);
  let dci = (defAttrs?.defenseChanceIncrease | 0);
  // Audit #36 P1 #4 — HLA/HLD malus. ServUO `HitLower.cs:9-10,25,45,78`:
  // subtract a fixed 25 (HLA) / 25 (HLD) from the value, NOT zero.
  // Zero-out was way too punitive — a single proc reduced a HCI-45
  // attacker to 0% (a fixed 25-pt malus leaves them at 20%, the
  // canonical "you took a wallop" feel). Stamped by onHitProcs().
  const now = Date.now();
  if ((attacker?._lostHciUntil ?? 0) > now) hci = Math.max(-100, hci - 25);
  if ((defender?._lostDciUntil ?? 0) > now) dci = Math.max(-100, dci - 25);
  // Audit #36 P2 #13 — Surprise Attack DCI malus on the defender.
  // ServUO `SurpriseAttack.cs:77-110` stamps `dci -= ninjitsu/60` for
  // 8 s after a successful Surprise Attack hit. Magnitude is captured
  // on `_surpriseAttackMalus`; default to 10 when only the timer is set.
  if ((defender?._surpriseAttackUntil ?? 0) > now) {
    dci = Math.max(-100, dci - (defender._surpriseAttackMalus | 0 || 10));
  }
  // Feint special move — defender's `_feintUntil` adds +30 % DCI for
  // the duration of the buff (ServUO Bushido `Feint` proc).
  if ((defender?._feintUntil ?? 0) > Date.now()) dci += 30;
  // ServUO skill mastery bridge. Focused Eye makes the next short window
  // far more accurate; Heightened Senses is the defensive counterpart.
  if ((attacker?._focusedEyeUntil ?? 0) > now) hci += 50;
  if ((defender?._heightenedUntil ?? 0) > now) dci += 10;
  if (hci || dci) {
    chance = chance * (1 + hci / 100) / (1 + dci / 100);
  }
  return clamp(chance, 0.02, 1.0);
}

/**
 * Effective stat after magery debuffs/buffs. ServUO Clumsy/Feeblemind/
 * Weaken stamp `<stat>DebuffUntil` + `<stat>Debuff` (magnitude); the
 * corresponding 2nd-circle Agility/Cunning/Strength stamp `<stat>BuffUntil`
 * + `<stat>Buff`. Bug-hunt #6 P2 #2.
 */
export function effectiveStat(mob, statKey, now = Date.now()) {
  let val = mob?.[statKey] | 0;
  const debuffUntil = Number(mob?.[`${statKey}DebuffUntil`]) || 0;
  if (debuffUntil > now) val -= (mob[`${statKey}Debuff`] ?? 10);
  const buffUntil = Number(mob?.[`${statKey}BuffUntil`]) || 0;
  if (buffUntil > now) val += (mob[`${statKey}Buff`] ?? 20);
  return Math.max(0, val);
}

/**
 * Min/max raw damage range for an unarmed (Wrestling) swing, derived from
 * the attacker's strength. ServUO uses `str/40 + {1..4}`.
 *
 * @returns {{lo:number, hi:number}}
 */
export function unarmedDamageRange(str) {
  const s = Math.max(0, str | 0);
  const lo = Math.floor(s / 40) + 1;
  const hi = Math.floor(s / 40) + 4;
  return { lo, hi };
}

/**
 * Multiplier applied to the rolled base damage. Combines Tactics, Anatomy
 * and raw Strength bonuses. At 100/100 Tactics+Anatomy this is roughly
 * 1.6× before the str term — close to ServUO's "fully trained warrior"
 * damage budget.
 */
export function damageMultiplier(attacker) {
  const tactics = effectiveSkill(attacker, SKILL_TACTICS);
  const anatomy = effectiveSkill(attacker, SKILL_ANATOMY);
  const str = Math.max(0, attacker?.str ?? 0);
  return 1 + tactics * 0.00625 + anatomy * 0.005 + str / 300;
}

/** Sum of armor rating from a mobile's equipped pieces, plus any inherent
 *  `armor` field (used by monsters). Each piece contributes `ar` (0..30). */
export function armorRating(mob) {
  let total = mob?.armor ?? 0;
  const equip = mob?._equipment;
  if (Array.isArray(equip)) {
    for (const piece of equip) total += piece?.ar ?? 0;
  }
  return total;
}

/** Apply armor reduction. Linear up to a 70% cap so high-AR targets
 *  always take at least 30% (and never less than 1) of incoming damage. */
export function applyArmor(damage, armor) {
  const reduction = clamp((armor | 0) / 100, 0, 0.7);
  return Math.max(1, Math.floor(damage * (1 - reduction)));
}

/**
 * Roll a complete melee swing: base range × multiplier × armor reduction.
 *
 * Status-effect modifiers:
 *   - attacker 'honorable-execution' (Bushido) → +20% damage
 *   - attacker 'ki-attack' (Ninjitsu)          → +25% damage
 *   - attacker 'lightning-strike' (Bushido)    → forced 1.5× crit damage
 *   - attacker 'consecrate-weapon' (Chiv)      → ignore armour entirely
 *   - attacker 'enchant' (Mysticism)           → ignore 50% of armour
 *   - attacker 'immolating-weapon' (SW)        → +6 fire damage flat
 *   - defender 'corpse-skin' (Necro)           → +20% damage taken
 *
 * Lifesteal hooks (applied to caller — they read the returned damage):
 *   - attacker 'curse-weapon'    → caller heals 50% of dealt damage
 *   - attacker 'vampiric-embrace'→ caller heals 15% of dealt damage
 *
 * Reflection:
 *   - defender 'blood-oath'      → caller takes 30% of damage they dealt
 *
 * Lifesteal/reflect aren't applied here directly — the caller reads
 * `damageRiders(attacker, defender, dmg)` to get a side-effect plan.
 *
 * @param {object} attacker
 * @param {object} defender
 * @param {() => number} [rng]  injected for deterministic tests; defaults to Math.random.
 */
export function rollDamage(attacker, defender, rng = Math.random) {
  // Use effective Str so Weaken / Strength buffs alter the swing range
  // (Bug-hunt #6 P2 #2).
  const weaponLo = Number(attacker?._weapon?.minDamage);
  const weaponHi = Number(attacker?._weapon?.maxDamage);
  const hasWeaponRange = Number.isFinite(weaponLo) && Number.isFinite(weaponHi)
    && weaponLo >= 0 && weaponHi >= weaponLo;
  const { lo, hi } = hasWeaponRange
    ? { lo: weaponLo | 0, hi: weaponHi | 0 }
    : unarmedDamageRange(effectiveStat(attacker, 'str'));
  const base = lo + Math.floor(rng() * (hi - lo + 1));
  let scaled = Math.max(1, Math.floor(base * damageMultiplier(attacker)));

  // Bushido / Ninjitsu single-shot buff readers. Each cast stamps a
  // `<name>Until` field; mirror the ServUO multipliers and consume the
  // buff on first swing.
  const nowMs = Date.now();
  if ((attacker?.honorableExecUntil ?? 0) > nowMs) {
    scaled = Math.floor(scaled * 1.2);
    attacker.honorableExecUntil = 0;
  }
  if ((attacker?.lightningStrikeUntil ?? 0) > nowMs) {
    scaled = Math.floor(scaled * 1.5);
    attacker.lightningStrikeUntil = 0;
  }
  if ((attacker?.momentumStrikeUntil ?? 0) > nowMs) {
    scaled = Math.floor(scaled * 1.4);
    attacker.momentumStrikeUntil = 0;
  }
  if ((attacker?.kiAttackUntil ?? 0) > nowMs) {
    scaled = Math.floor(scaled * 1.25);
    attacker.kiAttackUntil = 0;
  }
  if ((attacker?.backstabUntil ?? 0) > nowMs && attacker.hidden) {
    scaled = Math.floor(scaled * 1.5);
    attacker.backstabUntil = 0;
    attacker.hidden = false;
  }
  if ((attacker?.surpriseAttackUntil ?? 0) > nowMs) {
    // Surprise Attack — disables defender DCI for this swing + small bump.
    if (defender) defender._lostDciUntil = nowMs + 4000;
    scaled = Math.floor(scaled * 1.15);
    attacker.surpriseAttackUntil = 0;
  }
  // ServUO skill mastery bridge. These are timestamped by
  // systems/mastery-abilities.js and by the ServUO spell class adapter.
  if ((attacker?._warcryUntil ?? 0) > nowMs) scaled = Math.floor(scaled * 1.10);
  if ((attacker?._whiteTigerUntil ?? 0) > nowMs) scaled = Math.floor(scaled * 1.15);
  if ((attacker?._onslaughtUntil ?? 0) > nowMs) scaled = Math.floor(scaled * 1.10);

  if (hasEffect(attacker, 'honorable-execution')) scaled = Math.floor(scaled * 1.2);
  // Audit #38 P1 #1 — Stone Form flat damage bonus from
  // `(Mysticism + max(Focus, Imbuing))/12`.
  if (attacker?._stoneForm && (attacker._stoneFormDmgBonus | 0) > 0) {
    scaled = scaled + (attacker._stoneFormDmgBonus | 0);
  }
  // Audit #38 P2 #6 — Enemy of One affinity. Lock kind on first hit;
  // multi-target reset clears the lock back to null.
  if ((attacker?._eooUntil ?? 0) > nowMs) {
    if (attacker._eooKind == null) attacker._eooKind = defender?.kind ?? null;
    if (attacker._eooKind && defender?.kind === attacker._eooKind) {
      scaled = Math.floor(scaled * (1 + (attacker._eooScalar | 0) / 100));
    }
  }
  // Defender side: +100 % damage TAKEN from attackers that DON'T match
  // the paladin's bound kind. Mirrors ServUO `EnemyOfOne.UpdateDamage`.
  if ((defender?._eooUntil ?? 0) > nowMs
      && defender?._eooKind != null
      && attacker?.kind !== defender._eooKind) {
    scaled = Math.floor(scaled * 2);
  }
  if (hasEffect(attacker, 'ki-attack'))           scaled = Math.floor(scaled * 1.25);
  if (hasEffect(attacker, 'lightning-strike'))    scaled = Math.floor(scaled * 1.5);

  let armour = armorRating(defender);
  if (hasEffect(attacker, 'consecrate-weapon')) armour = 0;
  else if (hasEffect(attacker, 'enchant')) armour = Math.floor(armour * 0.5);
  // Armor Ignore special move — sets `_armorIgnoreUntil` on the
  // attacker; while the timer is live the next swing pierces all
  // physical armor. Mirrors ServUO `WeaponAbility.ArmorIgnore`.
  if ((attacker?._armorIgnoreUntil ?? 0) > Date.now()) {
    armour = 0;
    attacker._armorIgnoreUntil = 0;   // single-use proc
  }

  let dmg = applyArmor(scaled, armour);
  // AOS elemental conversion. A weapon authored with
  // `_weapon.damageBreakdown = { physical, fire, cold, poison, energy }`
  // routes the post-armor amount through 5-element resists instead of
  // the flat AR cap. Pure-physical weapons (no breakdown) keep the
  // legacy linear armor path so balance for vanilla content is unchanged.
  const breakdown = attacker?._weapon?.damageBreakdown;
  if (breakdown) dmg = applyTypedResist(dmg, defender, breakdown);
  if (hasEffect(attacker, 'immolating-weapon')) dmg += 6;
  // Audit #38 P2 #10 — Corpse Skin now applies resist mods via the
  // standard `_resistOverlay` (see `necro/corpse-skin.js`). The
  // damage pipeline picks up the resist deltas automatically; this
  // legacy reader would double-apply. Kept the `hasEffect` branch as
  // a fallback ONLY for ancient saves whose `_resistOverlay` wasn't
  // stamped — gate on the absence of the overlay flag.
  if (hasEffect(defender, 'corpse-skin') && !defender._corpseSkinOverlayApplied) {
    const malus = (defender._corpseSkinMalus | 0) || 15;
    if (breakdown) {
      const firePoisonShare = ((breakdown.fire | 0) + (breakdown.poison | 0)) / 100;
      const coldPhysShare   = ((breakdown.cold | 0) + (breakdown.physical | 0)) / 100;
      dmg = Math.floor(
        dmg * (1 + firePoisonShare * (malus / 100) - coldPhysShare * 0.10),
      );
    } else {
      dmg = Math.floor(dmg * 0.9);
    }
    if (dmg < 1) dmg = 1;
  }
  // AOS Damage Increase (raw post-mitigation bump, capped at 100). Keeps
  // crafted weapons relevant against high-AR targets.
  const di = _attrs(attacker)?.damageIncrease | 0;
  if (di > 0) dmg = Math.floor(dmg * (1 + di / 100));
  // FAZA EW: slayer weapons. The wielded weapon's `slayer` tag triples
  // damage against matching creature kinds. ServUO ships ~10 slayer
  // matchups; we read the active weapon's tag from `attacker._weapon`
  // (combat layer captures this on swing resolution).
  if (attacker?._weapon?.slayer) {
    const sm = slayerMul(attacker._weapon.slayer, defender?.kind);
    if (sm > 1) dmg = Math.floor(dmg * sm);
  }
  // Server parity #10 #4 — talisman slayer / protection multipliers.
  // The talisman item carries `talisman.slayer` (matches `defender.kind`
  // → 3×) and / or `talisman.protection` on the DEFENDER (matches
  // `attacker.kind` → 0.5×). Was wired in `systems/talismans.js` but
  // no consumer read the values.
  const talSlayer = attacker?._equipment?.find?.((p) => p?.talisman?.slayer);
  if (talSlayer?.talisman?.slayer && defender?.kind === talSlayer.talisman.slayer) {
    dmg = Math.floor(dmg * 3);
  }
  const talProt = defender?._equipment?.find?.((p) => p?.talisman?.protection);
  if (talProt?.talisman?.protection && attacker?.kind === talProt.talisman.protection) {
    dmg = Math.floor(dmg * 0.5);
  }
  // Racial bonus — applied AFTER armour and slayer so each multiplier
  // compounds in ServUO order (race → slayer → armor → status). Idempotent
  // on monsters / mounts (raceOf returns null).
  const racialMul = racialDamageMul(attacker, defender);
  if (racialMul !== 1) dmg = Math.floor(dmg * racialMul);
  // Discordance — bard skill. ServUO `Discordance.OnTarget` applies a
  // 30 % damage-taken bump for 30 s. Bug-hunt #6 P1 #1: the timer was
  // stamped but no reader consumed it, so a 120-skill bard burnt cooldown
  // for zero effect.
  const now = Date.now();
  if ((defender?._discordedUntil ?? 0) > now) {
    const pen = defender._discordPenaltyPct ?? 0.30;
    dmg = Math.floor(dmg * (1 + pen));
  }
  if ((defender?._toughnessUntil ?? 0) > now) dmg = Math.floor(dmg * 0.90);
  if ((defender?._toleranceUntil ?? 0) > now) dmg = Math.floor(dmg * 0.85);
  return Math.max(1, dmg);
}

// Inline slayer multiplier — duplicating the matrix from systems/slayers.js
// avoids a circular import (combat-formulas is leaf-level).
const _SLAYER_MAT = {
  silver: ['skeleton','zombie','lich','mummy','ghoul','wraith','bone-knight'],
  repond: ['orc','ogre','troll','lizardman','ratman','kobold'],
  fey:    ['pixie','satyr','wisp','reaper'],
  dragon: ['dragon','wyrm','drake','wyvern'],
  daemon: ['daemon','imp','gargoyle','devourer'],
  arachnid: ['spider','scorpion','tarantula'],
  reptile: ['lizard','snake','serpent','wyvern'],
};
function slayerMul(tag, kind) {
  if (!tag || !kind) return 1.0;
  const arr = _SLAYER_MAT[tag];
  return arr && arr.includes(kind) ? 3.0 : 1.0;
}

/**
 * Compute on-hit side effects (lifesteal + reflect) for the swing the
 * caller just resolved. Returns `{ heal, reflect }` — both numbers, both
 * may be 0.
 *
 * Caller responsibility:
 *   - heal:    `attacker.hp = min(hpMax, attacker.hp + heal)` and broadcast
 *   - reflect: `attacker.hp = max(0, attacker.hp - reflect)` (kill-protected
 *              upstream) and broadcast a damage packet on the attacker
 */
export function damageRiders(attacker, defender, dmg) {
  let heal = 0;
  let reflect = 0;
  let manaLeech = 0;
  // ServUO CurseWeapon.cs: "half the damage … added to the necromancer's health".
  if (hasEffect(attacker, 'curse-weapon'))     heal += Math.floor(dmg * 0.5);
  // Audit #32 P2 #10 — ServUO `VampiricEmbrace.cs:80-92` lifesteal = 20%
  // (buff arg literal "20"); previously 15% which was a port-time guess.
  if (hasEffect(attacker, 'vampiric-embrace')) heal += Math.floor(dmg * 0.20);
  // Audit #38 P1 #3 — ServUO `AOS.cs:246` reflects the ORIGINAL
  // damage 1:1 to the attacker (was 30 %). The +20 % defender-side
  // damage bump that ServUO also applies lives on `onHitProcs` via the
  // `bloodOathExtraDmg` return field below — separate function.
  if (hasEffect(defender, 'blood-oath')) reflect += dmg;
  // AOS magic-property leech / reflect — % chance proportional to the
  // weapon's authored property value, capped by the AOS table (max
  // 50% per property). Mirrors ServUO `BaseWeapon.OnHit` leech roll.
  const attrs = _attrs(attacker);
  if (attrs?.hitLifeLeech > 0) {
    const chance = Math.min(50, attrs.hitLifeLeech) / 100;
    if (Math.random() < chance) heal += Math.floor(dmg * 0.30);
  }
  if (attrs?.hitManaLeech > 0) {
    const chance = Math.min(50, attrs.hitManaLeech) / 100;
    if (Math.random() < chance) manaLeech += Math.floor(dmg * 0.40);
  }
  // Audit #32 P1 #4 — Wraith Form mana leech. ServUO
  // `WraithForm.cs:98-100` leeches `(5 + SpiritSpeak/5) %` of damage as
  // mana. Was completely unimplemented — the spell set a flag
  // (`wraithFormUntil`) that nothing read, so casters in wraith form
  // got the body change but zero combat benefit. Skill 33 = Spirit Speak.
  if ((attacker?.wraithFormUntil ?? 0) > Date.now()) {
    // Audit #41 P1 #3 — Spirit Speak is skill 33 (skills.json:34).
    // Skill 32 is Archery — the wraith-form mana leech was scaling
    // off the wrong skill.
    const ss = effectiveSkill(attacker, 33);
    const pct = (5 + ss / 5) / 100;
    manaLeech += Math.floor(dmg * pct);
  }
  // Reflect Physical Damage — defender's armor property pushes a
  // fraction of any incoming physical damage back to the attacker.
  // Capped at 50%; ServUO `AosArmorAttributes.ReflectPhysical` uses
  // the same cap.
  const defAttrs = _attrs(defender);
  if (defAttrs?.reflectPhysical > 0) {
    const pct = Math.min(50, defAttrs.reflectPhysical) / 100;
    reflect += Math.floor(dmg * pct);
  }
  return { heal, reflect, manaLeech };
}

/**
 * Swing delay in milliseconds for the attacker. Faster with stam, faster
 * with a high weapon-speed rating (1=heavy mace, 5=dagger, default 3).
 * Clamped so a fully-decked-out fighter still has a 1.25s minimum and an
 * exhausted brawler doesn't take 10s between swings.
 */
export function swingDelayMs(attacker, weaponSpeed = attacker?._weapon?.speed ?? 30) {
  const stam = Math.max(0, attacker?.stam ?? attacker?.dex ?? 50);
  // ServUO BaseWeapon.GetDelay (AOS):
  //   floor(40000 / ((stam + 100) * speed * (1 + SSI/100))) * 0.5 s
  // Weapon definitions carry the real AOS speed values (22..56), not the
  // old local 1..5 rating. Previously the live auto-attack omitted this
  // argument entirely, so daggers, bows and halberds all used speed=3.
  const speed = Math.max(1, Number(weaponSpeed) || 30);
  let ssi = _attrs(attacker)?.swingSpeedIncrease | 0;
  // Audit #37 P1 #6 — Reaper Form grants +10 SSI from the transform.
  ssi += (attacker?._reaperSSI | 0);
  // Essence of Wind subtracts SSI while the debuff is active.
  if ((attacker?._essenceWindUntil ?? 0) > Date.now()) {
    ssi -= (attacker._essenceWindSSIMalus | 0);
  }
  if ((attacker?._rampageUntil ?? 0) > Date.now()) {
    ssi += Math.min(25, (attacker._rampageStacks | 0) * 5);
  }
  ssi = clamp(ssi, -90, 60);
  const divisor = Math.max(1, (stam + 100) * speed * (1 + ssi / 100));
  let raw = Math.floor(40000 / divisor) * 500;
  // The AOS minimum is 1.25 s. Keep a defensive upper bound for malformed
  // custom weapons without flattening legitimate slow weapons.
  raw = clamp(raw || 1250, 1250, 10_000);
  if (hasEffect(attacker, 'divine-fury'))     raw = Math.floor(raw * 0.5);
  if (hasEffect(attacker, 'essence-of-wind')) raw = Math.floor(raw * 1.5);
  if (attacker?._dualWield) raw = Math.floor(raw * 1.3);
  if ((attacker?._staggerUntil ?? 0) > Date.now()) raw = Math.floor(raw * 1.5);
  return clamp(raw, 1250, 10_000);
}

export function applyConfidenceParryStamina(mob) {
  if (!mob?._confidenceStamRegen) return 0;
  const before = mob.stam ?? mob.dex ?? 50;
  const max = mob.stamMax ?? mob.dex ?? 50;
  if (before >= max) return 0;
  const bushido = effectiveSkill(mob, SKILL_BUSHIDO);
  const gain = Math.max(5, 10 + Math.floor(bushido / 12));
  mob.stam = Math.min(max, before + gain);
  return mob.stam - before;
}

/**
 * Apply 5-element resistance split to a typed-damage swing. The breakdown
 * defaults to 100% physical, but specific weapons (fire-brand, ice-spear,
 * arrow-of-lightning) can pass a `breakdown` like `{ physical: 70, fire: 30 }`
 * to mix the elements. Reads `applyResistanceTyped` from world/attributes.
 *
 * Caller responsibility: `rollDamage` already applies linear armor; pass the
 * post-armor damage to `applyTypedResist` only when the weapon has an
 * elemental breakdown (otherwise the linear armor model is a strict subset
 * of the physical resist and we don't double-mitigate).
 */
export function applyTypedResist(damage, defender, breakdown) {
  if (!breakdown || !defender) return Math.max(1, damage | 0);
  const out = applyResistanceTyped(damage, breakdown, defender);
  return Math.max(1, out | 0);
}

function epiphanyKarmaBonus(mob, alignment) {
  const karma = mob?.karma | 0;
  if (alignment === 'good') {
    if (karma <= 0) return 0;
    return Math.min(20, Math.floor(karma / 500));
  }
  if (alignment === 'evil') {
    if (karma >= 0) return 0;
    return Math.min(20, Math.floor((-karma) / 500));
  }
  return 0;
}

function applyEpiphanySurges(defender, damage) {
  if (!defender || damage <= 15 || !Array.isArray(defender._equipment)) return null;
  const groups = new Map();
  for (const piece of defender._equipment) {
    if (!piece?.epiphanyAlignment) continue;
    const alignment = String(piece.epiphanyAlignment).toLowerCase();
    const type = String(piece.epiphanyType ?? 'mana').toLowerCase();
    const key = `${alignment}:${type}`;
    const rec = groups.get(key) ?? { alignment, type, count: 0 };
    rec.count++;
    groups.set(key, rec);
  }
  if (groups.size === 0) return null;
  defender._epiphanySurgeDamage ??= {};
  const fired = [];
  for (const rec of groups.values()) {
    const bonus = epiphanyKarmaBonus(defender, rec.alignment);
    if (bonus <= 0) continue;
    const key = `${rec.alignment}:${rec.type}`;
    const total = (defender._epiphanySurgeDamage[key] | 0) + (damage | 0);
    const frequency = Math.max(1, Math.min(5, rec.count | 0));
    const threshold = 10000 / frequency;
    if (total > Math.random() * threshold) {
      defender._epiphanySurgeDamage[key] = 0;
      if (rec.type === 'hits' || rec.type === 'health') {
        defender.hp = Math.min(defender.hpMax ?? 50, (defender.hp ?? 0) + bonus);
      } else if (rec.type === 'stam' || rec.type === 'stamina') {
        defender.stam = Math.min(defender.stamMax ?? 50, (defender.stam ?? 0) + bonus);
      } else {
        defender.mana = Math.min(defender.manaMax ?? 50, (defender.mana ?? 0) + bonus);
      }
      fired.push({ type: rec.type, bonus });
    } else {
      defender._epiphanySurgeDamage[key] = total;
    }
  }
  return fired.length ? fired : null;
}

/**
 * AOS on-hit weapon-attribute procs. Called after a swing connects.
 * Each attribute rolls independently; stamps the relevant time-windowed
 * flag on attacker/defender or returns a bonus damage delta. Cheap —
 * one `Math.random()` per non-zero attribute.
 *
 * @param {object} attacker
 * @param {object} defender
 * @param {number} weaponRange  >1 = ranged (Velocity activates)
 * @param {number} baseDmg      the damage about to be applied; used for
 *                               DamageEater + Velocity scaling
 * @returns {{ bonusDamage: number, applyBleed: boolean }}
 */
export function onHitProcs(attacker, defender, weaponRange, baseDmg) {
  const result = { bonusDamage: 0, applyBleed: false };
  const a = _attrs(attacker);
  if (!a) return result;
  const now = Date.now();
  // Audit #38 P1 #3 — Blood Oath +20 % damage taken by the defender.
  // ServUO `AOS.cs:255` scales `totalDamage = floor(totalDamage * 1.2)`
  // when the defender is under Blood Oath. Folded into `bonusDamage`
  // so the swing total picks it up.
  if (hasEffect(defender, 'blood-oath') && baseDmg > 0) {
    result.bonusDamage += Math.floor(baseDmg * 0.2);
  }
  const epiphany = applyEpiphanySurges(defender, baseDmg | 0);
  if (epiphany) result.epiphany = epiphany;

  // Splintering — 3 % chance per swing (scaled by weapon attr %).
  // Stamp _bleedUntil = now + 8 s so regen.js's DoT tick fires 4 pulses.
  if ((a.splintering | 0) > 0 && defender && (defender.hp | 0) > 0) {
    if (Math.random() * 100 < a.splintering) {
      defender._bleedUntil = Math.max(defender._bleedUntil ?? 0, now + 8_000);
      result.applyBleed = true;
    }
  }

  // Audit #36 P1 #4 — ServUO `HitLower.cs:25,45,78`:
  //   HLD `DefenseEffectDuration = 8s`, malus -25 DCI (`DefenseTimer`)
  //   HLA `AttackEffectDuration = 10s`, malus -25 HCI (`AttackTimer`)
  // Was zero-out (-100% nerf) for both; subtraction is canonical.
  if ((a.hitLowerDefense | 0) > 0 && defender) {
    if (Math.random() * 100 < a.hitLowerDefense) {
      defender._lostDciUntil = now + 8_000;
    }
  }
  if ((a.hitLowerAttack | 0) > 0 && defender) {
    if (Math.random() * 100 < a.hitLowerAttack) {
      defender._lostHciUntil = now + 10_000;
    }
  }

  // Velocity — ranged-only. ServUO formula: 4 + 4 × range bonus when
  // the roll hits. weaponRange comes from the wielded bow/crossbow.
  if (weaponRange > 1 && (a.velocity | 0) > 0) {
    if (Math.random() * 100 < a.velocity) {
      result.bonusDamage += 4 + 4 * Math.max(1, Math.min(10, weaponRange - 1));
    }
  }

  // Hit-spell weapon procs (Burning / Storms / Force / Harm prefixes).
  // ServUO `BaseWeapon.OnHit` rolls each chance and casts the named spell
  // at the defender. We fold the extra damage into `bonusDamage` so it
  // shares the swing's typed/resist pipeline. Area procs are not authored
  // in our attribute bag yet; once content starts emitting HitFireArea
  // etc., this result object can carry an area-damage request to handlers.
  if (defender && (defender.hp | 0) > 0) {
    if ((a.hitFireball | 0) > 0 && Math.random() * 100 < a.hitFireball) {
      result.bonusDamage += 15 + Math.floor(Math.random() * 11);  // 15..25
    }
    if ((a.hitLightning | 0) > 0 && Math.random() * 100 < a.hitLightning) {
      result.bonusDamage += 15 + Math.floor(Math.random() * 11);
    }
    if ((a.hitMagicArrow | 0) > 0 && Math.random() * 100 < a.hitMagicArrow) {
      result.bonusDamage += 10 + Math.floor(Math.random() * 11);  // 10..20
    }
    if ((a.hitHarm | 0) > 0 && Math.random() * 100 < a.hitHarm) {
      result.bonusDamage += 10 + Math.floor(Math.random() * 11);
    }
    // Audit #34 P2 #5 — additional hit-procs loot.js authors but nothing
    // consumed: Dispel (kills summoned defender), StamLeech (heals
    // attacker stam), Fatigue (drains defender stam). ServUO
    // `BaseWeapon.OnHit:3281` for Fatigue: `defender.Stam -= dmg * (100 -
    // HitFatigue) / 100` (i.e. proportional to the attribute value).
    if ((a.hitDispel | 0) > 0 && defender.summoned
        && Math.random() * 100 < a.hitDispel) {
      // Flag for the caller — we don't have `world` here, but combat
      // dispatch can check `result.dispelSummon` and call destroyMobile.
      result.dispelSummon = true;
    }
    if ((a.hitStamLeech | 0) > 0 && Math.random() * 100 < a.hitStamLeech
        && (attacker.stam ?? 0) < (attacker.stamMax ?? 100)) {
      const gain = Math.max(1, Math.floor(baseDmg * 0.4));
      attacker.stam = Math.min(attacker.stamMax ?? 100,
        (attacker.stam ?? 0) + gain);
    }
    if ((a.hitFatigue | 0) > 0 && Math.random() * 100 < a.hitFatigue) {
      const drain = Math.max(1, Math.floor(baseDmg * (a.hitFatigue | 0) / 100));
      defender.stam = Math.max(0, (defender.stam ?? 0) - drain);
    }
  }

  // Wrestling Disarm (0xBF 0x09) — on the next successful hit within the
  // 4 s arm window, drop the defender's wielded weapon into their pack.
  // ServUO `WrestlingDisarm.cs:OnHit`. We expose a flag so the dispatch
  // path in handlers.js / world/world.js can perform the inventory move
  // — combat-formulas should stay free of world mutation.
  if (defender && (attacker?._pendingDisarm ?? 0) > now) {
    attacker._pendingDisarm = 0;
    result.disarmDefender = true;
  }
  // Wrestling Stun (0xBF 0x0A) — stamps a 4 s paralyze flag on the
  // defender (consumed by movement.js + the AI freeze check).
  if (defender && (attacker?._pendingStun ?? 0) > now) {
    attacker._pendingStun = 0;
    defender._paralyzedUntil = Math.max(defender._paralyzedUntil ?? 0, now + 4000);
    result.stunDefender = true;
  }
  // Rampage mastery: successful hits build a short swing-speed stack.
  if ((attacker?._rampageUntil ?? 0) > now) {
    attacker._rampageStacks = Math.min(5, (attacker._rampageStacks | 0) + 1);
    attacker._rampageUntil = now + 12_000;
  }

  // Damage Eater — defender attribute: % of dmg dealt healed back.
  // ServUO BaseArmor caps at 15 %; we honour ATTR_CAPS.damageEater (15).
  // Heals at *next* tick boundary, not synchronously, but for our model
  // we apply the heal immediately — close enough and avoids a queue.
  const de = (_attrs(defender)?.damageEater | 0);
  if (de > 0 && (defender.hp | 0) > 0 && baseDmg > 0) {
    // Bug-hunt #11 #2 — ServUO `BaseArmor.OnHit` rate-limits DamageEater
    // via `m_NextEaterTime` (~10s). Was firing every swing, making a
    // 15% DE target effectively unkillable under sustained pressure.
    const now = Date.now();
    if ((defender._nextEaterAt ?? 0) <= now) {
      const heal = Math.max(1, Math.floor(baseDmg * de / 100));
      const max = defender.hpMax | 0;
      defender.hp = Math.min(max, (defender.hp | 0) + heal);
      defender._nextEaterAt = now + 10_000;
    }
  }
  return result;
}
