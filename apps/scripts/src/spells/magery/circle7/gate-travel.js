import { broadcastSound } from '../../_helpers.js';
import { findMarkedRune, spawnGatePair, checkRecallCast } from '../../rune-helpers.js';

export default {
  name: 'gate-travel',
  cast(api, ctx) {
    const caster = ctx.sender;
    api.combat.animate(api.world, caster, 0x10);
    broadcastSound(api, api.world, caster, 0x20E);
    const reject = checkRecallCast(api, caster, ctx.state);
    if (reject) { ctx.state.sendSystemMessage(reject); return; }
    const rune = findMarkedRune(api, caster);
    if (!rune) {
      ctx.state.sendSystemMessage('You have no marked recall rune.');
      return;
    }
    const ok = spawnGatePair(api, caster, rune.runeDest);
    if (!ok) ctx.state.sendSystemMessage('The gate fails to open.');
    else ctx.state.sendSystemMessage(`A gate opens to ${rune.runeDest.label ?? 'a distant place'}.`);
  },
};
