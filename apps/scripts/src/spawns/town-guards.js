// Town-guard auto-call system. Mirrors ServUO `Regions/GuardedRegion.cs`
// `CallGuards(Point3D)` + `CheckGuardCandidate(Mobile)`.
//
// Triggers:
//   1. flagCriminal() fires for a mob standing inside a guarded region
//      → schedule a guard summon after CRIMINAL_FLEE_DELAY_MS so the
//        criminal can run for the exit (canon ServUO behaviour).
//   2. A notoriety-5 (Enemy) or notoriety-6 (Murderer) mob walks INTO
//      any guarded region → immediate summon (monsters / reds don't
//        get a flee window).
//
// Per-region cooldown — GUARD_COOLDOWN_MS between summons in the same
// city, so an AOE spell splashing 20 innocents doesn't spawn 20 guards.
//
// The summoned guard is an invulnerable 4 000-HP Town Guard (same
// stub as `[guards me`). It one-shots every criminally-flagged or
// noto-5/6 mob within GUARD_RADIUS tiles, then despawns after
// GUARD_LIFETIME_MS. Self / pets are skipped by serial.

import { onCriminalFlag } from '../_notoriety.js';
import { allMobiles } from '../_spatial.js';
import { createMobile, destroyMobileBySerial } from '../_mobiles.js';

const CRIMINAL_FLEE_DELAY_MS = 5_000;    // ServUO: 5 s after-flag delay
const GUARD_COOLDOWN_MS      = 5_000;    // per-region anti-spam
const GUARD_RADIUS           = 2;        // tiles around target
const GUARD_LIFETIME_MS      = 5_000;    // despawn timer

const MURDER_THRESHOLD = 5;              // kills count threshold (matches notoriety.js)

/** Track last guard summon per (facet, region) so we don't spawn a
 *  whole platoon when a Wildfire splashes every innocent at Britain Bank.
 *  Keyed `${map}:${regionName}`. Sliding window — beyond cooldown, the
 *  next trigger fires as normal. */
const _lastCallAt = new Map();

function isCriminalFlagged(mob, now = Date.now()) {
  if (!mob) return false;
  if ((mob.criminalUntil ?? 0) > now) return true;
  if ((mob.kills | 0) >= MURDER_THRESHOLD) return true;
  const noto = mob.notoriety ?? 1;
  return noto === 5 || noto === 6;
}

function regionKeyFor(api, mob) {
  const map = mob.map ?? 1;
  const primary = api.regions?.primary?.(map, mob.x, mob.y);
  return primary ? `${map}:${primary.name}` : `${map}:_unnamed`;
}

function onAnyRegionEnter(api, fn) {
  const register = api.systems?.regionOnEnter?.onAnyEnter;
  return typeof register === 'function' ? register(fn) : () => {};
}

function spawnGuardAt(api, target) {
  const factory = api.ctx?.spawnFactory ?? api.spawnFactory;
  let guard = null;
  try {
    if (factory) {
      guard = factory(api.world, 'town-guard', {
        x: target.x, y: target.y, z: target.z, map: target.map ?? 1,
      });
    }
  } catch { /* template missing — fall through */ }
  if (!guard) {
    guard = createMobile(api, api.world, {
      name: 'a Town Guard', body: 0x0190,
      x: target.x, y: target.y, z: target.z, map: target.map ?? 1,
      hp: 4000, hpMax: 4000, str: 250, dex: 250, int: 250,
      notoriety: 2,                  // guard-blue (CUO Innocent)
      invulnerable: true,
    });
  }
  if (!guard) return null;
  // Shout line — ServUO guards yell something like "Halt, knave!" on
  // arrival. Best-effort: skip silently if api.protocol.unicodeMessage
  // isn't wired (e.g. integration tests using a stripped harness).
  try {
    if (api.protocol?.unicodeMessage) {
      const pkt = api.protocol.unicodeMessage({
        serial: guard.serial, body: guard.body, name: guard.name,
        text: 'Halt, knave!', hue: 35, font: 3, type: 0,
      });
      for (const m of allMobiles(api)) {
        if (!m.client || m.map !== guard.map) continue;
        if (Math.abs(m.x - guard.x) > 12 || Math.abs(m.y - guard.y) > 12) continue;
        m.client.send(pkt);
      }
    }
  } catch { /* shout is cosmetic, never block the kill */ }
  // Sweep + execute every nearby criminal/murderer/enemy.
  const now = Date.now();
  let kills = 0;
  for (const m of allMobiles(api)) {
    if (m === guard) continue;
    if (m.map !== guard.map) continue;
    if (Math.max(Math.abs(m.x - guard.x), Math.abs(m.y - guard.y)) > GUARD_RADIUS) continue;
    if (!isCriminalFlagged(m, now)) continue;
    try {
      if (api.combat?.damage) {
        api.combat.damage(api.world, m, (m.hp ?? 1) + 10, guard);
        kills++;
      }
    } catch (e) { api.log?.(`[town-guard] kill threw: ${e.message}`); }
  }
  // Despawn timer — the guard is a one-shot summon, not a permanent
  // NPC. unref() so this never blocks process shutdown.
  const guardSerial = guard.serial;
  setTimeout(() => {
    try { destroyMobileBySerial(api, guardSerial); }
    catch { /* already gone */ }
  }, GUARD_LIFETIME_MS).unref?.();
  api.log?.(
    `[town-guard] summoned at (${guard.x},${guard.y},${guard.z}) facet ${guard.map} — killed ${kills} target${kills === 1 ? '' : 's'}`,
  );
  return guard;
}

/** Common gate: cooldown check + delay scheduling. `immediate=true`
 *  skips the 5 s flee window (used for noto-5/6 mobs entering a city). */
function tryCallGuards(api, target, immediate) {
  const map = target.map ?? 1;
  if (!api.regions?.isGuarded?.(map, target.x, target.y)) return;
  const key = regionKeyFor(api, target);
  const now = Date.now();
  if ((_lastCallAt.get(key) ?? 0) + GUARD_COOLDOWN_MS > now) return;
  _lastCallAt.set(key, now);
  const delay = immediate ? 0 : CRIMINAL_FLEE_DELAY_MS;
  setTimeout(() => {
    // Re-validate: did the target leave the region or shed the criminal
    // flag in the flee window? ServUO does the same re-check at fire
    // time so a 5-second escape sprint actually saves the criminal.
    const stillThere = (target.map | 0) === (map | 0)
      && api.regions?.isGuarded?.(target.map, target.x, target.y);
    if (!stillThere) return;
    if (!immediate && !isCriminalFlagged(target)) return;
    spawnGuardAt(api, target);
  }, delay).unref?.();
}

export default function register(api) {
  const unsubs = [];
  // Trigger 1 — criminal flag in a guarded zone (player splash-damage,
  // theft, harmful-on-innocent). 5 s delay window lets them run.
  unsubs.push(onCriminalFlag(api, (mob) => {
    if (!mob || !api.regions?.isGuarded?.(mob.map ?? 1, mob.x, mob.y)) return;
    tryCallGuards(api, mob, /* immediate */ false);
  }));
  // Trigger 2 — hostile mob walks into a guarded city. Catches summoned
  // Vortex / Blade Spirits, polymorphed PKs, dungeon escapees, etc.
  unsubs.push(onAnyRegionEnter(api, (mob, ctx) => {
    if (!ctx.next) return;                          // null → null transition
    const noto = mob.notoriety ?? 1;
    if (noto !== 5 && noto !== 6) return;
    if (!api.regions?.isGuarded?.(mob.map ?? 1, mob.x, mob.y)) return;
    tryCallGuards(api, mob, /* immediate */ true);
  }));
  api.log?.('spawns/town-guards: auto-call wired (criminal flag + hostile region entry)');
  return () => {
    for (const u of unsubs) { try { u(); } catch { /* ignore */ } }
    _lastCallAt.clear();
  };
}
