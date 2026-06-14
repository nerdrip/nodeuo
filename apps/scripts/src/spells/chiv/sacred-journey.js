// Sacred Journey — Chivalry analog of Magery Recall: teleports the
// caster to a tagged rune destination. ServUO `SacredJourney.cs:74-91`:
// targets a marked recall rune (or rune in book) and runs the same
// CheckCast blockers as Recall. Audit #32 P1 #3: previously this was
// a raw tile teleport — caster could click any ground tile in line of
// sight and skip every safety gate (criminal flag, held-cursor stack
// DUPE, weight overload, sigil bearer, combat lock). Now mirrors
// Recall via the shared `checkRecallCast` helper + `findMarkedRune`.
import { aura, broadcastEffect, broadcastSound } from '../_helpers.js';
import { findMarkedRune, teleportToRune, checkRecallCast } from '../rune-helpers.js';
export default {
  name: 'sacred-journey', school: 'chivalry', circle: 4, mana: 0,
  cast(api, ctx) {
    const caster = ctx.sender;
    broadcastEffect(api, api.world, caster, aura(api, caster, { itemId: 0x375A, hue: 0x4FE }));
    broadcastSound(api, api.world, caster, 0x01FC);
    const reject = checkRecallCast(api, caster, ctx.state);
    if (reject) { ctx.state.sendSystemMessage(reject); return; }
    const rune = findMarkedRune(api, caster);
    if (!rune) { ctx.state.sendSystemMessage('You have no marked recall rune.'); return; }
    const ok = teleportToRune(api, caster, rune.runeDest);
    if (!ok) ctx.state.sendSystemMessage('That destination cannot be reached.');
    else ctx.state.sendSystemMessage(`Sacred Journey: ${rune.runeDest.label ?? 'destination'}.`);
  },
};
