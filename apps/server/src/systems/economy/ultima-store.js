// Ultima Store — port of ServUO `Scripts/Services/UltimaStore/`. Stub
// the cash-shop transaction surface. We don't accept real currency in
// our shard — the "store" is just a curated catalogue of decorative
// items that players can buy with `sovereigns`, an alternate currency
// awarded by event participation, anniversaries, BODs, etc.

const CATALOGUE = Object.freeze([
  { id: 'silver-cuff',     label: 'Silver Cuff',     cost: 50,  category: 'jewelry' },
  { id: 'sage-scarf',      label: 'Sage Scarf',      cost: 80,  category: 'apparel' },
  { id: 'crystal-bell',    label: 'Crystal Bell',    cost: 120, category: 'decor' },
  { id: 'phoenix-banner',  label: 'Phoenix Banner',  cost: 220, category: 'decor' },
  { id: 'shrine-pillar',   label: 'Shrine Pillar',   cost: 350, category: 'decor' },
  { id: 'tribal-mask',     label: 'Tribal Mask',     cost: 180, category: 'apparel' },
  { id: 'mystical-orb',    label: 'Mystical Orb',    cost: 600, category: 'rare' },
]);

export function catalogue() { return CATALOGUE; }
export function findItem(id) { return CATALOGUE.find((i) => i.id === id) ?? null; }

export function balance(account) { return account?._sovereigns | 0; }
export function award(account, n) {
  if (!account) return;
  account._sovereigns = (account._sovereigns | 0) + Math.max(0, n | 0);
}

export function buy(account, mob, itemId, api) {
  const it = findItem(itemId);
  if (!it) return { ok: false, reason: 'Unknown item.' };
  const have = balance(account);
  if (have < it.cost) return { ok: false, reason: `Need ${it.cost} sovereigns (you have ${have}).` };
  account._sovereigns = have - it.cost;
  const pack = mob?.backpack ?? mob?.equipment?.get?.(21);
  api?.templates?.spawn?.(it.id, { container: pack, amount: 1 });
  return { ok: true, item: it, remaining: account._sovereigns };
}
