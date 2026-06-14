// Plant System — full lifecycle from seed → sapling → adult plant, with
// hue genetics, watering, fertilization, and decorative bowls. Mirrors
// ServUO `Engines/Plants/`:
//
//   PlantStatus enum: BowlOfDirt → Seedling → Sapling → Plant → FullyGrown
//   PlantHue: 26 colors with genetic crossbreed table
//   PlantType: 53 species (cactus, hedge, bush, sapling, vine, etc.)
//
// Lifecycle ticks once per real-world day (24h server time). Each stage
// requires water + fertilizer to advance; neglect = wilt, dead plant
// becomes compost.
//
// Crossbreed: pollinating one plant with the pollen of another can
// produce a plant of the average hue or a mutated child color. The
// chance ramps up with both parents' growth quality.
//
// API:
//   plants.plantSeed(world, mob, type, hue)    → bowl-of-dirt item
//   plants.water(plant, amount)                → add water charge
//   plants.fertilize(plant, charges=1)         → add fertilizer
//   plants.tick(world, now)                    → advance all live plants
//   plants.pollinate(srcPlant, dstPlant)       → cross-breed
//   plants.harvest(plant)                      → returns seeds when ripe
//
// State on the item: `plant: { type, hue, status, water, fertilizer,
// growth, pollinated, lastTickAt, parents }`.

const STAGES = ['bowl', 'seedling', 'sapling', 'plant', 'full'];
const TICK_INTERVAL_MS = 24 * 60 * 60 * 1000;     // 24h

// Watering bands per stage — too dry / just-right / too wet.
const WATER_REQ = { seedling: 1, sapling: 2, plant: 3, full: 2 };
const FERT_REQ  = { seedling: 0, sapling: 1, plant: 2, full: 1 };

const PLANT_TYPES = Object.freeze([
  'campion','poppies','snowdrops','bulrushes','lilies',
  'pampas','rushes','elephant-ear','fern','ponytail-palm',
  'small-palm','century-plant','water-plant','snake-plant','prickly-pear',
  'barrel-cactus','tribarrel','common-green-bonsai','common-pink-bonsai',
  'uncommon-green-bonsai','uncommon-pink-bonsai','rare-green-bonsai',
  'rare-pink-bonsai','exceptional-bonsai','exotic-bonsai',
  'hedge','juniper-bush','small-bush','sapling','rose',
]);

const PLANT_HUES = Object.freeze([
  'plain','red','blue','yellow','bright-red','bright-blue','bright-yellow',
  'purple','green','orange','pink','black','white','aqua','magenta',
  'rare-fire-red','rare-paragon','rare-violet','rare-ice','rare-volcano',
  'rare-rainbow','crossbreed-1','crossbreed-2','crossbreed-3','crossbreed-4','crossbreed-5',
]);

/** Plant a seed of given type/hue. Returns the new item descriptor. */
export function plantSeed(world, mob, type, hue) {
  if (!PLANT_TYPES.includes(type)) throw new Error(`unknown plant type: ${type}`);
  if (!PLANT_HUES.includes(hue))   throw new Error(`unknown plant hue: ${hue}`);
  const item = world.createItem({
    itemId: 0x1602,                  // OSI bowl-of-dirt graphic
    name: `bowl of dirt (${type}, ${hue})`,
    weight: 1,
    parent: mob.serial,
    plant: {
      type, hue,
      status: 'bowl',
      water: 0, fertilizer: 0,
      growth: 0,
      pollinated: false,
      lastTickAt: Date.now(),
      parents: null,
    },
  });
  // Register in the per-shard plant index so tickPlants walks just the
  // bowls (typically ≤200) instead of all 110k world.items.
  world._plants ??= new Set();
  world._plants.add(item.serial);
  return item;
}

/** Add water (1..5). Returns the new water level. */
export function water(plant, amount = 1) {
  if (!plant?.plant) return 0;
  plant.plant.water = Math.min(5, (plant.plant.water | 0) + (amount | 0));
  return plant.plant.water;
}

/** Add fertilizer charge (1..3). */
export function fertilize(plant, charges = 1) {
  if (!plant?.plant) return 0;
  plant.plant.fertilizer = Math.min(3, (plant.plant.fertilizer | 0) + (charges | 0));
  return plant.plant.fertilizer;
}

/** Advance one plant by one day. Updates status / water / health. */
function _advance(item, now) {
  const p = item.plant;
  if (!p) return;
  if (p.status === 'dead') return;
  const stageIdx = STAGES.indexOf(p.status);
  const nextStage = STAGES[stageIdx + 1];
  if (!nextStage) return;             // already full-grown

  // Need enough water + fertilizer to advance, otherwise wilt.
  const wReq = WATER_REQ[nextStage] ?? 0;
  const fReq = FERT_REQ[nextStage] ?? 0;
  if (p.water < wReq || p.fertilizer < fReq) {
    p.growth = Math.max(0, (p.growth | 0) - 1);
    if (p.growth <= -3) {
      p.status = 'dead';
      item.name = `dead ${p.type}`;
      return;
    }
    return;
  }

  p.water = Math.max(0, p.water - wReq);
  p.fertilizer = Math.max(0, p.fertilizer - fReq);
  p.growth = Math.min(10, (p.growth | 0) + 1);
  if (p.growth >= 5) {
    p.status = nextStage;
    p.growth = 0;
    item.name = `${p.type} (${p.status})`;
  }
  p.lastTickAt = now;
}

/** Tick all plants in `world`. Idempotent — safe to call faster than the
 *  real interval; we gate on each plant's `lastTickAt`. Lazy index
 *  `world._plants` populated on first tick (walks world.items once);
 *  afterwards plantSeed adds, item destroy drops. Bug-hunt #2 D. */
export function tickPlants(world, now = Date.now()) {
  let idx = world._plants;
  if (!(idx instanceof Set)) {
    idx = new Set();
    for (const it of world.items.values()) if (it.plant) idx.add(it.serial);
    world._plants = idx;
  }
  for (const serial of [...idx]) {
    const it = world.items.get(serial);
    if (!it?.plant) { idx.delete(serial); continue; }
    if (now - (it.plant.lastTickAt | 0) < TICK_INTERVAL_MS) continue;
    _advance(it, now);
  }
}

/** Cross-pollinate. Both plants must be at least `plant` stage. */
export function pollinate(src, dst) {
  if (!src?.plant || !dst?.plant) return false;
  if (src.plant.status !== 'plant' && src.plant.status !== 'full') return false;
  if (dst.plant.status !== 'plant' && dst.plant.status !== 'full') return false;
  dst.plant.pollinated = true;
  // Average hue index → child hue. Mutation chance 10% — child gets a
  // random rare crossbreed slot.
  const srcIdx = PLANT_HUES.indexOf(src.plant.hue);
  const dstIdx = PLANT_HUES.indexOf(dst.plant.hue);
  let childHue;
  if (Math.random() < 0.10) {
    childHue = PLANT_HUES[20 + Math.floor(Math.random() * 6)];   // crossbreed slot
  } else {
    const avg = Math.floor((srcIdx + dstIdx) / 2);
    childHue = PLANT_HUES[avg] ?? 'plain';
  }
  dst.plant.parents = { src: src.plant.hue, dst: dst.plant.hue, childHue };
  return childHue;
}

/** Harvest seeds from a fully-grown pollinated plant. Returns array of
 *  { type, hue } seed descriptors. Resets pollinated flag. */
export function harvestSeeds(plant) {
  if (!plant?.plant) return [];
  if (plant.plant.status !== 'full') return [];
  const seeds = [];
  const childHue = plant.plant.parents?.childHue ?? plant.plant.hue;
  const count = plant.plant.pollinated ? (1 + Math.floor(Math.random() * 3)) : 1;
  for (let i = 0; i < count; i++) {
    seeds.push({ type: plant.plant.type, hue: childHue });
  }
  plant.plant.pollinated = false;
  plant.plant.parents = null;
  return seeds;
}

export const PLANT_CONST = Object.freeze({ STAGES, TICK_INTERVAL_MS, PLANT_TYPES, PLANT_HUES });
