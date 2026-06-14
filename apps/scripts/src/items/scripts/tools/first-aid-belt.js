import { childrenOf } from '../../../_inventory.js';
import { destroyItemBySerial } from '../../../_items.js';
import { moveItem } from '../../../_movement.js';
import { allMobiles } from '../../../_spatial.js';

const BANDAGE_ITEM_ID = 0x0E21;
const ENHANCED_BANDAGE_HUE = 0x08A5;
const LAYER_WAIST = 12;

function classesOf(item) {
  return [item?.servuoClass, ...(item?.servuoClasses ?? [])].filter(Boolean);
}

function isBandageItem(item) {
  if (!item) return false;
  if ((item.itemId | 0) === BANDAGE_ITEM_ID) return true;
  if (item.tagId === 'bandage' || item.tagId === 'enhanced-bandage') return true;
  const classes = classesOf(item);
  return classes.includes('Bandage') || classes.includes('EnhancedBandage');
}

function isEnhancedBandage(item) {
  if (!isBandageItem(item)) return false;
  if ((item.bandageHealingBonus | 0) > 0) return true;
  if (item.tagId === 'enhanced-bandage') return true;
  if (classesOf(item).includes('EnhancedBandage')) return true;
  if ((item.itemId | 0) === BANDAGE_ITEM_ID && (item.hue | 0) === ENHANCED_BANDAGE_HUE) return true;
  return /enhanced bandage/i.test(item.name ?? '');
}

function ensureBelt(item) {
  item.firstAidBelt = true;
  item.container = true;
  item.gumpId ||= 0x003C;
  item.capacity ??= 1;
  item.maxWeight ??= 100;
  item.firstAidMaxBandages ??= (item.maxWeight | 0) * 10 || 1000;
  item.equipLayer ??= LAYER_WAIST;
  item.weight ??= 2;
  item.servuoClass ??= 'FirstAidBelt';
  item.servuoClasses = [...new Set([
    item.servuoClass,
    ...(item.servuoClasses ?? []),
    'FirstAidBelt',
  ].filter(Boolean))];
}

function contents(api, world, belt) {
  return [...childrenOf({ ...api, world }, belt)];
}

function bandageAmount(api, world, belt) {
  let total = 0;
  for (const item of contents(api, world, belt)) {
    if (isBandageItem(item)) total += Math.max(1, item.amount ?? 1);
  }
  return total;
}

function beltBandage(api, world, belt) {
  return contents(api, world, belt).find(isBandageItem) ?? null;
}

function notifyContainer(api, world, belt, item, removed = false) {
  const parent = belt?.serial >>> 0;
  if (!parent || !item) return;
  const packet = removed
    ? api.protocol?.removeEntity?.(item.serial)
    : api.protocol?.containerContentUpdate?.({
        serial: item.serial,
        itemId: item.itemId,
        amount: item.amount ?? 1,
        hue: item.hue ?? 0,
        gridX: item.gridX ?? 0,
        gridY: item.gridY ?? 0,
        gridLocation: item.gridLocation ?? 0,
      }, parent);
  if (!packet) return;
  for (const mob of allMobiles({ ...api, world })) {
    if (mob.client?.openContainers?.has?.(parent)) mob.client.send?.(packet);
  }
}

export default function buildFirstAidBelt(api) {
  return {
    name: 'first-aid-belt',
    onCreate(_world, item) {
      ensureBelt(item);
    },
    onUse(world, item, user) {
      ensureBelt(item);
      const count = bandageAmount(api, world, item);
      const bonus = item.firstAidHealingBonus | 0;
      const reduction = item.firstAidWeightReduction | 0;
      const details = [
        `${count}/${item.firstAidMaxBandages | 0} bandage(s)`,
        bonus > 0 ? `healing bonus +${bonus}` : null,
        reduction > 0 ? `weight reduction ${reduction}%` : null,
      ].filter(Boolean).join(', ');
      user?.client?.sendSystemMessage?.(`First Aid Belt: ${details}.`);
      return false;
    },
    onDrop(world, belt, dropped, dropper) {
      ensureBelt(belt);
      if (!isBandageItem(dropped)) {
        dropper?.client?.sendSystemMessage?.('The container can not hold that type of object.');
        return { handled: true, consumeHeld: false };
      }

      const existing = beltBandage(api, world, belt);
      if (existing && isEnhancedBandage(existing) !== isEnhancedBandage(dropped)) {
        dropper?.client?.sendSystemMessage?.('The belt can only hold one kind of bandage at a time.');
        return { handled: true, consumeHeld: false };
      }

      const current = bandageAmount(api, world, belt);
      const incoming = Math.max(1, dropped.amount ?? 1);
      if (current + incoming > (belt.firstAidMaxBandages | 0)) {
        dropper?.client?.sendSystemMessage?.('That container cannot hold more items.');
        return { handled: true, consumeHeld: false };
      }

      if (existing) {
        existing.amount = (existing.amount ?? 1) + incoming;
        destroyItemBySerial({ ...api, world }, dropped.serial);
        notifyContainer(api, world, belt, existing);
        notifyContainer(api, world, belt, dropped, true);
        return true;
      }

      moveItem(api, dropped, {
        parent: belt.serial,
        x: dropped.gridX ?? 44,
        y: dropped.gridY ?? 44,
        z: 0,
        map: 0,
      });
      notifyContainer(api, world, belt, dropped);
      return true;
    },
  };
}
