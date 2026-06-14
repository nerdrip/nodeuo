import { broadcastSound } from '../../_helpers.js';
import { itemBySerial } from '../../../_entities.js';

// Counterpart to magic-lock. Strips the `locked` flag.
export default {
  name: 'unlock',
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target?.serial) { ctx.state.sendSystemMessage('Unlock needs a target.'); return; }
    const item = itemBySerial(api, target.serial >>> 0);
    if (!item) { ctx.state.sendSystemMessage('You can only unlock containers.'); return; }
    if (!item.locked) { ctx.state.sendSystemMessage('It is not locked.'); return; }
    item.locked = false;
    api.combat.animate(api.world, caster, 0x10);
    broadcastSound(api, api.world, caster, 0x1FF);
    ctx.state.sendSystemMessage('You unlock it.');
  },
};
