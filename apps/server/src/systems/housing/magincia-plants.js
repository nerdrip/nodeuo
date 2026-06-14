// New Magincia Plants — port of ServUO `Scripts/Services/New Magincia/`.
// A persistent farming system where each player rents a patch of soil,
// plants a seed, waters it, and returns later for produce. Mirrors the
// ServUO bazaar plant patches without the housing-deed integration.
//
// Patches:
//   - registered globally (one per (x, y, map) trio)
//   - `_owner` = player serial / null when free
//   - `_plant` = seed type id (matches our consumables registry)
//   - `_stage` = 0 (seed) / 1 (sapling) / 2 (mature) / 3 (decayed)
//   - `_water` = float 0..1 — drains per day, replenished with [water
//   - `_plantedAt` = ms timestamp; advances stage on a 6h cadence
//
// Tick (called from main loop once / minute) advances each patch.

const STAGE_MS = 6 * 60 * 60 * 1000;   // 6h per stage
const WATER_DRAIN_PER_TICK = 1 / (24 * 60); // dry in 24h
const HARVEST_FRESH_MS  = 24 * 60 * 60 * 1000;  // window before decay

const _patches = new Map();    // key `${x},${y},${map}` → patch

export function registerPatch(x, y, map) {
  const key = `${x},${y},${map}`;
  if (_patches.has(key)) return _patches.get(key);
  const p = { x, y, map, _owner: null, _plant: null, _stage: 0, _water: 0, _plantedAt: 0, _lastHarvestAt: 0 };
  _patches.set(key, p);
  return p;
}

export function patchAt(x, y, map) {
  return _patches.get(`${x},${y},${map}`) ?? null;
}

export function listPatches() {
  return Array.from(_patches.values());
}

export function rentPatch(patch, mob) {
  if (!patch || !mob) return false;
  if (patch._owner && patch._owner !== mob.serial) return false;
  patch._owner = mob.serial;
  return true;
}

export function plantSeed(patch, mob, seedType) {
  if (!patch || patch._owner !== mob?.serial) return false;
  if (patch._plant && patch._stage < 3) return false;
  patch._plant = seedType;
  patch._stage = 0;
  patch._water = 1;
  patch._plantedAt = Date.now();
  return true;
}

export function waterPatch(patch, mob) {
  if (!patch || patch._owner !== mob?.serial) return false;
  patch._water = Math.min(1, (patch._water ?? 0) + 0.5);
  return true;
}

export function harvestPatch(patch, mob) {
  if (!patch || patch._owner !== mob?.serial) return null;
  if (patch._stage !== 2) return null;
  const yieldType = patch._plant;
  patch._plant = null;
  patch._stage = 0;
  patch._water = 0;
  patch._lastHarvestAt = Date.now();
  return { yieldType, count: 1 + Math.floor(Math.random() * 3) };
}

/** Cadence tick — call every minute. */
export function tick(now = Date.now()) {
  for (const p of _patches.values()) {
    if (!p._plant) continue;
    p._water = Math.max(0, p._water - WATER_DRAIN_PER_TICK);
    if (p._water <= 0 && p._stage < 3) {
      // dehydration → decay (skip mature → decayed sequence)
      p._stage = 3;
      continue;
    }
    if (p._stage < 2) {
      const elapsed = now - p._plantedAt;
      const want = Math.min(2, Math.floor(elapsed / STAGE_MS));
      if (want > p._stage) p._stage = want;
    } else if (p._stage === 2) {
      // mature — decays if not harvested in window
      if (now - p._plantedAt > 2 * STAGE_MS + HARVEST_FRESH_MS) p._stage = 3;
    }
  }
}
