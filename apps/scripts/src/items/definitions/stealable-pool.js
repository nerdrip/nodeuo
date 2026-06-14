// Default stealable-loot pool seed for paragon / boss creatures used by
// `systems/monster-stealing.js`. ServUO assigns specific minor artifacts
// to each fame-tier — we keep the same idea but reference our existing
// item kinds.
//
// Pool is keyed by creature kind; the spawner can copy entries into the
// freshly-spawned mob's `_stealablePool` field on creation, plus toggle
// `_stealableLoot=true` so `tryMonsterSteal` accepts the target.


// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];
export const STEALABLE_SERVUO_CLASSES = Object.freeze([
  'StealableArtifactsSpawner',
  'StealableEntry',
  'StealableInstance',
]);

export const RESOURCE_GEMS = Object.freeze([
  { itemId: 0x0F15, name: 'citrine' },
  { itemId: 0x0F25, name: 'amber' },
  { itemId: 0x0F2D, name: 'tourmaline' },
  { itemId: 0x0F16, name: 'amethyst' },
  { itemId: 0x0F19, name: 'sapphire' },
  { itemId: 0x0F10, name: 'emerald' },
  { itemId: 0x0F13, name: 'ruby' },
  { itemId: 0x0F26, name: 'diamond' },
  { itemId: 0x0F21, name: 'star sapphire' },
]);

export const STEALABLE_POOL = Object.freeze({
  // Fame ~ 12000 (mid-tier paragon)
  'troll-paragon': [
    { itemId: 0x0F4C, name: 'enchanted shillelagh', hue: 0x47E },
    { itemId: 0x1442, name: 'troll trinket',         hue: 0x06D },
  ],
  'ogre-paragon': [
    { itemId: 0x0F50, name: 'ogre coin pouch',       hue: 0x44E },
    { itemId: 0x1F03, name: 'ogre tooth amulet',     hue: 0x481 },
  ],
  'dragon-paragon': [
    { itemId: 0x1F1C, name: 'dragon scale earring',  hue: 0x66D },
    { itemId: 0x0DE9, name: 'dragonbone fragment',   hue: 0x481 },
    { itemId: 0x0EE3, name: 'pyrite gem',            hue: 0x489 },
    ...RESOURCE_GEMS.slice(6),
  ],
  // Fame ~ 22500 (mini-boss)
  'lich-lord-paragon': [
    { itemId: 0x0F0E, name: 'soulshard',             hue: 0x4D3 },
    { itemId: 0x1F18, name: 'phylactery of ages',    hue: 0x47A },
    ...RESOURCE_GEMS.slice(3, 6),
  ],
  // Fame ~ 30000 (peerless minion)
  'travesty-shadow': [
    { itemId: 0x232B, name: 'shadow gem',            hue: 0x47A },
    { itemId: 0x232D, name: 'shadow rune',           hue: 0x47A },
    ...RESOURCE_GEMS.slice(0, 3),
  ],
});

/** Convenience: stamp a creature with stealable bits at spawn time.
 *  Caller (spawner.js / boss-spawner) calls this with the freshly
 *  minted mob + its kind. No-op if no pool exists for the kind. */
export function stampStealable(mob) {
  if (!mob?.kind) return;
  const pool = STEALABLE_POOL[mob.kind];
  if (!pool) return;
  mob._stealableLoot = true;
  mob.servuoClasses = [...new Set([...(mob.servuoClasses ?? []), ...STEALABLE_SERVUO_CLASSES])];
  // Copy so per-mob steals don't drain the shared pool.
  mob._stealablePool = pool.map((e) => ({
    ...e,
    servuoClass: e.servuoClass ?? 'StealableInstance',
    servuoClasses: [...new Set([...(e.servuoClasses ?? []), ...STEALABLE_SERVUO_CLASSES])],
  }));
}


// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('stealable-pool: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('stealable-pool: ' + e.message); } }
  api.log?.('stealable-pool: registered ' + count + ' items');
  return () => {};
}
