// Skill Mastery active abilities — ServUO `Spells/Skill Masteries/` ports.
// Each ability is a one-shot or short-buff trigger, gated by mana,
// cooldown and (optional) skill prerequisite. Effects are intentionally
// browser-friendly: no persistent ticker per buff — we set a timestamp
// (`mob._<name>Until`) and let consumers (combat, regen, status-effects)
// inspect the flag on demand.
//
// API:
//   registerMastery(spec)        — append to registry
//   getMastery(name)             — lookup
//   listMasteries()              — enumerate (UI)
//   invokeMastery(world, mob, target, name) — perform; returns {ok,reason}
//
// Naming follows ServUO class names so existing references in
// systems/skill-masteries.js + commands/cast.js can map 1:1.

import { registerSpecialMove, getSpecialMove, invokeMove as _invokeSpecialMove } from './special-moves.js';
import { normalizeSkillValue } from '../combat-formulas.js';
import { registerSummon } from './pets/summon-expire.js';

const MASTERY_PREFIX = 'mastery:';

function skillValue(mob, id) {
  const raw = mob?.skills?.[id] ?? mob?.skills?.[String(id)] ?? 0;
  return normalizeSkillValue(raw);
}

/**
 * @typedef {Object} MasterySpec
 * @property {string} name
 * @property {number} mana
 * @property {number} cooldownMs
 * @property {string} [school]   bushido|ninjitsu|bard|melee|caster|ranged|tame
 * @property {(mob:any) => boolean} [canUse]
 * @property {(world:any, mob:any, target:any) => void} apply
 */

/** @type {Map<string, MasterySpec>} */
const _masteries = new Map();

export function registerMastery(spec) {
  if (!spec?.name) return;
  _masteries.set(spec.name, spec);
  // Mirror into special-moves so combat hooks (cast.js, [combat) can
  // dispatch through the existing pipeline.
  registerSpecialMove({
    name: MASTERY_PREFIX + spec.name,
    mana: spec.mana ?? 0,
    cooldownMs: spec.cooldownMs ?? 30_000,
    canUse: spec.canUse,
    apply: spec.apply,
  });
}

export function getMastery(name)   { return _masteries.get(name); }
export function listMasteries()    { return [..._masteries.values()]; }

export function invokeMastery(world, mob, target, name) {
  return _invokeSpecialMove(world, mob, target, MASTERY_PREFIX + name);
}

// Helpers ---------------------------------------------------------------

// Reserved for future per-mastery FX broadcasts; abilities currently use
// the `_combat.damage` path which broadcasts on its own.
function _broadcastFx(world, mob, fx) {
  if (!fx) return;
  for (const o of world.mobiles.values()) {
    if (!o.client || o.map !== mob.map) continue;
    if (Math.abs(o.x - mob.x) > 18 || Math.abs(o.y - mob.y) > 18) continue;
    o.client.send(fx);
  }
}
void _broadcastFx;

function damageIfTarget(world, target, amount, attacker) {
  if (!target || target === attacker) return;
  if (world?._combat?.damage) {
    world._combat.damage(world, target, amount, attacker);
  } else if (typeof target.hp === 'number') {
    target.hp = Math.max(0, target.hp - amount);
  }
}

function applyTimer(mob, key, ms) {
  mob[key] = Date.now() + ms;
}

// =====================================================================
//  PASSIVE / SELF-BUFFS
// =====================================================================

registerMastery({
  name: 'Toughness', mana: 30, cooldownMs: 60_000, school: 'melee',
  // +stamina regen + +HP cap for 60s. Encoded as a status-effect
  // marker; combat-formulas can read mob._toughnessUntil for the swing
  // resist. Consumers: regen.js, combat-formulas.js.
  apply(_w, mob) { applyTimer(mob, '_toughnessUntil', 60_000); },
});

registerMastery({
  name: 'Tolerance', mana: 25, cooldownMs: 60_000, school: 'melee',
  // +20 to all elemental resists for 60s.
  apply(_w, mob) { applyTimer(mob, '_toleranceUntil', 60_000); },
});

registerMastery({
  name: 'ManaShield', mana: 30, cooldownMs: 30_000, school: 'caster',
  // Damage taken first drains mana 2:1 until expiry or mana=0.
  apply(_w, mob) { applyTimer(mob, '_manaShieldUntil', 30_000); },
});

registerMastery({
  name: 'Rampage', mana: 50, cooldownMs: 90_000, school: 'melee',
  // Each successful hit grants +5% swing speed for 12s, stacking to 5x.
  apply(_w, mob) {
    applyTimer(mob, '_rampageUntil', 12_000);
    mob._rampageStacks = 0;
  },
});

registerMastery({
  name: 'WhiteTigerForm', mana: 50, cooldownMs: 120_000, school: 'caster',
  // Transform into white tiger; +AR, +damage, lose spells.
  apply(_w, mob) {
    applyTimer(mob, '_whiteTigerUntil', 60_000);
    mob._formBackup = { body: mob.body, name: mob.name };
    mob.body = 0xCD;                  // White Tiger body id
  },
});

registerMastery({
  name: 'StoneFormMastery', mana: 40, cooldownMs: 90_000, school: 'caster',
  apply(_w, mob) { applyTimer(mob, '_stoneFormUntil', 30_000); },
});

registerMastery({
  name: 'Conduit', mana: 50, cooldownMs: 180_000, school: 'caster',
  // No mana cost on next 5 spells in 30s (counter on mob).
  apply(_w, mob) {
    applyTimer(mob, '_conduitUntil', 30_000);
    mob._conduitCharges = 5;
  },
});

registerMastery({
  name: 'EtherealBurst', mana: 30, cooldownMs: 120_000, school: 'caster',
  // Restore 100 mana over 6s.
  apply(_w, mob) {
    applyTimer(mob, '_etherealBurstUntil', 6_000);
    mob._etherealBurstPool = 100;
  },
});

registerMastery({
  name: 'Rejuvinate', mana: 50, cooldownMs: 90_000, school: 'caster',
  // Cleanse all debuffs from self.
  apply(_w, mob) {
    if (Array.isArray(mob.statusEffects)) mob.statusEffects.length = 0;
    mob._rejuvenatedAt = Date.now();
  },
});

registerMastery({
  name: 'SummonReaper', mana: 65, cooldownMs: 240_000, school: 'caster',
  apply(world, mob) {
    applyTimer(mob, '_reaperUntil', 30_000);
    const reaper = world?.createMobile?.({
      name: 'summoned reaper',
      body: 0x4D,
      x: (mob.x ?? 0) + 1,
      y: mob.y ?? 0,
      z: mob.z ?? 0,
      map: mob.map ?? 1,
      hp: 80,
      hpMax: 80,
      mana: 40,
      manaMax: 40,
      stam: 60,
      stamMax: 60,
      str: 80,
      dex: 60,
      int: 40,
      notoriety: 1,
      skills: { 44: 80, 28: 80 },
    });
    if (!reaper) return;
    reaper.kind = 'summoned-reaper';
    reaper.summoned = true;
    reaper.summonedBy = mob.serial >>> 0;
    reaper.controlMaster = mob.serial >>> 0;
    reaper.summonedUntil = Date.now() + 30_000;
    reaper.ai = 'pet';
    reaper.aiState = { command: 'follow', targetSerial: mob.serial >>> 0 };
    registerSummon(world, reaper);
  },
});

// =====================================================================
//  AOE / TARGETED DAMAGE
// =====================================================================

registerMastery({
  name: 'Onslaught', mana: 50, cooldownMs: 30_000, school: 'melee',
  apply(world, mob, target) {
    const dmg = 25 + Math.floor(Math.random() * 15);
    damageIfTarget(world, target, dmg, mob);
    applyTimer(mob, '_onslaughtUntil', 8_000);
  },
});

registerMastery({
  name: 'Stagger', mana: 25, cooldownMs: 20_000, school: 'melee',
  // Slows target by 50% swing for 6s.
  apply(_w, _m, target) {
    if (target) applyTimer(target, '_staggerUntil', 6_000);
  },
});

registerMastery({
  name: 'Pierce', mana: 25, cooldownMs: 20_000, school: 'ranged',
  apply(world, mob, target) {
    const dmg = 18 + Math.floor(Math.random() * 12);
    damageIfTarget(world, target, dmg, mob);
  },
});

registerMastery({
  name: 'Thrust', mana: 25, cooldownMs: 20_000, school: 'melee',
  apply(world, mob, target) {
    const dmg = 22 + Math.floor(Math.random() * 14);
    damageIfTarget(world, target, dmg, mob);
  },
});

registerMastery({
  name: 'CalledShot', mana: 40, cooldownMs: 45_000, school: 'ranged',
  apply(world, mob, target) {
    if (!target) return;
    // Headshot: 2x damage, ignores shield, applies bleed. Bleed dmg
    // scales by attacker Anatomy + SS so a 100/100 grandmaster bleeds
    // harder than a 50/50 newbie. ServUO `BleedAttack.Damage`.
    const dmg = 30 + Math.floor(Math.random() * 20);
    damageIfTarget(world, target, dmg, mob);
    applyTimer(target, '_bleedUntil', 8_000);
    const anat = skillValue(mob, 2);                // Anatomy
    const ss   = skillValue(mob, 33);               // Spirit Speak
    target._bleedDmg = Math.max(3, 3 + Math.floor((anat + ss) / 40));
  },
});

registerMastery({
  name: 'FlamingShot', mana: 30, cooldownMs: 30_000, school: 'ranged',
  apply(world, mob, target) {
    const dmg = 18 + Math.floor(Math.random() * 12);
    damageIfTarget(world, target, dmg, mob);
    if (target) {
      applyTimer(target, '_burnUntil', 6_000);
      const anat = skillValue(mob, 2);
      target._burnDmg = Math.max(4, 4 + Math.floor(anat / 30));
    }
  },
});

registerMastery({
  name: 'Stab', mana: 25, cooldownMs: 20_000, school: 'melee',
  apply(world, mob, target) {
    const dmg = 14 + Math.floor(Math.random() * 10);
    damageIfTarget(world, target, dmg, mob);
  },
});

registerMastery({
  name: 'ShieldBash', mana: 35, cooldownMs: 30_000, school: 'melee',
  // Stuns target 2s + small dmg.
  apply(world, mob, target) {
    if (!target) return;
    damageIfTarget(world, target, 12 + Math.floor(Math.random() * 8), mob);
    applyTimer(target, '_paralyzeUntil', 2_000);
  },
});

registerMastery({
  name: 'FistsOfFury', mana: 30, cooldownMs: 25_000, school: 'melee',
  apply(world, mob, target) {
    // 3-strike combo: 3 quick damage rolls.
    for (let i = 0; i < 3; i++) {
      const d = 8 + Math.floor(Math.random() * 6);
      damageIfTarget(world, target, d, mob);
    }
  },
});

registerMastery({
  name: 'FocusedEye', mana: 40, cooldownMs: 30_000, school: 'ranged',
  // +50% hit chance for 12s.
  apply(_w, mob) { applyTimer(mob, '_focusedEyeUntil', 12_000); },
});

registerMastery({
  name: 'HeightenSenses', mana: 25, cooldownMs: 30_000, school: 'caster',
  // +reveal range, +parry chance.
  apply(_w, mob) { applyTimer(mob, '_heightenedUntil', 30_000); },
});

registerMastery({
  name: 'PlayingTheOdds', mana: 30, cooldownMs: 60_000, school: 'caster',
  apply(_w, mob) { applyTimer(mob, '_playingOddsUntil', 30_000); },
});

registerMastery({
  name: 'InjectedStrike', mana: 30, cooldownMs: 30_000, school: 'melee',
  apply(world, mob, target) {
    // Apply strong poison + small damage.
    damageIfTarget(world, target, 8, mob);
    if (target) applyTimer(target, '_poisonUntil', 12_000);
  },
});

// =====================================================================
//  BARD MASTERIES (also covered by bard-masteries.js spells; abilities
//  here are the slot-able ones from skill-masteries engine)
// =====================================================================

registerMastery({
  name: 'Inspire', mana: 16, cooldownMs: 20_000, school: 'bard',
  apply(_w, mob) { applyTimer(mob, '_inspireUntil', 30_000); },
});

registerMastery({
  name: 'Invigorate', mana: 24, cooldownMs: 30_000, school: 'bard',
  apply(_w, mob) {
    applyTimer(mob, '_invigorateUntil', 30_000);
    if (mob.hp != null && mob.hpMax != null) {
      mob.hp = Math.min(mob.hpMax, mob.hp + 25);
    }
  },
});

registerMastery({
  name: 'Resilience', mana: 16, cooldownMs: 25_000, school: 'bard',
  apply(_w, mob) { applyTimer(mob, '_resilienceUntil', 30_000); },
});

registerMastery({
  name: 'Perseverance', mana: 24, cooldownMs: 30_000, school: 'bard',
  apply(_w, mob) { applyTimer(mob, '_perseveranceUntil', 30_000); },
});

registerMastery({
  name: 'Tribulation', mana: 16, cooldownMs: 25_000, school: 'bard',
  apply(_w, _m, target) {
    if (target) applyTimer(target, '_tribulationUntil', 30_000);
  },
});

registerMastery({
  name: 'Despair', mana: 24, cooldownMs: 30_000, school: 'bard',
  apply(_w, _m, target) {
    if (target) applyTimer(target, '_despairUntil', 30_000);
  },
});

// =====================================================================
//  CASTER / MAGIC NICHE
// =====================================================================

registerMastery({
  name: 'MysticWeapon', mana: 30, cooldownMs: 30_000, school: 'caster',
  // Wield a magic weapon for 60s — combat-formulas reads mob._mysticWeaponUntil.
  apply(_w, mob) { applyTimer(mob, '_mysticWeaponUntil', 60_000); },
});

registerMastery({
  name: 'NetherBlast', mana: 50, cooldownMs: 45_000, school: 'caster',
  apply(world, mob, target) {
    const dmg = 25 + Math.floor(Math.random() * 18);
    damageIfTarget(world, target, dmg, mob);
  },
});

registerMastery({
  name: 'DeathRay', mana: 50, cooldownMs: 60_000, school: 'caster',
  apply(world, mob, target) {
    const dmg = 30 + Math.floor(Math.random() * 25);
    damageIfTarget(world, target, dmg, mob);
  },
});

registerMastery({
  name: 'ElementalFury', mana: 50, cooldownMs: 90_000, school: 'caster',
  // Random-element nuke; pick from fire/cold/poison/energy.
  apply(world, mob, target) {
    const dmg = 28 + Math.floor(Math.random() * 18);
    damageIfTarget(world, target, dmg, mob);
  },
});

registerMastery({
  name: 'HolyFist', mana: 40, cooldownMs: 60_000, school: 'caster',
  apply(world, mob, target) {
    const dmg = 25 + Math.floor(Math.random() * 15);
    damageIfTarget(world, target, dmg, mob);
  },
});

// =====================================================================
//  GROUP / TAME
// =====================================================================

registerMastery({
  name: 'BodyGuard', mana: 40, cooldownMs: 60_000, school: 'tame',
  apply(_w, mob) { applyTimer(mob, '_bodyGuardUntil', 30_000); },
});

registerMastery({
  name: 'CombatTraining', mana: 40, cooldownMs: 90_000, school: 'tame',
  apply(_w, mob) { applyTimer(mob, '_combatTrainingUntil', 60_000); },
});

registerMastery({
  name: 'CommandUndead', mana: 40, cooldownMs: 60_000, school: 'caster',
  apply(_w, mob, target) {
    if (target?.kind?.includes?.('undead') || target?.body === 0x18) {
      target._charmedBy = mob.serial;
      applyTimer(target, '_charmedUntil', 30_000);
    }
  },
});

registerMastery({
  name: 'Whispering', mana: 16, cooldownMs: 20_000, school: 'tame',
  // Pet bond stat regen.
  apply(_w, mob) { applyTimer(mob, '_whisperingUntil', 30_000); },
});

registerMastery({
  name: 'Warcry', mana: 30, cooldownMs: 60_000, school: 'melee',
  // Group damage buff for 30s in 8-tile radius.
  apply(world, mob) {
    applyTimer(mob, '_warcryUntil', 30_000);
    if (!world?.mobiles) return;
    for (const o of world.mobiles.values()) {
      if (o === mob) continue;
      if (o.map !== mob.map) continue;
      if (Math.max(Math.abs(o.x - mob.x), Math.abs(o.y - mob.y)) > 8) continue;
      // Same-party / pet: buff. Otherwise: nothing.
      if (o.partyId && o.partyId === mob.partyId) {
        applyTimer(o, '_warcryUntil', 30_000);
      }
    }
  },
});

registerMastery({
  name: 'PassiveMastery', mana: 0, cooldownMs: 0, school: 'caster',
  // Marker only — flag indicating the slot is in passive mode.
  apply(_w, mob) { mob._masteryPassive = true; },
});

registerMastery({
  name: 'Shadow', mana: 40, cooldownMs: 30_000, school: 'caster',
  apply(_w, mob) {
    applyTimer(mob, '_shadowUntil', 12_000);
    mob.hidden = true;
  },
});

// Sanity export so we can test the registry from outside.
export { _masteries as _masteriesForTest, getSpecialMove };
