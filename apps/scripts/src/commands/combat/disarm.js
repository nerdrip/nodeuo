// PHASE EM — `[disarm` Remove Trap activity for chests.
//
// ServUO `Skills/RemoveTrap.cs`: targeted on a trapped container,
// runs a Remove Trap skill check; on success clears `item.trapped`,
// on failure springs the trap (damages the disarmer). We tag traps
// via `item.trapped: { damage, level }` (level scales difficulty).

import { normalizeSkillValue } from '../../_rules.js';
import { itemBySerial } from '../../_entities.js';

const SKILL_REMOVE_TRAP = 49;
const SKILL_LOCKPICKING = 25;
const SKILL_DETECT_HIDDEN = 15;
const COOLDOWN_MS = 3000;
const cooldown = new WeakMap();

export default function register(api) {
  if (!api.commands || !api.targeting) return () => {};

  api.commands.register({
    name: 'disarm',
    help: '[disarm — target a trapped container to remove the trap.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      const last = cooldown.get(mob) ?? 0;
      const now = Date.now();
      if (now - last < COOLDOWN_MS) {
        ctx.state.sendSystemMessage('Be patient.');
        return;
      }
      // Audit #33 P2 #7 — ServUO `RemoveTrap.cs:29-67` prerequisites:
      // Lockpicking ≥ 50 AND Detect Hidden ≥ 50 just to START the skill;
      // refuses a `LockableContainer.Locked` target outright. Previously
      // anyone could attempt any trap, including locked chests (decoy-
      // disarm-while-locked exploit ServUO closed).
      const lockpick = readSkill(mob, SKILL_LOCKPICKING);
      const detect   = readSkill(mob, SKILL_DETECT_HIDDEN);
      if (lockpick < 50 || detect < 50) {
        ctx.state.sendSystemMessage('You lack the skill to attempt that. (Lockpicking 50, Detect Hidden 50.)');
        return;
      }
      ctx.state.sendSystemMessage('Disarm which trap?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) {
          ctx.state.sendSystemMessage('Cancelled.');
          return;
        }
        const item = itemBySerial(api, picked.serial >>> 0);
        if (!item) {
          ctx.state.sendSystemMessage('That is not a container.');
          return;
        }
        if (item.locked) {
          ctx.state.sendSystemMessage('That is locked.');
          return;
        }
        if (!item.trapped) {
          ctx.state.sendSystemMessage('You see no trap.');
          return;
        }
        cooldown.set(mob, now);
        const skill = readSkill(mob, SKILL_REMOVE_TRAP);
        const level = item.trapped.level | 0;
        const diff = 30 + level * 20;
        const margin = skill - diff;
        const chance = Math.max(0.05, Math.min(0.95, 0.5 + margin / 100));
        if (Math.random() < chance) {
          delete item.trapped;
          item._magicTrapDmg = 0;
          item._magicTrapBy = 0;
          ctx.state.sendSystemMessage('You disarm the trap.');
          api.skillGain?.tryGain?.(mob, SKILL_REMOVE_TRAP, diff);
        } else {
          // Spring the trap on the disarmer. Bug-hunt #7 B9: do NOT
          // delete the trap on a failed disarm — ServUO `RemoveTrap`
          // keeps the trap live (player must keep retrying). Without
          // this fix a low-skill player griefs the trap, eats the dmg
          // once and walks into the loot.
          const dmg = item.trapped.damage | 0;
          ctx.state.sendSystemMessage(`The trap fires! (-${dmg} hp)`);
          if (mob.hp != null) {
            mob.hp = Math.max(0, mob.hp - dmg);
            if (mob.client && api.protocol?.healthUpdate) {
              mob.client.send(api.protocol.healthUpdate({
                serial: mob.serial, current: mob.hp, max: mob.hpMax ?? 50,
              }));
            }
          }
        }
      }, { kind: 0 });
    },
  });

  return () => api.commands.unregister('disarm');
}

function readSkill(mob, id) {
  const raw = mob?.skills?.[id] ?? mob?.skills?.[String(id)] ?? 0;
  return normalizeSkillValue(raw);
}
