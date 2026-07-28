// ---- Bank box helpers ------------------------------------------------------
// Walk an item's parent chain up to 8 hops. Returns the bank container
// (layer 0x1D) if one is in the chain, else null. Used to enforce the
// 125-item / 1600-stone cap on bank deposits.
export function _findBankRoot(world, item) {
  let cur = item;
  for (let hop = 0; hop < 8; hop++) {
    if (!cur) return null;
    if (cur.layer === 0x1D) return cur;
    const p = world.items.get(cur.parent);
    if (!p) return null;
    cur = p;
  }
  return null;
}
export function _isInsideBank(world, item) {
  return _findBankRoot(world, item) !== null;
}

