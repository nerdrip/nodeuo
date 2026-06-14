// CleanUpBritannia — turn-in unwanted items at trash barrels around
// the world for points. Mirrors ServUO `Services/CleanUpBritannia/`.
//
// Players drop items into a CleanUp Barrel; the system computes a
// per-item point value (rare/event drops worth more), credits the
// player's pool, and lets them redeem at any reward stone.
//
// Storage:
//   account.cleanupPoints   — accumulated points (lifetime - redeemed)
//   account.cleanupRedeemed — array of redeemed reward names
//
// Points table is intentionally focused on the major categories ServUO
// ships (paragon-grade gear, ML/SA artifacts, holiday tokens). Items
// outside the table are 1 point per stack-count (gold drains 1 point
// per 100 gp).

import { destroyItem } from '../../world/items.js';

const POINTS_BY_CATEGORY = {
  trash:           0,
  basic:           1,
  craftable:       2,
  decoration:      5,
  gem:             3,
  rare:            50,
  artifact:        500,
  paragon:         200,
  event:           100,
  holiday:         150,
  imbuingResource: 25,
  runic:           120,
};

function classify(item) {
  if (!item) return 'trash';
  if (item.artifactDrop || item.tier === 'major' || item.tier === 'greater') return 'artifact';
  if (item.kind === 'gem' || item.gem) return 'gem';
  if (item._paragonLoot) return 'paragon';
  if (item.event) return 'event';
  if (item.holiday) return 'holiday';
  if (item.material === 'verite' || item.material === 'valorite' ||
      item.material === 'agapite' || item.material === 'gold') return 'runic';
  if (item.imbuingMagic) return 'imbuingResource';
  if (item.isDecoration) return 'decoration';
  if (item.craftedBy) return 'craftable';
  return 'basic';
}

/** Compute per-item points the player will receive on turn-in. */
export function pointsFor(item) {
  if (!item) return 0;
  if (item.itemId === 0x0EED) return Math.floor((item.amount ?? 1) / 100);
  const cat = classify(item);
  const base = POINTS_BY_CATEGORY[cat] ?? 0;
  // Stack multiplier — only basic / craftable / gem / imbuing benefit.
  const mult = (cat === 'basic' || cat === 'craftable' || cat === 'gem' || cat === 'imbuingResource')
    ? Math.min(100, item.amount ?? 1) : 1;
  return base * mult;
}

/** Credit `account` with the item's points and remove it from world. */
export function turnIn(account, world, item) {
  if (!account || !world || !item) return 0;
  const pts = pointsFor(item);
  if (pts <= 0) return 0;
  account.cleanupPoints = (account.cleanupPoints | 0) + pts;
  // BH #11 #12 — was `world.items.delete(serial)` which bypassed
  // `destroyItem` reverse-index unlink + sector cleanup + onDestroy
  // script hooks. Use the canonical path.
  try {
    destroyItem(world, item.serial);
  } catch { /* ignore */ }
  return pts;
}

// =====================================================================
//  REWARD CATALOG (per-tier point cost)
// =====================================================================

const REWARDS = {
  // Basic tier (250-1000 pts)
  'cleanup-cloak':            { cost: 500,    itemId: 0x1515, hue: 0x47E, name: 'cleanup cloak' },
  'cleanup-robe':             { cost: 750,    itemId: 0x1F03, hue: 0x47E, name: 'cleanup robe' },
  'cleanup-sash':             { cost: 250,    itemId: 0x152C, hue: 0x47E, name: 'cleanup sash' },

  // Mid tier (1500-5000 pts) — usable items
  'enhanced-bandage':         {
    cost: 1500, itemId: 0x0E21, hue: 0x8A5, name: 'enhanced bandage', amount: 50,
    tagId: 'enhanced-bandage', script: 'bandage', stackable: true, bandageHealingBonus: 10,
    servuoClass: 'EnhancedBandage', servuoClasses: ['EnhancedBandage', 'Bandage', 'ICommodity'],
  },
  'enhanced-magery-scroll':   { cost: 2500,   itemId: 0x1F2D, hue: 0x47E, name: 'enhanced scroll' },
  'cleanup-recall-runes':     { cost: 2000,   itemId: 0x1F14, hue: 0x47E, name: 'rune set', amount: 5 },
  'cleanup-tools':            { cost: 3000,   itemId: 0x1102, hue: 0x47E, name: 'enhanced tool' },

  // High tier (5000-15000 pts) — runic + reward dyes
  'cleanup-runic-hammer':     { cost: 7500,   itemId: 0x13E3, hue: 0x47E, name: 'runic hammer (cleanup)' },
  'cleanup-runic-sewing-kit': { cost: 7500,   itemId: 0x0F9D, hue: 0x47E, name: 'runic sewing kit (cleanup)' },
  'cleanup-leather-dye-tub':  { cost: 5000,   itemId: 0x0FAB, hue: 0x47E, name: 'leather dye tub' },
  'cleanup-pigments':         { cost: 5000,   itemId: 0x0FAB, hue: 0x481, name: 'pigments of tokuno' },

  // Top tier (25000+ pts) — rare cosmetics + statues
  'cleanup-davies-locker':    { cost: 25000,  itemId: 0x4B5A, hue: 0x47E, name: 'davies locker (cleanup)' },
  'cleanup-monster-statuette':{ cost: 30000,  itemId: 0x14F0, hue: 0x47E, name: 'monster statuette' },
  'cleanup-ethereal-mount':   { cost: 50000,  itemId: 0x20DD, hue: 0x47E, name: 'cleanup ethereal mount' },
  'cleanup-mythic-title':     { cost: 75000,  itemId: 0x14F0, hue: 0x47E, name: 'mythic title deed' },
};

export function listRewards() { return Object.entries(REWARDS).map(([k, v]) => ({ key: k, ...v })); }
export function rewardCost(key) { return REWARDS[key]?.cost ?? null; }
export function rewardSpawn(key) { return REWARDS[key] ?? null; }

/**
 * Redeem a named reward — debits points + returns the spawn config so
 * the caller can `world.createItem` it into the player's pack.
 */
export function redeem(account, key) {
  if (!account) return { ok: false, reason: 'no-account' };
  const reward = REWARDS[key];
  if (!reward) return { ok: false, reason: 'unknown-reward' };
  if ((account.cleanupPoints | 0) < reward.cost) return { ok: false, reason: 'not-enough-points' };
  account.cleanupPoints -= reward.cost;
  account.cleanupRedeemed ??= [];
  account.cleanupRedeemed.push(key);
  return { ok: true, reward };
}

export function pointsOf(account) { return account?.cleanupPoints | 0; }

export const CLEANUP_CONST = Object.freeze({ POINTS_BY_CATEGORY, REWARDS });
