// Cleanse By Fire — Chivalry self-heal that burns away poison.
// Mirrors ServUO `Spells/Chivalry/CleanseByFire.cs`. The caster takes
// a small fire-damage reaction proportional to the poison level, then
// the poison is removed. Functional model:
//   • cure full poison stack on caster
//   • caster takes 4 + level*4 fire damage as the cleansing burn
//   • spell-effect FX + sound
// Tithing cost: 10. No reagents (Chivalry).

import { aura, broadcastEffect, broadcastSound, skillValue } from '../_helpers.js';
import { mobileBySerial } from '../../_entities.js';

// Audit #38 P3 #11 — ServUO `CleanseByFire.cs:53-122`: targeted spell
// (`needsTarget: true`), cure chance `(10000 + chiv*75 - (level+1)*2000)/100`,
// burn dmg `clamp(50 - sqrt((karma+20000+chiv*10))/4, 13, 55)` (much
// harsher than the 4+lvl*4 of the legacy stub). Paladins can cure
// party members for the fire tax. Was: self-only + light burn.
export default {
  name: 'cleanse-by-fire',
  school: 'chivalry',
  cast(api, ctx, picked) {
    const caster = ctx.sender;
    // Default target = self when no target picked.
    const target = picked?.serial
      ? mobileBySerial(api, picked.serial >>> 0) ?? caster
      : caster;
    const fx = aura(api, caster, { itemId: 0x37CC, hue: 0x35, duration: 10 });
    broadcastEffect(api, api.world, target, fx);
    broadcastSound(api, api.world, caster, 0x208);

    // Resolve poison level from status-effects if present (poison entry
    // carries `data.level`); otherwise fall back to mob.poisonLevel.
    let poisonLevel = 0;
    const eff = (target.statusEffects ?? target.effects ?? []).find?.((e) => e.name === 'poison');
    if (eff) poisonLevel = eff.data?.level ?? 1;
    else if (target.poisonLevel) poisonLevel = target.poisonLevel;

    if (poisonLevel <= 0) {
      ctx.state.sendSystemMessage?.('The target is not afflicted by poison.');
      return;
    }

    // ServUO cure-chance roll.
    const chiv = skillValue(caster, 52);
    const cureChance = Math.max(0, (10000 + chiv * 75 - (poisonLevel + 1) * 2000) / 100);
    const cured = Math.random() * 100 < cureChance;
    if (cured) {
      if (api.statusEffects?.remove) {
        api.statusEffects.remove(target, 'poison');
      } else {
        target.statusEffects = (target.statusEffects ?? []).filter((e) => e.name !== 'poison');
        target.poisoned = false;
        target.poisonLevel = 0;
      }
    }

    // Burn payment — caster always pays even on cure-fail (the fire
    // still scorches them while the poison is amplified).
    const karma = caster.karma ?? 0;
    const burn = Math.max(13, Math.min(55,
      Math.floor(50 - Math.sqrt(Math.max(0, karma + 20000 + chiv * 10)) / 4)));
    api.combat.damage(api.world, caster, burn, caster);
    ctx.state.sendSystemMessage?.(cured
      ? `The cleansing fire burns the poison from ${target === caster ? 'your' : 'their'} veins. (-${burn} hp)`
      : `The fire scorches you but the poison persists. (-${burn} hp)`);
  },
};
