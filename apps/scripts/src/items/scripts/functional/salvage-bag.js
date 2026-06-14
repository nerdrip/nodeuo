import { childrenOf } from '../../../_inventory.js';
import { createItem, destroyItemBySerial } from '../../../_items.js';

function backpackOf(world, user) {
  for (const item of childrenOf({ world }, user)) {
    if ((item.layer | 0) === 21 || /backpack/i.test(item.name ?? '')) return item;
  }
  return null;
}

function salvageYield(item) {
  if (!item) return 0;
  if (item.salvageIngots != null) return Math.max(0, item.salvageIngots | 0);
  if (item.kind === 'weapon') return Math.max(1, Math.floor(((item.weight ?? 4) + (item.durability ?? 20) / 10) / 2));
  if (item.kind === 'armor' || item.kind === 'shield') return Math.max(1, Math.floor((item.weight ?? 6) / 2));
  if (item.material === 'metal') return Math.max(1, Math.floor((item.weight ?? 2) / 2));
  return 0;
}

export default function buildSalvageBag(api) {
  return {
    name: 'salvage-bag',
    onCreate(_world, item) {
      item.container = true;
      item.gumpId ||= 0x003D;
      item.capacity ??= 125;
      item.salvageMode ??= 'all';
      item.servuoClasses ??= ['SalvageBag', 'SalvageAllEntry', 'SalvageIngotsEntry'];
    },
    onUse(world, bag, user) {
      const mode = bag.salvageMode ?? 'all';
      const contents = [...childrenOf({ world }, bag)];
      let ingots = 0;
      let salvaged = 0;
      for (const item of contents) {
        const yieldIngots = salvageYield(item);
        if (yieldIngots <= 0) continue;
        if (mode === 'ingots' && item.kind !== 'weapon' && item.kind !== 'armor' && item.kind !== 'shield') continue;
        ingots += yieldIngots;
        salvaged++;
        destroyItemBySerial({ world }, item.serial);
      }
      if (ingots > 0) {
        const pack = backpackOf(world, user);
        createItem(api, world, {
          itemId: 0x1BF2,
          name: 'iron ingots',
          amount: ingots,
          parent: pack?.serial ?? user?.serial,
          x: pack ? 60 : bag.x,
          y: pack ? 60 : bag.y,
          z: 0,
          map: user?.map ?? bag.map ?? 1,
          movable: true,
        });
      }
      user?.client?.sendSystemMessage?.(salvaged
        ? `You salvage ${salvaged} item${salvaged === 1 ? '' : 's'} into ${ingots} ingots.`
        : 'There is nothing salvageable in the bag.');
      return true;
    },
  };
}
