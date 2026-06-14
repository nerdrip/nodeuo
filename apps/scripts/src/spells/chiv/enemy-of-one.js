// Enemy of One — Chivalry self-buff: bonus damage vs one chosen foe
// type, but extra damage taken from everyone else. MVP just tags
// the buff; combat-formulas would consult the flag.
import { aura, broadcastEffect, broadcastSound, skillValue } from '../_helpers.js';
export default {
  name: 'enemy-of-one', school: 'chivalry', circle: 2, mana: 0,
  cast(api, ctx) {
    const caster = ctx.sender;
    broadcastEffect(api, api.world, caster, aura(api, caster, { itemId: 0x37C4, hue: 0x4F2 }));
    broadcastSound(api, api.world, caster, 0x0F5);
    const chiv = skillValue(caster, 52);
    // Audit #38 P2 #6 — ServUO `EnemyOfOne.cs:185 EnemyOfOneContext`:
    //   `damageScalar = 10 + ((chiv-40)*9)/10`  (≈ 64 % at 100 Chiv)
    // Stamp the scalar; on first hit `_eooKind` is locked to the
    // defender's `kind`. Combat-formulas applies +scalar% to dmg vs
    // matching kind, and +100% damage TAKEN from non-matching attackers.
    caster._eooKind = null;
    caster._eooScalar = Math.max(10, 10 + Math.floor((chiv - 40) * 9 / 10));
    caster._eooUntil = Date.now() + 10_000 + chiv * 100;
    api.statusEffects?.apply?.(caster, {
      name: 'enemy-of-one',
      durationMs: 10_000 + chiv * 100,
      onRemove(mob) {
        mob._eooKind = null;
        mob._eooScalar = 0;
        mob._eooUntil = 0;
      },
    });
    ctx.state.sendSystemMessage('You sharpen your hatred. Strike a foe to bind your enmity.');
  },
};
