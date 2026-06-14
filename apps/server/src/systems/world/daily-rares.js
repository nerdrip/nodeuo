// DailyRares — ServUO `Services/DailyRares/DailyRares.cs`. 24h-rotating
// rare-item pool: each UTC day picks a deterministic-by-date subset of
// the catalog and tags those items as "spawnable today". Players who
// find them in the world (random hidden chest, fishing catch, etc.)
// get a one-time daily rare.
//
// Catalog is by-itemId (the actual graphic) + label. The rotation uses
// a hash of the UTC day-of-year so each shard sees the same pool on
// any given day without needing inter-shard sync.

const CATALOG = [
  { itemId: 0x09EC, label: 'Cobblestone Block (Daily Rare)' },
  { itemId: 0x14F0, label: 'Forged Crown (Daily Rare)' },
  { itemId: 0x1F0F, label: 'Antique Ruby (Daily Rare)' },
  { itemId: 0x1F1A, label: 'Antique Diamond (Daily Rare)' },
  { itemId: 0x1779, label: 'Silken Thread (Daily Rare)' },
  { itemId: 0x09B7, label: 'Festive Roast (Daily Rare)' },
  { itemId: 0x1086, label: 'Royal Signet Ring (Daily Rare)' },
  { itemId: 0x108A, label: 'Silver Signet Ring (Daily Rare)' },
  { itemId: 0x1F4D, label: 'Vellum Scroll (Daily Rare)' },
  { itemId: 0x0FFE, label: 'Jeweled Brooch (Daily Rare)' },
  { itemId: 0x232A, label: 'Mystery Bag (Daily Rare)' },
  { itemId: 0x14EB, label: 'Antique Map (Daily Rare)' },
  { itemId: 0x4007, label: 'Spring Pigment Vial (Daily Rare)' },
  { itemId: 0x09F1, label: 'Hearty Stew (Daily Rare)' },
  { itemId: 0x100E, label: 'Ornate Cradle (Daily Rare)' },
  { itemId: 0x4D6E, label: 'Gargish Talisman (Daily Rare)' },
  { itemId: 0x05DC, label: 'Elven Wreath (Daily Rare)' },
  { itemId: 0x4076, label: 'Sculpted Bust (Daily Rare)' },
  { itemId: 0x0BC3, label: 'Embroidered Banner (Daily Rare)' },
  { itemId: 0x2AF9, label: 'Music Cylinder (Daily Rare)' },
];

const DAILY_POOL_SIZE = 5;     // 5/20 active each UTC day.

/** Deterministic hash for date YYYY-MM-DD → 32-bit. */
function dateHash(d = new Date()) {
  const y = d.getUTCFullYear() | 0;
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  let h = (y * 73856093) ^ (m * 19349663) ^ (day * 83492791);
  h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
  return h >>> 0;
}

/** Mulberry32 PRNG seeded with `seed` — same input → same shuffled order. */
function mulberry32(seed) {
  let t = seed | 0;
  return () => {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** The pool active today (UTC). Stable per UTC day. */
export function todaysPool(now = Date.now()) {
  const rand = mulberry32(dateHash(new Date(now)));
  const shuffled = [...CATALOG].sort(() => rand() - 0.5);
  return shuffled.slice(0, DAILY_POOL_SIZE);
}

export function catalog() { return CATALOG.slice(); }

/** Was `itemId` part of today's rotation? */
export function isDailyRare(itemId, now = Date.now()) {
  return todaysPool(now).some((e) => (e.itemId | 0) === (itemId | 0));
}

/** Pick a random entry from today's pool. Used by loot rollers as a
 *  "if not a normal drop, 1% chance: this." */
export function rollDailyRare(now = Date.now()) {
  const pool = todaysPool(now);
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}
