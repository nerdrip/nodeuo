// Ocean encounters — periodic spawn of deep-water threats / opportunities
// for players boating in open water. Mirrors ServUO `OceanEncounters.cs`
// + `SeaCreatures.cs`. Triggers:
//
//   • Every active boat with > 1 rider rolls every 5 minutes for an
//     encounter; chance scales with distance from shore (closer = land
//     spawn pool / lower; deep ocean = sea-serpent / kraken / ghost ship).
//   • Ghost ship: spectral boat that materialises near the target,
//     contains 2-3 undead pirates + a treasure chest with magic items.
//   • Sea-serpent: aggressive, 2-3 spawn at once.
//   • Kraken: large solo encounter, drops Sea Tinderbox + rare scales.
//
// Caller-side wiring: main.js installs a 5-min interval that calls
// `tickOceanEncounters(world, deps)`. Boats are recognised via
// `boat.riders.size > 0`. Spawn factory shipped via deps.
//
// We don't ship Ghost Ship as a fully animated boat yet — for the
// MVP it's a single undead-captain mob with named loot bag.

const ENCOUNTER_TYPES = [
  // [kind, weight, count, msg]
  ['sea-serpent', 50, 2, 'A sea serpent rises from the deep!'],
  ['sea-serpent', 25, 3, 'A pod of sea serpents surfaces!'],
  ['kraken',      15, 1, 'A massive kraken emerges from the depths!'],
  ['undead-pirate', 8, 3, 'A spectral ship looms — undead pirates board!'],
  ['water-elemental', 2, 1, 'A water elemental coalesces from the waves.'],
];

const ENCOUNTER_INTERVAL_MS = 5 * 60 * 1000;
const ENCOUNTER_CHANCE = 0.35;
const SPAWN_RADIUS = 6;

/**
 * Pick one encounter from the weight table.
 */
function pickEncounter(rng = Math.random) {
  const total = ENCOUNTER_TYPES.reduce((a, t) => a + t[1], 0);
  let pick = rng() * total;
  for (const t of ENCOUNTER_TYPES) {
    pick -= t[1];
    if (pick <= 0) return { kind: t[0], count: t[2], message: t[3] };
  }
  return { kind: ENCOUNTER_TYPES[0][0], count: ENCOUNTER_TYPES[0][2], message: ENCOUNTER_TYPES[0][3] };
}

/**
 * One pass — iterate boats with at least one rider, roll for encounter.
 * Spawns mobs around the boat tile via deps.spawnFactory. Sends warning
 * speech to all riders.
 *
 * @param {*} world
 * @param {{
 *   spawnFactory: (world: any, kind: string, pos: {x:number,y:number,z:number,map:number}) => any | null,
 *   broadcastNear: (world: any, center: {x,y,z,map}, range: number, payload: any) => void,
 *   landProvider?: { isWater?: (m,x,y)=>boolean }
 * }} deps
 */
export function tickOceanEncounters(world, deps = {}) {
  if (!world?.items || !deps.spawnFactory) return 0;
  let triggered = 0;
  // Find boats with riders. Boats are items with `boat.riders` Set.
  for (const it of world.items.values()) {
    if (!it.boat) continue;
    const riders = it.boat.riders;
    const ridersSet = riders instanceof Set ? riders
                    : Array.isArray(riders) ? new Set(riders) : null;
    if (!ridersSet || ridersSet.size === 0) continue;
    // Rate-limit per boat — `_lastEncounterAt`.
    const now = Date.now();
    if (now - (it._lastEncounterAt ?? 0) < ENCOUNTER_INTERVAL_MS) continue;
    it._lastEncounterAt = now;
    // Open-water filter — only spawn if the boat's tile is on water.
    const onWater = deps.landProvider?.isWater?.(it.map ?? 1, it.x, it.y) ?? true;
    if (!onWater) continue;
    if (Math.random() > ENCOUNTER_CHANCE) continue;

    const enc = pickEncounter();
    let spawned = 0;
    for (let i = 0; i < enc.count; i++) {
      const dx = Math.floor((Math.random() - 0.5) * SPAWN_RADIUS * 2);
      const dy = Math.floor((Math.random() - 0.5) * SPAWN_RADIUS * 2);
      const pos = { x: it.x + dx, y: it.y + dy, z: it.z, map: it.map };
      try {
        const m = deps.spawnFactory(world, enc.kind, pos);
        if (m) {
          spawned++;
          // First rider becomes the combatant — they're the ship captain
          // for combat purposes. Subsequent serpents pick from the rider
          // pool randomly.
          const riderSerials = [...ridersSet];
          const targetSerial = riderSerials[Math.floor(Math.random() * riderSerials.length)];
          if (targetSerial) m.combatant = targetSerial;
        }
      } catch (e) { console.warn('[ocean-enc] spawn failed:', e.message); }
    }
    if (spawned > 0) {
      triggered++;
      try { deps.broadcastNear?.(world, { x: it.x, y: it.y, z: it.z, map: it.map }, 24, enc.message); }
      catch { /* advisory */ }
    }
  }
  return triggered;
}

export const OCEAN_ENCOUNTER_TYPES = ENCOUNTER_TYPES;
