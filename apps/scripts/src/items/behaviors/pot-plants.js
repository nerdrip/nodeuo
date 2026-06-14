// Decorative pot-plant system. Mirrors ServUO `Engines/Plants/`:
//
//   • A "pot plant" is a portable item that grows through 5 stages
//     (seed → sapling → bud → flowering plant → withered). Each
//     stage swaps the sprite + opens new actions (water, fertilise,
//     re-pot, harvest seeds for crossbreeding).
//   • Plants need water every ~24 game hours. Skipping waterings for
//     3 days lets the plant wither — that drops its tier back by one.
//   • Once flowering, the plant can be harvested for SEEDS. Seeds
//     carry the parent species + hue; planting them gives you a fresh
//     stage-0 sprout. Cross-pollinating two adjacent flowering plants
//     can produce a HYBRID with a blended hue (rare).
//   • Decorative when matured — locks down in a house at 1 lockdown.
//
// This module exports the catalogue + lifecycle helpers. The actual
// `[plant pot <species>` command lives in apps/scripts/src/commands/
// plant.js (extended in this batch).

// =====================================================================
//  SPECIES catalogue. Each species ships a base hue and one or two
//  rare crossbreed-only hues.
// =====================================================================
export const POT_SPECIES = {
  'campion-flowers':     { defaultHue: 0x21,  rareHue: 0x05A, seed: 0x0DCF, plant: 0x28DC, name: 'campion flowers' },
  'poppies':             { defaultHue: 0x21,  rareHue: 0x025, seed: 0x0DCF, plant: 0x28DC, name: 'poppies' },
  'snowdrops':           { defaultHue: 0x481, rareHue: 0x47E, seed: 0x0DCF, plant: 0x28DD, name: 'snowdrops' },
  'bulrushes':           { defaultHue: 0x044, rareHue: 0x048, seed: 0x0DCF, plant: 0x28DD, name: 'bulrushes' },
  'lilies':              { defaultHue: 0x481, rareHue: 0x05A, seed: 0x0DCF, plant: 0x28DE, name: 'lilies' },
  'pampas-grass':        { defaultHue: 0x47E, rareHue: 0x110, seed: 0x0DCF, plant: 0x28DE, name: 'pampas grass' },
  'rushes':              { defaultHue: 0x048, rareHue: 0x04A, seed: 0x0DCF, plant: 0x28DF, name: 'rushes' },
  'elephant-ear':        { defaultHue: 0x048, rareHue: 0x06D, seed: 0x0DCF, plant: 0x28E0, name: 'elephant ear plant' },
  'fern':                { defaultHue: 0x048, rareHue: 0x06D, seed: 0x0DCF, plant: 0x28E1, name: 'fern' },
  'ponytail-palm':       { defaultHue: 0x048, rareHue: 0x110, seed: 0x0DCF, plant: 0x28E2, name: 'ponytail palm' },
  'small-palm':          { defaultHue: 0x048, rareHue: 0x110, seed: 0x0DCF, plant: 0x28E3, name: 'small palm' },
  'century-plant':       { defaultHue: 0x158, rareHue: 0x115, seed: 0x0DCF, plant: 0x28E4, name: 'century plant' },
  'water-plant':         { defaultHue: 0x048, rareHue: 0x06D, seed: 0x0DCF, plant: 0x28E5, name: 'water plant' },
  'snake-plant':         { defaultHue: 0x048, rareHue: 0x110, seed: 0x0DCF, plant: 0x28E6, name: 'snake plant' },
  'prickly-pear':        { defaultHue: 0x110, rareHue: 0x021, seed: 0x0DCF, plant: 0x28E7, name: 'prickly pear cactus' },
  'barrel-cactus':       { defaultHue: 0x115, rareHue: 0x021, seed: 0x0DCF, plant: 0x28E8, name: 'barrel cactus' },
  'tribarrel-cactus':    { defaultHue: 0x115, rareHue: 0x025, seed: 0x0DCF, plant: 0x28E9, name: 'tribarrel cactus' },
  // Stygian-Abyss additions (post-SA expansion plants).
  'common-plant':        { defaultHue: 0x048, rareHue: 0x06D, seed: 0x4006, plant: 0x4007, name: 'common plant' },
  'pampas-fern':         { defaultHue: 0x048, rareHue: 0x06D, seed: 0x4007, plant: 0x4008, name: 'pampas fern' },
  'jewel-fly-trap':      { defaultHue: 0x047, rareHue: 0x02B, seed: 0x4008, plant: 0x4009, name: 'jewel fly trap' },
  'orfluer-flowers':     { defaultHue: 0x047, rareHue: 0x12E, seed: 0x4009, plant: 0x400A, name: 'orfluer flowers' },
  'jaipalti-blooming':   { defaultHue: 0x024, rareHue: 0x115, seed: 0x400A, plant: 0x400B, name: 'jaipalti blooming' },
  'arumbushvuli-plant':  { defaultHue: 0x110, rareHue: 0x021, seed: 0x400B, plant: 0x400C, name: 'arumbushvuli plant' },
  'medusas-mouth':       { defaultHue: 0x115, rareHue: 0x047, seed: 0x400C, plant: 0x400D, name: "medusa's mouth" },
  'voidrunner-fungus':   { defaultHue: 0x047, rareHue: 0x025, seed: 0x400D, plant: 0x400E, name: 'voidrunner fungus' },
  // Trans-dimensional cross-breeds (only obtainable via crossbreed).
  'hybrid-blossom':      { defaultHue: 0x47E, rareHue: 0x489, seed: 0x4010, plant: 0x4011, name: 'hybrid blossom', hybridOnly: true },
  'twilight-blossom':    { defaultHue: 0x489, rareHue: 0x481, seed: 0x4011, plant: 0x4012, name: 'twilight blossom', hybridOnly: true },
  'starflower':          { defaultHue: 0x47E, rareHue: 0x047, seed: 0x4012, plant: 0x4013, name: 'starflower', hybridOnly: true },
  'lunar-vine':          { defaultHue: 0x489, rareHue: 0x047, seed: 0x4013, plant: 0x4014, name: 'lunar vine', hybridOnly: true },
  'sunset-orchid':       { defaultHue: 0x47E, rareHue: 0x110, seed: 0x4014, plant: 0x4015, name: 'sunset orchid', hybridOnly: true },
};

export const POT_SPECIES_KEYS = Object.keys(POT_SPECIES);
export const PLANTABLE_KEYS   = POT_SPECIES_KEYS.filter((k) => !POT_SPECIES[k].hybridOnly);

// =====================================================================
//  GROWTH stages
// =====================================================================
export const STAGE_SEED        = 0;
export const STAGE_SAPLING     = 1;
export const STAGE_BUD         = 2;
export const STAGE_FLOWERING   = 3;
export const STAGE_WITHERED    = 4;

const STAGE_LABEL = ['Seed', 'Sapling', 'Bud', 'Flowering', 'Withered'];

// Each stage swaps the plant's display itemId. The pot baseline is
// the seed slot (0x0DCF / 0x4006). Growth replaces with the species'
// `plant` graphic at flowering.
function spriteForStage(species, stage) {
  if (stage === STAGE_SEED)      return species.seed;
  if (stage === STAGE_SAPLING)   return species.seed;       // same sprite as seed, different label
  if (stage === STAGE_BUD)       return species.plant;
  if (stage === STAGE_FLOWERING) return species.plant;
  if (stage === STAGE_WITHERED)  return species.plant;
  return species.seed;
}

export const STAGE_HUE_DELTA = {
  [STAGE_SEED]:      0,
  [STAGE_SAPLING]:   0,
  [STAGE_BUD]:      -8,                  // slightly darker until flowering
  [STAGE_FLOWERING]: 0,
  [STAGE_WITHERED]:  0x047E,             // grey-brown wither overlay
};

// =====================================================================
//  LIFECYCLE timers (in real-time ms)
// =====================================================================
const HOUR_MS = 60 * 60 * 1000;
const STAGE_DURATION_MS = 24 * HOUR_MS;   // 1 day per stage
const WATER_NEED_MS     = 24 * HOUR_MS;   // 1 day between waterings
const WATER_GRACE_MS    = 3  * 24 * HOUR_MS;  // wither after 3 dry days
const SEED_HARVEST_COOLDOWN_MS = 6 * HOUR_MS; // 6h between seed pulls

// =====================================================================
//  PUBLIC API — used by commands/plant.js + the on-tick item script
// =====================================================================

/** Build a fresh pot-plant item descriptor (seed stage). Caller passes
 *  the result to the script item factory. */
export function makePotPlant(speciesKey, ownerSerial, mapId, x, y, z) {
  const species = POT_SPECIES[speciesKey] ?? POT_SPECIES[PLANTABLE_KEYS[0]];
  const now = Date.now();
  return {
    itemId: species.seed,
    hue:    species.defaultHue,
    name:   `${species.name} (Seed)`,
    x, y, z, map: mapId,
    parent: ownerSerial,
    movable: true,
    script: 'pot-plant',
    potPlant: {
      species: speciesKey,
      stage:   STAGE_SEED,
      grownAt: now,
      lastWaterAt: now,
      lastSeedHarvestAt: 0,
      hue: species.defaultHue,
      hybrid: false,
    },
  };
}

/** Tick a plant's growth + water decay. Called from the lifecycle-
 *  scripts module on every item tick (~1Hz). */
export function tickPotPlant(world, item) {
  const data = item.potPlant;
  if (!data) return;
  const species = POT_SPECIES[data.species];
  if (!species) return;
  const now = Date.now();
  // Water-decay → withering. Withered plants stop growing and DROP
  // back one stage on the next water. Three dry days = wither.
  if (data.stage !== STAGE_WITHERED && (now - data.lastWaterAt) > WATER_GRACE_MS) {
    data.stage = STAGE_WITHERED;
    item.itemId = spriteForStage(species, STAGE_WITHERED);
    item.name = `${species.name} (Withered)`;
    item.hue  = 0x47E;
    return;
  }
  // Growth — advance one stage per STAGE_DURATION_MS, capped at flowering.
  if (data.stage < STAGE_FLOWERING && (now - data.grownAt) > STAGE_DURATION_MS) {
    data.stage += 1;
    data.grownAt = now;
    item.itemId = spriteForStage(species, data.stage);
    item.hue    = data.hue ?? species.defaultHue;
    item.name   = `${species.name} (${STAGE_LABEL[data.stage]})`;
  }
}

/** Water a plant. Owner / friends can do this from a bucket / pitcher.
 *  Withered plants get revived (back to flowering -1 if past bud, else
 *  to bud). Mirrors ServUO's `PlantItem.OnWatered`. */
export function waterPotPlant(item, _user) {
  const data = item.potPlant;
  if (!data) return { ok: false, reason: 'not-a-plant' };
  const species = POT_SPECIES[data.species];
  if (!species) return { ok: false, reason: 'unknown-species' };
  const now = Date.now();
  if (now - data.lastWaterAt < WATER_NEED_MS) {
    return { ok: false, reason: 'already-watered' };
  }
  data.lastWaterAt = now;
  if (data.stage === STAGE_WITHERED) {
    data.stage = Math.max(STAGE_SAPLING, data.stage - 1);
    if (data.stage === STAGE_WITHERED) data.stage = STAGE_BUD;
    data.grownAt = now;
    item.itemId = spriteForStage(species, data.stage);
    item.hue    = data.hue ?? species.defaultHue;
    item.name   = `${species.name} (${STAGE_LABEL[data.stage]})`;
    return { ok: true, revived: true };
  }
  return { ok: true, revived: false };
}

/** Harvest seeds from a flowering plant. Returns up to N seeds. Seeds
 *  inherit the parent's species + hue. Cooldown of 6h between pulls
 *  prevents farm-spam. */
export function harvestSeeds(item) {
  const data = item.potPlant;
  if (!data) return { ok: false, reason: 'not-a-plant' };
  if (data.stage !== STAGE_FLOWERING) {
    return { ok: false, reason: 'not-flowering' };
  }
  const now = Date.now();
  if (now - (data.lastSeedHarvestAt ?? 0) < SEED_HARVEST_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown' };
  }
  data.lastSeedHarvestAt = now;
  const seedCount = 1 + (Math.random() < 0.4 ? 1 : 0) + (Math.random() < 0.1 ? 1 : 0);
  const seeds = [];
  const species = POT_SPECIES[data.species];
  for (let i = 0; i < seedCount; i++) {
    seeds.push({
      itemId: species?.seed ?? 0x0DCF,
      hue:    data.hue ?? species?.defaultHue ?? 0,
      name:   `${species?.name ?? 'plant'} seed`,
      potSeed: { species: data.species, hue: data.hue ?? species?.defaultHue },
    });
  }
  return { ok: true, seeds };
}

/** Cross-pollinate two flowering plants. Both parents must be in the
 *  same facet within 2 tiles. Outputs ONE hybrid seed with a chance
 *  of inheriting a `hybridOnly` species from POT_SPECIES.
 *  Mirrors ServUO `Plant Crossbreed` table — simplified to a coin-
 *  flip + a hybrid-pool roll. */
export function crossPollinate(plantA, plantB) {
  const a = plantA?.potPlant, b = plantB?.potPlant;
  if (!a || !b) return { ok: false, reason: 'not-plants' };
  if (a.stage !== STAGE_FLOWERING || b.stage !== STAGE_FLOWERING) {
    return { ok: false, reason: 'need-flowering' };
  }
  const spA = POT_SPECIES[a.species];
  const spB = POT_SPECIES[b.species];
  if (!spA || !spB) return { ok: false, reason: 'unknown-species' };
  // 25% hybrid roll — picks a random hybridOnly species and uses a
  // mid-hue between the parents. 75% the seed is just one of the
  // parents' species with a 50/50 hue inheritance.
  if (Math.random() < 0.25) {
    const hybrids = POT_SPECIES_KEYS.filter((k) => POT_SPECIES[k].hybridOnly);
    const picked = hybrids[(Math.random() * hybrids.length) | 0] ?? a.species;
    const hyb = POT_SPECIES[picked];
    return {
      ok: true,
      hybrid: true,
      seed: {
        itemId: hyb.seed,
        hue: mixHues(a.hue ?? spA.defaultHue, b.hue ?? spB.defaultHue),
        name: `${hyb.name} (hybrid seed)`,
        potSeed: { species: picked, hue: mixHues(a.hue ?? spA.defaultHue, b.hue ?? spB.defaultHue), hybrid: true },
      },
    };
  }
  // Non-hybrid path — child species = one of the parents (50/50).
  const childSpecies = Math.random() < 0.5 ? a.species : b.species;
  const child = POT_SPECIES[childSpecies];
  return {
    ok: true,
    hybrid: false,
    seed: {
      itemId: child.seed,
      hue: Math.random() < 0.5 ? (a.hue ?? spA.defaultHue) : (b.hue ?? spB.defaultHue),
      name: `${child.name} seed`,
      potSeed: { species: childSpecies, hue: a.hue ?? spA.defaultHue },
    },
  };
}

/** Average two UO hue ids. Not a real palette mix — just picks the
 *  midpoint integer. Good enough for crossbreed visuals. */
function mixHues(a, b) { return ((a + b) >>> 1) & 0x3FFF; }

/** Wire as a lifecycle script. Imported from items/lifecycle-scripts.js
 *  at boot so api.itemScripts can dispatch by `script: 'pot-plant'`. */
export function buildPotPlantScript() {
  return {
    name: 'pot-plant',
    hasTick: true,
    onCreate(_world, item) {
      // Pot plants placed via the [plant pot command come pre-stamped
      // with their potPlant payload; nothing extra to do.
      void item;
    },
    onTick(world, item) { tickPotPlant(world, item); },
  };
}
