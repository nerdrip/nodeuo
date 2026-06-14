import { broadcastSound } from '../../_helpers.js';
import { findMarkedRune, teleportToRune, checkRecallCast } from '../../rune-helpers.js';

export default {
  name: 'recall',
  cast(api, ctx) {
    const caster = ctx.sender;
    api.combat.animate(api.world, caster, 0x10);
    broadcastSound(api, api.world, caster, 0x1FC);
    const reject = checkRecallCast(api, caster, ctx.state);
    if (reject) { ctx.state.sendSystemMessage(reject); return; }
    const rune = findMarkedRune(api, caster);
    if (!rune) {
      ctx.state.sendSystemMessage('You have no marked recall rune.');
      return;
    }
    const ok = teleportToRune(api, caster, rune.runeDest);
    if (!ok) ctx.state.sendSystemMessage('That destination cannot be reached.');
    else ctx.state.sendSystemMessage(`Recall: ${rune.runeDest.label ?? 'destination'}.`);
  },
};
