// Shared summon path for the magery spells (summon-creature already has
// its own random-pick variant; the elementals + blade-spirits + energy-
// vortex share the same shape: spawn ONE specific kind, attach pet AI
// when friendly OR aggressive AI when autonomous, despawn after N ms).
//
// Returns the spawned mob (or null on failure).

import { broadcastSound, clientsNear, skillValue } from './_helpers.js';
import { createMobile, destroyMobileBySerial } from '../_mobiles.js';
import { allMobiles } from '../_spatial.js';

const SUMMON_OFFSETS = [
  [1, 0], [1, 1], [0, 1], [-1, 1],
  [-1, 0], [-1, -1], [0, -1], [1, -1],
  [2, 0], [0, 2], [-2, 0], [0, -2],
];

/** ServUO SpellHelper.Summon does not display a placement cursor; it finds a
 * legal tile near the caster. Preserve that behavior and avoid materialising
 * pets inside a wall or on top of another mobile. Explicit spots (EV) are
 * validated but are not silently moved away from the selected tile. */
function findSummonSpot(api, caster, requested = null) {
  const base = requested ?? caster;
  const facet = base.map ?? caster.map ?? 1;
  const candidates = requested
    ? [[base.x | 0, base.y | 0, base.z ?? caster.z]]
    : SUMMON_OFFSETS.map(([dx, dy]) => [caster.x + dx, caster.y + dy, caster.z]);
  const resolve = api.game?.movement?.findStandingZ;
  for (const [x, y, requestedZ] of candidates) {
    let occupied = false;
    for (const other of allMobiles(api)) {
      if (other.map === facet && other.x === x && other.y === y && (other.hp ?? 1) > 0) {
        occupied = true;
        break;
      }
    }
    if (occupied) continue;
    const z = resolve ? resolve(facet, x, y, requestedZ) : requestedZ;
    if (z == null) continue;
    return { x, y, z, map: facet };
  }
  return null;
}

/** Fallback path: if `api.ctx.spawnFactory` returned null we drop down
 *  to manual createMobile using the registered template directly. The
 *  factory wrapper in npcs/aggressive.js can return null when it tries
 *  to broadcast 0x78 to no nearby clients (dead world) or when its
 *  `spawnAggressive` helper bails on a tiledata edge case. The catch:
 *  hardcoded summon kinds (Daemon, four Elementals, Blade Spirits,
 *  Energy Vortex) are guaranteed to be in monsters.json — so look up
 *  the template directly, mint the mob, broadcast it ourselves. */
function manualSummonFallback(api, kind, spot) {
  const tmpl = api.monsters?.get?.(kind);
  if (!tmpl) return null;
  const world = api.world;
  if (!world) return null;
  const mob = createMobile(api, world, {
    name: tmpl.name, body: tmpl.body, hue: tmpl.hue ?? 0,
    x: spot.x, y: spot.y, z: spot.z, map: spot.map,
    notoriety: tmpl.notoriety ?? 1,
    hp: tmpl.hp ?? 50, hpMax: tmpl.hp ?? 50,
    str: tmpl.str ?? 50, dex: tmpl.dex ?? 50, int: tmpl.int ?? 50,
    mana: tmpl.manaMax ?? 0, manaMax: tmpl.manaMax ?? 0,
  });
  if (!mob) return null;
  // Broadcast incoming so nearby clients get a sprite. Mirror what
  // `spawnAggressive` does — 18-tile cap, same map.
  if (api.protocol?.mobileIncoming) {
    const pkt = api.protocol.mobileIncoming({
      serial: mob.serial, body: mob.body, x: mob.x, y: mob.y, z: mob.z,
      direction: mob.direction ?? 4, hue: mob.hue ?? 0,
      flags: mob.flags ?? 0, notoriety: mob.notoriety ?? 1,
      equipment: [],
    });
    for (const m of clientsNear(api, world, mob, 18)) {
      m.client.send(pkt);
    }
  }
  return mob;
}

/**
 * @param {*} api
 * @param {*} ctx          spells context (`ctx.sender`, `ctx.state`)
 * @param {object} opts
 * @param {string}  opts.kind          monster kind for `api.ctx.spawnFactory`
 * @param {number}  opts.soundId       cast sound
 * @param {number}  [opts.durationMs]  despawn timer (default 120 s)
 * @param {boolean} [opts.aggressive]  attach `aggressive` AI instead of pet
 * @param {string}  [opts.label]       sysmsg name override
 * @param {{x:number,y:number,z:number,map:number}} [opts.spot] override spawn tile
 */
export function summonOne(api, ctx, opts) {
  const caster = ctx.sender;
  // Audit #31 P1 #3 — FollowersMax cap. ServUO `BladeSpirits.cs` /
  // `EnergyVortex.cs` reject when `(Followers + cost) > FollowersMax`.
  // BladeSpirits and EnergyVortex consume 2 follower slots each; other
  // summons consume 1. Without this a mage could stack 7+ aggressive
  // summons (4× EV, etc.) under what should be a 5-pet ceiling.
  const followerCost = opts.followerCost ?? (
    (opts.kind === 'energy-vortex' || opts.kind === 'blade-spirits') ? 2 : 1
  );
  const followersMax = caster.followersMax ?? 5;
  if (((caster.followers | 0) + followerCost) > followersMax) {
    ctx.state.sendSystemMessage?.('You have too many followers to summon that creature.');
    return null;
  }
  const factory = api.ctx?.spawnFactory;
  const picked = opts.spot ?? ctx.target?.entity ?? ctx.target ?? null;
  const requestedSpot = picked && Number.isFinite(picked.x) && Number.isFinite(picked.y)
    ? {
        x: picked.x | 0, y: picked.y | 0, z: picked.z ?? caster.z,
        map: picked.map ?? caster.map ?? 1,
      }
    : null;
  const spot = findSummonSpot(api, caster, requestedSpot);
  if (!spot) {
    ctx.state.sendSystemMessage?.('There is no room for the summoned creature.');
    return null;
  }
  // Try the registered factory first (`npcs/aggressive.js` wires this with
  // gold/loot/AI hookup). When it returns null — happens when the wrapper
  // bails on an edge case OR the script-loaded api.ctx reference drifted —
  // fall back to a direct createMobile so the spell at least produces the
  // creature visible to nearby players. Marcin reported "vortex unavailable"
  // even though monsters.json has the kind: this fallback closes that path.
  let mob = null;
  if (factory) {
    try { mob = factory(api.world, opts.kind, spot); }
    catch (e) { console.error(`[summon] factory threw for ${opts.kind}:`, e?.message ?? e); }
  }
  if (!mob) mob = manualSummonFallback(api, opts.kind, spot);
  if (!mob) {
    const reason = !api.monsters?.get?.(opts.kind) ? 'no template' : 'spawn refused';
    ctx.state.sendSystemMessage(`Your summoning fails (${opts.kind}: ${reason}).`);
    return null;
  }
  mob.kind ||= opts.kind;
  mob.summoned = true;
  mob.summonedBy = caster.serial >>> 0;
  if (opts.aggressive) {
    // Autonomous combatant — blade spirits / energy vortex behave this
    // way in retail UO. They stay loyal to the caster (won't attack)
    // but pick fights with everything else nearby.
    mob.notoriety = 4;                                  // criminal grey
    mob.team = caster.team ?? caster.serial;            // friendly-fire guard
    // BUGFIX: always pass full initState with `home` populated. The
    // previous `attach(mob, 'aggressive')` call with NO state arg made
    // ai.attach() fall through to behavior.initState() which leaves
    // `home: null`. The aggressive tick then dereferenced `state.home.x`
    // on every cycle → TypeError → error spam → client visibly froze
    // ("hang after vortex spawn"). Re-init explicitly so state is always
    // valid regardless of whether factory or fallback created the mob.
    api.ai?.attach?.(mob, 'aggressive', {
      targetSerial: 0, nextAttackAt: 0, nextStepAt: 0, nextCastAt: 0,
      home: { x: mob.x, y: mob.y }, kind: opts.kind,
      fleeUntil: 0,
    });
  } else {
    mob.controlMaster = caster.serial >>> 0;
    mob.controlled = true;
    mob.controlOrder = 'follow';
    mob.controlTarget = caster.serial >>> 0;
    mob.team = caster.serial >>> 0;
    mob.notoriety = 1;                                  // friendly to caster
    mob.aiBehavior = 'pet';
    mob.petCommand = 'follow';
    api.ai?.attach?.(mob, 'pet', { command: 'follow', targetSerial: caster.serial });
  }
  mob._followerCost = followerCost;
  caster.followers = (caster.followers | 0) + followerCost;
  if (opts.soundId) broadcastSound(api, api.world, caster, opts.soundId);
  ctx.state.sendSystemMessage(opts.label ?? `You summon a ${opts.kind}.`);
  // Re-broadcast the mob with the corrected notoriety. spawnAggressive's
  // initial 0x78 carried `cfg.notoriety` (Daemon = 6 / Murderer-red),
  // so summoned daemons appeared as enemies to nearby observers — the
  // pet/criminal hue we just stamped never reached the wire. Push a
  // mobileMoving update so the colour matches the actual allegiance.
  if (api.protocol?.mobileMoving) {
    const refresh = api.protocol.mobileMoving({
      serial: mob.serial, body: mob.body,
      x: mob.x, y: mob.y, z: mob.z,
      direction: mob.direction ?? 0,
      hue: mob.hue ?? 0,
      flags: mob.flags ?? 0,
      notoriety: mob.notoriety ?? 1,
    });
    for (const m of clientsNear(api, api.world, mob, 18)) {
      m.client.send(refresh);
    }
  }
  const magery = skillValue(caster, 26);
  // ServUO duration: (2 * Magery.Fixed) / 5 seconds. Fixed is skill*10,
  // therefore a 100.0 mage receives 400 seconds rather than a fixed 120.
  const durationMs = opts.durationMs ?? Math.max(10, magery || 30) * 4_000;
  mob.summonedUntil = Date.now() + durationMs;
  const registerSummon = api.systems?.summons?.registerSummon;
  if (registerSummon) {
    // Production uses the indexed 1 Hz sweep: one timer for the entire shard.
    registerSummon(api.world, mob);
  } else {
    // Isolated script harnesses do not wire the summon system.
    setTimeout(() => {
    try {
      // Audit #31 P1 #4 — was `api.world.mobiles.delete(mob.serial)`, a
      // raw storage drop that orphaned reverse-parent index entries
      // (corpse, equipment), skipped sector unhash, and bypassed
      // `world.onMobileDestroyed` hooks. Same foot-gun pattern audit
      // #20 BH#10 banned for admin DELETE. Use the canonical destroy
      // path; fall back only when it's not wired (test harness).
      if (api.protocol?.removeEntity) {
        const rem = api.protocol.removeEntity(mob.serial);
        for (const m of clientsNear(api, api.world, mob, 18)) {
          m.client.send(rem);
        }
      }
      destroyMobileBySerial(api, mob.serial);
      // Audit #31 P1 #3 — release the follower slot we consumed at
      // spawn (see followerCost stamp on the mob below).
      const slots = mob._followerCost | 0;
      if (slots > 0 && caster) {
        caster.followers = Math.max(0, (caster.followers | 0) - slots);
      }
    } catch { /* gone */ }
    caster.client?.sendSystemMessage?.('Your summoning returns to the ether.');
    }, durationMs).unref?.();
  }
  return mob;
}
