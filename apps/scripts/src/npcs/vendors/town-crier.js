import { spawnNPC } from './_spawn.js';
import { moveMobile } from '../../_movement.js';

// Town crier: a very simple NPC that wanders a short distance and periodically
// calls out one of a list of messages.
//
// The behavior piggybacks on the built-in `wander` and layers a speech timer
// on top. Because behaviors are registered by name, reloading this script
// replaces the old definition cleanly.

const LINES = [
  'Hear ye, hear ye! Fresh news from the shard!',
  'The Lord British declares a grand tournament at Britain Castle!',
  'Beware of brigands upon the road to Yew!',
  'Fresh bread for sale at the bakery, two copper a loaf!',
  'A reward for any who return the lost amulet of Lord Blackthorn!',
];

/**
 * @param {import('@uo/server/src/scripts.js').ScriptAPI} api
 */
export default function register(api) {
  if (!api.ai || !api.templates) {
    api.log('npc/town-crier: api.ai or api.templates missing; skipping');
    return () => {};
  }

  api.ai.registerBehavior({
    name: 'townCrier',
    initState() {
      return {
        nextStepAt: Date.now() + 2000,
        nextShoutAt: Date.now() + 5000 + Math.random() * 5000,
        home: null,
        lineIndex: 0,
      };
    },
    tick(ctx, mob, state) {
      if (state.home === null) state.home = { x: mob.x, y: mob.y };

      // Wander (copy of wanderBehavior logic, trimmed).
      if (ctx.now >= state.nextStepAt) {
        state.nextStepAt = ctx.now + 2000 + Math.random() * 3000;
        const dir = Math.floor(Math.random() * 8);
        const deltas = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
        const [dx, dy] = deltas[dir];
        if (Math.abs((mob.x + dx) - state.home.x) <= 5 &&
            Math.abs((mob.y + dy) - state.home.y) <= 5) {
          moveMobile(api, mob, {
            x: (mob.x + dx) & 0xFFFF,
            y: (mob.y + dy) & 0xFFFF,
            z: mob.z,
            map: mob.map,
          });
          mob.direction = dir;
          ctx.broadcastMove(mob);
        } else {
          mob.direction = dir;
        }
      }

      // Shout periodically.
      if (ctx.now >= state.nextShoutAt) {
        state.nextShoutAt = ctx.now + 15000 + Math.random() * 15000;
        const text = LINES[state.lineIndex % LINES.length];
        state.lineIndex++;
        ctx.broadcastSpeech(mob, text, 0x0035); // yellow
      }
    },
  });

  // `[crier` — spawn a town crier at the sender's feet.
  api.commands.register({
    name: 'crier',
    help: '[crier — spawn a wandering town crier at your feet',
    run(ctx) {
      // FAZA CB — route through spawnNPC so the crier comes dressed.
      const npc = spawnNPC(api, ctx.sender, {
        name: 'Town Crier',
        body: 0x0190, hue: 0x83EA,
        kind: 'crier', outfit: 'peasant',
        notoriety: 1, invulnerable: false,
        behavior: 'townCrier',
      });
      ctx.state.sendSystemMessage(`Town crier 0x${npc.serial.toString(16)} appears.`);
    },
  });

  return () => {
    api.ai.unregisterBehavior('townCrier');
    api.commands.unregister('crier');
  };
}
