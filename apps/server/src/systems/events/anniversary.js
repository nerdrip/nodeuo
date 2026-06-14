// Anniversary — ENGINE ONLY. Reward-tier table lives in
// apps/scripts/src/data/world/anniversary-tiers.json and is registered at
// startup by apps/scripts/src/systems/events/anniversary.js.
//
// Engine responsibilities:
//   - hold the active tier list (set by script via setTiers)
//   - compute eligibleTiers based on account age
//   - mark gifts as claimed (idempotent)
//   - grant pending tiers into the player's pack on login

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/** @type {Array<{years:number, gift:string, label:string, itemId:number, hue?:number}>} */
let _tiers = [];

/** Replace the active tier list. Called once from the script loader. */
export function setTiers(tiers) {
  _tiers = Array.isArray(tiers) ? tiers.slice() : [];
}

export function getTiers() { return _tiers.slice(); }

export function eligibleTiers(account, now = Date.now()) {
  if (!account) return [];
  const created = account.createdAt ?? account.created ?? now;
  const ageMs = Math.max(0, now - created);
  const years = ageMs / YEAR_MS;
  const claimed = new Set(Array.isArray(account._anniversaryClaimed) ? account._anniversaryClaimed : []);
  return _tiers.filter((t) => years >= t.years && !claimed.has(t.gift));
}

export function markClaimed(account, gift) {
  if (!account) return;
  if (!Array.isArray(account._anniversaryClaimed)) account._anniversaryClaimed = [];
  if (!account._anniversaryClaimed.includes(gift)) {
    account._anniversaryClaimed.push(gift);
  }
}

function findPack(world, mob) {
  const idx = world._childrenByParent?.get?.(mob.serial);
  if (idx) {
    for (const s of idx) {
      const it = world.items.get(s);
      if (it && it.layer === 21) return it;
    }
  }
  for (const it of world.items.values()) {
    if (it.parent === mob.serial && it.layer === 21) return it;
  }
  return null;
}

/** Grant any pending anniversary rewards. Called from the login flow. */
export function grantPending(world, mob, account, now = Date.now()) {
  if (!world || !mob || !account || _tiers.length === 0) return [];
  const pack = findPack(world, mob);
  if (!pack) return [];
  const createItem = world.createItem ?? world.items?.create;
  if (typeof createItem !== 'function') return [];
  const granted = [];
  for (const tier of eligibleTiers(account, now)) {
    const out = { itemId: tier.itemId, name: tier.label, parent: pack.serial };
    if (tier.hue) out.hue = tier.hue;
    createItem(out);
    markClaimed(account, tier.gift);
    granted.push(tier);
    mob.client?.sendSystemMessage?.(
      `Anniversary reward: ${tier.label} (${tier.years}-year veteran).`,
    );
  }
  return granted;
}
