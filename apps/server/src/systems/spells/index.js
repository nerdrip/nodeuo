// Spell engine — the dispatcher and registry. Individual spell schools
// live in sibling files (chivalry.js, magery.js, …) and self-register by
// calling `registerSpell()` at module-load time. Add a new school = add a
// new file and import it here.
//
// Design split vs ServUO:
//   ServUO:  one `Spell` subclass per spell (200+ files), heavy OOP boilerplate.
//   Us:      one plain-object `SpellDef` per spell. Thin effect function,
//            cast pipeline is in `castSpell()`. Schools group into files
//            instead of individual classes. ~10× less code for parity.
//
// Spell-id convention matches ServUO (Magery 1-64, Necromancy 101-117,
// Chivalry 201-210, Bushido 401-405, Ninjitsu 501-508, Spellweaving
// 601-616, Mysticism 677-692, Mastery 701+).

import { playSound, manaUpdate } from '@uo/protocol';

/** Send a 0xA2 manaUpdate to the caster after debit/refund. ServUO
 *  `Mobile.Mana { set; }` auto-broadcasts via `Delta(MobileDelta.Mana)`;
 *  ours has bare assignment, so any mana mutation that skips this call
 *  leaves the client's mana bar visually frozen until the next regen
 *  tick (~1 Hz) updates it. User report 2026-05-19 "podczas rzucania
 *  zaklęć nie pokazuje się zmniejszenie many". */
function pushMana(mob) {
  if (!mob?.client) return;
  try {
    mob.client.send(manaUpdate({
      serial: mob.serial,
      current: mob.mana | 0,
      max: mob.manaMax ?? mob.mana ?? 0,
    }));
  } catch { /* socket transient */ }
}
import { effectiveSkill } from '../../combat-formulas.js';
import { effectiveAttributes } from '../../world/attributes.js';
import { getSpell, registerSpell, unregisterSpell, allSpells, spellsBySchool } from './registry.js';
import { manaCostFor as spellweavingCost, recordSpellweavingCast } from '../spellweaving.js';
import { tryConsumeReagents } from './reagents.js';
import { lineOfSight } from '../../world/los.js';
import { manaCost as specializationManaCost, castTimeMs as specializationCastTimeMs } from '../specializations.js';
import { runtimeGovernor } from '../runtime-governor.js';

/** Resolve the world-space point used for range/LOS checks. Items inside a
 * container carry gump-grid x/y values, so climb their parent chain first. */
function targetWorldPoint(world, target) {
  if (!target) return null;
  let current = target;
  const seen = new Set();
  while (current?.serial && world?.items?.get?.(current.serial >>> 0) === current && current.parent) {
    const serial = current.parent >>> 0;
    if (!serial || seen.has(serial)) break;
    seen.add(serial);
    const parent = world.mobiles?.get?.(serial) ?? world.items?.get?.(serial);
    if (!parent) break;
    current = parent;
  }
  return {
    x: current.x | 0, y: current.y | 0, z: current.z | 0,
    map: current.map ?? target.map ?? 1,
  };
}

function targetStillExists(world, target) {
  if (!target) return false;
  const serial = target.serial >>> 0;
  if (!serial) return Number.isFinite(target.x) && Number.isFinite(target.y);
  return world?.mobiles?.get?.(serial) === target || world?.items?.get?.(serial) === target;
}

// Re-export registry helpers so legacy callers importing from '../spells.js'
// (now '../systems/spells/index.js') keep working unchanged.
export { getSpell, registerSpell, unregisterSpell, allSpells, spellsBySchool };

/**
 * @typedef {Object} SpellDef
 * @property {number} id
 * @property {string} name
 * @property {string} school
 * @property {number} skillId
 * @property {number} minSkill   required skill × 10
 * @property {number} mana
 * @property {number} [tithing]      Chivalry-only
 * @property {number[]|number} [reagents] Optional authored reagent ids or
 *   legacy mask. Runtime consumption uses the normalized spell-id table
 *   installed in systems/spells/reagents.js.
 * @property {number} delayMs
 * @property {number} [soundId]
 * @property {boolean} [requiresTarget]
 * @property {(ctx: CastContext) => void} effect
 */

/**
 * @typedef {Object} CastContext
 * @property {import('../../world/world.js').Mobile} caster
 * @property {import('../../world/world.js').Mobile|null} target
 * @property {import('../../world/world.js').World} world
 * @property {Object} [deps]
 * @property {(world:any, victim:any, amount:number) => void} [deps.damage]
 * @property {Object} [deps.statusEffects]
 *
 * `deps` is wired up by the caller (server's cast handler injects
 * `combat` + `statusEffects`). Spell effects that need to deal damage
 * or apply status effects use `ctx.deps.damage(world, victim, n)` or
 * `ctx.deps.statusEffects.apply/remove(...)`. Without `deps` the spell
 * effect should still run — it just may silently no-op the bookkeeping
 * pieces, which is what the chivalry stubs do.
 */

/**
 * Cast dispatch — validates skill + cost, rolls fizzle probability,
 * consumes resources, schedules the effect callback.
 *
 * @param {CastContext & { spellId: number }} ctx
 * @returns {{ ok: boolean, reason?: string }}
 */
function castSpellCore(ctx) {
  const def = getSpell(ctx.spellId);
  if (!def) return { ok: false, reason: 'unknown-spell' };
  const c = ctx.caster;
  if (!c || (c.hp ?? 0) <= 0) return { ok: false, reason: 'dead' };

  const skill = effectiveSkill(c, def.skillId);
  const isScroll = !!ctx.scroll;
  // GM/Admin bypass the minimum-skill gate too. The mana/reagent/tithing
  // bypass below already exists; without skill bypass an admin with
  // default 50/30/20 skills couldn't cast circle 8 (Summon Daemon
  // requires Magery 80).
  const isStaffSkill = ctx.accessLevel === 'GM' || ctx.accessLevel === 'Admin'
    || ctx.accessLevel === 'Administrator';
  // ServUO scrolls intentionally let characters invoke a spell up to 20
  // skill points earlier than its memorised variant. The item-side check
  // already used this threshold, but this shared pipeline re-applied the
  // full requirement and rejected the cast afterwards.
  const requiredSkill = isScroll ? Math.max(0, (def.minSkill | 0) - 20) : def.minSkill;
  if (!isStaffSkill && skill < requiredSkill) {
    return { ok: false, reason: 'low-skill' };
  }
  // Custom spell graphs may attach an additional server-authoritative
  // progression gate.  Keeping the hook in the shared cast pipeline prevents
  // clients from bypassing research ranks by invoking the numeric spell id.
  if (typeof def.canCast === 'function') {
    const gate = def.canCast(ctx);
    if (gate === false || gate?.ok === false) {
      return { ok: false, reason: gate?.reason ?? 'spell-gated', details: gate };
    }
  }

  // Region spell gate — `regions.allowSpellcast` checks `blockedSpells`
  // lists + per-region `onSpell` hook. Town centers / jails / certain
  // dungeons reject specific spells. Bug-hunt #4 A3. Staff bypass.
  if (!isStaffSkill) {
    const regions = ctx.world?.regions;
    if (regions?.allowSpellcast) {
      try {
        if (!regions.allowSpellcast(c.map, c.x | 0, c.y | 0, def.id, c)) {
          c.client?.sendSystemMessage?.('That spell is forbidden in this region.');
          return { ok: false, reason: 'region-blocks-spell' };
        }
      } catch { /* advisory */ }
    }
  }

  // SpellChanneling gate — ServUO `Spell.OnCast` rejects the cast when
  // the wielder holds a weapon WITHOUT the SpellChanneling property.
  // Free hand or a channelling weapon → OK. Without this, mages could
  // freely chain combat swings + spells holding a 2H halberd. Read the
  // wielded item via `c._weapon` (set by handleEquip when a weapon
  // lands on layer 1 / 2). Staff bypass via accessLevel.
  if (!isStaffSkill) {
    const wpn = c?._weapon;
    if (wpn && !wpn.spellChanneling && !ctx.scroll) {
      c.client?.sendSystemMessage?.('You cannot cast while wielding that weapon.');
      return { ok: false, reason: 'no-channeling' };
    }
  }

  // Shared target gate. Previously every target was assumed to be a living
  // mobile, so location spells and item spells were discarded after their
  // cursor completed. Validate in world-space according to the actual kind.
  const targetPoint = def.requiresTarget ? targetWorldPoint(ctx.world, ctx.target) : null;
  if (def.requiresTarget && !targetPoint) return { ok: false, reason: 'missing-target' };
  if (targetPoint) {
    if ((targetPoint.map ?? c.map) !== c.map) return { ok: false, reason: 'different-map' };
    const distance = Math.max(
      Math.abs(targetPoint.x - (c.x | 0)),
      Math.abs(targetPoint.y - (c.y | 0)),
    );
    if (distance > (def.range ?? 12)) return { ok: false, reason: 'out-of-range' };
  }

  // LOS gate. Contained items use the position of their owning mobile,
  // rather than their backpack-grid x/y coordinates.
  if (def.requiresTarget && targetPoint && ctx.target !== c) {
    const tx = targetPoint.x | 0, ty = targetPoint.y | 0;
    if (tx !== (c.x | 0) || ty !== (c.y | 0)) {
      if (!lineOfSight(c.map, c, targetPoint)) {
        c.client?.sendSystemMessage?.('Target cannot be seen.');
        return { ok: false, reason: 'no-los' };
      }
    }
  }
  // FAZA HA: GM+ bypass mana/tithing here too. ctx.accessLevel is the
  // caller-supplied staff flag — passed by handlers.dispatchCast when
  // the player's account access level is GM or Admin.
  // ctx.scroll: scroll cast bypasses BOTH mana cost AND reagent
  // consumption (the scroll itself is the cost; the dispatcher is
  // expected to consume the scroll item). Mirrors ServUO `Spell.OnScrollCast`.
  const isStaff = ctx.accessLevel === 'GM' || ctx.accessLevel === 'Admin'
    || ctx.accessLevel === 'Administrator';
  // Spellweaving cumulative cost — cast charge stacks (manaCostFor inflates).
  // Audit #30 P1 #2 — apply AOS Lower Mana Cost (cap 40 %) and Mind Rot
  // (Necromancy debuff, +50 % cost). Previously only `[cast` chat command
  // honored LMC; the spellbook icon + 0x12 macro path skipped it entirely,
  // so full LMC-40 gear had zero effect through the gump. ServUO
  // `Spell.cs::ScaleMana` runs unconditionally.
  let manaCost = def.school === 'spellweaving' ? spellweavingCost(c, def.mana) : def.mana;
  try {
    const attrs = effectiveAttributes(c) ?? {};
    const lmc = Math.min(40, attrs.lowerManaCost | 0);
    let mul = 1 - lmc / 100;
    if ((c._mindRotUntil ?? 0) > Date.now()) mul *= 1.5;
    manaCost = Math.max(1, Math.floor(manaCost * mul));
  } catch { /* attributes optional for unit tests */ }
  manaCost = specializationManaCost(c, manaCost);
  if (!isStaff && !isScroll) {
    const usesTithing = def.school === 'chivalry' && def.tithing;
    if (!usesTithing && (c.mana ?? 0) < manaCost) return { ok: false, reason: 'low-mana' };
    // Audit #42 P1 #4 — canonical field is `tithingPoints` (see
    // `cast.js:79-83` + persistence whitelist). Was: read `c.tithing`
    // (undefined) → AI paladins always got `low-tithing` and could
    // not cast Chivalry through the registry path.
    if (def.tithing && (c.tithingPoints ?? 0) < def.tithing) {
      return { ok: false, reason: 'low-tithing' };
    }
    // Reagent gate — magery + necromancy consume one of each reagent
    // from the caster's backpack. Atomic: refuses cast and charges
    // nothing if any reagent is missing. Schools without reagents
    // (chivalry/bushido/ninjitsu/spellweaving/mysticism) pass through.
    if (!tryConsumeReagents(ctx.world, c, def.id)) {
      c.client?.sendSystemMessage?.('You lack the reagents for this spell.');
      return { ok: false, reason: 'no-reagents' };
    }
    if (!usesTithing) {
      c.mana -= manaCost;
      pushMana(c);
    }
    if (def.tithing) c.tithingPoints = Math.max(0, (c.tithingPoints ?? 0) - def.tithing);
  }

  // ServUO `DefaultSpellBookTable` formula translated to our 0..120
  // runtime skill scale:
  //   p = (skill - (minSkill - 25)) / 50,   clamped to [0.5, 1]
  const floor = def.minSkill - 25;
  const successChance = isStaff
    ? 1
    : Math.min(1, Math.max(0.5, (skill - floor) / 50));
  if (Math.random() > successChance) {
    // BUGFIX #90 (FAZA DV): fizzle previously kept the full mana cost.
    // ServUO `Spell.cs::DoFizzle` refunds half the mana.
    // BUGFIX #115 (FAZA HA): refund only when costs were actually
    // charged. GM+ bypass-cost path skipped the c.mana -= def.mana
    // line, so applying the +half refund put their mana ABOVE manaMax.
    if (!isStaff && !(def.school === 'chivalry' && def.tithing)) {
      c.mana += Math.floor(manaCost / 2);
      pushMana(c);
    }
    c.client?.sendSystemMessage?.('The spell fizzles.');
    // Audible feedback on failed cast — ServUO `Spell.cs::DoFizzle`
    // plays sound 0x5C (FizzleSound). Without this fizzle was silent
    // and looked identical to a successful cast for a moment.
    if (typeof ctx.deps?.playSoundNear === 'function') {
      try { ctx.deps.playSoundNear(ctx.world, c, 0x5C); }
      catch { /* non-fatal */ }
    } else if (c.client) {
      c.client.send(playSound({
        soundId: 0x5C, volume: 0xFF, x: c.x, y: c.y, z: c.z,
      }));
    }
    return { ok: true, reason: 'fizzled' };
  }

  // Wave 38: play the cast sound to every nearby viewer, not just the
  // caster's own client — without this, a wizard casting Fireball was
  // silent to anyone standing next to him. Falls back to the
  // solo-caster send when `playSoundNear` isn't wired.
  if (def.soundId) {
    if (typeof ctx.deps?.playSoundNear === 'function') {
      try { ctx.deps.playSoundNear(ctx.world, c, def.soundId); }
      catch { /* keep caster path going even if broadcast fails */ }
    } else if (c.client) {
      c.client.send(playSound({
        soundId: def.soundId, volume: 0xFF, x: c.x, y: c.y, z: c.z,
      }));
    }
  }

  // Wave 38: cast gesture animation. Action 0x10 = "cast directed"
  // (most magery / chivalry / necromancy spells), 0x11 = "cast area"
  // (mass spells like Earthquake / Mass Curse — heuristic: marked via
  // `def.areaCast`). Broadcast via the deps `animate` callback so all
  // nearby observers see the gesture, not just the caster.
  if (typeof ctx.deps?.animate === 'function') {
    const action = def.areaCast ? 0x11 : 0x10;
    try { ctx.deps.animate(ctx.world, c, action, { frameCount: 7, repeatCount: 1 }); }
    catch { /* non-fatal */ }
  }

  // Spell power-words above the caster's head — UO classic mage chants
  // ("In Vas Mani" etc) the moment they begin casting. `def.mantra` is
  // populated by the spells/index.js bridge from SPELL_MANTRAS. Fire
  // BEFORE the cast-delay timer so the words appear at the same instant
  // as the gesture, not when the effect lands.
  if (def.mantra && ctx.deps?.broadcastSpellWords) {
    try { ctx.deps.broadcastSpellWords(ctx.world, c, def.mantra); }
    catch { /* non-fatal */ }
  }

  // delayMs:0 = stance/buff with no cast bar — execute synchronously
  // (Bushido/Ninjitsu stances). Otherwise schedule like the original.
  const runEffect = () => {
    // BH #13 B6 — caster may have been destroyed (corpse, [del,
    // disconnect-and-cleanup) between cast start and effect. Without
    // this guard the timer fires `def.effect(ctx)` on a stale mob ref
    // and lifedrain spells crash on `caster.hp += dmg` for a deleted
    // mob.
    if (!ctx.world?.mobiles?.has?.(c.serial)) {
      c._castTimer = null;
      c._castDef = null;
      c._castManaRefund = 0;
      return;
    }
    // Bug-hunt #9 #5 — re-validate target between cast start and effect.
    // The cast bar may have ticked through with the target now dead /
    // out of map / out of range. Without this, Flamestrike / Energy Bolt
    // call applyDamage on a stale mob object (corpse already created,
    // mob removed from `world.mobiles`).
    if (ctx.target) {
      const w = ctx.world;
      const t = ctx.target;
      const point = targetWorldPoint(w, t);
      const stillThere = targetStillExists(w, t)
        && point?.map === c.map
        && Math.max(Math.abs(point.x - c.x), Math.abs(point.y - c.y)) <= (def.range ?? 12);
      if (!stillThere) {
        c._castTimer = null;
        c._castDef = null;
        return;
      }
    }
    if ((c.hp ?? 0) <= 0) {
      c._castTimer = null;
      c._castDef = null;
      return;
    }
    // Clear `_castTimer` BEFORE the effect so `disturbCast` invoked
    // from inside the effect (reflect damage onto caster) sees "no cast
    // active" and short-circuits cleanly. `_castDef` is cleared AFTER
    // so spell-school taggers (e.g. spellweaving record) still see it.
    c._castTimer = null;
    try { def.effect(ctx); }
    catch (e) { console.error(`[spell] ${def.name} effect threw:`, e); }
    c._castDef = null;
    if (def.school === 'spellweaving') recordSpellweavingCast(c);
  };
  // ctx.instant: scroll cast — short-circuit the cast bar entirely.
  // ServUO `ScrollHandlers` calls Spell.OnScrollCast which sets
  // CastDelayBase = 0 for scroll casts. Mirror by skipping the timer.
  if (def.delayMs > 0 && !ctx.instant) {
    // Track the pending cast so a damage hit can disturb it (ServUO
    // Spell.Disturb). Casters can only have one active cast bar at a
    // time — clear any prior one defensively.
    if (c._castTimer) clearTimeout(c._castTimer);
    c._castDef = def;
    c._castManaRefund = (isStaff || isScroll || (def.school === 'chivalry' && def.tithing))
      ? 0
      : Math.floor(manaCost / 2);
    c._castTimer = setTimeout(runEffect, specializationCastTimeMs(c, def.delayMs));
  } else {
    runEffect();
  }

  return { ok: true };
}

export function castSpell(ctx) {
  const tx = runtimeGovernor.transactions.begin('cast', {
    correlationId: ctx.correlationId ?? `cast:${ctx.caster?.serial ?? 0}:${Date.now().toString(36)}`,
    caster: ctx.caster?.serial >>> 0, spellId: ctx.spellId | 0,
  });
  ctx.correlationId = tx.details.correlationId;
  try {
    const result = castSpellCore(ctx);
    runtimeGovernor.transactions.event(tx, result?.ok ? 'cast.accepted' : 'cast.rejected', { reason: result?.reason ?? '' });
    if (result?.ok) runtimeGovernor.transactions.commit(tx);
    else runtimeGovernor.transactions.rollback(tx, result?.reason ?? 'rejected');
    return result;
  } catch (error) {
    runtimeGovernor.transactions.rollback(tx, error?.message ?? error);
    throw error;
  }
}

/**
 * Cancel the caster's in-progress cast (ServUO `Spell.Disturb`). Used
 * by damage paths and movement-disrupt to interrupt mid-cast spells.
 * Refunds half the mana (matches DoFizzle behavior) and notifies the
 * caster's client. No-op when no spell is in flight.
 */
export function disturbCast(caster) {
  if (!caster || !caster._castTimer) return false;
  clearTimeout(caster._castTimer);
  const refund = caster._castManaRefund | 0;
  if (refund > 0) {
    caster.mana = Math.min(caster.manaMax ?? caster.mana ?? 0, (caster.mana ?? 0) + refund);
    pushMana(caster);
  }
  caster._castTimer = null;
  caster._castDef = null;
  caster._castManaRefund = 0;
  caster.client?.sendSystemMessage?.('Your spell was disrupted.');
  return true;
}

// Spell schools (definitions + effects) now live in apps/scripts/src/spells/schools/
// and self-register at runtime via the script loader. The dispatcher above
// (castSpell, disturbCast) is engine-only — it knows NOTHING about specific
// spells, just how to validate + run a registered SpellDef.
