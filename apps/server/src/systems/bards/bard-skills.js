// Bard skills — Discordance / Provocation / Peacemaking core engine.
// Mirrors ServUO `Skills/Discordance.cs`, `Skills/Provocation.cs`,
// `Skills/Peacemaking.cs`. All three need a Musicianship roll first
// (`musicCheck`) plus a held instrument; the actual effect then runs
// off the secondary skill.
//
// Effects are encoded as transient `mob._<effect>Until` timestamps so
// combat-formulas / regen / AI can read them on demand without a
// per-tick sweeper.
//
// Audit #42 P1 #5 — was MUSICIANSHIP=29 (Snooping per skills.json:30)
// and PROVOCATION=22 (Hiding). Canonical IDs:
//   30 = Musicianship, 16 = Discordance, 23 = Provocation, 10 = Peacemaking.
// Snooping bards passed music checks trivially; high-stealth reds
// provoked perfectly.
import { normalizeSkillValue } from '../../combat-formulas.js';

const MUSICIANSHIP = 30;
const DISCORDANCE  = 16;
const PROVOCATION  = 23;
const PEACEMAKING  = 10;

// Standard Bard cooldown (ServUO = ~5s + skill bonus).
const BARD_COOLDOWN_MS = 8_000;

function skillValue(mob, id) {
  const raw = mob?.skills?.[id] ?? mob?.skills?.[String(id)] ?? 0;
  return normalizeSkillValue(raw);
}

/** Roll a Musicianship check against the instrument quality + targeting
 *  range. Returns true on success. */
export function musicCheck(mob, instrument) {
  const skill = skillValue(mob, MUSICIANSHIP);
  const quality = (instrument?.quality ?? 0); // -25..+25 (ServUO)
  const chance = (skill + quality) / 100;
  return Math.random() < Math.max(0.05, Math.min(0.95, chance));
}

/** Apply Discordance — slows target's attacks + reduces combat skills.
 *  Mirrors ServUO `Discordance.OnTarget`. Effect lasts 30s. */
export function applyDiscordance(world, bard, target, instrument) {
  if (!bard || !target) return { ok: false, reason: 'no-target' };
  if (Date.now() < (bard._bardCooldownUntil ?? 0)) return { ok: false, reason: 'cooldown' };
  if (!musicCheck(bard, instrument))            return _failMusic(bard, instrument);

  const bardSkill = skillValue(bard, DISCORDANCE);
  const targetResist = (skillValue(target, 27) + (target.fame ?? 0) / 10);
  if (bardSkill < targetResist) {
    bard._bardCooldownUntil = Date.now() + BARD_COOLDOWN_MS;
    return { ok: false, reason: 'too-tough' };
  }

  // Audit #31 P2 #8 — ServUO `Discordance.cs::OnTarget`:
  //   penaltyPct = max(0.04, min(0.28, skill/4 / 100))
  //   effect lasts until the bard leaves range; 15 s grace after they
  //   step > 8 tiles away or change facets. Was: flat 30 s + flat 30 %.
  // We track the leash via `_discordLeashFrom`+`_discordGracedUntil`;
  // the keep-alive sweep below renews `_discordedUntil` while the
  // bard stays close. After the grace window the penalty expires and
  // the next combat tick drops the buff naturally.
  const penalty = Math.max(0.04, Math.min(0.28, bardSkill / 4 / 100));
  target._discordedUntil = Date.now() + 60_000;     // initial window; refreshed by leash
  target._discordPenaltyPct = penalty;
  target._discordSourceSerial = bard.serial >>> 0;
  bard._bardCooldownUntil = Date.now() + BARD_COOLDOWN_MS;
  _startDiscordLeash(world, bard, target);
  return { ok: true, durationMs: 60_000, penaltyPct: penalty };
}

/** Audit #31 P2 #8 — ServUO ticks Discordance every 1.25 s; while the
 *  bard remains within 8 tiles and on the same map, the effect window
 *  keeps refreshing. Stepping out starts a 15 s grace timer; if the
 *  bard returns the leash resumes. Otherwise the effect lapses. */
function _startDiscordLeash(world, bard, target) {
  _cancelDiscordLeash(target);
  const start = Date.now();
  const tick = () => {
    if (!target || (target.hp ?? 0) <= 0) {
      _cancelDiscordLeash(target);
      return;
    }
    const now = Date.now();
    // Hard ceiling so a forgotten interval never runs forever.
    if (now - start > 10 * 60_000) {
      _cancelDiscordLeash(target);
      return;
    }
    const inRange = bard
      && bard.map === target.map
      && Math.max(Math.abs(bard.x - target.x), Math.abs(bard.y - target.y)) <= 8;
    if (inRange) {
      target._discordedUntil = now + 5_000;          // refresh ahead of tick
      target._discordGracedUntil = 0;
    } else {
      if (!target._discordGracedUntil) target._discordGracedUntil = now + 15_000;
      if (now > target._discordGracedUntil) {
        // Lapse — let the buff expire naturally; no need to mutate
        // since `_discordedUntil` is already older than `now`.
        _cancelDiscordLeash(target);
        target._discordPenaltyPct = 0;
        target._discordedUntil = 0;
      }
    }
  };
  target._discordLeashTimer = world?._scheduler?.every
    ? world._scheduler.every(`bard-discord:${target.serial >>> 0}`, 1_250, tick)
    : setInterval(tick, 1_250);
  target._discordLeashTimer.unref?.();
}

function _cancelDiscordLeash(target) {
  const handle = target?._discordLeashTimer;
  if (typeof handle?.cancel === 'function') handle.cancel();
  else if (handle) clearInterval(handle);
  if (target) target._discordLeashTimer = null;
}

/** Audit #35 P2 #5 — wrap a music-check failure with the canonical
 *  penalty. ServUO `Provocation/Peacemaking/Discordance.cs`: a failed
 *  music roll locks the skill for ~10 s AND consumes one instrument
 *  charge. Previously the fail path returned immediately with no
 *  cooldown, so players could spam-retry until music passes for free. */
function _failMusic(bard, instrument, world) {
  bard._bardCooldownUntil = Date.now() + BARD_COOLDOWN_MS;
  if (instrument) {
    instrument.usesRemaining = (instrument.usesRemaining ?? 10) - 1;
    // Audit #43 P2-14 — ServUO `BaseInstrument.cs:262-274 ConsumeUse`
    // deletes the instrument at 0 charges. Was: kept ticking down past
    // 0 → infinite-use lute.
    if (instrument.usesRemaining <= 0 && world?.destroyItem) {
      try { world.destroyItem(instrument.serial); }
      catch { /* item already gone */ }
      bard?.client?.sendSystemMessage?.('Your instrument breaks.');
    }
  }
  return { ok: false, reason: 'failed-music' };
}

/** Apply Provocation — make A attack B. Both must be aggressive type. */
export function applyProvocation(world, bard, mobA, mobB, instrument) {
  if (!bard || !mobA || !mobB) return { ok: false, reason: 'no-target' };
  if (mobA === mobB)            return { ok: false, reason: 'same-target' };
  if (mobA.client || mobB.client) return { ok: false, reason: 'cant-target-players' };
  // Audit #35 P2 #4 — ServUO `Provocation.cs:58-60` refuses player-
  // controlled creatures with cliloc 501590 "They are too loyal to
  // their master to be provoked." A bard could otherwise pit two
  // players' pets against each other.
  if (mobA.controlMaster || mobB.controlMaster) return { ok: false, reason: 'too-loyal' };
  if (Date.now() < (bard._bardCooldownUntil ?? 0)) return { ok: false, reason: 'cooldown' };
  if (!musicCheck(bard, instrument))               return _failMusic(bard, instrument);

  const bardSkill = skillValue(bard, PROVOCATION);
  const sumResist = (((mobA.fame ?? 0) + (mobB.fame ?? 0)) / 10);
  if (bardSkill < sumResist) {
    bard._bardCooldownUntil = Date.now() + BARD_COOLDOWN_MS;
    return { ok: false, reason: 'too-tough' };
  }

  // Set combat target on A → B and on B → A.
  mobA._provokedTarget = mobB.serial >>> 0;
  mobA._provokedUntil  = Date.now() + 60_000;
  mobB._provokedTarget = mobA.serial >>> 0;
  mobB._provokedUntil  = Date.now() + 60_000;
  bard._bardCooldownUntil = Date.now() + BARD_COOLDOWN_MS;
  return { ok: true };
}

/** Apply Peacemaking — area calm or single-target. */
export function applyPeacemaking(world, bard, instrument, opts = {}) {
  if (Date.now() < (bard._bardCooldownUntil ?? 0)) return { ok: false, reason: 'cooldown' };
  if (!musicCheck(bard, instrument))               return _failMusic(bard, instrument);

  const radius = opts.radius ?? 8;
  const dur = 10_000;
  const skill = skillValue(bard, PEACEMAKING);
  let calmed = 0;
  if (opts.target) {
    // Single-target: calm one mob.
    opts.target._peacefulUntil = Date.now() + dur;
    delete opts.target._provokedTarget;
    calmed = 1;
  } else {
    // AoE: calm everyone in `radius` whose fame*5 < bard skill.
    if (!world?.mobiles) return { ok: false, reason: 'no-world' };
    for (const m of world.mobiles.values()) {
      if (m === bard) continue;
      if (m.map !== bard.map) continue;
      if (Math.max(Math.abs(m.x - bard.x), Math.abs(m.y - bard.y)) > radius) continue;
      const resist = (m.fame ?? 0) * 5;
      if (skill <= resist) continue;
      m._peacefulUntil = Date.now() + dur;
      delete m._provokedTarget;
      calmed++;
    }
  }
  bard._bardCooldownUntil = Date.now() + BARD_COOLDOWN_MS;
  return { ok: true, calmed, durationMs: dur };
}

/** Helper consumers — combat-formulas can call these to short-circuit. */
export function isPeaceful(mob, now = Date.now()) { return (mob?._peacefulUntil ?? 0) > now; }
export function isDiscorded(mob, now = Date.now()) { return (mob?._discordedUntil ?? 0) > now; }
export function isProvoked(mob, now = Date.now())  { return (mob?._provokedUntil ?? 0) > now; }
export function discordPenalty(mob)                { return mob?._discordPenaltyPct ?? 0; }

export const BARD_CONST = Object.freeze({
  MUSICIANSHIP, DISCORDANCE, PROVOCATION, PEACEMAKING,
  BARD_COOLDOWN_MS,
});
