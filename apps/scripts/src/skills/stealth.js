// `[stealth` — try to remain hidden while moving.
//
// Without this skill, hidden mobs can stand still forever but reveal the
// instant they take a step (handled wherever movement reveals — for now,
// movement does NOT auto-reveal because we have no script-side movement hook).
//
// MVP behaviour: rolling Stealth grants `mob.stealthSteps`, the number of
// upcoming steps the player can take while staying hidden. Steps are
// decremented by the movement reveal hook (when one is wired in).
// Failure: nothing changes; the player simply stays hidden until they
// trigger another reveal source.

import { normalizeSkillValue } from '../_rules.js';
import { equipped } from '../_inventory.js';

const SKILL_STEALTH = 48;
const SKILL_HIDING = 22;
// ServUO `Stealth.cs::ArmorMod` rejects when summed worn AR ≥ 42 with the
// "you could not hope to move quietly wearing this much armor" cliloc.
// Medium leather/studded fits under the cap; chain/plate doesn't.
const STEALTH_ARMOR_CAP = 42;

function skillOf(mob, id) {
  if (!mob?.skills) return 0;
  return normalizeSkillValue(mob.skills[id] ?? mob.skills[String(id)] ?? 0);
}

/** Sum AR of every armor piece the player is currently wearing. Walks the
 *  reverse parent index (cheap O(slots)), falls back to a full items scan
 *  only when the index isn't built yet (e.g. very first tick after world
 *  load before anyone has equipped). */
function wornArmorRating(api, mob) {
  if (!mob) return 0;
  let total = 0;
  for (const it of equipped(api, mob)) {
    // Layers 1..2 are weapon/shield/spellbook hands — not armor.
    if (it.layer >= 3 && it.layer <= 24) total += it.ar | 0;
  }
  return total;
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.protocol) return () => {};

  api.commands.register({
    name: 'stealth',
    help: '[stealth — attempt silent movement; only works while hidden.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      if (!mob) return;
      if (!mob.hidden) {
        ctx.state.sendSystemMessage('You must hide first.');
        return;
      }
      // Audit #41 P3 #38 — rate-limit to 1 attempt/s. Was: spam-click
      // `[stealth` from full hide ground GM in minutes via the skill
      // award on success. ServUO ticks `Stealth.OnUse` per movement
      // step, not per button press — same effect as a 1s gate.
      if ((mob._lastStealthAt ?? 0) + 1000 > Date.now()) {
        ctx.state.sendSystemMessage('You must wait before attempting that again.');
        return;
      }
      mob._lastStealthAt = Date.now();
      const stealth = skillOf(mob, SKILL_STEALTH);
      const hiding = skillOf(mob, SKILL_HIDING);
      if (hiding < 80) {
        ctx.state.sendSystemMessage('You are not hidden well enough to attempt stealth.');
        return;
      }
      // Heavy armor blocks stealth even at GM skill — same cap ServUO
      // applies. Staff bypass mirrors `m.AccessLevel < GameMaster` check.
      const isStaff = ctx.state?.account?.accessLevel === 'GM'
                   || ctx.state?.account?.accessLevel === 'Admin';
      if (!isStaff) {
        const ar = wornArmorRating(api, mob);
        if (ar >= STEALTH_ARMOR_CAP) {
          ctx.state.sendSystemMessage('You could not hope to move quietly wearing this much armor.');
          return;
        }
      }
      const award = api.combat?.awardSkill;
      const chance = Math.min(1, Math.max(0, stealth / 100));
      if (Math.random() >= chance) {
        ctx.state.sendSystemMessage('You fail to move quietly.');
        if (mob.skills && Math.random() < 0.5) award?.(mob, SKILL_STEALTH, 60);
        return;
      }
      // ServUO grants steps == floor(skill / 10). Cached on the mob; the
      // movement reveal hook (when wired) will decrement and re-veal at 0.
      mob.stealthSteps = Math.max(1, Math.floor(stealth / 10));
      ctx.state.sendSystemMessage(`You move quietly. (${mob.stealthSteps} steps)`);
      if (mob.skills) award?.(mob, SKILL_STEALTH, 60);
    },
  });

  return () => api.commands.unregister('stealth');
}
