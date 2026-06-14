// Points Systems — port of ServUO `Scripts/Services/PointsSystems/`.
// Generic ledger of per-account "points" balances earned from world
// events / champion spawns / faction kills / clean-up donations etc.
// Each ledger is a separate currency; rewards turn-in NPCs read the
// ledger and gate items by balance.

// Extended catalogue — every ServUO Services/PointsSystems/*.cs ledger
// has its own kind here so per-vendor turn-ins read a stable namespace.
const KINDS = Object.freeze([
  'champion',     // boss spawn participation
  'invasion',     // Magincia invasion
  'cleanup',      // CleanUpBritannia
  'doom',         // Doom Gauntlet
  'shadowguard',  // Shadowguard tower
  'huntmaster',   // weekly hunt
  'faction',      // Factions / VvV
  'community',    // community-collections totals
  'sovereign',    // store currency (mirrors ultima-store but stable)
  // — added in batch 2026-05-15 to match ServUO Services/PointsSystems
  'blackthorn',   // Blackthorn dungeon contribution
  'casino',       // Fire Casino chip credit
  'krampus',      // Krampus naughty/nice ledger
  'tokuno',       // Treasures of Tokuno turn-ins
  'khaldun',      // Khaldun reward currency
  'sanctuary',    // Sanctuary boss participation
  'aetheric',     // Aetheric Citadel participation
  'cityloyalty',  // City Loyalty + Renaissance (aggregate)
  'kotl',         // Eodon Kotl sentinel kills
  'myrmidex',     // Myrmidex invasion side rep
  'arena',        // PvP Arena season points
  'bod',          // Bulk Order Deeds reward points
  'turfwar',      // Faction stronghold capture
]);

export function listKinds() { return KINDS; }

function lock(account) { account._points ??= {}; return account._points; }

export function balance(account, kind) {
  if (!KINDS.includes(kind)) return 0;
  return lock(account)[kind] | 0;
}

export function award(account, kind, n) {
  if (!account || !KINDS.includes(kind)) return 0;
  const ledger = lock(account);
  ledger[kind] = Math.max(0, (ledger[kind] | 0) + (n | 0));
  return ledger[kind];
}

export function spend(account, kind, n) {
  if (!account || !KINDS.includes(kind)) return false;
  const ledger = lock(account);
  if ((ledger[kind] | 0) < n) return false;
  ledger[kind] -= n;
  return true;
}

export function dump(account) {
  const out = {};
  for (const k of KINDS) out[k] = balance(account, k);
  return out;
}

// ---- Shared turn-in helper ----------------------------------------------
//
// ServUO `BasePointsSystem.AwardPoints` does per-rank thresholds
// (Initiate/Adept/Master/Grandmaster). Surface those tiers so vendor
// scripts can gate items consistently across all ledgers.

const TIER_THRESHOLDS = [
  { id: 'initiate',     min: 0 },
  { id: 'adept',        min: 1000 },
  { id: 'master',       min: 5000 },
  { id: 'grandmaster',  min: 25000 },
  { id: 'legendary',    min: 100000 },
];

/** Compute tier for a ledger balance. */
export function tierOf(account, kind) {
  const b = balance(account, kind);
  let cur = TIER_THRESHOLDS[0];
  for (const t of TIER_THRESHOLDS) if (b >= t.min) cur = t;
  return cur.id;
}

/** Transfer points between ledgers (e.g. casino chips → sovereign tokens). */
export function transfer(account, fromKind, toKind, n, rate = 1.0) {
  if (!spend(account, fromKind, n)) return false;
  award(account, toKind, Math.floor(n * rate));
  return true;
}

/** Atomic "buy" — refuses unless balance ≥ price; returns new balance. */
export function purchase(account, kind, price) {
  if (balance(account, kind) < price) return null;
  spend(account, kind, price);
  return balance(account, kind);
}
