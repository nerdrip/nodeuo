// Bracelet of Binding — recall-to-rune-or-paired-bracelet jewelry.
// ServUO `Items/Artifacts/Equipment/Misc/BraceletOfBinding.cs`:
// `OnDoubleClick` opens a target prompt; on a marked rune item or a
// paired bracelet, performs a Recall (consumes 1 charge) regardless of
// mana / reagents / Magery skill. Greater Bracelet (60 charges) differs
// only in capacity. Audit #35 P3 #16 — content registry pointed at
// `script: 'bracelet-binding'` but no file existed; double-clicking
// the bracelet was a no-op.

import { teleportToRune, checkRecallCast } from '../../../spells/rune-helpers.js';
import { itemBySerial, mobileBySerial } from '../../../_entities.js';

function isBindingBracelet(item) {
  return item?.script === 'bracelet-binding'
    || item?.tagId === 'bracelet-of-binding'
    || item?.tagId === 'greater-bracelet-of-binding';
}

export default function buildBraceletBindingScript(api) {
  return {
    name: 'bracelet-binding',
    onCreate(_world, item) {
      item.maxCharges ??= item.tagId === 'greater-bracelet-of-binding' ? 60 : 999;
      item.charges ??= item.tagId === 'greater-bracelet-of-binding' ? 60 : 0;
      item.recharges ??= 0;
      item.inscription ??= '';
      item.servuoClasses ??= [
        item.tagId === 'greater-bracelet-of-binding' ? 'GreaterBraceletOfBinding' : 'BraceletOfBinding',
        'TransportTimer',
        'BindTarget',
        'InscribePrompt',
      ];
    },
    onUse(world, item, user) {
      if (!user?.client) return true;
      const state = user.client;
      if ((item.charges | 0) <= 0) {
        state.sendSystemMessage?.('The bracelet has no charges remaining.');
        return true;
      }
      const reject = checkRecallCast(api, user, state);
      if (reject) { state.sendSystemMessage?.(reject); return true; }
      const activateBound = () => {
        const bound = item.boundBraceletSerial
          ? itemBySerial({ world }, item.boundBraceletSerial >>> 0)
          : null;
        const partner = bound?.parent ? mobileBySerial({ world }, bound.parent >>> 0) : null;
        if (!partner) {
          state.sendSystemMessage?.('The bound bracelet cannot be reached.');
          return true;
        }
        const dest = { x: partner.x, y: partner.y, z: partner.z | 0, map: partner.map, label: partner.name ?? 'partner' };
        item.transportPendingUntil = Date.now() + 5_000;
        user.frozen = true;
        state.sendSystemMessage?.('The bracelet is attempting contact. You decide to wait a moment.');
        setTimeout(() => {
          user.frozen = false;
          item.transportPendingUntil = 0;
          if (teleportToRune(api, user, dest)) {
            item.charges = Math.max(0, (item.charges | 0) - 1);
            state.sendSystemMessage?.(`The bracelet hums and you vanish. (${item.charges} charges left)`);
          } else {
            state.sendSystemMessage?.('The destination is unreachable.');
          }
        }, 5_000).unref?.();
        return true;
      };
      if (item.boundBraceletSerial) return activateBound();
      // Unbound bracelet: target another bracelet and bind both sides.
      if (!api.targeting?.request) {
        state.sendSystemMessage?.('Targeting unavailable.');
        return true;
      }
      state.sendSystemMessage?.('Target the bracelet of binding you wish to bind this bracelet to.');
      api.targeting.request(state, (picked) => {
        if (!picked?.serial) { state.sendSystemMessage?.('Cancelled.'); return; }
        const targetItem = itemBySerial({ world }, picked.serial >>> 0);
        if (!targetItem) {
          state.sendSystemMessage?.('That is not a valid target.');
          return;
        }
        if (targetItem.serial === item.serial) {
          state.sendSystemMessage?.('You cannot bind a bracelet of binding to itself!');
          return;
        }
        if (!isBindingBracelet(targetItem)) {
          state.sendSystemMessage?.('You can only bind this bracelet to another bracelet of binding!');
          return;
        }
        if (targetItem.boundBraceletSerial && (targetItem.boundBraceletSerial >>> 0) !== (item.serial >>> 0)) {
          state.sendSystemMessage?.('That bracelet is already bound.');
          return;
        }
        item.boundBraceletSerial = targetItem.serial;
        targetItem.boundBraceletSerial = item.serial;
        state.sendSystemMessage?.('The bracelets are now bound.');
      });
      return true;
    },
  };
}
