// `[dethide` (alias `[detect`) — attempt to spot hidden mobs around you.
//
// ServUO: Detect Hidden runs a per-target skill check vs the hidden mob's
// Hiding skill, scanning a small radius. Success reveals; failure leaves
// the mob hidden. We award Detect Hidden once per cast against difficulty
// 50 — using the average hidden skill is awkward when there are zero
// targets, so the simple flat number keeps gain smooth.

import { reveal } from '../_visibility.js';
import { nearbyMobiles } from '../_spatial.js';
import { normalizeSkillValue } from '../_rules.js';

const SKILL_DETECT_HIDDEN = 15;
const SKILL_HIDING = 22;
const RADIUS = 8;

function skillOf(mob, id) {
  if (!mob?.skills) return 0;
  return normalizeSkillValue(mob.skills[id] ?? mob.skills[String(id)] ?? 0);
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.protocol) return () => {};

  function run(ctx) {
    const mob = ctx.sender;
    if (!mob) return;
    const detect = skillOf(mob, SKILL_DETECT_HIDDEN);
    let revealed = 0;
    const iter = nearbyMobiles(api, mob, mob, RADIUS);
    for (const target of iter) {
      if (target === mob) continue;
      if (!target.hidden) continue;
      if (target.map !== mob.map) continue;
      if (Math.abs(target.x - mob.x) > RADIUS || Math.abs(target.y - mob.y) > RADIUS) continue;
      const hiding = skillOf(target, SKILL_HIDING);
      // ServUO-style opposed roll: detect needs (hiding + 21) to auto-pass,
      // (hiding - 21) to auto-fail; smooth band in between.
      const margin = detect - hiding;
      let chance;
      if (margin >= 21) chance = 1;
      else if (margin <= -21) chance = 0;
      else chance = (margin + 21) / 42;
      if (Math.random() < chance) {
        reveal(api, target);
        revealed++;
      }
    }
    if (revealed > 0) {
      ctx.state.sendSystemMessage(`You reveal ${revealed} hidden being(s).`);
    } else {
      ctx.state.sendSystemMessage('You see no hidden beings nearby.');
    }
    if (mob.skills) api.combat?.awardSkill?.(mob, SKILL_DETECT_HIDDEN, 50);
  }

  api.commands.register({
    name: 'dethide',
    help: '[dethide — search for hidden beings nearby.',
    access: 'Player',
    run,
  });
  api.commands.register({
    name: 'detect',
    help: '[detect — alias for [dethide.',
    access: 'Player',
    run,
  });

  return () => {
    api.commands.unregister('dethide');
    api.commands.unregister('detect');
  };
}
