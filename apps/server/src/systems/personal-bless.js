// Personal Bless Deed — account-bound item blessing.
//
// ServUO `Items/Misc/PersonalBlessDeed.cs`. A consumable scroll that
// blesses ONE worn item per character — that item survives death
// (skips the corpse drop) and any subsequent damage doesn't break the
// blessing. Distinct from regular blessed items (`item.newbied`):
//   • blessed = ServUO LootType.Blessed (item-class property, can't change)
//   • newbied = starter equipment (account-scoped via item.newbied flag)
//   • personal-bless = account+serial binding stamped at use time
//
// Bind: stamp `item._personalBlessed = account.username` (lowercased).
// On death (`corpse.killMobile`) any item with that flag whose match
// equals the dying mob's account stays parented to the mob — same
// path the `insured` flag uses (insurance.collectInsuredItems sister).
//
// Limits — ServUO defaults:
//   • One active blessing per character (re-using on a second item
//     clears the first).
//   • Account-scoped, not transferrable.
//   • Blessing survives `[del item` — the deed becomes refundable.

const DEED_ITEM_ID = 0x14F0;     // ServUO PersonalBlessDeed art

/**
 * Apply a personal-bless to `item` for `account`. Caller (the [pbd
 * command / scroll use-handler) is responsible for destroying the
 * deed after success. Returns true if the item is now blessed.
 *
 * Reuse: if `account` already has another blessed item, that one is
 * unblessed first (Map-of-account → serial maintained on the world).
 */
export function applyPersonalBless(world, account, item) {
  if (!world || !account || !item) return false;
  const key = String(account.username ?? '').toLowerCase();
  if (!key) return false;
  if ((item.layer ?? 0) === 0) return false;        // worn-only
  if (item._personalBlessed) return false;          // already blessed
  // Clear any prior blessing for this account.
  world._personalBlessByAccount ??= new Map();
  const priorSerial = world._personalBlessByAccount.get(key);
  if (priorSerial && priorSerial !== item.serial) {
    const prior = world.items.get(priorSerial);
    if (prior?._personalBlessed === key) delete prior._personalBlessed;
  }
  item._personalBlessed = key;
  world._personalBlessByAccount.set(key, item.serial);
  return true;
}

/**
 * Filter items that should NOT drop to the corpse because they're
 * blessed for the dying mob's account. Mirrors
 * insurance.collectInsuredItems shape so corpse.killMobile can chain
 * both checks. Returns the items to KEEP on the player.
 */
export function collectPersonalBlessed(world, mob) {
  if (!world?.items || !mob) return [];
  const accountName = (mob.accountName ?? mob.client?.account?.username ?? '').toLowerCase();
  if (!accountName) return [];
  const out = [];
  const idx = world._childrenByParent;
  const iter = idx?.get?.(mob.serial)
    ? Array.from(idx.get(mob.serial), (s) => world.items.get(s)).filter(Boolean)
    : [...world.items.values()].filter((it) => it.parent === mob.serial);
  for (const it of iter) {
    if (!it._personalBlessed) continue;
    if (it._personalBlessed !== accountName) continue;
    if ((it.layer ?? 0) === 0) continue;
    out.push(it);
  }
  return out;
}

export const PERSONAL_BLESS_DEED_ITEM_ID = DEED_ITEM_ID;
