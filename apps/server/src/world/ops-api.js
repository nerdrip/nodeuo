import { destroyItem, setItemParent } from './items.js';

function resolveMobile(world, mobileOrSerial) {
  return typeof mobileOrSerial === 'number'
    ? world.mobiles.get(mobileOrSerial >>> 0)
    : mobileOrSerial;
}

function resolveItem(world, itemOrSerial) {
  return typeof itemOrSerial === 'number'
    ? world.items.get(itemOrSerial >>> 0)
    : itemOrSerial;
}

/**
 * Mutation facade for scripts.
 *
 * Direct `mob.x = ...` / `item.parent = ...` assignments are easy to write
 * but easy to forget to mirror into sector and parent indexes. This facade
 * keeps the low-level world maps authoritative while giving scripts one
 * Node-first path for common mutations.
 */
export function createWorldOpsApi(world) {
  return Object.freeze({
    moveMobile(mobileOrSerial, dest = {}) {
      const mob = resolveMobile(world, mobileOrSerial);
      if (!mob) return null;
      const before = { x: mob.x, y: mob.y, z: mob.z, map: mob.map };
      if (dest.x != null) mob.x = dest.x | 0;
      if (dest.y != null) mob.y = dest.y | 0;
      if (dest.z != null) mob.z = dest.z | 0;
      if (dest.map != null) mob.map = dest.map | 0;
      world.sectors?.moveMobile?.(mob);
      return { mob, before, mapChanged: before.map !== mob.map };
    },

    moveItem(itemOrSerial, dest = {}) {
      const item = resolveItem(world, itemOrSerial);
      if (!item) return null;
      const before = {
        x: item.x, y: item.y, z: item.z, map: item.map, parent: item.parent,
      };
      if (Object.prototype.hasOwnProperty.call(dest, 'parent')) {
        setItemParent(world, item, dest.parent ?? null);
      }
      if (dest.x != null) item.x = dest.x | 0;
      if (dest.y != null) item.y = dest.y | 0;
      if (dest.z != null) item.z = dest.z | 0;
      if (dest.map != null) item.map = dest.map | 0;
      world.sectors?.moveItem?.(item);
      return {
        item,
        before,
        mapChanged: before.map !== item.map,
        parentChanged: before.parent !== item.parent,
      };
    },

    setItemParent(itemOrSerial, parentSerial = null) {
      const item = resolveItem(world, itemOrSerial);
      if (!item) return null;
      setItemParent(world, item, parentSerial);
      world.sectors?.moveItem?.(item);
      return item;
    },

    destroyItem(itemOrSerial) {
      const serial = typeof itemOrSerial === 'number'
        ? itemOrSerial >>> 0
        : itemOrSerial?.serial >>> 0;
      if (!serial) return false;
      destroyItem(world, serial);
      return true;
    },

    destroyMobile(mobileOrSerial) {
      const serial = typeof mobileOrSerial === 'number'
        ? mobileOrSerial >>> 0
        : mobileOrSerial?.serial >>> 0;
      if (!serial) return false;
      world.destroyMobile?.(serial);
      return true;
    },
  });
}
