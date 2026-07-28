// Camps — ENGINE ONLY.
//
// Camp definitions (BankerCamp, HealerCamp, etc.) live in
// apps/scripts/src/data/world/camps.json and are registered at startup by
// apps/scripts/src/systems/housing/camps.js.
//
// Engine responsibilities:
//   - hold the camp definition table (set by script via setDefs)
//   - placeCamp (spawn decor + NPCs + chest at coords)
//   - tick (60s restock dead NPCs)
//   - despawn

/** @type {Record<string, {decor:string[], npcs:string[], chestLoot:string}>} */
let _camp_defs = {};

const _camps = new Map(); // id -> { kind, x, y, z, map, npcs:[], decor:[], chest, lastRestock }

export function setDefs(table) { _camp_defs = { ...(table || {}) }; }
export function listKinds() { return Object.keys(_camp_defs); }
export function getDef(kind) { return _camp_defs[kind] ?? null; }

/** Spawn a camp at (x,y,z) on `map` of the given kind. */
export function placeCamp(world, opts = {}) {
  const def = _camp_defs[opts.kind];
  if (!def) return null;
  const camp = {
    id: opts.id ?? Math.floor(Math.random() * 1e9),
    kind: opts.kind,
    x: opts.x | 0, y: opts.y | 0, z: opts.z | 0, map: opts.map | 0,
    npcs: [], decor: [], chest: null,
    lastRestock: Date.now(),
  };
  _spawnDecor(world, camp, def);
  _spawnNpcs(world, camp, def, opts.spawner);
  _spawnChest(world, camp, def);
  _camps.set(camp.id, camp);
  return camp;
}

function _spawnDecor(world, camp, def) {
  if (!world?.createItem) return;
  let dx = 0;
  for (const tag of def.decor) {
    const it = world.createItem({
      itemId: 0x09F1, name: tag,
      x: camp.x + dx, y: camp.y, z: camp.z, map: camp.map,
    });
    if (it) camp.decor.push(it.serial);
    dx++;
  }
}

function _spawnNpcs(world, camp, def, spawner) {
  if (!spawner?.spawn) return;
  let dx = 0;
  for (const kind of def.npcs) {
    const m = spawner.spawn(kind, {
      x: camp.x + dx, y: camp.y + 1, z: camp.z, map: camp.map,
    });
    if (m) camp.npcs.push(m.serial);
    dx++;
  }
}

function _spawnChest(world, camp, def) {
  if (!world?.createItem) return;
  const chest = world.createItem({
    itemId: 0x0E40, name: 'chest',
    x: camp.x, y: camp.y + 2, z: camp.z, map: camp.map,
    lootTable: def.chestLoot,
  });
  if (chest) camp.chest = chest.serial;
}

/** Periodic restock — runs every 5 minutes per camp. */
export function tick(world, spawner, now = Date.now()) {
  if (world?._createWorldDone === false) return;
  for (const camp of _camps.values()) {
    if (now - camp.lastRestock < 5 * 60 * 1000) continue;
    const def = _camp_defs[camp.kind];
    if (!def) continue;
    const alive = camp.npcs.filter((s) => {
      const m = world?.mobiles?.get?.(s);
      return m && (m.hp ?? 1) > 0;
    });
    if (alive.length < def.npcs.length) {
      const missing = def.npcs.length - alive.length;
      let dx = 0;
      for (let i = 0; i < missing; i++) {
        const kind = def.npcs[alive.length + i] ?? def.npcs[0];
        const m = spawner?.spawn?.(kind, {
          x: camp.x + dx, y: camp.y + 1, z: camp.z, map: camp.map,
        });
        if (m) alive.push(m.serial);
        dx++;
      }
    }
    camp.npcs = alive;
    camp.lastRestock = now;
  }
}

export function despawnCamp(world, campId) {
  const camp = _camps.get(campId);
  if (!camp) return false;
  for (const s of camp.npcs) world?.mobiles?.delete?.(s);
  for (const s of camp.decor) world?.destroyItem?.(s);
  if (camp.chest) world?.destroyItem?.(camp.chest);
  _camps.delete(campId);
  return true;
}

export function listCamps() { return [..._camps.values()]; }

/** Forget camp runtime records after a full world wipe. Their entities are
 * removed by the canonical world sweep; retaining these rows would make the
 * restock timer resurrect old camp NPCs after the next CreateWorld. */
export function reset() {
  const campsRemoved = _camps.size;
  _camps.clear();
  return { campsRemoved };
}
