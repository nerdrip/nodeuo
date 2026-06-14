// Huntmaster Challenge — port of ServUO
// `Scripts/Services/HuntmasterChallenge/`. A weekly rotating contest
// where players turn in trophy heads of designated creatures for fame
// + a leaderboard slot. ServUO computes the trophy from the creature's
// `Hits + Stam + Mana + base damage` and rewards the highest scorer
// each week.
//
// We expose:
//   - `currentTarget()`            → the rotation target this week
//   - `submitTrophy(state, mob, item)` → score the kill, record entry
//   - `top(n=10)`                  → leaderboard slice
//
// Persistence is via `_huntmasterEntries` on world state (saved by the
// existing world.persistence module).

// 12-week rotation. Mirrors ServUO `Configuration` tier list (one
// trophy per Tier 1..12). Each kind matches a `monsters.json` entry
// our spawner can produce.
const ROTATION = [
  { kind: 'troll',         name: 'Troll Hunt',          tier: 1, rewardItem: { itemId: 0x1854, hue: 0x44, name: 'troll-head trophy' } },
  { kind: 'ogrelord',      name: 'Ogre Lord Hunt',      tier: 2, rewardItem: { itemId: 0x1855, hue: 0x60, name: 'ogre-lord trophy' } },
  { kind: 'lich',          name: 'Lich Hunt',           tier: 3, rewardItem: { itemId: 0x1854, hue: 0x47D, name: 'lich-skull trophy' } },
  { kind: 'cyclops',       name: 'Cyclopean Hunt',      tier: 4, rewardItem: { itemId: 0x1854, hue: 0x21, name: 'cyclops-eye trophy' } },
  { kind: 'liche',         name: 'Lich Lord Hunt',      tier: 5, rewardItem: { itemId: 0x1854, hue: 0x47D, name: 'lich-lord skull' } },
  { kind: 'titan',         name: 'Titan Hunt',          tier: 6, rewardItem: { itemId: 0x1855, hue: 0x4F4, name: 'titan-fist trophy' } },
  { kind: 'wyvern',        name: 'Wyvern Hunt',         tier: 7, rewardItem: { itemId: 0x1854, hue: 0x44, name: 'wyvern-talon trophy' } },
  { kind: 'dragon',        name: 'Dragon Hunt',         tier: 8, rewardItem: { itemId: 0x1855, hue: 0x44, name: 'dragon-scale trophy' } },
  { kind: 'demon',         name: 'Demon Hunt',          tier: 9, rewardItem: { itemId: 0x1854, hue: 0x47D, name: 'demon-horn trophy' } },
  { kind: 'silver-serpent',name: 'Silver Serpent Hunt', tier:10, rewardItem: { itemId: 0x1855, hue: 0x47E, name: 'silver-fang trophy' } },
  { kind: 'AncientWyrm',   name: 'Ancient Wyrm Hunt',   tier:11, rewardItem: { itemId: 0x1855, hue: 0x4F4, name: 'ancient wyrm scale' } },
  { kind: 'AbyssalInfernal',name:'Abyssal Hunt',         tier:12, rewardItem: { itemId: 0x1855, hue: 0x44, name: 'abyssal heart trophy' } },
];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const EPOCH = Date.UTC(2026, 0, 1);

export function currentTarget(now = Date.now()) {
  const week = Math.floor((now - EPOCH) / WEEK_MS);
  return ROTATION[((week % ROTATION.length) + ROTATION.length) % ROTATION.length];
}

export function scoreFor(creature) {
  if (!creature) return 0;
  const hp   = creature.hpMax ?? creature.hp ?? 0;
  const stam = creature.stamMax ?? creature.stam ?? 0;
  const mana = creature.manaMax ?? creature.mana ?? 0;
  const dmg  = creature.minDamage ?? 5;
  return ((hp | 0) + (stam | 0) + (mana | 0) + ((dmg * 5) | 0)) | 0;
}

/** Server side: called from corpse/loot generation when a kill matches
 *  the rotation target. Stores a single-best entry per player. */
export function submitTrophy(world, mob, creature, now = Date.now()) {
  if (!world || !mob || !creature) return null;
  const tgt = currentTarget(now);
  if (creature.kind !== tgt.kind) return null;
  const score = scoreFor(creature);
  if (score <= 0) return null;
  if (!world._huntmasterEntries) world._huntmasterEntries = [];
  const week = Math.floor((now - EPOCH) / WEEK_MS);
  // Prune stale entries (more than 4 weeks old) so the leaderboard stays current.
  world._huntmasterEntries = world._huntmasterEntries.filter((e) => week - e.week < 4);
  const existing = world._huntmasterEntries.find(
    (e) => e.week === week && e.serial === mob.serial,
  );
  if (existing) {
    if (score > existing.score) existing.score = score;
    return existing;
  }
  const entry = {
    week, serial: mob.serial, name: mob.name ?? 'Adventurer',
    score, target: tgt.kind, ts: now,
  };
  world._huntmasterEntries.push(entry);
  return entry;
}

export function top(world, n = 10, now = Date.now()) {
  if (!world?._huntmasterEntries) return [];
  const week = Math.floor((now - EPOCH) / WEEK_MS);
  return world._huntmasterEntries
    .filter((e) => e.week === week)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, n | 0));
}

/** All-time leaderboard across the kept window (4 weeks). */
export function topAllTime(world, n = 10) {
  if (!world?._huntmasterEntries) return [];
  return [...world._huntmasterEntries]
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, n | 0));
}

/** Reward bundle for the weekly winner. Caller spawns the item. */
export function weeklyReward(now = Date.now()) {
  return currentTarget(now)?.rewardItem ?? null;
}

/** End-of-week settlement: pick the top entry, return the reward
 *  metadata + winner so the caller can spawn the trophy and grant
 *  fame. Idempotent — flips the entry's `paidOut` flag.
 */
export function settleWeek(world, week, now = Date.now()) {
  if (!world?._huntmasterEntries) return null;
  const eligible = world._huntmasterEntries
    .filter((e) => e.week === week && !e.paidOut)
    .sort((a, b) => b.score - a.score);
  if (!eligible.length) return null;
  const winner = eligible[0];
  winner.paidOut = true;
  return { winner, reward: weeklyReward(now), tier: ROTATION.find((r) => r.kind === winner.target)?.tier };
}

export const HM_CONST = Object.freeze({ ROTATION, WEEK_MS, EPOCH });
