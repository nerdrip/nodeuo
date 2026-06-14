// Evil Omen — debuffs target's next saving throw / resist roll. Tagged
// via status-effects; combat code reads the flag at apply-spell-damage
// time to drop the resist reduction.
import { aura, broadcastEffect, broadcastSound, skillValue } from '../_helpers.js';
export default {
  name: 'evil-omen', school: 'necromancy', circle: 1, mana: 11,
  cast(api, ctx, target) {
    if (!target?.serial) return ctx.state.sendSystemMessage('Evil Omen needs a target.');
    broadcastEffect(api, api.world, target, aura(api, target, { itemId: 0x3728, hue: 0x06D }));
    broadcastSound(api, api.world, target, 0x0240);
    // Audit #41 P1 #2 — the +25%-damage rider and the poison-level+1
    // consumer (`_helpers.js:424` and `poison.js:70`) both read
    // `evilOmenUntil`.
    // Audit #43 P2-6 — ServUO `EvilOmen.cs:132` duration scales by
    // Spirit Speak: `(SS/12 + 1) seconds`. Was flat 30s. At GM SS=100
    // that's ~9s; at SS=0 1s. The +25% damage reader consumes the buff
    // on first harmful event regardless.
    const caster = ctx.sender;
    const ss = skillValue(caster, 33) || skillValue(caster, 50);
    const durationMs = Math.max(1000, Math.floor((ss / 12 + 1) * 1000));
    target.evilOmenUntil = Date.now() + durationMs;
    api.statusEffects?.apply?.(target, { name: 'evil-omen', durationMs });
    target.client?.sendSystemMessage?.('A foreboding shadow follows you.');
  },
};
