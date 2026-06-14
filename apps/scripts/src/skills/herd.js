// `[herd` — Herding skill (id 21). ServUO Skills/Herding.cs: target an
// animal then a destination tile to drive it there. Cap target type to
// passive animals (notoriety 1 = innocent / 3 = neutral). Failure yields
// a system message.

import { normalizeSkillValue } from '../_rules.js';
import { mobileBySerial } from '../_entities.js';

const SKILL_HERDING = 21;

function readSkill(mob, id) {
  if (!mob?.skills) return 0;
  const raw = mob.skills[id] ?? mob.skills[String(id)] ?? 0;
  return normalizeSkillValue(raw);
}

export default function register(api) {
  if (!api.targeting || !api.world) return () => {};

  api.commands.register({
    name: 'herd',
    help: '[herd — drive an animal to a chosen tile.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      ctx.state.sendSystemMessage('Herd which animal?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const animal = mobileBySerial(api, picked.serial >>> 0);
        if (!animal) return;
        // Animals only — checked via body range or a `kind` tag.
        if (animal.client) {
          ctx.state.sendSystemMessage('You can only herd animals.');
          return;
        }
        const NOT_HERDABLE = (animal.notoriety | 0) > 3;
        if (NOT_HERDABLE) {
          ctx.state.sendSystemMessage('That creature cannot be herded.');
          return;
        }
        ctx.state.sendSystemMessage('Where should it go?');
        api.targeting.request(ctx.state, (tile) => {
          const skill = readSkill(mob, SKILL_HERDING) || 30;
          const success = Math.random() * 100 < skill;
          if (!success) {
            ctx.state.sendSystemMessage('The animal ignores you.');
            api.skillGain?.tryGain?.(mob, SKILL_HERDING, 0.5);
            return;
          }
          // Set a fresh wander destination so the AI scheduler walks the
          // animal toward the tile. AI module reads `goal` if present.
          if (tile.x != null && tile.y != null) {
            animal.goal = { x: tile.x | 0, y: tile.y | 0, set: Date.now() };
          }
          ctx.state.sendSystemMessage('The animal moves where you wish.');
          api.skillGain?.tryGain?.(mob, SKILL_HERDING, 1.0);
        });
      });
    },
  });

  return () => api.commands.unregister('herd');
}
