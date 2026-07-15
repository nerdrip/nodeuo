import { broadcastSound } from '../../_helpers.js';
import { markedDestination, teleportToRune, checkRecallCast } from '../../rune-helpers.js';

export default {
  name: 'recall',
  cast(api, ctx, selected) {
    const caster = ctx.sender;
    api.combat.animate(api.world, caster, 0x10);
    broadcastSound(api, api.world, caster, 0x1FC);
    const reject = checkRecallCast(api, caster, ctx.state);
    if (reject) { ctx.state.sendSystemMessage(reject); return; }
    const dest = markedDestination(selected);
    if (!dest) {
      ctx.state.sendSystemMessage('That is not a marked rune or a runebook with a default destination.');
      return;
    }
    const ok = teleportToRune(api, caster, dest);
    if (!ok) ctx.state.sendSystemMessage('That destination cannot be reached.');
    else ctx.state.sendSystemMessage(`Recall: ${dest.label ?? dest.name ?? 'destination'}.`);
  },
};
