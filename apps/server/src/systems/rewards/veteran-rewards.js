// Veteran Rewards — accrual + redeemable items based on account age.
// Mirrors ServUO `Engines/VeteranRewards/` (Definitions + Rewards + Gump).
//
// Account age is tracked in real-time months on the account record. At
// each month threshold the account earns one "reward credit". Players
// redeem credits at a Davies Locker / Reward Stone / via `[claimreward`
// command for a tier-appropriate item.
//
// Tiers (months → max-tier choosable):
//    1 → Tier 1   (mounts + small house deeds)
//   12 → Tier 2   (etheral horse, ringmail dye)
//   24 → Tier 3   (mythic title deed, 16x18 house)
//   36 → Tier 4   (special ethereal mounts, 18x18 house)
//   48 → Tier 5   (artifact-grade decoration)
//   60 → Tier 6   (legendary etheral dragon, ankh, etc.)
//   84 → Tier 7   (rare commemorative / event-specific)
//
// Reward credits are stored on the account: `account.veteran = { credits, redeemed[] }`.
// `redeemed[]` is the list of named rewards already claimed (some are
// once-per-account, others stackable).

const TIER_THRESHOLDS_MONTHS = [0, 1, 12, 24, 36, 48, 60, 84];
const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;

function accountCreationTime(account, now = Date.now()) {
  const raw = account?.createdAt ?? account?.created;
  const value = typeof raw === 'number' ? raw : Date.parse(raw ?? '');
  return Number.isFinite(value) ? value : now;
}

const REWARDS_BY_TIER = {
  // Tier 1 (1+ months) — basic dyes, deeds, common mounts
  1: [
    'horse-dye-tub', 'small-bed-deed', 'mounted-orc-deed',
    'leather-dye-tub', 'reward-cloak', 'reward-robe',
    'pillow-deed', 'tapestry-deed-east', 'tapestry-deed-south',
    'davies-locker-deed', 'rocking-chair-deed', 'fountain-deed',
  ],
  // Tier 2 (12+ months) — first ethereal mounts, more cosmetics
  2: [
    'ethereal-horse', 'ringmail-dye-tub', 'mortar-pestle-bedlam',
    'ethereal-llama', 'crystal-ball-pet-stat', 'practice-target',
    'banner-deed-britain', 'banner-deed-trinsic', 'banner-deed-magincia',
    'flamistar-flag', 'crystal-ball-knowledge',
  ],
  // Tier 3 (24+ months) — house upgrades + soulstones
  3: [
    'mythic-title-deed', '16x18-house-deed', 'soulstone-fragment',
    'soulstone-fragment-1', 'soulstone-fragment-2',
    'cannon-flask', 'aquarium', 'mining-cart',
    'davies-locker', 'reward-pet-trainer-deed',
  ],
  // Tier 4 (36+ months) — special ethereals
  4: [
    'ethereal-ostard', '18x18-house-deed', 'soulstone',
    'ethereal-zostrich', 'ethereal-kirin', 'ethereal-unicorn',
    'monster-statue-balron', 'monster-statue-dragon',
    'reward-stable-deed', 'reward-music-box',
  ],
  // Tier 5 (48+ months) — high-tier deco + locker
  5: [
    'ethereal-ridgeback', 'davies-locker-rare', 'rare-statue-collection',
    'rare-pirate-painting', 'rare-vampire-painting',
    'commemorative-cushion', 'reward-throne',
  ],
  // Tier 6 (60+ months) — legendary mounts + ankhs
  6: [
    'ethereal-dragon', 'ankh-pendant', 'commemorative-shroud',
    'ethereal-cu-sidhe', 'ethereal-hiryu',
    'reward-pavilion-deed', 'reward-castle-banner-set',
  ],
  // Tier 7 (84+ months) — rarest commemorative tier
  7: [
    'ethereal-reptalon', 'commemorative-banner', 'crystal-event-artifact',
    'reward-statue-of-charity', 'reward-statue-of-spirituality',
    'reward-statue-of-honor', 'reward-statue-of-justice',
    'reward-statue-of-valor', 'reward-statue-of-honesty',
    'reward-statue-of-compassion', 'reward-statue-of-humility',
  ],
};

// Concrete item spawn config per reward name. Caller (claim command) reads
// this to call `world.createItem` with the right `itemId/hue/movable`.
const REWARD_ITEM_SPAWN = {
  // Dye tubs
  'horse-dye-tub':         { itemId: 0x0FAB, hue: 0,     name: 'horse dye tub',     deed: false },
  'leather-dye-tub':       { itemId: 0x0FAB, hue: 0x1F0, name: 'leather dye tub' },
  'ringmail-dye-tub':      { itemId: 0x0FAB, hue: 0x21,  name: 'ringmail dye tub' },

  // Cloaks / robes
  'reward-cloak':          { itemId: 0x1515, hue: 0x47E, name: 'reward cloak' },
  'reward-robe':           { itemId: 0x1F03, hue: 0x47E, name: 'reward robe' },
  'commemorative-shroud':  { itemId: 0x1F03, hue: 0x4A6, name: 'commemorative shroud' },
  'commemorative-cushion': { itemId: 0x152E, hue: 0x4A6, name: 'commemorative cushion' },

  // Deeds (one-time use → spawn small "deed" item; admin handles place)
  'small-bed-deed':        { itemId: 0x14F0, hue: 0,     name: 'small bed deed',     deed: true },
  '16x18-house-deed':      { itemId: 0x14F0, hue: 0x47E, name: '16x18 house deed',   deed: true },
  '18x18-house-deed':      { itemId: 0x14F0, hue: 0x481, name: '18x18 house deed',   deed: true },
  'pillow-deed':           { itemId: 0x14F0, hue: 0x60,  name: 'pillow deed',        deed: true },
  'tapestry-deed-east':    { itemId: 0x14F0, hue: 0x501, name: 'tapestry (east)',    deed: true },
  'tapestry-deed-south':   { itemId: 0x14F0, hue: 0x501, name: 'tapestry (south)',   deed: true },
  'davies-locker-deed':    { itemId: 0x14F0, hue: 0x47E, name: 'davies locker deed', deed: true },
  'rocking-chair-deed':    { itemId: 0x14F0, hue: 0x21,  name: 'rocking chair deed', deed: true },
  'fountain-deed':         { itemId: 0x14F0, hue: 0x44,  name: 'fountain deed',      deed: true },
  'banner-deed-britain':   { itemId: 0x14F0, hue: 0x1A,  name: 'banner deed (Britain)', deed: true },
  'banner-deed-trinsic':   { itemId: 0x14F0, hue: 0x21,  name: 'banner deed (Trinsic)', deed: true },
  'banner-deed-magincia':  { itemId: 0x14F0, hue: 0x60,  name: 'banner deed (Magincia)',deed: true },
  'reward-stable-deed':    { itemId: 0x14F0, hue: 0x6,   name: 'stable master deed', deed: true },
  'reward-pavilion-deed':  { itemId: 0x14F0, hue: 0x4F4, name: 'pavilion deed',      deed: true },
  'reward-castle-banner-set': { itemId: 0x14F0, hue: 0x47E, name: 'castle banner set', deed: true },
  'mounted-orc-deed':      { itemId: 0x14F0, hue: 0x21,  name: 'mounted orc head deed', deed: true },
  'reward-pet-trainer-deed': { itemId: 0x14F0, hue: 0x44F, name: 'pet trainer deed', deed: true },

  // Ethereal mounts (statuettes that double-click → mount)
  'ethereal-horse':        { itemId: 0x20DD, hue: 0,     name: 'ethereal horse statuette',    mount: 'horse' },
  'ethereal-llama':        { itemId: 0x20F6, hue: 0,     name: 'ethereal llama statuette',    mount: 'llama' },
  'ethereal-ostard':       { itemId: 0x2135, hue: 0,     name: 'ethereal ostard statuette',   mount: 'ostard' },
  'ethereal-zostrich':     { itemId: 0x2135, hue: 0x4F4, name: 'ethereal zostrich statuette', mount: 'zostrich' },
  'ethereal-kirin':        { itemId: 0x20EA, hue: 0,     name: 'ethereal kirin statuette',    mount: 'kirin' },
  'ethereal-unicorn':      { itemId: 0x20F0, hue: 0,     name: 'ethereal unicorn statuette',  mount: 'unicorn' },
  'ethereal-ridgeback':    { itemId: 0x2D9F, hue: 0,     name: 'ethereal ridgeback statuette',mount: 'ridgeback' },
  'ethereal-dragon':       { itemId: 0x20F0, hue: 0x44,  name: 'ethereal dragon statuette',   mount: 'dragon' },
  'ethereal-cu-sidhe':     { itemId: 0x2D96, hue: 0x47E, name: 'ethereal cu sidhe statuette', mount: 'cu-sidhe' },
  'ethereal-hiryu':        { itemId: 0x276A, hue: 0,     name: 'ethereal hiryu statuette',    mount: 'hiryu' },
  'ethereal-reptalon':     { itemId: 0x2D9C, hue: 0x4F2, name: 'ethereal reptalon statuette', mount: 'reptalon' },

  // Soulstones (capacity-different fragments)
  'soulstone-fragment':    { itemId: 0x2A93, hue: 0,     name: 'soulstone fragment', charges: 1 },
  'soulstone-fragment-1':  { itemId: 0x2A93, hue: 0x21,  name: 'soulstone fragment', charges: 2 },
  'soulstone-fragment-2':  { itemId: 0x2A93, hue: 0x47E, name: 'soulstone fragment', charges: 3 },
  'soulstone':             { itemId: 0x2A94, hue: 0,     name: 'soulstone',          charges: 99 },

  // Title / pet
  'mythic-title-deed':     { itemId: 0x14F0, hue: 0x47E, name: 'mythic title deed' },
  'mortar-pestle-bedlam':  { itemId: 0x0E9B, hue: 0x44,  name: 'bedlam mortar' },

  // Tier 5+ rares
  'davies-locker':         { itemId: 0x4B5A, hue: 0x47E, name: 'davies locker' },
  'davies-locker-rare':    { itemId: 0x4B5A, hue: 0x4F4, name: 'davies locker (rare)' },
  'rare-statue-collection':{ itemId: 0x14F0, hue: 0x501, name: 'rare statue collection' },
  'rare-pirate-painting':  { itemId: 0x14F0, hue: 0x44,  name: 'rare pirate painting' },
  'rare-vampire-painting': { itemId: 0x14F0, hue: 0x47D, name: 'rare vampire painting' },
  'reward-throne':         { itemId: 0x14F0, hue: 0x60,  name: 'reward throne' },
  'monster-statue-balron': { itemId: 0x14F0, hue: 0x44,  name: 'balron monster statue' },
  'monster-statue-dragon': { itemId: 0x14F0, hue: 0x481, name: 'dragon monster statue' },
  'reward-music-box':      { itemId: 0x4B27, hue: 0x47E, name: 'reward music box' },
  'crystal-ball-pet-stat': { itemId: 0x468B, hue: 0x4F4, name: 'pet stat crystal ball' },
  'crystal-ball-knowledge':{ itemId: 0x468B, hue: 0x481, name: 'knowledge crystal ball' },
  'practice-target':       { itemId: 0x232C, hue: 0,     name: 'practice target' },
  'mining-cart':           { itemId: 0x46DC, hue: 0,     name: 'mining cart' },
  'aquarium':              { itemId: 0x3062, hue: 0,     name: 'aquarium' },
  'cannon-flask':          { itemId: 0x232C, hue: 0x44,  name: 'cannon powder flask' },
  'flamistar-flag':        { itemId: 0x14F0, hue: 0x44,  name: 'flamistar flag' },

  // Tier 7 commemorative
  'commemorative-banner':       { itemId: 0x14F0, hue: 0x47E, name: 'commemorative banner' },
  'crystal-event-artifact':     { itemId: 0x14F0, hue: 0x4F4, name: 'crystal event artifact' },
  'ankh-pendant':               { itemId: 0x1086, hue: 0x47E, name: 'ankh pendant' },
  'reward-statue-of-charity':       { itemId: 0x14F0, hue: 0x47E, name: 'statue of charity' },
  'reward-statue-of-spirituality':  { itemId: 0x14F0, hue: 0x481, name: 'statue of spirituality' },
  'reward-statue-of-honor':         { itemId: 0x14F0, hue: 0x4F4, name: 'statue of honor' },
  'reward-statue-of-justice':       { itemId: 0x14F0, hue: 0x47D, name: 'statue of justice' },
  'reward-statue-of-valor':         { itemId: 0x14F0, hue: 0x4FA, name: 'statue of valor' },
  'reward-statue-of-honesty':       { itemId: 0x14F0, hue: 0x47E, name: 'statue of honesty' },
  'reward-statue-of-compassion':    { itemId: 0x14F0, hue: 0x47E, name: 'statue of compassion' },
  'reward-statue-of-humility':      { itemId: 0x14F0, hue: 0x47E, name: 'statue of humility' },
};

/** Lookup: spawn config for a redeemed reward (or null when unknown). */
export function spawnConfig(rewardName) {
  return REWARD_ITEM_SPAWN[rewardName] ?? null;
}

/** Compute current tier from account age in ms. */
export function tierFromAge(ageMs) {
  const months = Math.floor(ageMs / MS_PER_MONTH);
  let tier = 0;
  for (let i = TIER_THRESHOLDS_MONTHS.length - 1; i >= 0; i--) {
    if (months >= TIER_THRESHOLDS_MONTHS[i]) { tier = i; break; }
  }
  return tier;
}

export function tierForAccount(account, now = Date.now()) {
  return tierFromAge(Math.max(0, now - accountCreationTime(account, now)));
}

/** How many reward credits this account has earned in total (lifetime). */
export function lifetimeCredits(account, now = Date.now()) {
  const created = accountCreationTime(account, now);
  const age = Math.max(0, now - created);
  const months = Math.floor(age / MS_PER_MONTH);
  // 1 credit per qualifying anniversary month: 1, 12, 24, 36, 48, 60, 84.
  let credits = 0;
  for (const t of TIER_THRESHOLDS_MONTHS) {
    if (t === 0) continue;
    if (months >= t) credits++;
  }
  return credits;
}

/** Available (unclaimed) credits — lifetime minus already-redeemed. */
export function availableCredits(account, now = Date.now()) {
  const lifetime = lifetimeCredits(account, now);
  const used = account?.veteran?.redeemed?.length ?? 0;
  return Math.max(0, lifetime - used);
}

/** All reward names this account is eligible to choose. */
export function eligibleRewards(account, now = Date.now()) {
  const tier = tierForAccount(account, now);
  const out = [];
  for (let t = 1; t <= tier; t++) out.push(...(REWARDS_BY_TIER[t] ?? []));
  return out;
}

/**
 * Redeem one credit for a named reward. Returns:
 *   { ok:true, reward:'name' }
 *   { ok:false, reason:'not-eligible' | 'no-credits' | 'already-redeemed' }
 *
 * Stackable rewards (mounts, dye tubs) may be claimed multiple times if
 * credits are available; one-shot rewards (titles, locker) check redeemed[].
 */
const ONE_SHOT_REWARDS = new Set([
  'mythic-title-deed', 'davies-locker', 'soulstone',
  'soulstone-fragment', 'ankh-pendant',
]);

export function redeem(account, rewardName, now = Date.now()) {
  if (!account) return { ok: false, reason: 'no-account' };
  account.veteran ??= { redeemed: [] };
  if (availableCredits(account, now) <= 0) return { ok: false, reason: 'no-credits' };
  const eligible = eligibleRewards(account, now);
  if (!eligible.includes(rewardName)) return { ok: false, reason: 'not-eligible' };
  if (ONE_SHOT_REWARDS.has(rewardName) && account.veteran.redeemed.includes(rewardName)) {
    return { ok: false, reason: 'already-redeemed' };
  }
  account.veteran.redeemed.push(rewardName);
  return { ok: true, reward: rewardName };
}

/** Roll back a credit reservation when item delivery fails. */
export function rollbackRedemption(account, rewardName) {
  const redeemed = account?.veteran?.redeemed;
  if (!Array.isArray(redeemed)) return false;
  const index = redeemed.lastIndexOf(rewardName);
  if (index < 0) return false;
  redeemed.splice(index, 1);
  return true;
}

export const VETERAN_CONST = Object.freeze({
  TIER_THRESHOLDS_MONTHS, REWARDS_BY_TIER, MS_PER_MONTH, ONE_SHOT_REWARDS,
});
