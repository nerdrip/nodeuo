import { broadcastSound, skillValue } from '../../_helpers.js';
import { itemBySerial } from '../../../_entities.js';

export default {
  name: 'magic-trap',
  cast(api, ctx, picked) {
    const caster = ctx.sender;
    if (!picked?.serial) { ctx.state.sendSystemMessage('Magic Trap needs a target.'); return; }
    const target = itemBySerial(api, picked.serial >>> 0);
    if (!target || !target.gumpId) {
      ctx.state.sendSystemMessage('You can only trap containers.');
      return;
    }
    const magery = skillValue(caster, 26);
    const trapDmg = 10 + Math.floor((magery + (caster.int ?? 0)) / 12);
    target._magicTrapDmg = trapDmg;
    target._magicTrapBy = caster.serial;
    target.trapped = {
      kind: 'magic',
      damage: trapDmg,
      level: 1,
      difficulty: Math.max(25, Math.min(100, Math.floor(magery))),
      by: caster.serial,
    };
    api.combat.animate(api.world, caster, 0x10);
    broadcastSound(api, api.world, caster, 0x1F8);
    ctx.state.sendSystemMessage('The trap is set.');
  },
};
