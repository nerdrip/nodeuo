import { broadcastEffect, broadcastSound, clientsNear } from '../../_helpers.js';
import { checkRecallCast, travelAllowed } from '../../rune-helpers.js';
import { findStandingZ, moveMobile } from '../../../_movement.js';

export default {
  name: 'teleport',
  targetKind: 'location',
  cast(api, ctx, picked) {
    const caster = ctx.sender;
    if (!picked) return;
    const nx = picked.x & 0xFFFF;
    const ny = picked.y & 0xFFFF;
    const requestedZ = picked.z | 0;
    // Audit #40 P1 #4 — ServUO `Teleport.cs:67-84` blockers:
    //   1. range ≤ 11 tiles
    //   2. CheckTravel (sigil/criminal/held-cursor — shared helper)
    //   3. map.CanSpawnMobile at destination (no walls / impassable)
    //   4. CheckMulti (no teleport INTO foreign house — stuck-forever
    //      exploit)
    // Was: zero range cap, no travel check, cross-map teleport into
    // any player's house.
    const dx = Math.abs(nx - caster.x);
    const dy = Math.abs(ny - caster.y);
    if (Math.max(dx, dy) > 11) {
      ctx.state.sendSystemMessage('Target is too far away.');
      return;
    }
    const refuse = checkRecallCast(api, caster, ctx.state);
    if (refuse) { ctx.state.sendSystemMessage(refuse); return; }
    if (!travelAllowed(api, caster.map, nx, ny)) {
      ctx.state.sendSystemMessage('A magical force prevents travel to that location.');
      return;
    }
    // Client tile replies often carry the land base z while the legal floor
    // is a bridge/static above it. ServUO calls GetSurfaceTop before
    // CanSpawnMobile; use the shared movement resolver for the same snap.
    const nz = findStandingZ(api, caster.map, nx, ny, requestedZ);
    if (nz == null) {
      ctx.state.sendSystemMessage('You can not teleport there.');
      return;
    }
    if (api.houses?.findHouseAt) {
      const house = api.houses.findHouseAt(nx, ny, caster.map);
      if (house && house.ownerSerial !== caster.serial && !house.coOwners?.includes?.(caster.serial)) {
        ctx.state.sendSystemMessage('You can not teleport into a house.');
        return;
      }
    }
    api.combat.animate(api.world, caster, 0x10);
    const fx = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.FromSource,
      from: caster.serial, to: caster.serial,
      itemId: 0x3728,
      fromX: caster.x, fromY: caster.y, fromZ: caster.z,
      toX: caster.x, toY: caster.y, toZ: caster.z,
      speed: 10, duration: 13,
      fixedDirection: 1, explodes: 0,
      hue: 0, renderMode: 0,
    });
    broadcastEffect(api, api.world, caster, fx);
    broadcastSound(api, api.world, caster, 0x1FE);

    if (!api.game?.mobile?.teleport?.(
      caster,
      { x: nx, y: ny, z: nz, map: caster.map },
      { state: ctx.state, refresh: true },
    )) {
      const preObservers = [...clientsNear(api, api.world, caster, 18, caster)];
      if (api.protocol?.removeEntity) {
        const rm = api.protocol.removeEntity(caster.serial);
        for (const other of preObservers) other.client.send(rm);
      }
      moveMobile(api, caster, { x: nx, y: ny, z: nz });

      if (caster.client && api.protocol.mobileUpdate) {
        caster.client.send(api.protocol.mobileUpdate({
          serial: caster.serial, body: caster.body, hue: caster.hue,
          flags: caster.flags, x: nx, y: ny, z: nz, direction: caster.direction,
        }));
      }
      if (api.protocol.mobileMoving) {
        const pkt = api.protocol.mobileMoving({
          serial: caster.serial, body: caster.body, x: nx, y: ny, z: nz,
          direction: caster.direction, hue: caster.hue,
          flags: caster.flags, notoriety: caster.notoriety ?? 1,
        });
        for (const other of clientsNear(api, api.world, caster, 18, caster)) other.client.send(pkt);
      }
    }
    ctx.state.sendSystemMessage(`Teleported to (${nx}, ${ny}, ${nz}).`);
  },
};
