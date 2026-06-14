// Shame Crystal Levels — port of ServUO `Engines/Shame Revamp/`. The
// dungeon Shame got a 5-level rework: each level rotates a unique boss
// + themed mob pool every 90 minutes (server-clock). Drops include
// Shame-exclusive level-tagged loot.
//
// We model the rotation as a global state object on the world. The
// content registry (`apps/scripts/src/spawns/shame.js`) reads
// `currentShameLevels()` to pick which mob pool to use for each
// sub-region.

const LEVELS = [
  { name: 'L1: Earth',     theme: 'earth',  mobs: ['EarthElemental', 'StoneHarpy', 'Reaper'], boss: 'StoneSpirit' },
  { name: 'L2: Wisp',      theme: 'wisp',   mobs: ['Wisp', 'Pixie', 'EvilFairyWisp'],            boss: 'WispLord' },
  { name: 'L3: Decay',     theme: 'decay',  mobs: ['BoneKnight', 'Mummy', 'Zombie'],            boss: 'TormentedSoul' },
  { name: 'L4: Shadow',    theme: 'shadow', mobs: ['ShadowWyrm', 'ShadowKnight', 'ShadowGuard'], boss: 'ShadowLord' },
  { name: 'L5: Insanity',  theme: 'mad',    mobs: ['MadHermit', 'MadMage', 'MadBard'],          boss: 'TheCaretaker' },
];

const ROTATION_INTERVAL_MS = 90 * 60 * 1000;

/**
 * Return the level currently active for `mapTier` (1..5). Rotation
 * advances 1 step every 90 min, wrapping. World stamp `_shameRotation`
 * keeps the boot-time seed so all callers see the same level for
 * the same wall-clock minute.
 */
export function currentLevel(world, mapTier, now = Date.now()) {
  const tier = Math.max(1, Math.min(5, mapTier | 0));
  const seed = world._shameRotationSeed ??= now;
  const elapsed = Math.max(0, now - seed);
  const slot = Math.floor(elapsed / ROTATION_INTERVAL_MS);
  return LEVELS[(slot + (tier - 1)) % LEVELS.length];
}

/** Force-set the rotation seed — admin command for testing. */
export function setRotationSeed(world, now) { world._shameRotationSeed = now; }

/**
 * Argent Mine bonus — Shame's surface mine ore drops 30 % extra
 * compared to baseline mining. Hooked by harvest.js when the mining
 * tile's region matches the `argent-mine` region tag.
 */
export const ARGENT_MINE_BONUS = 0.30;

export const SHAME_LEVELS = LEVELS;
