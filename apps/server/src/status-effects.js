// Timed status effects (buff/debuff) on mobiles.
//
// ServUO uses per-mobile `Timer` objects attached to a mobile's "timers" list
// — things like Poison, Bless, Curse, Paralyze. We keep the bookkeeping
// simpler: each mobile owns an `effects` array, and a single sweeper tick
// called from main.js walks everyone and runs per-effect `tick` + expiry.
//
// Effect shape:
//   { name, expiresAt, lastTickAt, tickIntervalMs, data, tick(mob, world, now), onRemove(mob, world) }
//
// Scripts register effects by calling `apply(mob, effectDescriptor)`. The
// descriptor is merged into the fresh effect instance so callers don't have
// to think about the bookkeeping fields.

/**
 * Optional observer — called whenever apply() or remove() mutates a mob's
 * effect list. The network layer registers one of these so clients get
 * pushed a 0xDF buff-info packet when their own mob gains/loses an effect.
 *
 * Signature: `(mob, 'add' | 'remove', effect) => void`
 *
 * Left as a module-local to stay out of the scripting API surface — only
 * main.js sets it.
 *
 * @type {((mob:any, action:'add'|'remove', eff:any) => void) | null}
 */
let _listener = null;
export function setListener(fn) { _listener = fn; }

/**
 * BuffIcon catalogue — the 0xDF buff-info packet carries a `type` (u16)
 * the client matches against ServUO's `BuffIcon` enum
 * (Server/Network/BuffInfo.cs). Content scripts can pass
 * `kind: BUFF_ICONS.Bless` instead of magic numbers so the on-wire
 * mapping stays consistent with the OSI client. Add entries as new
 * effects come online — order is irrelevant, only the numeric value
 * (which must match the client's BuffIcon enum).
 */
export const BUFF_ICONS = Object.freeze({
  DismountPrevention: 0x3E9, NoRearm: 0x3EA, NightSight: 0x3ED, DeathStrike: 0x3EE,
  EvilOmen: 0x3EF, HonoredDebuff: 0x3F0, AchievePerfection: 0x3F1, DivineFury: 0x3F2,
  EnemyOfOne: 0x3F3, HidingAndOrStealth: 0x3F4, ActiveMeditation: 0x3F5,
  BloodOathCaster: 0x3F6, BloodOathCurse: 0x3F7, CorpseSkin: 0x3F8, Mindrot: 0x3F9,
  PainSpike: 0x3FA, Strangle: 0x3FB, GiftOfRenewal: 0x3FC, AttuneWeapon: 0x3FD,
  Thunderstorm: 0x3FE, EssenceOfWind: 0x3FF, EtherealVoyage: 0x400, GiftOfLife: 0x401,
  ArcaneEmpowerment: 0x402, MortalStrike: 0x403, ReactiveArmor: 0x404, Protection: 0x405,
  ArchProtection: 0x406, MagicReflection: 0x407, Incognito: 0x408, Disguised: 0x409,
  AnimalForm: 0x40A, Polymorph: 0x40B, Invisibility: 0x40C, Paralyze: 0x40D,
  Poison: 0x40E, Bleed: 0x40F, Clumsy: 0x410, FeebleMind: 0x411, Weaken: 0x412,
  Curse: 0x413, MassCurse: 0x414, Agility: 0x415, Cunning: 0x416, Strength: 0x417,
  Bless: 0x418, Sleep: 0x41A, StoneForm: 0x41B, SpellPlague: 0x41C,
  Spellweaving: 0x420, ManaShield: 0x42E,
});

const BUFF_ICON_BY_NORMALIZED_NAME = new Map(
  Object.entries(BUFF_ICONS).map(([name, icon]) => [name.toLowerCase().replace(/[^a-z0-9]/g, ''), icon]),
);

/** Resolve script-friendly names (`night-sight`, `mind rot`) to OSI icons. */
export function buffIconForEffect(name, fallback = BUFF_ICONS.DismountPrevention) {
  const key = String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return BUFF_ICON_BY_NORMALIZED_NAME.get(key) ?? fallback;
}

/**
 * Attach `eff` to `mob`, replacing any existing effect of the same name.
 * Returns the attached instance so callers can tweak it (e.g. hold a ref
 * for manual removal).
 */
export function apply(mob, eff) {
  if (!mob.effects) mob.effects = [];
  // Replace-on-name: re-casting poison on a poisoned target refreshes it.
  const existing = mob.effects.findIndex((e) => e.name === eff.name);
  const normalized = {
    name: eff.name,
    expiresAt: eff.expiresAt ?? (Date.now() + (eff.durationMs ?? 10_000)),
    lastTickAt: 0,
    tickIntervalMs: eff.tickIntervalMs ?? 0,
    data: eff.data ?? {},
    // Audit #41 P1 #1 — accept both `tick` (canonical) and `onTick`
    // (used by Confidence regen / Gift of Renewal HoT / Spell Plague
    // DoT / Death Strike). Was: framework only read `tick` → every
    // `onTick` caller silently had no periodic effect at all.
    tick: eff.tick ?? eff.onTick,
    onRemove: eff.onRemove,
    icon: Number.isFinite(eff.icon) ? (eff.icon & 0xffff)
      : (Number.isFinite(eff.kind) ? (eff.kind & 0xffff) : buffIconForEffect(eff.name)),
  };
  if (existing >= 0) {
    const prev = mob.effects[existing];
    if (prev.onRemove) { try { prev.onRemove(mob, null); } catch {} }
    if (_listener) { try { _listener(mob, 'remove', prev); } catch {} }
    mob.effects[existing] = normalized;
  } else {
    mob.effects.push(normalized);
  }
  if (_listener) { try { _listener(mob, 'add', normalized); } catch {} }
  return normalized;
}

/**
 * Drop the named effect, firing its onRemove hook. Returns true if an
 * effect was actually removed.
 */
export function remove(mob, name, world = null) {
  if (!mob.effects || mob.effects.length === 0) return false;
  const i = mob.effects.findIndex((e) => e.name === name);
  if (i < 0) return false;
  const eff = mob.effects[i];
  mob.effects.splice(i, 1);
  if (eff.onRemove) { try { eff.onRemove(mob, world); } catch {} }
  if (_listener) { try { _listener(mob, 'remove', eff); } catch {} }
  return true;
}

export function has(mob, name) {
  if (!mob.effects) return false;
  return mob.effects.some((e) => e.name === name);
}

/**
 * Run every mobile's active effects: fire `tick` on any that are due, and
 * expire+remove those past their deadline. Safe to call at any cadence —
 * effects self-schedule via `tickIntervalMs`.
 *
 * @param {import('./world/world.js').World} world
 * @param {number} now Date.now() at tick start
 */
export function tickAll(world, now) {
  // Fast-path: walk world._mobsWithEffects (maintained by main.js's
  // listener) instead of every mobile. Falls back to the legacy full
  // walk if the index is missing — that keeps unit tests that build
  // world directly working without the listener wired.
  const idx = world._mobsWithEffects;
  if (idx && idx.size >= 0) {
    for (const serial of [...idx]) {
      const mob = world.mobiles.get(serial);
      if (!mob) { idx.delete(serial); continue; }
      tickMob(mob, world, now);
      // Drop the entry once the last effect has expired or been cleared.
      if (!mob.effects || mob.effects.length === 0) idx.delete(serial);
    }
    return;
  }
  for (const mob of world.mobiles.values()) {
    if (!mob.effects || mob.effects.length === 0) continue;
    tickMob(mob, world, now);
  }
}

function tickMob(mob, world, now) {
  if (!mob.effects || mob.effects.length === 0) return;
  // Iterate a snapshot — tick handlers may mutate the list (e.g. by
  // removing the effect when the mob dies).
  const snap = mob.effects.slice();
  for (const eff of snap) {
    if (now >= eff.expiresAt) {
      remove(mob, eff.name, world);
      continue;
    }
    if (eff.tick && eff.tickIntervalMs > 0 && (now - eff.lastTickAt) >= eff.tickIntervalMs) {
      eff.lastTickAt = now;
      try { eff.tick(mob, world, now); }
      catch (e) { console.error(`[effects] ${eff.name} tick threw:`, e); }
    }
  }
}
