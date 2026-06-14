import { broadcastSound, skillValue } from '../../_helpers.js';
import { itemBySerial } from '../../../_entities.js';

export default {
  name: 'magic-untrap',
  cast(api, ctx, picked) {
    const caster = ctx.sender;
    if (!picked?.serial) { ctx.state.sendSystemMessage('Magic Untrap needs a target.'); return; }
    const target = itemBySerial(api, picked.serial >>> 0);
    if (!target) {
      ctx.state.sendSystemMessage('That cannot be untrapped.');
      return;
    }
    api.combat.animate(api.world, caster, 0x10);
    broadcastSound(api, api.world, caster, 0x1F8);
    const magicTrap = (target._magicTrapDmg | 0) > 0 || target.trapped?.kind === 'magic';
    if (!magicTrap) {
      ctx.state.sendSystemMessage('Nothing to disarm.');
      return;
    }
    const magery = skillValue(caster, 26);
    const difficulty = target.trapped?.difficulty ?? target._magicTrapDmg ?? 50;
    const chance = Math.min(95, Math.max(5, 50 + magery - difficulty));
    if (Math.random() * 100 < chance) {
      target._magicTrapDmg = 0;
      target._magicTrapBy = 0;
      delete target.trapped;
      ctx.state.sendSystemMessage('The trap is disarmed.');
    } else {
      ctx.state.sendSystemMessage('You fail to disarm the trap.');
    }
  },
};
