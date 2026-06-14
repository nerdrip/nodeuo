// [move — relocate the caller (or a target) to coordinates. Distinct
// from [tele which expects a click target. Mirrors ServUO `MoveCommand`.
//
// Usage:
//   [move <x> <y> [z]              move caller
//   [move to <username>            teleport to a logged-in player
//   [move bring <username>         pull a logged-in player to caller

import { moveMobile } from '../../_movement.js';
import { onlineMobiles } from '../../_spatial.js';

function teleport(api, mob, x, y, z, map) {
  moveMobile(api, mob, { x, y, z, map });
  if (!api.protocol || !mob.client) return;
  try {
    mob.client.send(api.protocol.mobileUpdate({
      serial: mob.serial, body: mob.body, x: mob.x, y: mob.y, z: mob.z,
      direction: mob.direction ?? 0, hue: mob.hue ?? 0, flags: mob.flags ?? 0,
    }));
  } catch (e) { console.error('[move] push', e); }
}

function findOnlineByName(api, name) {
  const found = api.game?.findOnlineByName?.(name) ?? api.query?.findOnlineByName?.(name);
  if (found) return found;
  const lower = String(name).toLowerCase();
  for (const m of onlineMobiles(api)) {
    if ((m.name ?? '').toLowerCase() === lower) return m;
  }
  return null;
}

export default function (api) {
  const { commands } = api;

  commands.register({
    name: 'move',
    help: 'Move: [move x y [z] | [move to <name> | [move bring <name>',
    access: 'GameMaster',
    run: (ctx) => {
      const caller = ctx.state?.mobile;
      if (!caller) return;
      const a = ctx.args ?? [];
      if (a[0] && /^to$/i.test(a[0])) {
        const target = a[1] ? findOnlineByName(api, a[1]) : null;
        if (!target) { ctx.state.sendSystemMessage(`No online player: ${a[1]}`); return; }
        teleport(api, caller, target.x, target.y, target.z, target.map);
        ctx.state.sendSystemMessage(`Moved to ${target.name}.`);
        return;
      }
      if (a[0] && /^bring$/i.test(a[0])) {
        const target = a[1] ? findOnlineByName(api, a[1]) : null;
        if (!target) { ctx.state.sendSystemMessage(`No online player: ${a[1]}`); return; }
        teleport(api, target, caller.x, caller.y, caller.z, caller.map);
        target.client?.sendSystemMessage?.(`You have been summoned by ${caller.name}.`);
        ctx.state.sendSystemMessage(`Brought ${target.name}.`);
        return;
      }
      const x = parseInt(a[0] ?? '', 10);
      const y = parseInt(a[1] ?? '', 10);
      const z = parseInt(a[2] ?? caller.z, 10);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        ctx.state.sendSystemMessage('Usage: [move x y [z]  |  [move to <name>  |  [move bring <name>');
        return;
      }
      teleport(api, caller, x, y, z, caller.map);
      ctx.state.sendSystemMessage(`Moved to (${x},${y},${z}).`);
    },
  });

  return () => commands.unregister('move');
}
