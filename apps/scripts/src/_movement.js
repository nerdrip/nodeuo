export function resolveStandingZ(api, facet, x, y, requestedZ = 0) {
  if (typeof api === 'number') {
    return Number.isFinite(y) ? y : 0;
  }
  const resolver = api?.game?.movement?.resolveStandingZ
    ?? api?.query?.resolveStandingZ
    ?? api?.ops?.resolveStandingZ;
  if (!resolver) return requestedZ;
  return resolver(facet, x, y, requestedZ);
}

export function moveMobile(api, mob, dest = {}) {
  if (!mob || !dest) return null;
  if (api?.game?.mobile?.move) return api.game.mobile.move(mob, dest);
  if (api?.ops?.moveMobile) return api.ops.moveMobile(mob, dest);
  const before = { x: mob.x, y: mob.y, z: mob.z, map: mob.map };
  if (dest.x != null) mob.x = dest.x | 0;
  if (dest.y != null) mob.y = dest.y | 0;
  if (dest.z != null) mob.z = dest.z | 0;
  if (dest.map != null) mob.map = dest.map | 0;
  api?.world?.sectors?.moveMobile?.(mob);
  return { mob, before, mapChanged: before.map !== mob.map };
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function setItemParent(api, item, parent) {
  if (api?.game?.item?.setParent) return api.game.item.setParent(item, parent);
  if (api?.ops?.setItemParent) return api.ops.setItemParent(item, parent);
  if (api?.items?.setItemParent) return api.items.setItemParent(api.world, item, parent);
  item.parent = parent ?? null;
  return item;
}

export function teleportMobile(api, mob, dest = {}, options = {}) {
  if (!mob || !dest) return null;
  if (api?.game?.mobile?.teleport) {
    return api.game.mobile.teleport(mob, dest, options);
  }
  return moveMobile(api, mob, dest);
}

export function moveItem(api, item, dest = {}) {
  if (!item || !dest) return null;
  if (api?.game?.item?.move) return api.game.item.move(item, dest);
  if (api?.ops?.moveItem) return api.ops.moveItem(item, dest);
  const before = {
    x: item.x, y: item.y, z: item.z, map: item.map, parent: item.parent,
  };
  if (hasOwn(dest, 'parent')) setItemParent(api, item, dest.parent ?? null);
  if (dest.x != null) item.x = dest.x | 0;
  if (dest.y != null) item.y = dest.y | 0;
  if (dest.z != null) item.z = dest.z | 0;
  if (dest.map != null) item.map = dest.map | 0;
  api?.world?.sectors?.moveItem?.(item);
  return {
    item,
    before,
    mapChanged: before.map !== item.map,
    parentChanged: before.parent !== item.parent,
  };
}
