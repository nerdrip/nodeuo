import { itemBySerial } from './_entities.js';

export function serialOf(value) {
  return typeof value === 'number' ? value >>> 0 : value?.serial >>> 0;
}

function worldOf(apiOrWorld) {
  if (apiOrWorld?.[Symbol.for('uo.world')]) return apiOrWorld;
  return apiOrWorld?.world ?? apiOrWorld;
}

function apiOf(apiOrWorld) {
  const world = worldOf(apiOrWorld);
  if (apiOrWorld?.world || apiOrWorld?.game || apiOrWorld?.query) {
    return {
      ...apiOrWorld,
      world,
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
  return { world };
}

export function* childrenOf(apiOrWorld, parentOrSerial) {
  const api = apiOf(apiOrWorld);
  const parent = serialOf(parentOrSerial);
  if (!parent) return;
  if (api?.game?.inventory?.childrenOf) {
    yield* api.game.inventory.childrenOf(parent);
    return;
  }
  if (api?.query?.childrenOf) {
    yield* api.query.childrenOf(parent);
    return;
  }
  const idx = api?.world?._childrenByParent?.get?.(parent);
  if (idx) {
    for (const serial of idx) {
      const it = itemBySerial(api, serial);
      if (it && (it.parent >>> 0) === parent) yield it;
    }
    return;
  }
  if (api?.game?.allItems) {
    for (const it of api.game.allItems()) {
      if ((it.parent >>> 0) === parent) yield it;
    }
    return;
  }
  if (api?.query?.allItems) {
    for (const it of api.query.allItems()) {
      if ((it.parent >>> 0) === parent) yield it;
    }
    return;
  }
  for (const it of api?.world?.items?.values?.() ?? []) {
    if ((it.parent >>> 0) === parent) yield it;
  }
}

export function findBackpack(apiOrWorld, mob) {
  const api = apiOf(apiOrWorld);
  const equippedPack = mob?.equipment?.get?.(21) ?? mob?.equipment?.[21];
  if (equippedPack) return equippedPack;
  const pack = api?.game?.inventory?.findBackpack?.(mob);
  if (pack) return pack;
  for (const it of childrenOf(api, mob)) {
    if ((it.layer ?? 0) === 21) return it;
  }
  return null;
}

export function* descendantsOf(apiOrWorld, parentOrSerial) {
  const api = apiOf(apiOrWorld);
  const root = serialOf(parentOrSerial);
  if (!root) return;
  if (api?.game?.inventory?.descendantsOf) {
    yield* api.game.inventory.descendantsOf(root);
    return;
  }
  if (api?.query?.descendantsOf) {
    yield* api.query.descendantsOf(root);
    return;
  }
  const seen = new Set([root]);
  const stack = [root];
  while (stack.length) {
    const parent = stack.pop();
    for (const it of childrenOf(api, parent)) {
      const serial = it.serial >>> 0;
      if (seen.has(serial)) continue;
      seen.add(serial);
      yield it;
      stack.push(serial);
    }
  }
}

export function* packItems(apiOrWorld, mob) {
  const api = apiOf(apiOrWorld);
  if (api?.game?.inventory?.packItems) {
    yield* api.game.inventory.packItems(mob);
    return;
  }
  const pack = findBackpack(api, mob);
  yield* descendantsOf(api, pack ?? mob);
}

export function findInPack(apiOrWorld, mob, predicate) {
  const api = apiOf(apiOrWorld);
  const found = api?.game?.inventory?.findInPack?.(mob, predicate);
  if (found) return found;
  for (const it of packItems(api, mob)) {
    if (predicate(it)) return it;
  }
  return null;
}

export function findChild(apiOrWorld, parentOrSerial, predicate) {
  const api = apiOf(apiOrWorld);
  const found = api?.game?.inventory?.findChild?.(parentOrSerial, predicate)
    ?? api?.query?.findChild?.(parentOrSerial, predicate);
  if (found) return found;
  for (const it of childrenOf(api, parentOrSerial)) {
    if (predicate(it)) return it;
  }
  return null;
}

export function findDescendant(apiOrWorld, parentOrSerial, predicate) {
  const api = apiOf(apiOrWorld);
  const found = api?.game?.inventory?.findDescendant?.(parentOrSerial, predicate)
    ?? api?.query?.findDescendant?.(parentOrSerial, predicate);
  if (found) return found;
  for (const it of descendantsOf(api, parentOrSerial)) {
    if (predicate(it)) return it;
  }
  return null;
}

export function isContainedBy(apiOrWorld, item, ancestorOrSerial, maxDepth = 64) {
  const api = apiOf(apiOrWorld);
  const ancestor = serialOf(ancestorOrSerial);
  if (!item || !ancestor) return false;
  let parent = item.parent;
  for (let depth = 0; depth < maxDepth && parent != null; depth++) {
    if ((parent >>> 0) === ancestor) return true;
    parent = itemBySerial(api, parent)?.parent;
  }
  return false;
}

export function isInPack(apiOrWorld, item, mob) {
  const api = apiOf(apiOrWorld);
  if (api?.game?.inventory?.isInPack) return api.game.inventory.isInPack(item, mob);
  const pack = findBackpack(api, mob);
  return isContainedBy(api, item, pack ?? mob);
}

export function isPackedOrWorn(apiOrWorld, item, mob) {
  return isInPack(apiOrWorld, item, mob)
    || ((item?.parent >>> 0) === (mob?.serial >>> 0) && (item.layer ?? 0) > 0);
}

export function isEquippedBy(_api, item, mob, layerOrPredicate = null) {
  if ((item?.parent >>> 0) !== (mob?.serial >>> 0)) return false;
  const layer = item.layer ?? 0;
  if (layer <= 0) return false;
  if (typeof layerOrPredicate === 'function') return !!layerOrPredicate(item);
  if (layerOrPredicate != null) return layer === (layerOrPredicate | 0);
  return true;
}

export function* equipped(apiOrWorld, mob) {
  const api = apiOf(apiOrWorld);
  if (api?.game?.inventory?.equipped) {
    yield* api.game.inventory.equipped(mob);
    return;
  }
  for (const it of childrenOf(api, mob)) {
    if ((it.layer ?? 0) > 0) yield it;
  }
}
