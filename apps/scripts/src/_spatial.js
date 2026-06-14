export const UPDATE_RANGE = 18;

function worldOf(apiOrWorld) {
  return apiOrWorld?.world ?? apiOrWorld;
}

function apiOf(apiOrWorld) {
  const world = worldOf(apiOrWorld);
  if (apiOrWorld?.world || apiOrWorld?.game || apiOrWorld?.query) {
    return {
      ...apiOrWorld,
      game: apiOrWorld.game ?? world?._scriptGame,
      query: apiOrWorld.query ?? world?._scriptQuery,
    };
  }
  if (world?._scriptGame || world?._scriptQuery) {
    return {
      world,
      game: world._scriptGame,
      query: world._scriptQuery,
    };
  }
  return null;
}

export function inRange(a, b, range = UPDATE_RANGE) {
  if ((a?.map ?? 1) !== (b?.map ?? 1)) return false;
  return Math.max(Math.abs((a?.x | 0) - (b?.x | 0)), Math.abs((a?.y | 0) - (b?.y | 0))) <= range;
}

function mobileSectorsUsable(world) {
  return !!world?.sectors
      && typeof world.sectors.mobileSerialsNear === 'function'
      && typeof world.sectors.mobilesIndexed === 'function'
      && world.sectors.mobilesIndexed() >= (world.mobiles?.size ?? 0);
}

function itemSectorsUsable(world) {
  if (!world?.sectors || typeof world.sectors.itemSerialsNear !== 'function') return false;
  if (typeof world.sectors.itemsIndexed !== 'function') return false;
  if ((world.items?.size ?? 0) === 0) return true;
  return world.sectors.itemsIndexed() > 0;
}

export function* nearbyClients(apiOrWorld, center, self = null, range = UPDATE_RANGE) {
  const api = apiOf(apiOrWorld);
  const world = worldOf(apiOrWorld);
  if (api?.game?.clientsNear) {
    yield* api.game.clientsNear(center, { range, self });
    return;
  }
  if (api?.query?.clientsNear) {
    yield* api.query.clientsNear(center, range, self);
    return;
  }
  if (mobileSectorsUsable(world)) {
    const map = center?.map ?? 1;
    for (const serial of world.sectors.mobileSerialsNear(map | 0, center.x | 0, center.y | 0, range)) {
      const m = world.mobiles.get(serial);
      if (m === self || !m?.client) continue;
      if (!inRange(center, m, range)) continue;
      yield m;
    }
    return;
  }
  for (const m of world?.mobiles?.values?.() ?? []) {
    if (m === self || !m.client) continue;
    if (!inRange(center, m, range)) continue;
    yield m;
  }
}

export function* nearbyMobiles(apiOrWorld, center, self = null, range = UPDATE_RANGE) {
  const api = apiOf(apiOrWorld);
  const world = worldOf(apiOrWorld);
  if (api?.game?.mobilesNear) {
    yield* api.game.mobilesNear(center, { range, self });
    return;
  }
  if (api?.query?.mobilesNear) {
    yield* api.query.mobilesNear(center, range, self);
    return;
  }
  if (mobileSectorsUsable(world)) {
    const map = center?.map ?? 1;
    for (const serial of world.sectors.mobileSerialsNear(map | 0, center.x | 0, center.y | 0, range)) {
      const m = world.mobiles.get(serial);
      if (!m || m === self) continue;
      if (!inRange(center, m, range)) continue;
      yield m;
    }
    return;
  }
  for (const m of world?.mobiles?.values?.() ?? []) {
    if (m === self) continue;
    if (!inRange(center, m, range)) continue;
    yield m;
  }
}

export function* nearbyItems(apiOrWorld, center, range = UPDATE_RANGE) {
  const api = apiOf(apiOrWorld);
  const world = worldOf(apiOrWorld);
  if (api?.game?.itemsNear) {
    yield* api.game.itemsNear(center, { range });
    return;
  }
  if (api?.query?.itemsNear) {
    yield* api.query.itemsNear(center, range);
    return;
  }
  if (itemSectorsUsable(world)) {
    const map = center?.map ?? 1;
    for (const serial of world.sectors.itemSerialsNear(map | 0, center.x | 0, center.y | 0, range)) {
      const it = world.items.get(serial);
      if (!it || it.parent) continue;
      if (!inRange(center, it, range)) continue;
      yield it;
    }
    return;
  }
  for (const it of world?.items?.values?.() ?? []) {
    if (it.parent) continue;
    if (!inRange(center, it, range)) continue;
    yield it;
  }
}

export function* onlineMobiles(apiOrWorld) {
  const api = apiOf(apiOrWorld);
  const world = worldOf(apiOrWorld);
  if (api?.game?.onlineMobiles) {
    yield* api.game.onlineMobiles();
    return;
  }
  if (api?.query?.onlineMobiles) {
    yield* api.query.onlineMobiles();
    return;
  }
  if (typeof world?.onlineMobiles === 'function') {
    yield* world.onlineMobiles();
    return;
  }
  for (const m of world?.mobiles?.values?.() ?? []) {
    if (m.client) yield m;
  }
}

export function* allMobiles(apiOrWorld, predicate = null) {
  const api = apiOf(apiOrWorld);
  const world = worldOf(apiOrWorld);
  if (api?.game?.allMobiles) {
    yield* api.game.allMobiles(predicate);
    return;
  }
  if (api?.query?.allMobiles) {
    yield* api.query.allMobiles(predicate);
    return;
  }
  for (const m of world?.mobiles?.values?.() ?? []) {
    if (!predicate || predicate(m)) yield m;
  }
}

export function* allItems(apiOrWorld, predicate = null) {
  const api = apiOf(apiOrWorld);
  const world = worldOf(apiOrWorld);
  if (api?.game?.allItems) {
    yield* api.game.allItems(predicate);
    return;
  }
  if (api?.query?.allItems) {
    yield* api.query.allItems(predicate);
    return;
  }
  for (const it of world?.items?.values?.() ?? []) {
    if (!predicate || predicate(it)) yield it;
  }
}

export function sendToClientsNear(apiOrWorld, center, packet, self = null, range = UPDATE_RANGE) {
  const api = apiOf(apiOrWorld);
  if (api?.game?.sendToClientsNear) {
    return api.game.sendToClientsNear(center, packet, { range, self });
  }
  if (api?.query?.sendToClientsNear) {
    return api.query.sendToClientsNear(center, packet, range, self);
  }
  let sent = 0;
  for (const m of nearbyClients(apiOrWorld, center, self, range)) {
    try {
      m.client?.send?.(packet);
      sent++;
    } catch { /* socket transient */ }
  }
  return sent;
}

export function sendToOnline(apiOrWorld, packet, predicate = null) {
  const api = apiOf(apiOrWorld);
  if (api?.game?.sendToOnline) return api.game.sendToOnline(packet, predicate);
  if (api?.query?.sendToOnline) return api.query.sendToOnline(packet, predicate);
  let sent = 0;
  for (const m of onlineMobiles(apiOrWorld)) {
    if (predicate && !predicate(m)) continue;
    try {
      m.client?.send?.(packet);
      sent++;
    } catch { /* socket transient */ }
  }
  return sent;
}

export function sendSystemMessageToOnline(apiOrWorld, text, predicate = null) {
  let sent = 0;
  for (const m of onlineMobiles(apiOrWorld)) {
    if (predicate && !predicate(m)) continue;
    try {
      m.client?.sendSystemMessage?.(text);
      sent++;
    } catch { /* socket transient */ }
  }
  return sent;
}
