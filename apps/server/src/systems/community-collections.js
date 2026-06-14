// Community Collections — port of ServUO
// `Scripts/Services/CommunityCollections/`. Cyclical donation mechanic:
// each Collector NPC accepts certain item kinds for "points", and when
// the global tally crosses a tier threshold, players who donated at
// that tier get a reward.
//
// Collections (5 base ones):
//   Library Collection      — books / scrolls
//   Museum of Vesper        — gems / artifacts
//   Brit Royal Forge        — ingots / metals
//   Britannia Zoo           — pelts / corpses
//   Magincia Bazaar Coffer  — gold

const COLLECTIONS = {
  library:    { label: 'Library Collection',      accepts: ['book', 'scroll'], rate: 1 },
  museum:     { label: 'Museum of Vesper',        accepts: ['gem', 'artifact'], rate: 5 },
  forge:      { label: 'Brit Royal Forge',        accepts: ['ingot'], rate: 2 },
  zoo:        { label: 'Britannia Zoo',           accepts: ['pelt', 'hide'], rate: 1 },
  bazaar:     { label: 'Magincia Bazaar Coffer',  accepts: ['gold'], rate: 1 },
};

const TIERS = [10_000, 25_000, 50_000, 100_000, 250_000];

export function listCollections() { return Object.keys(COLLECTIONS); }
export function collectionInfo(id) { return COLLECTIONS[id] ?? null; }

export function ensureState(world, id) {
  world._communityCollections ??= {};
  if (!world._communityCollections[id]) {
    world._communityCollections[id] = { points: 0, donors: {}, rewardedTiers: 0 };
  }
  return world._communityCollections[id];
}

export function donate(world, id, mob, item) {
  const c = COLLECTIONS[id]; if (!c) return { ok: false, reason: 'Unknown collection.' };
  if (!item) return { ok: false, reason: 'Nothing to donate.' };
  const cat = String(item.category ?? item.kind ?? '').toLowerCase();
  if (!c.accepts.some((a) => cat.includes(a))) {
    return { ok: false, reason: `That collection does not accept ${cat}.` };
  }
  const points = (item.amount ?? 1) * c.rate;
  const st = ensureState(world, id);
  st.points += points;
  const ser = mob.serial >>> 0;
  st.donors[ser] = (st.donors[ser] | 0) + points;
  // Tier crossing — caller dispatches the reward grant separately.
  let crossed = null;
  while (st.rewardedTiers < TIERS.length && st.points >= TIERS[st.rewardedTiers]) {
    crossed = TIERS[st.rewardedTiers++];
  }
  return { ok: true, points, total: st.points, crossed };
}

export function topDonors(world, id, n = 10) {
  const st = world?._communityCollections?.[id];
  if (!st) return [];
  return Object.entries(st.donors)
    .map(([s, p]) => ({ serial: Number(s), points: p }))
    .sort((a, b) => b.points - a.points)
    .slice(0, Math.max(1, n | 0));
}

export function status(world, id) {
  const c = COLLECTIONS[id]; if (!c) return null;
  const st = ensureState(world, id);
  const next = TIERS.find((t) => t > st.points) ?? null;
  return { id, label: c.label, total: st.points, nextTier: next, tiersAwarded: st.rewardedTiers };
}
