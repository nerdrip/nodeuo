import { aura, broadcastEffect, broadcastSound, skillValue } from '../_helpers.js';
export default {
  name: 'sleep', school: 'mysticism', circle: 3, mana: 9,
  cast(api, ctx, target) {
    if (!target?.serial) return ctx.state.sendSystemMessage('Sleep needs a target.');
    const caster = ctx.sender;
    broadcastEffect(api, api.world, target, aura(api, target, { itemId: 0x376A, hue: 0x47 }));
    broadcastSound(api, api.world, target, 0x657);
    // Audit #41 P2 #20 — ServUO `SleepSpell.cs:51-52`:
    //   dur_s = (CastSkill+DamageSkill)/20 + 2 − MagicResist/10
    // Mysticism (56) + max(Focus(57), Imbuing(58)) − target MR (27).
    // Was: flat 6s.
    // Audit #42 P2 #29 — was [57]=Imbuing (correct) + [58]=Throwing
    // (wrong — high throwers cast longer sleeps). ServUO Mysticism's
    // damage-skill is `max(Focus, Imbuing)` where Focus=51 and
    // Imbuing=57 per skills.json. `mass-sleep.js` already uses the
    // correct pair.
    const mys   = skillValue(caster, 56);
    const focus = Math.max(skillValue(caster, 51), skillValue(caster, 57));
    const mr    = skillValue(target, 27);
    const seconds = Math.max(2, Math.floor((mys + focus) / 20 + 2 - mr / 10));
    api.statusEffects?.apply?.(target, { name: 'sleep', durationMs: seconds * 1000 });
  },
};
