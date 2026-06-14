import { resolveStandingZ as resolveWorldStandingZ } from './movement.js';
import { UPDATE_RANGE, inRange, nearbyClients, nearbyItems, nearbyMobiles } from './visibility.js';

function serialOf(v) {
  return typeof v === 'number' ? v >>> 0 : v?.serial >>> 0;
}

function ensureCenter(center) {
  return {
    x: center?.x | 0,
    y: center?.y | 0,
    z: center?.z | 0,
    map: center?.map ?? 1,
  };
}

function* childrenOf(world, parentOrSerial) {
  const parent = serialOf(parentOrSerial);
  if (!parent) return;
  const bucket = world._childrenByParent?.get?.(parent);
  if (bucket) {
    for (const serial of bucket) {
      const it = world.items.get(serial);
      if (it && it.parent === parent) yield it;
    }
    return;
  }
  for (const it of world.items.values()) {
    if (it.parent === parent) yield it;
  }
}

function* descendantsOf(world, parentOrSerial) {
  const root = serialOf(parentOrSerial);
  if (!root) return;
  const seen = new Set([root]);
  const stack = [root];
  while (stack.length) {
    const parent = stack.pop();
    for (const it of childrenOf(world, parent)) {
      if (seen.has(it.serial)) continue;
      seen.add(it.serial);
      yield it;
      stack.push(it.serial);
    }
  }
}

function* onlineMobilesOf(world) {
  if (typeof world.onlineMobiles === 'function') {
    yield* world.onlineMobiles();
    return;
  }
  for (const m of world.mobiles.values()) {
    if (m.client) yield m;
  }
}

function* allMobilesOf(world, predicate = null) {
  for (const m of world.mobiles.values()) {
    if (!predicate || predicate(m)) yield m;
  }
}

function* allItemsOf(world, predicate = null) {
  for (const it of world.items.values()) {
    if (!predicate || predicate(it)) yield it;
  }
}

/**
 * Build a script-friendly query facade over the world's indexes.
 *
 * The raw world maps remain available for rare global/admin scans, but
 * gameplay scripts should prefer this facade for spatial, online-player,
 * and parent-chain lookups. It preserves the existing generator style while
 * routing through sectors / online / parent indexes when they are usable.
 */
export function createWorldQueryApi(world) {
  return Object.freeze({
    UPDATE_RANGE,
    inRange,

    resolveStandingZ(facet, x, y, requestedZ = 0) {
      return resolveWorldStandingZ(facet, x, y, requestedZ);
    },

    *clientsNear(center, range = UPDATE_RANGE, self = null) {
      yield* nearbyClients(world, ensureCenter(center), self, range);
    },

    *mobilesNear(center, range = UPDATE_RANGE, self = null) {
      yield* nearbyMobiles(world, ensureCenter(center), self, range);
    },

    *itemsNear(center, range = UPDATE_RANGE) {
      yield* nearbyItems(world, ensureCenter(center), range);
    },

    *allMobiles(predicate = null) {
      yield* allMobilesOf(world, predicate);
    },

    *allItems(predicate = null) {
      yield* allItemsOf(world, predicate);
    },

    mobileBySerial(serialOrMobile) {
      const serial = serialOf(serialOrMobile);
      return serial ? (world.mobiles.get(serial) ?? null) : null;
    },

    itemBySerial(serialOrItem) {
      const serial = serialOf(serialOrItem);
      return serial ? (world.items.get(serial) ?? null) : null;
    },

    entityBySerial(serialOrEntity) {
      const serial = serialOf(serialOrEntity);
      if (!serial) return null;
      return world.mobiles.get(serial) ?? world.items.get(serial) ?? null;
    },

    findMobile(predicate) {
      if (typeof predicate !== 'function') return null;
      for (const m of allMobilesOf(world, predicate)) return m;
      return null;
    },

    findItem(predicate) {
      if (typeof predicate !== 'function') return null;
      for (const it of allItemsOf(world, predicate)) return it;
      return null;
    },

    *mobilesAt(center, self = null) {
      const c = ensureCenter(center);
      for (const m of nearbyMobiles(world, c, self, 0)) {
        if ((m.x | 0) === c.x && (m.y | 0) === c.y && (m.map ?? 1) === c.map) yield m;
      }
    },

    *itemsAt(center) {
      const c = ensureCenter(center);
      for (const it of nearbyItems(world, c, 0)) {
        if ((it.x | 0) === c.x && (it.y | 0) === c.y && (it.map ?? 1) === c.map) yield it;
      }
    },

    *onlineMobiles() {
      yield* onlineMobilesOf(world);
    },

    onlineCount() {
      let count = 0;
      for (const _ of onlineMobilesOf(world)) count++;
      return count;
    },

    findOnline(predicate) {
      if (typeof predicate !== 'function') return null;
      for (const m of onlineMobilesOf(world)) {
        if (predicate(m)) return m;
      }
      return null;
    },

    findOnlineByName(name) {
      const lower = String(name ?? '').trim().toLowerCase();
      if (!lower) return null;
      for (const m of onlineMobilesOf(world)) {
        if ((m.name ?? '').toLowerCase() === lower) return m;
      }
      return null;
    },

    *childrenOf(parentOrSerial) {
      yield* childrenOf(world, parentOrSerial);
    },

    *descendantsOf(parentOrSerial) {
      yield* descendantsOf(world, parentOrSerial);
    },

    findChild(parentOrSerial, predicate) {
      if (typeof predicate !== 'function') return null;
      for (const it of childrenOf(world, parentOrSerial)) {
        if (predicate(it)) return it;
      }
      return null;
    },

    findDescendant(parentOrSerial, predicate) {
      if (typeof predicate !== 'function') return null;
      for (const it of descendantsOf(world, parentOrSerial)) {
        if (predicate(it)) return it;
      }
      return null;
    },

    findClientNear(center, predicate, range = UPDATE_RANGE, self = null) {
      if (typeof predicate !== 'function') return null;
      for (const m of nearbyClients(world, ensureCenter(center), self, range)) {
        if (predicate(m)) return m;
      }
      return null;
    },

    findMobileNear(center, predicate, range = UPDATE_RANGE, self = null) {
      if (typeof predicate !== 'function') return null;
      for (const m of nearbyMobiles(world, ensureCenter(center), self, range)) {
        if (predicate(m)) return m;
      }
      return null;
    },

    findItemNear(center, predicate, range = UPDATE_RANGE) {
      if (typeof predicate !== 'function') return null;
      for (const it of nearbyItems(world, ensureCenter(center), range)) {
        if (predicate(it)) return it;
      }
      return null;
    },

    sendToClientsNear(center, packet, range = UPDATE_RANGE, self = null) {
      let sent = 0;
      for (const m of nearbyClients(world, ensureCenter(center), self, range)) {
        try {
          m.client?.send?.(packet);
          sent++;
        } catch { /* socket transient */ }
      }
      return sent;
    },

    sendToOnline(packet, predicate = null) {
      let sent = 0;
      for (const m of onlineMobilesOf(world)) {
        if (predicate && !predicate(m)) continue;
        try {
          m.client?.send?.(packet);
          sent++;
        } catch { /* socket transient */ }
      }
      return sent;
    },
  });
}
