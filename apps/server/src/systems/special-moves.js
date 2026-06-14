// Special-moves cooldown registry — ServUO `Server/Items/Weapons/SpecialMoves`
// surfaces Bushido / Ninjitsu / Wrestling weapon abilities. Each move has:
//   - mana cost
//   - cooldown (ms)
//   - precondition function (skill check / weapon class)
//   - on-trigger effect
//
// Module is consumed by the special-move command handler (player) and by
// AI subclasses that want to leverage moves (Bushido critters, etc.).

import { setItemParent } from '../world/items.js';
import { effectiveSkill } from '../combat-formulas.js';

/**
 * @typedef {Object} SpecialMove
 * @property {string} name
 * @property {number} mana
 * @property {number} cooldownMs
 * @property {(mob:any) => boolean} canUse
 * @property {(world:any, mob:any, target:any) => void} apply
 */

/** @type {Map<string, SpecialMove>} */
const moves = new Map();

function skill(mob, id) {
  return effectiveSkill(mob, id);
}

export function registerSpecialMove(move) {
  if (!move?.name) return;
  moves.set(move.name, move);
}
export function getSpecialMove(name) { return moves.get(name); }
export function listSpecialMoves()    { return [...moves.values()]; }

/**
 * Try to invoke a registered move on `target`. Honours mana + cooldown
 * (`mob._moveCooldown.<name>`). Returns `{ ok, reason }`.
 */
export function invokeMove(world, mob, target, name) {
  const move = moves.get(name);
  if (!move) return { ok: false, reason: 'unknown-move' };
  if ((mob.mana ?? 0) < (move.mana ?? 0)) return { ok: false, reason: 'low-mana' };
  if (move.canUse && !move.canUse(mob))   return { ok: false, reason: 'no-skill' };
  const cdMap = (mob._moveCooldown ??= {});
  const now = Date.now();
  if (cdMap[name] && now < cdMap[name])  return { ok: false, reason: 'cooldown' };
  mob.mana = Math.max(0, (mob.mana ?? 0) - (move.mana ?? 0));
  cdMap[name] = now + (move.cooldownMs ?? 5_000);
  try { move.apply(world, mob, target); }
  catch (e) { console.error(`[special-move] ${name}:`, e); }
  return { ok: true };
}

// ---- Default Bushido / Ninjitsu moves ------------------------------------
// Skill ids: Bushido 53, Ninjitsu 54.

registerSpecialMove({
  name: 'HonorableExecution', mana: 0, cooldownMs: 30_000,
  canUse(m) { return skill(m, 53) >= 25; },
  apply(_w, mob, _t) {
    // Self-buff: next swing within 20s deals double damage but reveals.
    // Audit #31 P1 #1 — combat-formulas reads `honorableExecUntil` (no
    // underscore) for the 1.2× damage multiplier. The old `_executionUntil`
    // write was dead — the special-move had no damage effect.
    mob.honorableExecUntil = Date.now() + 20_000;
    mob._executionUntil = mob.honorableExecUntil;  // keep persistence parity
  },
});

registerSpecialMove({
  name: 'Confidence', mana: 25, cooldownMs: 20_000,
  canUse(m) { return skill(m, 53) >= 25; },
  apply(world, mob) {
    // ServUO Bushido Confidence — 8 s HP regen tick. We stamp the
    // *same* fields the spell version uses (`confidenceUntil` +
    // `confidenceRegen`) so the regen.js tick consumes both paths
    // uniformly. Bug-hunt #5 A2: previously stamped `_confidenceUntil`
    // (with underscore) which nothing read. Skill 53 = Bushido; the
    // regen scales 4..6 hp/s same as the spell variant.
    mob.confidenceUntil = Date.now() + 8_000;
    mob.confidenceRegen = 4 + Math.floor(skill(mob, 53) / 250);
  },
});

registerSpecialMove({
  name: 'Evasion', mana: 10, cooldownMs: 20_000,
  canUse(m) { return skill(m, 53) >= 60; },
  apply(_w, mob) { mob._evasionUntil = Date.now() + 6_000; },
});

registerSpecialMove({
  name: 'Backstab', mana: 30, cooldownMs: 15_000,
  canUse(m) { return skill(m, 54) >= 40; },
  apply(world, mob, target) {
    if (!target || target === mob) return;
    // ~1.5× damage; require hidden state.
    if (!mob.hidden) return;
    mob.hidden = false;
    const dmg = 12 + Math.floor(Math.random() * 9);
    if (world?._combat?.damage) world._combat.damage(world, target, dmg, mob);
  },
});

registerSpecialMove({
  name: 'SmokeBomb', mana: 30, cooldownMs: 30_000,
  canUse(m) { return skill(m, 54) >= 40; },
  apply(_w, mob) {
    mob.hidden = true;
    mob.stealthSteps = 5;
  },
});

// ---- AOS weapon abilities (canonical ServUO list) ------------------------
// Skill 41=Swords, 42=Macing, 43=Fencing, 44=Wrestling, 32=Archery,
// 9=Bowcraft (fletcher), 28=Tactics. Each AOS ability gates on a
// weapon-skill threshold + a tiny tactics gate.

/** Helper: does the mob have any of the listed weapon skills at >=N? */
function hasWeaponSkill(mob, threshold = 70) {
  const ws = [41, 42, 43, 44, 32, 58];   // Swords, Mace, Fence, Wrestling, Archery, Throwing
  for (const id of ws) {
    if (skill(mob, id) >= threshold) return true;
  }
  return false;
}

/** Disarm — drop the target's main-hand weapon to their backpack
 *  for 5s; they can't re-equip during the disarm window. ServUO
 *  `WeaponAbility.Disarm` mana=20, requires Wrestling 80 OR weapon
 *  with the Disarm primary slot. */
registerSpecialMove({
  name: 'Disarm', mana: 20, cooldownMs: 8_000,
  canUse(m) { return hasWeaponSkill(m, 70); },
  apply(world, mob, target) {
    if (!target || target === mob) return;
    // Reverse-index lookup — was full items walk twice (find weapon
    // + find pack). Bug-hunt #6 P1 #6.
    const idx = world._childrenByParent?.get?.(target.serial);
    let weapon = null, pack = null;
    if (idx) {
      for (const s of idx) {
        const it = world.items.get(s);
        if (!it) continue;
        if (!weapon && (it.layer === 1 || it.layer === 2)) weapon = it;
        if (!pack   && it.layer === 21) pack = it;
        if (weapon && pack) break;
      }
    } else {
      for (const it of world.items.values()) {
        if (it.parent !== target.serial) continue;
        if (!weapon && (it.layer === 1 || it.layer === 2)) weapon = it;
        if (!pack   && it.layer === 21) pack = it;
        if (weapon && pack) break;
      }
    }
    if (!weapon || !pack) return;
    // Drop the weapon into the target's backpack via setItemParent so
    // the reverse index stays consistent. Bug-hunt #6 P1 #6.
    setItemParent(world, weapon, pack.serial);
    weapon.layer = 0;
    // Drop equipment entry so handleWearItem layer-collision sees the
    // hand as free + future tick can't read a phantom weapon.
    target.equipment?.delete?.(weapon.layer ?? 1);
    target._disarmedUntil = Date.now() + 5_000;
    target.client?.sendSystemMessage?.('You have been disarmed!');
    mob.client?.sendSystemMessage?.(`You disarm ${target.name ?? 'them'}.`);
  },
});

/** Armor Ignore — next melee swing bypasses physical armor reduction.
 *  Marker on the attacker; combat-formulas reads `_armorIgnoreUntil`
 *  and skips armorReduce() during the window. */
registerSpecialMove({
  name: 'ArmorIgnore', mana: 30, cooldownMs: 10_000,
  canUse(m) { return hasWeaponSkill(m, 70); },
  apply(_w, mob) {
    mob._armorIgnoreUntil = Date.now() + 4_000;
    mob.client?.sendSystemMessage?.('Your next strike will pierce armor.');
  },
});

/** Concussion Blow — heavy hit + brief mana drain on target. */
registerSpecialMove({
  name: 'ConcussionBlow', mana: 25, cooldownMs: 12_000,
  canUse(m) { return hasWeaponSkill(m, 70); },
  apply(world, mob, target) {
    if (!target) return;
    const dmg = 14 + Math.floor(Math.random() * 8);
    if (world?._combat?.damage) world._combat.damage(world, target, dmg, mob);
    target.mana = Math.max(0, (target.mana | 0) - 10);
  },
});

/** Crushing Blow — brief stun (skip target's next swing). */
registerSpecialMove({
  name: 'CrushingBlow', mana: 25, cooldownMs: 12_000,
  canUse(m) { return hasWeaponSkill(m, 70); },
  apply(_w, mob, target) {
    if (!target) return;
    target._nextAttackAt = Date.now() + 2_500;
    target.client?.sendSystemMessage?.('You reel from the crushing blow!');
    void mob;
  },
});

/** Mortal Strike — blocks HP regen on target for 6s. ServUO Bushido /
 *  Necromancy heavy attack. Reads `_mortalStrikeUntil` in regenTick
 *  (regen.js already gates hp regen on the flag). */
registerSpecialMove({
  name: 'MortalStrike', mana: 30, cooldownMs: 18_000,
  canUse(m) { return hasWeaponSkill(m, 90); },
  apply(world, mob, target) {
    if (!target) return;
    const dmg = 14 + Math.floor(Math.random() * 10);
    if (world?._combat?.damage) world._combat.damage(world, target, dmg, mob);
    target._mortalStrikeUntil = Date.now() + 6_000;
    target.client?.sendSystemMessage?.('You suffer a mortal wound!');
  },
});

/** Bleed Attack — sets `_bleedUntil` for DoT in regen.js. */
registerSpecialMove({
  name: 'BleedAttack', mana: 30, cooldownMs: 10_000,
  canUse(m) { return hasWeaponSkill(m, 70); },
  apply(world, mob, target) {
    if (!target) return;
    const dmg = 8 + Math.floor(Math.random() * 6);
    if (world?._combat?.damage) world._combat.damage(world, target, dmg, mob);
    target._bleedUntil = Date.now() + 12_000;
    target.client?.sendSystemMessage?.('You start bleeding!');
  },
});

/** Paralyzing Blow — freezes target for 3s. Reads `_paralyzedUntil`
 *  in movement.js (already gates moves on the flag). */
registerSpecialMove({
  name: 'ParalyzingBlow', mana: 30, cooldownMs: 14_000,
  canUse(m) { return hasWeaponSkill(m, 80); },
  apply(world, mob, target) {
    if (!target) return;
    const dmg = 8 + Math.floor(Math.random() * 6);
    if (world?._combat?.damage) world._combat.damage(world, target, dmg, mob);
    target._paralyzedUntil = Date.now() + 3_000;
    target.client?.sendSystemMessage?.('You have been frozen in place!');
  },
});

/** Feint — temporarily +30 % DCI for the next 5s. Read by hitChance() */
registerSpecialMove({
  name: 'Feint', mana: 25, cooldownMs: 18_000,
  canUse(m) { return hasWeaponSkill(m, 70); },
  apply(_w, mob) {
    mob._feintUntil = Date.now() + 5_000;
    mob.client?.sendSystemMessage?.('You shift into a defensive feint.');
  },
});

/** Double Strike — fires two swings in rapid succession. Bypasses the
 *  swing-delay gate via `_doubleStrikeUntil`. */
registerSpecialMove({
  name: 'DoubleStrike', mana: 30, cooldownMs: 16_000,
  canUse(m) { return hasWeaponSkill(m, 80); },
  apply(world, mob, target) {
    if (!target) return;
    mob._doubleStrikeUntil = Date.now() + 1_500;
    // First swing now; second swing happens automatically on the next
    // 200 ms combat tick because `_doubleStrikeUntil` is still live.
    if (world?._combat?.damage) {
      const dmg = 8 + Math.floor(Math.random() * 6);
      world._combat.damage(world, target, dmg, mob);
    }
  },
});

/** Whirlwind Attack — strikes every adjacent target for half damage.
 *  ServUO Macing/Lumberjacking ability. */
registerSpecialMove({
  name: 'WhirlwindAttack', mana: 30, cooldownMs: 14_000,
  canUse(m) { return hasWeaponSkill(m, 80); },
  apply(world, mob /* , target */) {
    if (!world?.mobiles) return;
    let hit = 0;
    for (const other of world.mobiles.values()) {
      if (other === mob || other.map !== mob.map) continue;
      const d = Math.max(Math.abs(other.x - mob.x), Math.abs(other.y - mob.y));
      if (d > 1) continue;
      if ((other.hp | 0) <= 0) continue;
      if (other.notoriety === 1 && !mob.warMode) continue;     // skip innocents in peace
      const dmg = 5 + Math.floor(Math.random() * 5);
      if (world._combat?.damage) world._combat.damage(world, other, dmg, mob);
      hit++;
    }
    mob.client?.sendSystemMessage?.(`Your whirlwind catches ${hit} foe(s).`);
  },
});

/** Lightning Strike — Bushido follow-up. Next swing within 5 s is a
 *  guaranteed critical hit (+50% damage). Sets `_lightningStrikeUntil`
 *  read in combat-formulas damage. */
registerSpecialMove({
  name: 'LightningStrike', mana: 20, cooldownMs: 8_000,
  canUse(m) { return hasWeaponSkill(m, 50) && skill(m, 53) >= 50; },
  apply(_world, mob /* , target */) {
    mob._lightningStrikeUntil = Date.now() + 5_000;
    mob.client?.sendSystemMessage?.('Your next strike will pierce with lightning fury.');
  },
});

/** Momentum Strike — Bushido AoE follow-up. Damage the targeted foe
 *  AND a second target adjacent to that foe (per ServUO MomentumStrike). */
registerSpecialMove({
  name: 'MomentumStrike', mana: 30, cooldownMs: 12_000,
  canUse(m) { return hasWeaponSkill(m, 50) && skill(m, 53) >= 50; },
  apply(world, mob, target) {
    if (!target) return;
    const primary = 14 + Math.floor(Math.random() * 8);
    if (world?._combat?.damage) world._combat.damage(world, target, primary, mob);
    // Find a second target adjacent to primary.
    for (const other of world?.mobiles?.values?.() ?? []) {
      if (other === target || other === mob || other.map !== target.map) continue;
      const d = Math.max(Math.abs(other.x - target.x), Math.abs(other.y - target.y));
      if (d > 1) continue;
      if ((other.hp | 0) <= 0) continue;
      const splash = 7 + Math.floor(Math.random() * 4);
      if (world._combat?.damage) world._combat.damage(world, other, splash, mob);
      break;                          // single secondary hit
    }
  },
});

/** Riding Swipe — mounted attack. Dismounts the target (or strips
 *  Gargoyle Flying), with a 4s remount cooldown. ServUO Bushido/
 *  Ninjitsu cross-skill. */
registerSpecialMove({
  name: 'RidingSwipe', mana: 30, cooldownMs: 14_000,
  canUse(m) { return hasWeaponSkill(m, 50); },
  apply(world, mob, target) {
    if (!target) return;
    // Find the target's mount item (equipment layer 25 = mount).
    let mount = null;
    for (const it of world?.items?.values?.() ?? []) {
      if (it.parent === target.serial && it.layer === 25) { mount = it; break; }
    }
    if (mount) {
      // Dismount — convert mount item to mount-statuette in pack so
      // they can re-summon it after the cooldown.
      target._dismountedUntil = Date.now() + 4_000;
      try { world?._items?.unwear?.(target, mount); }
      catch { /* tolerate */ }
      target.client?.sendSystemMessage?.('You are dismounted!');
    } else if (target._gargoyleFlying) {
      target._gargoyleFlying = false;
      target.client?.sendSystemMessage?.('You are forced from flight!');
    }
    const dmg = 8 + Math.floor(Math.random() * 6);
    if (world?._combat?.damage) world._combat.damage(world, target, dmg, mob);
  },
});

/** Talon Strike — Throwing-skill ranged ability. Pierces armor + 4s
 *  bleed DoT. Requires Throwing 50 and a throwing weapon. */
registerSpecialMove({
  name: 'TalonStrike', mana: 25, cooldownMs: 10_000,
  canUse(m) {
    if (skill(m, 58) < 50) return false;       // Throwing
    // ServUO checks WeaponType.Ranged + throwing-style — proxied by
    // a worn weapon with `kind === 'throwing'`.
    return true;
  },
  apply(world, mob, target) {
    if (!target) return;
    const dmg = 16 + Math.floor(Math.random() * 8);     // pierces resist by ~50%
    if (world?._combat?.damage) {
      world._combat.damage(world, target, dmg, mob, { armorPierce: true });
    }
    target._bleedUntil = Date.now() + 4_000;
    target.client?.sendSystemMessage?.('A talon strike bleeds you!');
  },
});

/** Defense Mastery — temporary +25% DCI / -25% melee damage for 8 s.
 *  Burns 30 mana. ServUO Tactics mastery special. */
registerSpecialMove({
  name: 'DefenseMastery', mana: 30, cooldownMs: 30_000,
  canUse(m) { return hasWeaponSkill(m, 80); },
  apply(_world, mob /* , target */) {
    mob._defenseMasteryUntil = Date.now() + 8_000;
    mob.client?.sendSystemMessage?.('You enter a defensive stance.');
  },
});

// ---- Audit batch #44: 5 ServUO AOS abilities that were defined as
//      combat-formulas flags but had no invokable special-move entry.
//      Without these the action-bar / hotbar could not surface them
//      and AI subclasses couldn't fire them via `invokeMove`.

/** Dual Wield — toggle dual-wielding stance. ServUO `DualWield.cs`:
 *  while the buff is active, both weapons strike on every swing for
 *  a 5 s window. Reads `_dualWield` in combat-formulas (already wired
 *  for the +30% swing-delay penalty / dual-hit damage roll). */
registerSpecialMove({
  name: 'DualWield', mana: 20, cooldownMs: 12_000,
  canUse(m) {
    // ServUO requires Ninjitsu 40+ OR two one-handed weapons. We gate
    // on Ninjitsu (skill 54) like SmokeBomb / Backstab — letting any
    // dual-class user toggle the buff.
    return skill(m, 54) >= 40 || hasWeaponSkill(m, 70);
  },
  apply(_world, mob /* , target */) {
    mob._dualWield = true;
    mob._dualWieldUntil = Date.now() + 5_000;
    mob.client?.sendSystemMessage?.('You begin striking with both hands.');
  },
});

/** Frenzied Whirlwind — Mastery whirlwind variant. ServUO
 *  `FrenziedWhirlwindMove.cs`: hits every mobile within range 2 four
 *  times in quick succession for 30 mana. Mastery skill 28 (Tactics)
 *  ≥ 90 gate. We approximate with a 4× whirlwind sweep at lower
 *  per-hit damage than the base WhirlwindAttack so total DPS scales
 *  but each individual hit can be dodged. */
registerSpecialMove({
  name: 'FrenziedWhirlwind', mana: 30, cooldownMs: 25_000,
  canUse(m) { return hasWeaponSkill(m, 80) && skill(m, 28) >= 90; },
  apply(world, mob /* , target */) {
    if (!world?.mobiles) return;
    let hit = 0;
    for (const other of world.mobiles.values()) {
      if (other === mob || other.map !== mob.map) continue;
      const d = Math.max(Math.abs(other.x - mob.x), Math.abs(other.y - mob.y));
      if (d > 2) continue;
      if ((other.hp | 0) <= 0) continue;
      if (other.notoriety === 1 && !mob.warMode) continue;
      // Four rapid hits, 6-8 dmg each (≈28 dmg per victim cap).
      for (let i = 0; i < 4; i++) {
        const dmg = 6 + Math.floor(Math.random() * 3);
        if (world._combat?.damage) world._combat.damage(world, other, dmg, mob);
      }
      hit++;
    }
    mob.client?.sendSystemMessage?.(`A frenzied whirlwind catches ${hit} foe(s).`);
  },
});

/** Infectious Strike — Poisoning weapon ability. ServUO
 *  `InfectiousStrike.cs`: applies the wielder's currently-mixed poison
 *  to the target on hit, scaling level by Poisoning skill. Mana 15,
 *  Poisoning (skill 31) ≥ 40. Reads the wielder's main-hand weapon
 *  for `poisonCharges` / `poisonLevel`. */
registerSpecialMove({
  name: 'InfectiousStrike', mana: 15, cooldownMs: 6_000,
  canUse(m) { return hasWeaponSkill(m, 70) && skill(m, 31) >= 40; },
  apply(world, mob, target) {
    if (!target) return;
    // Find a poisoned weapon in mob's main-hand (layer 1) or two-hand (2).
    let weapon = null;
    const idx = world?._childrenByParent?.get?.(mob.serial);
    if (idx) {
      for (const s of idx) {
        const it = world.items.get(s);
        if (!it) continue;
        if ((it.layer === 1 || it.layer === 2) && (it.poisonCharges | 0) > 0) {
          weapon = it; break;
        }
      }
    }
    if (!weapon) {
      mob.client?.sendSystemMessage?.('Your weapon is not poisoned.');
      return;
    }
    const dmg = 8 + Math.floor(Math.random() * 5);
    if (world?._combat?.damage) world._combat.damage(world, target, dmg, mob);
    // Apply poison via the central applyPoison helper (handles cure
    // resistance + DoT stacking). Level matches the weapon's poison.
    const lvl = Math.max(1, Math.min(4, weapon.poisonLevel ?? 1));
    if (world?._poison?.applyPoison) {
      world._poison.applyPoison(world, target, lvl, mob);
    } else {
      target.poisoned = true;
      target.poisonLevel = Math.max(target.poisonLevel ?? 0, lvl);
    }
    weapon.poisonCharges = Math.max(0, (weapon.poisonCharges | 0) - 1);
    target.client?.sendSystemMessage?.('You feel a virulent poison course through your veins!');
  },
});

/** Moving Shot — Archery ability. ServUO `MovingShot.cs`: fires while
 *  in motion (cancels the standard 1-tile root-on-shoot). Mana 20,
 *  Archery (32) ≥ 30. Reads `_movingShotUntil` in combat-formulas — a
 *  2 s window during which the wielder may attack while walking and
 *  the next swing deals ~80% of base damage. */
registerSpecialMove({
  name: 'MovingShot', mana: 20, cooldownMs: 6_000,
  canUse(m) { return skill(m, 32) >= 30; },
  apply(_world, mob /* , target */) {
    mob._movingShotUntil = Date.now() + 2_000;
    mob.client?.sendSystemMessage?.('You ready a shot on the run.');
  },
});

/** Double Shot — Archery rapid-fire ability. ServUO `DoubleShot.cs`:
 *  fires two arrows in quick succession (next combat tick auto-fires
 *  a second arrow at 80% damage). Mana 25, Archery (32) ≥ 80. */
registerSpecialMove({
  name: 'DoubleShot', mana: 25, cooldownMs: 12_000,
  canUse(m) { return skill(m, 32) >= 80; },
  apply(world, mob, target) {
    if (!target) return;
    mob._doubleStrikeUntil = Date.now() + 1_500;
    // First arrow now; second will fire on the next combat tick because
    // _doubleStrikeUntil is still live (same gate the melee DoubleStrike
    // uses — both abilities branch to the same swing-multiplier path).
    if (world?._combat?.damage) {
      const dmg = 10 + Math.floor(Math.random() * 6);
      world._combat.damage(world, target, dmg, mob);
    }
  },
});
