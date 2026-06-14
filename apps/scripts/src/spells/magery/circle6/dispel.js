import { broadcastEffect, broadcastSound, skillValue } from '../../_helpers.js';
import { destroyMobileBySerial } from '../../../_mobiles.js';

export default {
  name: 'dispel',
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target || !target.serial) { ctx.state.sendSystemMessage('Dispel needs a target.'); return; }
    api.combat.animate(api.world, caster, 0x10);
    const fx = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.FromSource,
      from: target.serial, to: target.serial,
      itemId: 0x3728,
      fromX: target.x, fromY: target.y, fromZ: target.z,
      toX: target.x, toY: target.y, toZ: target.z,
      speed: 10, duration: 13,
      fixedDirection: 1, explodes: 0,
      hue: 0, renderMode: 0,
    });
    broadcastEffect(api, api.world, target, fx);
    broadcastSound(api, api.world, target, 0x201);
    // Audit #30 P1 #4 — summons branch. ServUO `Dispel.cs` rolls
    //   chance = (50 + 100*(magery − dispelDifficulty) / (dispelFocus*2)) / 100
    // and on success calls `target.Delete()`. Previously Dispel only
    // walked `target.effects[]`, leaving summoned daemons completely
    // immune — a 90-Magery dispel against a Fiend was a no-op.
    if (target.summoned) {
      // Audit #41 P1 #4 — Magery is skill id 26 (skill 16 = Discordance).
      // Was: 100-Magery / 0-Discord mage rolled against 0 → never dispelled.
      const magery = skillValue(caster, 26);
      const diff   = target.dispelDifficulty ?? 90;
      const focus  = target.dispelFocus ?? 30;
      const chance = (50 + (100 * (magery - diff)) / (focus * 2)) / 100;
      if (Math.random() < chance) {
        destroyMobileBySerial(api, target.serial);
        ctx.state.sendSystemMessage('The creature dissipates.');
      } else {
        ctx.state.sendSystemMessage('The creature resists your dispel.');
      }
      return;
    }
    if (!api.statusEffects) return;
    // Strip every non-system effect except 'poison' (use Cure for that).
    const removable = (target.effects ?? [])
      .map((e) => e.name)
      .filter((n) => n && n !== 'poison');
    for (const n of removable) api.statusEffects.remove(target, n, api.world);
    ctx.state.sendSystemMessage(`Dispelled ${removable.length} effect(s).`);
  },
};
