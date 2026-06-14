// Damageable items — ENGINE ONLY.
//
// Kind definitions (beacon, chaos-blocker, etc. with itemId/hp/onDestroyed)
// live in apps/scripts/src/items/damageable.js and are registered at
// startup via registerDamageableKind.
//
// Engine responsibilities:
//   - registry (kind → def)
//   - createDamageable (spawn world item flagged damageable)
//   - damageItem (decrement HP, fire onDestroyed, destroy at 0)

const _registry = new Map();

export function registerDamageableKind(kind, def) {
  _registry.set(kind, Object.freeze(def));
}

export function unregisterDamageableKind(kind) {
  _registry.delete(kind);
}

export function getDamageableDef(kind) { return _registry.get(kind) ?? null; }

/** Create a damageable item in the world. */
export function createDamageable(world, kind, opts = {}) {
  const def = _registry.get(kind);
  if (!def || !world?.createItem) return null;
  return world.createItem({
    itemId: def.itemId,
    name: def.name,
    x: opts.x | 0, y: opts.y | 0, z: opts.z | 0, map: opts.map | 0,
    hp: def.hp, hpMax: def.hpMax,
    damageable: true,
    damageableKind: kind,
    movable: false,
    ...(def.hue ? { hue: def.hue } : {}),
  });
}

/** Apply damage. Returns { destroyed:bool, hpLeft:number }. */
export function damageItem(world, item, amount, source = null) {
  if (!item?.damageable) return { destroyed: false, hpLeft: item?.hp ?? 0 };
  item.hp = Math.max(0, (item.hp ?? 0) - amount);
  if (item.hp <= 0) {
    const def = _registry.get(item.damageableKind);
    try { def?.onDestroyed?.(world, item, source); }
    catch (e) { console.warn('[damageable]', e.message); }
    try { world?.destroyItem?.(item.serial); }
    catch { /* no-op */ }
    return { destroyed: true, hpLeft: 0 };
  }
  return { destroyed: false, hpLeft: item.hp };
}

export function listKinds() { return [..._registry.keys()]; }
