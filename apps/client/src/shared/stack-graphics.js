// Stack display helpers. ClassicUO keeps the canonical graphic on the
// item and derives the on-screen coin art from Amount:
//   1 coin  -> base
//   2..5    -> base + 1
//   6+      -> base + 2
//
// UO coin families are three consecutive graphics:
//   0x0EEA..0x0EEC copper, 0x0EED..0x0EEF gold,
//   0x0EF0..0x0EF2 silver.

const COIN_BASE_START = 0x0EEA;
const COIN_BASE_END = 0x0EF2;

export function coinBaseItemId(itemId) {
  const id = itemId | 0;
  if (id < COIN_BASE_START || id > COIN_BASE_END) return 0;
  return COIN_BASE_START + Math.floor((id - COIN_BASE_START) / 3) * 3;
}

export function isCoinItemId(itemId) {
  return coinBaseItemId(itemId) !== 0;
}

export function displayItemIdForAmount(itemId, amount = 1) {
  const base = coinBaseItemId(itemId);
  if (!base) return itemId | 0;
  const n = Math.max(1, amount | 0);
  if (n > 5) return base + 2;
  if (n > 1) return base + 1;
  return base;
}
