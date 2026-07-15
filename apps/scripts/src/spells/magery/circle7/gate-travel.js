import { broadcastSound } from '../../_helpers.js';
import { markedDestination, spawnGatePair, checkRecallCast } from '../../rune-helpers.js';

export default {
  name: 'gate-travel',
  cast(api, ctx, selected) {
    const caster = ctx.sender;
    api.combat.animate(api.world, caster, 0x10);
    broadcastSound(api, api.world, caster, 0x20E);
    const reject = checkRecallCast(api, caster, ctx.state);
    if (reject) { ctx.state.sendSystemMessage(reject); return; }
    const dest = markedDestination(selected);
    if (!dest) {
      ctx.state.sendSystemMessage('That is not a marked rune or a runebook with a default destination.');
      return;
    }
    const ok = spawnGatePair(api, caster, dest);
    if (!ok) ctx.state.sendSystemMessage('The gate fails to open.');
    else ctx.state.sendSystemMessage(`A gate opens to ${dest.label ?? dest.name ?? 'a distant place'}.`);
  },
};
