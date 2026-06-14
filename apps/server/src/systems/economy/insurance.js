// FAZA EJ — Item Insurance.
//
// ServUO `Misc/Insurance.cs`: items can be flagged Insured. On death,
// insured items are NOT moved to the corpse — they stay on the
// (revived) player's body. The player pays gold per insured item per
// death.
//
// Per-death escalation (ServUO Insurance.cs ~600 base scaling by recent
// death count) — frequent deaths cost more, encouraging careful play:
//   1st within 1h:  600  gp
//   2nd within 1h:  900
//   3rd within 1h: 1200
//   4th within 1h: 1800
//   5th+ within 1h: 2400 (cap)
// The window resets after 1 h of crime-free play.

const INSURE_COST_TABLE = [600, 900, 1200, 1800, 2400];
const INSURE_DEATH_WINDOW_MS = 60 * 60 * 1000;
const MAX_INSURED_VALUE = 10000;

/** Resolve the per-item charge for `mob`'s next death. Looks at the
 *  ring buffer of recent death timestamps within the 1h window. */
function currentInsureCost(mob, now = Date.now()) {
  const log = Array.isArray(mob?._insureDeathLog) ? mob._insureDeathLog : [];
  // Drop expired entries up-front so the table index reflects only
  // recent deaths.
  const recent = log.filter((t) => (now - t) < INSURE_DEATH_WINDOW_MS);
  const idx = Math.min(INSURE_COST_TABLE.length - 1, recent.length);
  return INSURE_COST_TABLE[idx];
}

/** Mark an item as insured by `mob`. Returns the item's insurance state. */
export function insureItem(mob, item) {
  if (!mob || !item) return null;
  if ((item.layer ?? 0) === 0) return null;            // only worn items insurable
  item.insured = true;
  item.insuredBy = mob.serial >>> 0;
  return { ok: true };
}

export function uninsureItem(item) {
  if (!item) return;
  delete item.insured;
  delete item.insuredBy;
}

/**
 * Called from corpse.killMobile. Filters items that should NOT be
 * dropped to the corpse because they're insured. Returns a list of
 * items the caller must keep parented to the player.
 */
export function collectInsuredItems(world, mob) {
  if (!world?.items || !mob) return [];
  const out = [];
  // Fast path — reverse parent index. Walks only items actually
  // parented to `mob` instead of all 110k world.items. Bug-hunt A7.
  const idx = world._childrenByParent;
  if (idx) {
    const set = idx.get(mob.serial);
    if (!set) return out;
    for (const s of set) {
      const it = world.items.get(s);
      if (!it || !it.insured) continue;
      if ((it.layer ?? 0) === 0) continue;
      out.push(it);
    }
    return out;
  }
  for (const it of world.items.values()) {
    if (it.parent !== mob.serial) continue;
    if (!it.insured) continue;
    if ((it.layer ?? 0) === 0) continue;
    out.push(it);
  }
  return out;
}

/**
 * Charge insurance fee on death. Caller passes the killed mob and an
 * iterable of insured items. Cost ramps with recent deaths inside the
 * 1h window (600 → 2400). If the mob doesn't have enough gold for an
 * item, it un-insures (drops to the corpse normally on next death).
 *
 * Stamps the death timestamp into `mob._insureDeathLog` so the next
 * call within the window uses the next-higher tier.
 */
export function chargeInsurance(mob, insuredItems, world = null) {
  const now = Date.now();
  const perItem = currentInsureCost(mob, now);
  let charged = 0, defaulted = 0;

  // Bug-hunt #8 #2: was reading `mob.gold` scalar, but for players gold
  // is the 0x0EED coin pile inside the backpack. Result: every insurance
  // charge defaulted, every insured item un-insured on first death. Walk
  // gold piles via the reverse parent index. `world` is now optional —
  // callers that pass it get correctness; the legacy scalar path
  // survives for callers that haven't been migrated yet.
  let goldLeft;
  let goldPiles = [];
  if (world) {
    const pack = (function () {
      const idx = world._childrenByParent?.get?.(mob.serial);
      if (!idx) return null;
      for (const s of idx) {
        const it = world.items.get(s);
        if (it?.layer === 21) return it;
      }
      return null;
    })();
    if (pack) {
      const packIdx = world._childrenByParent?.get?.(pack.serial);
      const iter = packIdx
        ? Array.from(packIdx, (s) => world.items.get(s)).filter(Boolean)
        : Array.from(world.items.values()).filter((it) => it.parent === pack.serial);
      for (const it of iter) if (it.itemId === 0x0EED) goldPiles.push(it);
    }
    goldLeft = goldPiles.reduce((sum, p) => sum + (p.amount ?? 1), 0);
  } else {
    goldLeft = mob.gold | 0;
  }

  for (const it of insuredItems) {
    if (goldLeft >= perItem) {
      goldLeft -= perItem;
      charged += perItem;
    } else {
      uninsureItem(it);
      defaulted += 1;
    }
  }

  // Drain the actual coin piles in pack order. Whole pile destroyed when
  // empty; partial deduction left in place.
  if (world && goldPiles.length > 0) {
    let drain = charged;
    for (const pile of goldPiles) {
      if (drain <= 0) break;
      const have = pile.amount ?? 1;
      if (have <= drain) {
        drain -= have;
        try { world.destroyItem?.(pile.serial); }
        catch { pile.amount = 0; }
      } else {
        pile.amount = have - drain;
        drain = 0;
      }
    }
  } else {
    mob.gold = goldLeft;
  }
  // Stamp this death so the next one within 1h ramps the tier. Trim
  // expired entries to keep the log short.
  mob._insureDeathLog = (Array.isArray(mob._insureDeathLog) ? mob._insureDeathLog : [])
    .filter((t) => (now - t) < INSURE_DEATH_WINDOW_MS);
  mob._insureDeathLog.push(now);
  return { charged, defaulted, perItem };
}

/**
 * Mark every worn item on `mob` as insured (the "Insure all" toggle
 * from the ServUO insurance gump). Returns the count of newly-insured
 * items. Items that are already insured stay insured (idempotent).
 */
export function insureAll(world, mob) {
  if (!world?.items || !mob) return { insured: 0 };
  let n = 0;
  // Walk only items actually parented to `mob` — reverse index.
  const idx = world._childrenByParent;
  const iter = idx?.get?.(mob.serial)
    ? Array.from(idx.get(mob.serial), (s) => world.items.get(s)).filter(Boolean)
    : [...world.items.values()].filter((it) => it.parent === mob.serial);
  for (const it of iter) {
    if ((it.layer ?? 0) === 0) continue;
    if (it.insured) continue;
    insureItem(mob, it);
    n++;
  }
  return { insured: n };
}

export const _INSURANCE_CONST = Object.freeze({
  // INSURE_COST kept for test back-compat — first-tier base price.
  INSURE_COST: INSURE_COST_TABLE[0],
  INSURE_COST_TABLE,
  INSURE_DEATH_WINDOW_MS,
  MAX_INSURED_VALUE,
});
