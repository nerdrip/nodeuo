// PHASE EN — `[forensic` Forensic Evaluation skill.
//
// ServUO `Skills/Forensic.cs`: targets a corpse to reveal its
// killer's name (and last known thief if the body was looted).
// Skill-gated: 30+ to read kills, 80+ to read recent looters.

import { normalizeSkillValue } from '../_rules.js';
import { itemBySerial, mobileBySerial } from '../_entities.js';

const SKILL_FORENSIC = 20;
const COOLDOWN_MS = 5000;
const cooldown = new WeakMap();

function readSkill(mob, id) {
  const raw = mob?.skills?.[id] ?? mob?.skills?.[String(id)] ?? 0;
  return normalizeSkillValue(raw);
}

export default function register(api) {
  if (!api.commands || !api.targeting) return () => {};

  api.commands.register({
    name: 'forensic',
    help: '[forensic — examine a corpse for forensic clues.',
    access: 'Player',
    run(ctx) {
      const sender = ctx.sender;
      const last = cooldown.get(sender) ?? 0;
      const now = Date.now();
      if (now - last < COOLDOWN_MS) {
        ctx.state.sendSystemMessage('Catch your breath.');
        return;
      }
      ctx.state.sendSystemMessage('Examine which corpse?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) {
          ctx.state.sendSystemMessage('Cancelled.');
          return;
        }
        const serial = picked.serial >>> 0;
        const skill = readSkill(sender, SKILL_FORENSIC);
        cooldown.set(sender, now);
        // ServUO ForensicEval.cs has THREE target branches: Mobile,
        // Corpse-item, and Lockpickable-item. Pick the one that matches.
        const mob = mobileBySerial(api, serial);
        const item = mob ? null : itemBySerial(api, serial);

        // ---- Mobile branch (skill ≥ 36): is this person a thief? ----
        if (mob && mob !== sender) {
          if (skill < 36) {
            ctx.state.sendSystemMessage('You are not skilled enough to evaluate that.');
            return;
          }
          if (mob.npcGuild === 'thieves' || mob._thiefGuildMember) {
            ctx.state.sendSystemMessage(`${mob.name ?? 'That individual'} is a member of the thieves guild.`);
          } else {
            ctx.state.sendSystemMessage(`${mob.name ?? 'That individual'} does not appear to be a thief.`);
          }
          api.skillGain?.tryGain?.(sender, SKILL_FORENSIC, 60);
          return;
        }

        if (!item) {
          ctx.state.sendSystemMessage('You learn nothing.');
          return;
        }

        // ---- Corpse branch (skill ≥ 30): killer + last looter --------
        if (item.itemId === 0x2006) {
          if (skill < 30) {
            ctx.state.sendSystemMessage('You learn nothing.');
            return;
          }
          const killer = item.killerName ?? 'unknown';
          ctx.state.sendSystemMessage(`This corpse fell to ${killer}.`);
          // Audit #37 P3 #1 — ServUO `ForensicEval.cs:64-77` concatenates
          // `c.Looters` with ", " separator (cliloc 1042752). Was: only
          // showed the LAST looter. Reveal the full list at skill ≥ 55
          // (ServUO threshold), or just the most recent at 30-54.
          if (skill >= 55 && Array.isArray(item.lootedBy) && item.lootedBy.length > 0) {
            ctx.state.sendSystemMessage(
              `Looters: ${item.lootedBy.join(', ')}.`,
            );
          } else if (skill >= 30 && Array.isArray(item.lootedBy) && item.lootedBy.length > 0) {
            ctx.state.sendSystemMessage(
              `Last looter: ${item.lootedBy[item.lootedBy.length - 1]}.`,
            );
          }
          api.skillGain?.tryGain?.(sender, SKILL_FORENSIC, 50);
          return;
        }

        // ---- Lockpickable item branch (skill ≥ 41): last picker -----
        if ((item.lockDifficulty | 0) > 0 || item._lockable) {
          if (skill < 41) {
            ctx.state.sendSystemMessage('You are not skilled enough to read the lock.');
            return;
          }
          const picker = item._lockpickedBy ?? null;
          if (picker) {
            ctx.state.sendSystemMessage(`This lock was last picked by ${picker}.`);
          } else {
            ctx.state.sendSystemMessage('This lock shows no signs of recent tampering.');
          }
          api.skillGain?.tryGain?.(sender, SKILL_FORENSIC, 60);
          return;
        }

        ctx.state.sendSystemMessage('You learn nothing from that.');
      }, { kind: 0 });
    },
  });

  return () => api.commands.unregister('forensic');
}
