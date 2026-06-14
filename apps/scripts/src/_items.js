function serialOf(value) {
  return typeof value === 'number' ? value >>> 0 : value?.serial >>> 0;
}

function worldOf(apiOrWorld) {
  return apiOrWorld?.world ?? apiOrWorld;
}

export function createItem(apiOrWorld, worldOrData = {}, maybeData = undefined) {
  const data = maybeData === undefined ? worldOrData : maybeData;
  const world = maybeData === undefined ? worldOf(apiOrWorld) : worldOf(worldOrData);
  if (apiOrWorld?.game?.item?.create && (!world || world === apiOrWorld.world)) {
    return apiOrWorld.game.item.create(data);
  }
  if (apiOrWorld?.items?.createItem && world) {
    return apiOrWorld.items.createItem(world, data);
  }
  if (typeof world?.createItem === 'function') {
    return world.createItem(data);
  }
  if (apiOrWorld?.game?.item?.create) {
    return apiOrWorld.game.item.create(data);
  }
  return null;
}

export function canCreateItem(apiOrWorld, worldOverride = undefined) {
  const world = worldOverride === undefined ? worldOf(apiOrWorld) : worldOf(worldOverride);
  return !!apiOrWorld?.game?.item?.create
    || !!(apiOrWorld?.items?.createItem && world)
    || typeof world?.createItem === 'function';
}

export function destroyItemBySerial(apiOrWorld, itemOrSerial) {
  const serial = serialOf(itemOrSerial);
  if (!serial) return false;
  const world = worldOf(apiOrWorld);
  if (apiOrWorld?.game?.item?.destroy) return !!apiOrWorld.game.item.destroy(serial);
  if (apiOrWorld?.ops?.destroyItem) return !!apiOrWorld.ops.destroyItem(serial);
  if (apiOrWorld?.items?.destroyItem && world) {
    apiOrWorld.items.destroyItem(world, serial);
    return true;
  }
  if (typeof world?.destroyItem === 'function') {
    world.destroyItem(serial);
    return true;
  }
  return !!world?.items?.delete?.(serial);
}
