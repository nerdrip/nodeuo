// Resource regen — a slow background tick that nudges HP, Mana and Stam
// back up toward their max values. Called from main.js at a 1 Hz cadence.
//
// ServUO uses skill-influenced regen (Healing/Anatomy + Meditation +
// Focus); we approximate with a simpler linear curve plus a Meditation
// boost on mana. Ghosts and dead mobiles don't regen — they have to
// resurrect first.

import { healthUpdate, manaUpdate, staminaUpdate } from '@uo/protocol';
import { effectiveSkill, racialManaRegenMul } from './combat-formulas.js';

const SKILL_MEDITATION = 47;
const SKILL_FOCUS      = 51;

// ENGINE NOTE — regen FORMULAS are settable from scripts via
// `setFormulas({ hpPerSecond, manaPerSecond, stamPerSecond })`. The
// engine ships baked-in defaults (below) so the server boots usable
// even without scripts; production shards override per-tier balance
// from apps/scripts/src/systems/regen.js.

let _hpFn = null, _manaFn = null, _stamFn = null;

export function setFormulas({ hpPerSecond: hp, manaPerSecond: mp, stamPerSecond: sp } = {}) {
  if (typeof hp === 'function') _hpFn = hp;
  if (typeof mp === 'function') _manaFn = mp;
  if (typeof sp === 'function') _stamFn = sp;
}

/**
 * Per-second regen rates (units of pool restored per second). HP rate scales
 * with hpMax so high-HP creatures don't take 5 minutes to top off; stam
 * scales with dex; mana scales with int and gets a meditation kicker.
 */
function hpPerSecondDefault(mob) {
  if ((mob.hp ?? 0) <= 0 || mob.ghost) return 0;
  const max = mob.hpMax ?? 50;
  if (mob.hp >= max) return 0;
  // FAZA DP: Camping "rested" buff doubles HP regen for the duration.
  // FAZA DS: 'sated' (food) also doubles regen. Stacking with rested
  // multiplies — players who eat AND camp get 4× regen, the canonical
  // ServUO "well-prepared adventurer" combo.
  let mult = 1;
  if (hasEffect(mob, 'rested')) mult *= 2;
  if (hasEffect(mob, 'sated'))  mult *= 2;
  return Math.max(0.1, (max / 100) * mult);
}

function hasEffect(mob, name) {
  const fx = mob?.effects;
  if (!fx) return false;
  // BUGFIX #87 (FAZA DS): regen ticks at 1 Hz but the status-effect
  // sweeper runs less often (every few seconds). Between sweeps an
  // expired effect would still be in `mob.effects` — players got a
  // few extra ticks of food/rest regen after the buff really should
  // have ended. Honour expiresAt directly here so the regen path is
  // tightly clamped to wall-clock duration.
  const now = Date.now();
  if (fx instanceof Map) {
    const e = fx.get(name);
    if (!e) return false;
    return !e.expiresAt || e.expiresAt > now;
  }
  if (Array.isArray(fx)) {
    return fx.some((e) => e?.name === name && (!e.expiresAt || e.expiresAt > now));
  }
  const e = fx[name];
  return Boolean(e) && (!e.expiresAt || e.expiresAt > now);
}

function stamPerSecondDefault(mob) {
  if ((mob.hp ?? 0) <= 0 || mob.ghost) return 0;
  const max = mob.stamMax ?? mob.dex ?? 50;
  if ((mob.stam ?? 0) >= max) return 0;
  return Math.max(0.5, (mob.dex ?? 50) / 50);
}

function manaPerSecondDefault(mob) {
  if ((mob.hp ?? 0) <= 0 || mob.ghost) return 0;
  const max = mob.manaMax ?? mob.int ?? 50;
  if ((mob.mana ?? 0) >= max) return 0;
  const base = (mob.int ?? 50) / 50;
  const med = effectiveSkill(mob, SKILL_MEDITATION) / 100;
  const focus = effectiveSkill(mob, SKILL_FOCUS) / 200;
  return Math.max(0.2, base * (1 + med + focus) * racialManaRegenMul(mob));
}

// Dispatchers — call script-supplied formula if registered, else default.
function hpPerSecond(mob) { return (_hpFn ?? hpPerSecondDefault)(mob); }
function manaPerSecond(mob) { return (_manaFn ?? manaPerSecondDefault)(mob); }
function stamPerSecond(mob) { return (_stamFn ?? stamPerSecondDefault)(mob); }

/**
 * Walk every mobile in the world, accumulating fractional regen on
 * `_regenAcc` and rolling whole-unit gains into hp/mana/stam. Sends
 * 0xA1/0xA2/0xA3 updates to the owning client only when a value changed
 * (avoids spamming the wire).
 *
 * @param {import('./world/world.js').World} world
 * @param {number} elapsedMs  ms since the previous tick (for fractional accumulation)
 */
export function regenTick(world, elapsedMs) {
  const seconds = elapsedMs / 1000;
  const now = Date.now();
  // 1-Hz callback runs against world.mobiles.values() (~11.7k after
  // createworld). 99 % of those NPCs sit at full pools with no DoT,
  // so the cheapest correctness-preserving optimisation is to skip
  // the per-mob math when every relevant condition reads as a no-op.
  // Each kept field is a tagged scalar — the read is essentially free
  // and the early-continue lets the JIT pop the iteration immediately.
  for (const mob of world.mobiles.values()) {
    const hpMax = mob.hpMax ?? 50;
    const maMax = mob.manaMax ?? 50;
    const stMax = mob.stamMax ?? 50;
    // Audit #40 P2 #15 — Mana Drain refund poll. The spell schedules a
    // 5-s setTimeout to return the drained mana; if the server saved
    // and restarted inside that window the timer died and the target
    // permanently lost the mana. Now we poll on the 1Hz tick and
    // refund whenever the timer has expired but the amount is still
    // stamped on the mob.
    if (mob._manaDrainAmount && now >= (mob._manaDrainUntil ?? 0)) {
      mob.mana = Math.min(mob.manaMax ?? 50, (mob.mana ?? 0) + mob._manaDrainAmount);
      mob._manaDrainAmount = 0;
      mob._manaDrainUntil = 0;
    }
    if ((mob.hp ?? 0) >= hpMax
        && (mob.mana ?? 0) >= maMax
        && (mob.stam ?? 0) >= stMax
        && !mob._regenAcc
        && !mob._bleedUntil && !mob._burnUntil
        && !mob._mortalStrikeUntil
        && !mob.effects) {
      continue;
    }
    const acc = mob._regenAcc ?? (mob._regenAcc = { hp: 0, mana: 0, stam: 0 });

    // Mortal Strike — Bushido / Necromancy effect that blocks all
    // hp regen for `mob._mortalStrikeUntil` ms (ServUO StatusEffect.cs:
    // MortalStrike duration = 6s). Mana / stam still tick to match
    // ServUO's MortalStrike.Effect implementation. Cleared once expired.
    const mortalActive = mob._mortalStrikeUntil && Date.now() < mob._mortalStrikeUntil;
    acc.hp += mortalActive ? 0 : hpPerSecond(mob) * seconds;
    acc.mana += manaPerSecond(mob) * seconds;
    acc.stam += stamPerSecond(mob) * seconds;
    if (!mortalActive && mob._mortalStrikeUntil) mob._mortalStrikeUntil = 0;

    let changed = { hp: false, mana: false, stam: false };

    if (acc.hp >= 1) {
      const gain = Math.floor(acc.hp);
      acc.hp -= gain;
      const max = mob.hpMax ?? 50;
      const before = mob.hp ?? 0;
      mob.hp = Math.min(max, before + gain);
      if (mob.hp !== before) changed.hp = true;
    }
    if (acc.mana >= 1) {
      const gain = Math.floor(acc.mana);
      acc.mana -= gain;
      const max = mob.manaMax ?? 50;
      const before = mob.mana ?? 0;
      mob.mana = Math.min(max, before + gain);
      if (mob.mana !== before) changed.mana = true;
    }
    if (acc.stam >= 1) {
      const gain = Math.floor(acc.stam);
      acc.stam -= gain;
      const max = mob.stamMax ?? 50;
      const before = mob.stam ?? 0;
      mob.stam = Math.min(max, before + gain);
      if (mob.stam !== before) changed.stam = true;
    }

    // Audit #32 P1 #4 — Lich Form HP drain. ServUO `LichForm.cs:84-87`
    // ticks `--m.Hits` every 2 seconds for the duration of the form
    // (and grants +13 mana regen / various resists). Was a no-op flag.
    // Mana regen is handled via the manaPerSecond curve already; we
    // just need the HP drain. Throttled to one tick per 2s via
    // `_lichDrainAt`.
    if ((mob.lichFormUntil ?? 0) > now) {
      if ((mob._lichDrainAt ?? 0) <= now && (mob.hp | 0) > 1) {
        mob.hp -= 1;
        mob._lichDrainAt = now + 2000;
        changed.hp = true;
      }
    } else if (mob.lichFormUntil) {
      mob.lichFormUntil = 0;
      mob._lichDrainAt = 0;
    }
    // Bushido Confidence — `confidenceUntil` + `confidenceRegen` set by
    // the spell (`systems/spells/bushido.js:402`). ServUO `Confidence`
    // grants 4-6 HP per second for 8 s. Was dead-code before; bug-hunt
    // #4 A2 fix. Counter-Attack / Evasion already have read-paths in
    // combat-formulas, so only Confidence needed a tick consumer.
    if ((mob.confidenceUntil | 0) > now) {
      const heal = mob.confidenceRegen | 0;
      if (heal > 0 && (mob.hp | 0) > 0) {
        const max = mob.hpMax ?? 50;
        const before = mob.hp ?? 0;
        mob.hp = Math.min(max, before + heal);
        if (mob.hp !== before) changed.hp = true;
      }
    } else if (mob.confidenceUntil) {
      mob.confidenceUntil = 0;
      mob.confidenceRegen = 0;
    }

    // Bleed / burn DoT — Mastery abilities (CalledShot, FlamingShot)
    // and a few necro effects stamp a `_bleedUntil` / `_burnUntil`
    // expiry on the target. Without this tick the timer counted down
    // but no damage ever fired, which is why "Headshot bleed" felt
    // free. ~3 hp/sec for the duration of the effect (matches
    // ServUO `BleedAttack` 4-pulse damage at 8s). Reuses the outer
    // `now` so the per-mob path takes one clock read.
    // DoT damage scales by the stamped `_bleedDmg` / `_burnDmg` field
    // (defaults 3/4 for legacy callers). Bug-hunt #8 #10 follow-up:
    // ServUO scales BleedAttack damage by attacker's Anatomy + SS;
    // callers that want that variability stamp the dmg field at cast
    // time. Without it we keep the flat tier.
    // Date.now() > 2^31 → don't use `| 0` (truncates to int32 → negative).
    if ((mob._bleedUntil ?? 0) > now && (mob.hp | 0) > 0) {
      const bleed = (mob._bleedDmg | 0) || 3;
      mob.hp = Math.max(0, (mob.hp | 0) - bleed);
      changed.hp = true;
      try { _onDoTDamage?.(world, mob, bleed); } catch { /* advisory */ }
    } else if (mob._bleedUntil) {
      mob._bleedUntil = 0;
      mob._bleedDmg = 0;
    }
    if ((mob._burnUntil ?? 0) > now && (mob.hp | 0) > 0) {
      const burn = (mob._burnDmg | 0) || 4;
      mob.hp = Math.max(0, (mob.hp | 0) - burn);
      changed.hp = true;
      try { _onDoTDamage?.(world, mob, burn); } catch { /* advisory */ }
    } else if (mob._burnUntil) {
      mob._burnUntil = 0;
      mob._burnDmg = 0;
    }

    if (mob.client) {
      if (changed.hp) {
        mob.client.send(healthUpdate({
          serial: mob.serial, current: mob.hp, max: mob.hpMax ?? 50,
        }));
      }
      if (changed.mana) {
        mob.client.send(manaUpdate({
          serial: mob.serial, current: mob.mana, max: mob.manaMax ?? 50,
        }));
      }
      if (changed.stam) {
        mob.client.send(staminaUpdate({
          serial: mob.serial, current: mob.stam, max: mob.stamMax ?? 50,
        }));
      }
    }
  }
}

/** Round-robin production wrapper. It caps work per event-loop turn while
 * preserving the elapsed time for a complete pass, so a 12k-NPC world no
 * longer creates a single 1 Hz spike and does not regenerate more slowly. */
export function regenTickBudgeted(world, elapsedMs, maxMobiles = 1024) {
  const budget = Math.max(1, maxMobiles | 0);
  let state = world._regenBudgetState;
  if (!state?.iterator) {
    state = world._regenBudgetState = {
      iterator: world.mobiles.values(), cycleElapsedMs: Math.max(0, elapsedMs),
      nextCycleElapsedMs: 0, completedCycles: 0,
    };
  }
  state.nextCycleElapsedMs += Math.max(0, elapsedMs);
  const selected = [];
  let completed = false;
  while (selected.length < budget) {
    const next = state.iterator.next();
    if (next.done) { completed = true; break; }
    selected.push(next.value);
  }
  if (selected.length) {
    const view = Object.create(world);
    view.mobiles = { values: () => selected.values() };
    regenTick(view, Math.max(1, state.cycleElapsedMs));
  }
  if (completed) {
    state.iterator = world.mobiles.values();
    state.cycleElapsedMs = Math.max(1, state.nextCycleElapsedMs);
    state.nextCycleElapsedMs = 0;
    state.completedCycles++;
  }
  return { processed: selected.length, remaining: !completed, completedCycles: state.completedCycles };
}

/** Late-bound damage broadcaster — main.js wires this to the
 *  `combat.damage` floating-number broadcast so DoT pulses paint
 *  the same red number above the victim's head. Optional. */
let _onDoTDamage = null;
export function setDotBroadcaster(fn) { _onDoTDamage = fn || null; }
