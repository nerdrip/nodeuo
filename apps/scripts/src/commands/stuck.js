// PHASE GF — `[stuck` self-unstuck command.
//
// ServUO `Engines/Help/StuckMenuTimer.cs`: a player who's wedged in
// terrain or stuck inside a wall can teleport to the nearest town.
// Cooldown 5 min, requires the player to be alive (no escape exploit
// from corpse spawns).

import { moveMobile, resolveStandingZ } from '../_movement.js';
import { nearbyClients } from '../_spatial.js';
import { isSigilCarrier } from '../_sigils.js';

const TOWN_DESTS = [
  { name: 'Britain',  x: 1495, y: 1629, z: 10, map: 1 },
  { name: 'Trinsic',  x: 1846, y: 2745, z:  0, map: 1 },
  { name: 'Yew',      x:  633, y:  858, z:  0, map: 1 },
  { name: 'Minoc',    x: 2479, y:  439, z: 15, map: 1 },
  { name: 'Magincia', x: 3713, y: 2113, z: 20, map: 1 },
];
const COOLDOWN_MS = 5 * 60 * 1000;
const cooldown = new WeakMap();

function distance(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }

export default function register(api) {
  if (!api.commands) return () => {};

  api.commands.register({
    name: 'stuck',
    help: '[stuck — teleport to the nearest town if your character is wedged.',
    access: 'Player',
    run(ctx) {
      const sender = ctx.sender;
      if (sender.ghost) {
        ctx.state.sendSystemMessage('Resurrect at a shrine — ghosts are never stuck.');
        return;
      }
      // Bug-hunt #7 B8: refuse rescue mid-combat (Criminal/Murderer flag
      // OR active combat in last 60 s) so flagged players can't slip
      // away from pursuit via [stuck.
      const now = Date.now();
      const recentCombat = (sender._lastCombatAt ?? 0) > now - 60_000;
      if (recentCombat || sender.notoriety === 4 || sender.notoriety === 6) {
        ctx.state.sendSystemMessage('You cannot rescue yourself while flagged or in combat.');
        return;
      }
      // Audit #34 P3 #7 — refuse rescue while carrying a Town Sigil.
      // ServUO `StuckMenu.cs:319`. Without this a faction raider could
      // grab a sigil and `[stuck` away from the stronghold defenders.
      if (isSigilCarrier(api, sender.serial | 0)) {
        ctx.state.sendSystemMessage("You can't do that while carrying the sigil.");
        return;
      }
      const last = cooldown.get(sender) ?? 0;
      if (now - last < COOLDOWN_MS) {
        const left = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
        ctx.state.sendSystemMessage(`Wait ${left}s before another rescue.`);
        return;
      }
      // Find nearest town.
      let best = null;
      let bestD = Infinity;
      for (const t of TOWN_DESTS) {
        if (t.map !== sender.map) continue;
        const d = distance(t, sender);
        if (d < bestD) { bestD = d; best = t; }
      }
      if (!best) {
        ctx.state.sendSystemMessage('No nearby town on this map.');
        return;
      }
      cooldown.set(sender, now);
      // Bug-hunt #7 B8: snap z to the actual standing tile + re-bucket
      // in sectors so AI / spawner / visibility queries see the move.
      moveMobile(api, sender, {
        x: best.x,
        y: best.y,
        z: resolveStandingZ(api, best.map, best.x, best.y, best.z),
        map: best.map,
      });
      if (sender.client && api.protocol?.mobileUpdate) {
        sender.client.send(api.protocol.mobileUpdate({
          serial: sender.serial, body: sender.body, hue: sender.hue ?? 0,
          flags: sender.flags ?? 0, x: sender.x, y: sender.y, z: sender.z,
          direction: sender.direction ?? 0,
        }));
      }
      // Tell observers the mob arrived.
      if (api.protocol?.mobileMoving) {
        const moving = api.protocol.mobileMoving({
          serial: sender.serial, body: sender.body,
          x: sender.x, y: sender.y, z: sender.z,
          direction: sender.direction ?? 0, hue: sender.hue ?? 0,
          flags: sender.flags ?? 0, notoriety: sender.notoriety ?? 1,
        });
        for (const m of nearbyClients(api.world, sender)) m.client.send(moving);
      }
      ctx.state.sendSystemMessage(`Rescued to ${best.name}.`);
    },
  });

  return () => api.commands.unregister('stuck');
}
