import { itemBySerial } from '../../../_entities.js';
import { destroyItemBySerial } from '../../../_items.js';

const MAX_CHARGES = 2000;
export const CrystalRechargeInfo = Object.freeze([
  { itemId: 3861, gem: 'Citrine', charges: 500 },
  { itemId: 3877, gem: 'Amber', charges: 500 },
  { itemId: 3864, gem: 'Tourmaline', charges: 750 },
  { itemId: 3856, gem: 'Emerald', charges: 1000 },
  { itemId: 3857, gem: 'Sapphire', charges: 1000 },
  { itemId: 3862, gem: 'Amethyst', charges: 1000 },
  { itemId: 3855, gem: 'StarSapphire', charges: 1250 },
  { itemId: 3878, gem: 'Diamond', charges: 2000 },
]);
const GEM_CHARGES = new Map(CrystalRechargeInfo.map((entry) => [entry.itemId, entry.charges]));

function toggle(item, user) {
  item.crystalActive = !item.crystalActive;
  item.itemId = item.crystalActive
    ? (item.crystalKind === 'receiver' ? 0x1ED1 : 0x1ECD)
    : 0x1ED0;
  user?.client?.sendSystemMessage?.(item.crystalActive
    ? 'You turn the crystal on.'
    : 'You turn the crystal off.');
}

function unlinkReceiver(world, receiver, user) {
  const sender = receiver.crystalSender
    ? itemBySerial({ world }, receiver.crystalSender >>> 0)
    : null;
  if (sender?.crystalReceivers) {
    sender.crystalReceivers = sender.crystalReceivers
      .filter((serial) => (serial >>> 0) !== (receiver.serial >>> 0));
  }
  receiver.crystalSender = null;
  user?.client?.sendSystemMessage?.('You unlink the receiver crystal.');
}

export default function buildCommunicationCrystal(api) {
  return {
    name: 'communication-crystal',
    onCreate(_world, item) {
      item.crystalKind ??= 'broadcast';
      item.crystalActive ??= false;
      item.crystalRechargeInfo ??= CrystalRechargeInfo;
      item.servuoClasses ??= [
        item.crystalKind === 'receiver' ? 'ReceiverCrystal' : 'BroadcastCrystal',
        'BaseCommunicationCrystal',
        'CrystalRechargeInfo',
        'UnlinkEntry',
      ];
      if (item.crystalKind === 'broadcast') {
        item.crystalCharges ??= MAX_CHARGES;
        item.crystalReceivers ??= [];
      }
    },
    onUse(world, item, user) {
      const state = user?.client;
      if (!state) return true;
      const request = api.targeting?.request;
      if (!request) {
        toggle(item, user);
        return true;
      }
      state.sendSystemMessage?.('Select the crystal target.');
      request(state, (picked) => {
        if (!picked) return;
        const target = picked.serial ? itemBySerial({ world }, picked.serial >>> 0) : null;
        if (target?.serial === item.serial) {
          if (item.crystalKind === 'broadcast' && (item.crystalCharges | 0) <= 0) {
            state.sendSystemMessage?.('This crystal is out of charges.');
            return;
          }
          toggle(item, user);
          return;
        }
        if ((picked.serial >>> 0) === (user.serial >>> 0)) {
          if (item.crystalKind === 'broadcast') {
            for (const serial of [...(item.crystalReceivers ?? [])]) {
              const receiver = itemBySerial({ world }, serial >>> 0);
              if (receiver) receiver.crystalSender = null;
            }
            item.crystalReceivers = [];
            state.sendSystemMessage?.('You unlink all receiver crystals.');
          } else {
            unlinkReceiver(world, item, user);
          }
          return;
        }
        if (item.crystalKind === 'broadcast') {
          if (target?.crystalKind === 'receiver') {
            item.crystalReceivers ??= [];
            if (item.crystalReceivers.length >= 10) {
              state.sendSystemMessage?.('This broadcast crystal is already linked to 10 receivers.');
              return;
            }
            if (target.crystalSender && (target.crystalSender >>> 0) !== (item.serial >>> 0)) {
              state.sendSystemMessage?.('That receiver crystal is already linked.');
              return;
            }
            if (!item.crystalReceivers.includes(target.serial)) item.crystalReceivers.push(target.serial);
            target.crystalSender = item.serial;
            state.sendSystemMessage?.('That crystal has been linked to this crystal.');
            return;
          }
          const recharge = GEM_CHARGES.get(target?.itemId | 0);
          if (recharge) {
            if ((item.crystalCharges | 0) >= MAX_CHARGES) {
              state.sendSystemMessage?.('This crystal is already fully charged.');
              return;
            }
            item.crystalCharges = Math.min(MAX_CHARGES, (item.crystalCharges | 0) + recharge);
            destroyItemBySerial({ world }, target.serial);
            state.sendSystemMessage?.(item.crystalCharges >= MAX_CHARGES
              ? 'You completely recharge the crystal.'
              : 'You recharge the crystal.');
            return;
          }
        } else if (target && GEM_CHARGES.has(target.itemId | 0)) {
          state.sendSystemMessage?.('This crystal cannot be recharged.');
          return;
        }
        state.sendSystemMessage?.('You cannot use this crystal on that.');
      });
      return true;
    },
  };
}
