// Summoned-creature auto-dismiss timer.
//
// Spells like `Summon Daemon`, `Energy Vortex`, `Blade Spirits`, and
// `Animate Dead` create a creature with a finite lifetime. ServUO's
// summon system stores the expiry on the BaseCreature; we tag the
// mobile with `summonedUntil` (Date.now timestamp) so a single sweep
// every second can dismiss anything expired.
//
// Dismiss = remove mobile from the world + a brief vanish FX. Caller
// (the spell that created the summon) is responsible for setting
// `summonedUntil` on the freshly-created mob.

import { removeEntity } from '@uo/protocol';

// ServUO `BaseCreature.DeleteTimer` equivalent for temporary summons.
export const ServUOSummonTimerClasses = Object.freeze(['BaseCreature', 'DeleteTimer']);

export function registerSummon(world, mob) {
  if (!world || !mob?.serial) return;
  world._summons ||= new Set();
  world._summons.add(mob.serial >>> 0);
}

export function unregisterSummon(world, mobOrSerial) {
  const serial = typeof mobOrSerial === 'number'
    ? mobOrSerial >>> 0
    : mobOrSerial?.serial >>> 0;
  if (!serial) return;
  world?._summons?.delete?.(serial);
}

function ensureSummonIndex(world) {
  world._summons ||= new Set();
  if (world._summonIndexReady) return world._summons;
  for (const m of world.mobiles?.values?.() ?? []) {
    if (m?.summonedUntil) world._summons.add(m.serial >>> 0);
  }
  world._summonIndexReady = true;
  return world._summons;
}

/** @param {import('../world/world.js').World} world */
export function tickSummons(world, deps = {}) {
  const now = Date.now();
  const summons = ensureSummonIndex(world);
  for (const serial of [...summons]) {
    const m = world.mobiles.get(serial);
    if (!m || !m.summonedUntil) {
      summons.delete(serial);
      continue;
    }
    if (now < m.summonedUntil) continue;
    // Dismiss. Sector-aware client fan-out — was iterating all 11.7k
    // mobiles per expiring summon (Doom / shadowguard farms trigger
    // many per minute). Bug-hunt #6 P2 #7.
    const pkt = removeEntity(m.serial);
    const sectors = world.sectors;
    if (sectors?.mobileSerialsNear) {
      for (const s of sectors.mobileSerialsNear(m.map, m.x, m.y, 18)) {
        const o = world.mobiles.get(s);
        if (o?.client && o.map === m.map
            && Math.abs(o.x - m.x) <= 18 && Math.abs(o.y - m.y) <= 18) o.client.send(pkt);
      }
    } else {
      for (const o of world.mobiles.values()) {
        if (o.client && o.map === m.map &&
            Math.abs(o.x - m.x) <= 18 && Math.abs(o.y - m.y) <= 18) o.client.send(pkt);
      }
    }
    // Visual effect — sparkle at the dismissal point.
    if (deps.huedEffect && deps.broadcast) {
      try {
        const fx = deps.huedEffect({
          kind: deps.EffectKind?.Stationary ?? 0,
          from: m.serial, to: m.serial,
          itemId: 0x373A,
          fromX: m.x, fromY: m.y, fromZ: m.z,
          toX:   m.x, toY:   m.y, toZ:   m.z,
          speed: 8, duration: 14, fixedDirection: 1, explodes: 0,
          hue: 0x481, renderMode: 0,
        });
        deps.broadcast(world, m, fx);
      } catch { /* fx optional */ }
    }
    // Notify the summoner.
    const master = world.mobiles.get(m.controlMaster);
    if (master?.client?.sendSystemMessage) {
      master.client.sendSystemMessage(`Your ${m.name ?? 'summon'} fades away.`);
    }
    // destroyMobile cleans the sector index too (bug-hunt #2 A4).
    unregisterSummon(world, m);
    world.destroyMobile?.(m.serial);
  }
}

/** Helper for spell callers: tag a freshly-created mob with a TTL. */
export function setSummonDuration(mob, durationMs, world = null) {
  mob.summoned = true;
  mob.summonedUntil = Date.now() + durationMs;
  if (world) registerSummon(world, mob);
}
