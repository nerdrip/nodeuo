// Christmas event — port of ServUO `Engines/Misc/ChristmasGifts.cs` and
// the holiday tree placement engine. Hot during the December 1-31 UTC
// window:
//
//   • Each Account receives a one-shot "wrapped gift" item on their
//     first login during the window. Tracked via `account._xmasYear`
//     so a player can't multi-claim per year.
//   • Snowflake / snow tile cosmetic — broadcast a seasonChange(3)
//     (Winter) to every connected client. Already handled by the
//     seasons region hook for dungeons / region-pinned zones;
//     `[xmas force-snow` flips the shard-wide pinned season.
//   • `[xmas claim` lets a player manually re-issue the wrapped gift
//     (admin-gated test path).
//
// Gift roster (random pick): wrapped box of varying hues + a small
// chance of a holiday wreath / mistletoe. Reuses the existing item
// pipeline so no new templates needed.

// Per-year gift pool. ServUO `ChristmasGifts.cs` ships a different gift
// table per year (snow globes, ornaments, plushies, hooded shrouds…)
// so two characters on the same account each year don't get the same
// art. Year mod 12 picks the slot; rare-pool tail (4) is identical
// across years for the artifact-tier drops.
const ANNUAL_GIFT_SLOTS = [
  { itemId: 0x232A, hue: 0x047,  name: 'wrapped present (red)' },
  { itemId: 0x232A, hue: 0x044,  name: 'wrapped present (green)' },
  { itemId: 0x232A, hue: 0x481,  name: 'wrapped present (white)' },
  { itemId: 0x232B, hue: 0x047,  name: 'wrapped present (red, large)' },
  { itemId: 0x2329, hue: 0x047,  name: 'a candy cane' },
  { itemId: 0x2326, hue: 0x044,  name: 'a green holiday bell' },
  { itemId: 0x2326, hue: 0x047,  name: 'a red holiday bell' },
  { itemId: 0x2328, hue: 0x481,  name: 'snowy reindeer' },
  { itemId: 0x232C, hue: 0x044,  name: 'holiday tree (small)' },
  { itemId: 0x232E, hue: 0x481,  name: 'snow pile' },
  { itemId: 0x2331, hue: 0x047,  name: 'red poinsettia' },
  { itemId: 0x2332, hue: 0x481,  name: 'a stocking' },
];
// Rare drops (5% roll, picked uniformly).
const RARE_POOL = [
  { itemId: 0x232C, hue: 0x044,  name: 'holiday wreath', rare: true },
  { itemId: 0x232D, hue: 0x047,  name: 'mistletoe', rare: true },
  { itemId: 0x2332, hue: 0x47E,  name: 'stocking of the snow lord', rare: true },
  { itemId: 0x2330, hue: 0x047,  name: 'crystal snowflake', rare: true },
  { itemId: 0x09E4, hue: 0x47E,  name: 'snowy boots', rare: true },
];

let _override = null;

/** True if the Christmas event window is currently active. */
export function isActive(now = new Date()) {
  if (_override === 'on') return true;
  if (_override === 'off') return false;
  return now.getUTCMonth() === 11;       // December
}
export function setOverride(mode) {
  if (mode === 'on' || mode === 'off' || mode === null) _override = mode;
}

/**
 * Pick one gift definition for delivery. 5 % rare, 95 % from this
 * year's annual slot pool. Per-year slot rotation is deterministic
 * (yearIndex = year % length) so all players who claim during the
 * same year see the same gift family — matches retail-shard year-of
 * announcements ("This year: Snow Reindeer").
 */
export function rollGift(now = new Date()) {
  if (Math.random() < 0.05) {
    return RARE_POOL[Math.floor(Math.random() * RARE_POOL.length)];
  }
  // Each year rotates through 3 of the annual slots so the same gift
  // doesn't repeat for an account that rotates characters.
  const yearIdx = (now.getUTCFullYear() * 3) % ANNUAL_GIFT_SLOTS.length;
  const window = [
    ANNUAL_GIFT_SLOTS[yearIdx],
    ANNUAL_GIFT_SLOTS[(yearIdx + 1) % ANNUAL_GIFT_SLOTS.length],
    ANNUAL_GIFT_SLOTS[(yearIdx + 2) % ANNUAL_GIFT_SLOTS.length],
  ];
  return window[Math.floor(Math.random() * window.length)];
}

/**
 * Deliver this year's gift to `account` via `account.characters[*].mob`.
 * Idempotent — once `account._xmasYear === currentYear` we skip. Returns
 * the spawned item OR null when already claimed / event inactive.
 */
export function deliverGift(api, account, mob, now = new Date()) {
  if (!isActive(now)) return null;
  if (!account || !mob) return null;
  const year = now.getUTCFullYear();
  if ((account._xmasYear | 0) === year) return null;
  const def = rollGift(now);
  try {
    const gift = api.items.createItem(api.world, {
      itemId: def.itemId, hue: def.hue, parent: mob.serial, name: def.name,
    });
    account._xmasYear = year;
    mob.client?.sendSystemMessage?.(
      `Happy Holidays! A ${def.name} has been placed in your pack.`);
    return gift;
  } catch {
    return null;
  }
}
