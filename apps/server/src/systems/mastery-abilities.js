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
import { applyPoison, forceCure } from '../poison.js';
import { apply as applyStatusEffect, remove as removeStatusEffect } from '../status-effects.js';

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
 * @property {boolean} [requiresTarget]
 * @property {'mobile'|'location'} [targetKind]
 * @property {boolean} [harmful]
 * @property {(target:any,mob:any,world:any) => boolean|string} [validateTarget]
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
  const spec = getMastery(name);
  if (!spec) return { ok: false, reason: 'unknown-mastery' };
  if (spec.requiresTarget && !target) return { ok: false, reason: 'target-required' };
  if (spec.targetKind === 'mobile' && (!target?.serial || target === mob && spec.harmful)) {
    return { ok: false, reason: 'invalid-target' };
  }
  if (spec.targetKind === 'location' && (!Number.isFinite(target?.x) || !Number.isFinite(target?.y))) {
    return { ok: false, reason: 'invalid-target' };
  }
  const validation = spec.validateTarget?.(target, mob, world);
  if (validation !== undefined && validation !== true) {
    return { ok: false, reason: typeof validation === 'string' ? validation : 'invalid-target' };
  }
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
  apply(world, mob) {
    const durationMs = 30_000;
    const bonus = Math.max(2, Math.min(8, Math.floor((skillValue(mob, 56) + skillValue(mob, 51)) / 24)));
    applyTimer(mob, '_stoneFormUntil', durationMs);
    mob._stoneForm = true;
    mob._stoneFormWalkOnly = true;
    mob._stoneFormDmgBonus = Math.max(1, Math.floor(bonus / 2));
    const overlay = mob._resistOverlay ?? (mob._resistOverlay = {});
    for (const type of ['physical', 'fire', 'cold', 'poison', 'energy']) {
      overlay[type] = (overlay[type] | 0) + bonus;
    }
    mob._resBagDirty = true;
    applyStatusEffect(mob, {
      name: 'stone-form-mastery', durationMs,
      onRemove(target) {
        target._stoneFormUntil = 0;
        target._stoneForm = false;
        target._stoneFormWalkOnly = false;
        target._stoneFormDmgBonus = 0;
        const current = target._resistOverlay ?? {};
        for (const type of ['physical', 'fire', 'cold', 'poison', 'energy']) {
          current[type] = (current[type] | 0) - bonus;
        }
        if (!current.physical && !current.fire && !current.cold && !current.poison && !current.energy) {
          target._resistOverlay = null;
        }
        target._resBagDirty = true;
      },
    });
    void world;
  },
});

registerMastery({
  name: 'Conduit', mana: 50, cooldownMs: 180_000, school: 'caster',
  requiresTarget: true, targetKind: 'location',
  // Necromancy damage dealt to a target in this zone is echoed to other
  // valid creatures in the zone. Spell scripts consume the area metadata.
  apply(_w, mob, target) {
    const durationMs = Math.max(4_000, Math.min(10_000,
      4_000 + Math.floor((skillValue(mob, 49) + skillValue(mob, 33)) * 28)));
    applyTimer(mob, '_conduitUntil', durationMs);
    mob._conduitArea = {
      x: target.x | 0, y: target.y | 0, map: target.map ?? mob.map,
      radius: 3,
    };
    mob._conduitStrength = Math.max(0.2, Math.min(1,
      (skillValue(mob, 49) + skillValue(mob, 33)) / 250));
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
  name: 'Rejuvinate', mana: 10, cooldownMs: 90_000, school: 'caster',
  requiresTarget: true, targetKind: 'mobile',
  // Restore one third of the target's missing vitals and cleanse harmful
  // effects. Keep beneficial effects intact: clearing the entire effect list
  // used to remove the target's buffs and still missed the real `effects[]`.
  apply(world, mob, target) {
    const recipient = target ?? mob;
    for (const [current, maximum] of [['hp', 'hpMax'], ['stam', 'stamMax'], ['mana', 'manaMax']]) {
      const max = Math.max(0, recipient[maximum] ?? 0);
      const value = Math.max(0, recipient[current] ?? 0);
      recipient[current] = Math.min(max, value + Math.ceil((max - value) / 3));
    }
    forceCure(recipient, world);
    for (const name of [
      'clumsy', 'feeblemind', 'weaken', 'curse', 'mass-curse', 'evil-omen',
      'strangle', 'corpse-skin', 'blood-oath-curse', 'mind-rot', 'paralyze',
    ]) removeStatusEffect(recipient, name, world);
    for (const key of [
      '_paralyzedUntil', '_mortalStrikeUntil', '_bleedUntil', '_burnUntil',
      '_despairUntil', 'statDebuffUntil', 'evilOmenUntil',
    ]) recipient[key] = 0;
    recipient._rejuvenatedAt = Date.now();
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
  requiresTarget: true, targetKind: 'mobile', harmful: true,
  apply(world, mob, target) {
    const dmg = 25 + Math.floor(Math.random() * 15);
    damageIfTarget(world, target, dmg, mob);
    applyTimer(mob, '_onslaughtUntil', 8_000);
  },
});

registerMastery({
  name: 'Stagger', mana: 25, cooldownMs: 20_000, school: 'melee',
  requiresTarget: true, targetKind: 'mobile', harmful: true,
  // Slows target by 50% swing for 6s.
  apply(_w, _m, target) {
    if (target) applyTimer(target, '_staggerUntil', 6_000);
  },
});

registerMastery({
  name: 'Pierce', mana: 25, cooldownMs: 20_000, school: 'ranged',
  requiresTarget: true, targetKind: 'mobile', harmful: true,
  apply(world, mob, target) {
    const dmg = 18 + Math.floor(Math.random() * 12);
    damageIfTarget(world, target, dmg, mob);
  },
});

registerMastery({
  name: 'Thrust', mana: 25, cooldownMs: 20_000, school: 'melee',
  requiresTarget: true, targetKind: 'mobile', harmful: true,
  apply(world, mob, target) {
    const dmg = 22 + Math.floor(Math.random() * 14);
    damageIfTarget(world, target, dmg, mob);
  },
});

registerMastery({
  name: 'CalledShot', mana: 40, cooldownMs: 45_000, school: 'ranged',
  requiresTarget: true, targetKind: 'mobile', harmful: true,
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
  requiresTarget: true, targetKind: 'mobile', harmful: true,
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
  requiresTarget: true, targetKind: 'mobile', harmful: true,
  apply(world, mob, target) {
    const dmg = 14 + Math.floor(Math.random() * 10);
    damageIfTarget(world, target, dmg, mob);
  },
});

registerMastery({
  name: 'ShieldBash', mana: 35, cooldownMs: 30_000, school: 'melee',
  requiresTarget: true, targetKind: 'mobile', harmful: true,
  // Stuns target 2s + small dmg.
  apply(world, mob, target) {
    if (!target) return;
    damageIfTarget(world, target, 12 + Math.floor(Math.random() * 8), mob);
    applyTimer(target, '_paralyzedUntil', 2_000);
  },
});

registerMastery({
  name: 'FistsOfFury', mana: 30, cooldownMs: 25_000, school: 'melee',
  requiresTarget: true, targetKind: 'mobile', harmful: true,
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
  requiresTarget: true, targetKind: 'mobile', harmful: true,
  apply(world, mob, target) {
    // Apply strong poison + small damage.
    damageIfTarget(world, target, 8, mob);
    if (target) applyPoison(target, 3, mob);
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
  apply(world, mob) {
    const recipients = [mob];
    const party = world?._partyRegistry?.partyOf?.(mob.serial);
    for (const serial of party?.members ?? []) {
      const member = world.mobiles?.get?.(serial >>> 0);
      if (member && member !== mob && member.map === mob.map
          && Math.max(Math.abs(member.x - mob.x), Math.abs(member.y - mob.y)) <= 10) {
        recipients.push(member);
      }
    }
    for (const recipient of recipients) {
      applyTimer(recipient, '_invigorateUntil', 30_000);
      recipient._invigorateNextHealAt = Date.now() + 4_000;
      if (recipient.hp != null && recipient.hpMax != null) {
        recipient.hp = Math.min(recipient.hpMax, recipient.hp + 25);
      }
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
  requiresTarget: true, targetKind: 'mobile', harmful: true,
  apply(_w, _m, target) {
    if (target) applyTimer(target, '_tribulationUntil', 30_000);
  },
});

registerMastery({
  name: 'Despair', mana: 24, cooldownMs: 30_000, school: 'bard',
  requiresTarget: true, targetKind: 'mobile', harmful: true,
  apply(_w, _m, target) {
    if (target) {
      applyTimer(target, '_despairUntil', 30_000);
      target.statDebuffUntil = target._despairUntil;
      target.statDebuffPct = 0.10;
      target._despairDmg = 10;
      target._despairNextTickAt = Date.now() + 2_000;
    }
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
  requiresTarget: true, targetKind: 'mobile', harmful: true,
  apply(world, mob, target) {
    const dmg = 25 + Math.floor(Math.random() * 18);
    damageIfTarget(world, target, dmg, mob);
  },
});

registerMastery({
  name: 'DeathRay', mana: 50, cooldownMs: 60_000, school: 'caster',
  requiresTarget: true, targetKind: 'mobile', harmful: true,
  apply(world, mob, target) {
    const dmg = 30 + Math.floor(Math.random() * 25);
    damageIfTarget(world, target, dmg, mob);
  },
});

registerMastery({
  name: 'ElementalFury', mana: 50, cooldownMs: 90_000, school: 'caster',
  requiresTarget: true, targetKind: 'mobile', harmful: true,
  // Random-element nuke; pick from fire/cold/poison/energy.
  apply(world, mob, target) {
    const dmg = 28 + Math.floor(Math.random() * 18);
    damageIfTarget(world, target, dmg, mob);
  },
});

registerMastery({
  name: 'HolyFist', mana: 40, cooldownMs: 60_000, school: 'caster',
  requiresTarget: true, targetKind: 'mobile', harmful: true,
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
  requiresTarget: true, targetKind: 'mobile', harmful: true,
  validateTarget(target) {
    if (target?.controlled || target?.summoned || target?.isBoss || target?.boss) return 'invalid-target';
    return target?.kind?.includes?.('undead') || target?.body === 0x18 || 'not-undead';
  },
  apply(world, mob, target) {
    if (!(target?.kind?.includes?.('undead') || target?.body === 0x18)) return;
    const previous = {
      controlMaster: target.controlMaster ?? null,
      controlled: !!target.controlled,
      controlOrder: target.controlOrder ?? null,
      controlTarget: target.controlTarget ?? null,
    };
    target._charmedBy = mob.serial >>> 0;
    applyTimer(target, '_charmedUntil', 30_000);
    target.controlMaster = mob.serial >>> 0;
    target.controlled = true;
    target.controlOrder = 'follow';
    target.controlTarget = mob.serial >>> 0;
    target.combatTarget = null;
    applyStatusEffect(target, {
      name: 'command-undead', durationMs: 30_000,
      onRemove(undead) {
        undead._charmedBy = 0;
        undead._charmedUntil = 0;
        undead.controlMaster = previous.controlMaster;
        undead.controlled = previous.controlled;
        undead.controlOrder = previous.controlOrder;
        undead.controlTarget = previous.controlTarget;
      },
    });
    world?._ai?.wake?.(target, mob);
  },
});

registerMastery({
  name: 'Whispering', mana: 40, cooldownMs: 1_800_000, school: 'tame',
  // Enhance skill/training gains of controlled pets in range.
  apply(world, mob) {
    applyTimer(mob, '_whisperingUntil', 600_000);
    for (const pet of world?.mobiles?.values?.() ?? []) {
      if ((pet.controlMaster >>> 0) !== (mob.serial >>> 0) || pet.map !== mob.map) continue;
      if (Math.max(Math.abs(pet.x - mob.x), Math.abs(pet.y - mob.y)) > 10) continue;
      applyTimer(pet, '_whisperingUntil', 600_000);
      pet._whisperingGainBonus = 0.25;
    }
  },
});

registerMastery({
  name: 'Warcry', mana: 30, cooldownMs: 60_000, school: 'melee',
  // Group damage buff for 30s in 8-tile radius.
  apply(world, mob) {
    applyTimer(mob, '_warcryUntil', 30_000);
    if (!world?.mobiles) return;
    const party = world._partyRegistry?.partyOf?.(mob.serial);
    for (const serial of party?.members ?? []) {
      const other = world.mobiles.get(serial >>> 0);
      if (!other || other === mob || other.map !== mob.map) continue;
      if (Math.max(Math.abs(other.x - mob.x), Math.abs(other.y - mob.y)) > 8) continue;
      applyTimer(other, '_warcryUntil', 30_000);
    }
    for (const pet of world.mobiles.values()) {
      if ((pet.controlMaster >>> 0) !== (mob.serial >>> 0) || pet.map !== mob.map) continue;
      if (Math.max(Math.abs(pet.x - mob.x), Math.abs(pet.y - mob.y)) <= 8) {
        applyTimer(pet, '_warcryUntil', 30_000);
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
