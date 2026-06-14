// `[revtp` — teleport into a revamped-dungeon room and spawn its
// encounter wave. Players use it after [revdungeon start <id> to actually
// enter the next pending room. Convenience for prog/playtesting since
// world-side teleporter pads aren't placed.

import { moveMobile } from '../../_movement.js';

export default function register(api) {
  if (!api.commands) return () => {};
  const sys = api.systems?.revampedDungeons;
  if (!sys) return () => {};

  // Room anchor table — one (x,y,z,map) per dungeon room. ServUO
  // dungeon revamps placed teleporter pads at fixed coordinates; we
  // pre-seed the same for the canonical Trammel coords.
  const ROOM_ANCHORS = {
    'shame-r1':         { x: 5454, y: 116,  z: 0, map: 1 },
    'shame-r2':         { x: 5458, y: 130,  z: 0, map: 1 },
    'shame-r3':         { x: 5462, y: 150,  z: -10, map: 1 },
    'wrong-r1':         { x: 5566, y: 1395, z: 0, map: 1 },
    'wrong-r2':         { x: 5570, y: 1408, z: 0, map: 1 },
    'despise-r1':       { x: 5395, y: 547,  z: 0, map: 1 },
    'despise-r2':       { x: 5408, y: 565,  z: -25, map: 1 },
    'covetous-r1':      { x: 5571, y: 1828, z: 0, map: 1 },
    'covetous-r2':      { x: 5575, y: 1840, z: -50, map: 1 },
    'deceit-r1':        { x: 5210, y: 645,  z: 0, map: 1 },
    'deceit-r2':        { x: 5230, y: 660,  z: -10, map: 1 },
    'destard-r1':       { x: 5460, y: 760,  z: 0, map: 1 },
    'destard-r2':       { x: 5480, y: 780,  z: -10, map: 1 },
    'hythloth-r1':      { x: 6090, y: 1015, z: 0, map: 1 },
    'hythloth-r2':      { x: 6110, y: 1040, z: 0, map: 1 },
    'pc-r1':            { x: 5984, y: 1004, z: 0, map: 1 },
    'ft-r1':            { x: 6100, y: 1180, z: 0, map: 1 },
    'sanct-r1':         { x: 6240, y: 1300, z: 0, map: 1 },
  };

  api.commands.register({
    name: 'revtp',
    help: '[revtp <dungeon-id> — teleport to the next pending room and spawn its wave.',
    access: 'Player',
    run(ctx, args) {
      const id = args?.[0];
      if (!id) { ctx.state.sendSystemMessage('Usage: [revtp <dungeon-id>'); return; }
      const def = sys.getDungeon(id);
      if (!def) { ctx.state.sendSystemMessage('Unknown dungeon.'); return; }
      const prog = sys.statusFor(ctx.sender, id);
      if (!prog) { ctx.state.sendSystemMessage('Use [revdungeon start <id> first.'); return; }
      const room = def.rooms[prog.room];
      if (!room) { ctx.state.sendSystemMessage('All rooms cleared. Fight the final boss.'); return; }
      const anchor = ROOM_ANCHORS[room.id];
      if (!anchor) { ctx.state.sendSystemMessage(`No anchor for room ${room.id}.`); return; }
      // Teleport player.
      const mob = ctx.sender;
      moveMobile(api, mob, anchor);
      ctx.state.sendSystemMessage(`Teleported to ${room.id}.`);
      // Spawn wave.
      for (let i = 0; i < (room.count ?? 0); i++) {
        const kind = room.spawns[Math.floor(Math.random() * room.spawns.length)];
        api.spawner?.spawn?.(kind, {
          x: anchor.x + (Math.floor(Math.random() * 6) - 3),
          y: anchor.y + (Math.floor(Math.random() * 6) - 3),
          z: anchor.z, map: anchor.map,
        });
      }
    },
  });

  return () => api.commands.unregister('revtp');
}
