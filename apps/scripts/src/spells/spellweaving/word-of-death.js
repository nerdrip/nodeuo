import { aura, broadcastEffect, broadcastSound, skillValue } from '../_helpers.js';
// Audit #32 P2 #8 — ServUO `WordOfDeath.cs:58-80`. Was: any target below
// 5% HP took 999 dmg, fallback flat 30. PvP-broken (player couldn't be
// saved). New: PvE-only execute, threshold scales with arcane focus
// (5% per level → max 30% at FL6). Fallback random Spellweaving/5..SW/3.
export default {
  name: 'word-of-death', school: 'spellweaving', circle: 6, mana: 50,
  cast(api, ctx, target) {
    if (!target?.serial) return ctx.state.sendSystemMessage('Word of Death needs a target.');
    const caster = ctx.sender;
    const sw = skillValue(caster, 55);                         // Spellweaving
    // Audit #37 P1 #1 — prefer canonical `_arcaneFocusLevel`.
    const focusRaw = (caster._arcaneFocusLevel | 0) || (caster._arcaneFocus | 0);
    const focusLevel = Math.max(1, Math.min(6, focusRaw || 1));
    const threshold = 0.05 * focusLevel;
    const isPlayer = !!target.client;
    const hpFrac = (target.hp ?? 0) / Math.max(1, target.hpMax ?? 1);
    const lo = Math.max(1, Math.floor(sw / 5));
    const hi = Math.max(lo, Math.floor(sw / 3));
    const fallback = lo + Math.floor(Math.random() * (hi - lo + 1));
    const dmg = (!isPlayer && hpFrac < threshold) ? 300 : fallback;
    broadcastEffect(api, api.world, target, aura(api, target, { itemId: 0x36CB, hue: 0x4F2 }));
    broadcastSound(api, api.world, target, 0x5D2);
    api.combat.damage(api.world, target, dmg, caster);
  },
};
