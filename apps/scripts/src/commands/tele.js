// `[tele` — teleport admin command. Requests a ground target via 0x6C and
// moves the sender there.
//
// Mirrors the move + visibility broadcast pattern from `[go` and the admin
// REST `/api/me/teleport` endpoint:
//   1. resolveStandingZ — picked.z from the targeting cursor is whatever
//      tile the cursor was over. For ground tiles that's usually 0 or the
//      land z, but inside multi-story buildings (Britain Bank floor sits
//      at z=20) the floor is a STATIC, and the cursor reports the LAND z
//      underneath. Result: TP lands the player UNDER the floor, stuck.
//      resolveStandingZ walks land + statics at (x,y), filters Surface
//      without Impassable, picks closest-to-requested.
//   2. removeEntity to pre-observers within 18 tiles — without this the
//      old position keeps a phantom mobile until the next 0x77.
//   3. mobileMoving to post-observers within 18 tiles.
//   4. refreshSurroundings on the mover so nearby NPCs/items appear at
//      the destination instead of an empty viewport.
//
// Demonstrates the targeting API: `api.targeting.request(state, cb, opts)`.

import { moveMobile, resolveStandingZ } from '../_movement.js';
import { nearbyClients } from '../_spatial.js';

function* clientsNear(api, center, range = 18, self = null) {
  if (api.query?.clientsNear) {
    yield* api.query.clientsNear(center, range, self);
    return;
  }
  yield* nearbyClients(api.world, center, self, range);
}

/**
 * @param {import('@uo/server/src/scripts.js').ScriptAPI} api
 */
export default function register(api) {
  if (!api.targeting || !api.protocol) {
    api.log('commands/tele: api.targeting missing; skipping');
    return () => {};
  }

  api.commands.register({
    name: 'tele',
    help: '[tele — click a tile to teleport there. (GM only)',
    // BH #13 B1 (security/P1) — was Player. Mid-PvP free teleport,
    // jail escape, dungeon-wall bypass exploits. ServUO [tele is GM.
    access: 'GameMaster',
    run(ctx) {
      ctx.state.sendSystemMessage('Where do you wish to go?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked) {
          ctx.state.sendSystemMessage('Teleport cancelled.');
          return;
        }
        const mob = ctx.sender;
        const tx = picked.x & 0xFFFF;
        const ty = picked.y & 0xFFFF;
        let tz = picked.z | 0;
        // Substitute proper standing Z so the avatar lands ON the visible
        // floor instead of underneath it. Cursor on a multi-story
        // building floor reports the LAND z underneath (often 0); the
        // visible static floor is at e.g. z=20.
        try {
          const standZ = resolveStandingZ(api, mob.map ?? 1, tx, ty, tz);
          if (Number.isFinite(standZ)) tz = standZ;
        } catch { /* fall back to picked.z */ }

        if (!api.game?.mobile?.teleport?.(mob, {
          x: tx, y: ty, z: tz,
        }, { state: ctx.state, refresh: true })) {
          // Pre-observers: remove the phantom mobile from anyone who could
          // see the player at the OLD spot.
          const preObservers = [...clientsNear(api, mob, 18, mob)];
          if (api.protocol.removeEntity) {
            const rm = api.protocol.removeEntity(mob.serial);
            for (const m of preObservers) m.client.send(rm);
          }

          moveMobile(api, mob, { x: tx, y: ty, z: tz });

          // Self: snap the mover's client to the new position.
          if (mob.client && api.protocol.mobileUpdate) {
            mob.client.send(api.protocol.mobileUpdate({
              serial: mob.serial, body: mob.body, hue: mob.hue ?? 0,
              flags: mob.flags ?? 0,
              x: mob.x, y: mob.y, z: mob.z, direction: mob.direction ?? 0,
            }));
          }
          // Post-observers: anyone now within 18 tiles.
          if (api.protocol.mobileMoving) {
            const moving = api.protocol.mobileMoving({
              serial: mob.serial, body: mob.body,
              x: mob.x, y: mob.y, z: mob.z,
              direction: mob.direction ?? 0, hue: mob.hue ?? 0,
              flags: mob.flags ?? 0, notoriety: mob.notoriety ?? 1,
            });
            for (const m of clientsNear(api, mob, 18, mob)) m.client.send(moving);
          }
          // Push every now-in-range NPC/item back to the player so the
          // destination viewport isn't empty. Same code path as 0x22 resync.
          try { ctx.state?.ctx?.handlers?.refreshSurroundings?.(ctx.state); }
          catch { /* helper missing in test setups */ }
        }

        ctx.state.sendSystemMessage(`Teleported to (${mob.x}, ${mob.y}, ${mob.z}).`);
      }, { kind: 1 /* location */ });
    },
  });

  return () => api.commands.unregister('tele');
}
