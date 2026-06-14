function worldOf(apiOrWorld) {
  return apiOrWorld?.world ?? apiOrWorld;
}

function serialOf(value) {
  return typeof value === 'number' ? value >>> 0 : value?.serial >>> 0;
}

function copyScriptFields(mob, data = {}) {
  if (!mob) return mob;
  for (const [key, value] of Object.entries(data)) {
    if (key === 'serial') continue;
    if (!(key in mob)) mob[key] = value;
  }
  return mob;
}

export function createMobile(apiOrWorld, worldOrData = {}, maybeData = undefined) {
  const data = maybeData === undefined ? worldOrData : maybeData;
  const world = maybeData === undefined ? worldOf(apiOrWorld) : worldOf(worldOrData);
  if (apiOrWorld?.game?.mobile?.create && (!world || world === apiOrWorld.world)) {
    return apiOrWorld.game.mobile.create(data);
  }
  if (typeof world?.createMobile === 'function') {
    return copyScriptFields(world.createMobile(data), data);
  }
  if (apiOrWorld?.game?.mobile?.create) {
    return apiOrWorld.game.mobile.create(data);
  }
  return null;
}

export function canCreateMobile(apiOrWorld, worldOverride = undefined) {
  const world = worldOverride === undefined ? worldOf(apiOrWorld) : worldOf(worldOverride);
  return !!apiOrWorld?.game?.mobile?.create || typeof world?.createMobile === 'function';
}

export function destroyMobileBySerial(apiOrWorld, mobileOrSerial) {
  const serial = serialOf(mobileOrSerial);
  if (!serial) return false;
  const world = worldOf(apiOrWorld);
  if (apiOrWorld?.game?.mobile?.destroy) return !!apiOrWorld.game.mobile.destroy(serial);
  if (apiOrWorld?.ops?.destroyMobile) return !!apiOrWorld.ops.destroyMobile(serial);
  if (typeof world?.destroyMobile === 'function') {
    world.destroyMobile(serial);
    return true;
  }
  return !!world?.mobiles?.delete?.(serial);
}
