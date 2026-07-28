// Daily login reward — port of ServUO `LoginStats` daily-gift pattern.
// First login of a UTC day grants the player a scaled gift; consecutive
// daily logins (no gaps) bump a `dailyStreak` counter that the gift
// table scales by. Streak resets on any 36h+ gap.
//
// State lives on the account: `account.lastDailyAt` (epoch ms),
// `account.dailyStreak` (int). Accounts.json round-trips both fields
// already (they're plain primitive props on Account).

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_STREAK_BONUS = 30;          // diminishing returns at 30 days

/** Gift table — keyed by `streak % 7` (per-weekday rotation, ServUO
 *  `DailyLoginRewards.cs` style). Each entry has a `grant(world, mob)`
 *  that creates+drops the reward item into the player's backpack. */
const GIFTS = [
  { key: 'gold',         label: 'a small purse of gold' },
  { key: 'bandage',      label: 'a stack of bandages' },
  { key: 'reagent',      label: 'a sampler of reagents' },
  { key: 'gem',          label: 'a polished gem' },
  { key: 'scroll',       label: 'a random magic scroll' },
  { key: 'powerhour',    label: 'a Power Hour scroll' },
  { key: 'ankh-deed',    label: 'a deed for a small ankh' },
];

/** Pick the gift slot for a given streak. */
function pickGift(streak) {
  const idx = ((streak - 1) % GIFTS.length + GIFTS.length) % GIFTS.length;
  return GIFTS[idx];
}

/** Returns the player's backpack item or null. */
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

function createRewardItem(world, data) {
  if (typeof world?.createItem === 'function') return world.createItem(data);
  if (typeof world?.items?.create === 'function') return world.items.create(data);
  return null;
}

/** Default item factories — overridable via opts (so the script-side
 *  registry can plug in canonical createItem definitions). */
function defaultGrant(world, mob, pack, gift, streak) {
  const bonus = Math.min(streak, MAX_STREAK_BONUS);
  switch (gift.key) {
    case 'gold': {
      const amount = 500 + bonus * 50;
      return !!createRewardItem(world, { itemId: 0x0EED, name: 'gold coins', amount, parent: pack.serial });
    }
    case 'bandage': {
      return !!createRewardItem(world, { itemId: 0x0E21, name: 'bandage', amount: 10 + bonus, parent: pack.serial });
    }
    case 'reagent': {
      const reagents = [0x0F7A, 0x0F7B, 0x0F84, 0x0F86, 0x0F88, 0x0F8C, 0x0F8D, 0x0F8E];
      for (const id of reagents) {
        if (!createRewardItem(world, { itemId: id, name: 'reagent', amount: 5 + Math.floor(bonus / 4), parent: pack.serial })) return false;
      }
      return true;
    }
    case 'gem': {
      const gems = [0x0F0F, 0x0F11, 0x0F15, 0x0F16, 0x0F19, 0x0F25, 0x0F26];
      const id = gems[Math.floor(Math.random() * gems.length)];
      return !!createRewardItem(world, { itemId: id, name: 'gem', amount: 1 + Math.floor(bonus / 7), parent: pack.serial });
    }
    case 'scroll': {
      const scrollId = 0x1F2D + Math.floor(Math.random() * 64);
      return !!createRewardItem(world, { itemId: scrollId, name: 'magic scroll', parent: pack.serial });
    }
    case 'powerhour': {
      return !!createRewardItem(world, {
        itemId: 0x14F0, name: 'a Power Hour scroll', parent: pack.serial,
        script: 'power-hour-scroll', powerHour: 60 * 60 * 1000,
      });
    }
    case 'ankh-deed': {
      return !!createRewardItem(world, {
        itemId: 0x14F0, name: 'a small ankh deed', parent: pack.serial,
        script: 'addon-deed', addonName: 'stone-ankh',
      });
    }
    default: return false;
  }
}

/**
 * Check and grant daily reward for `mob`'s account. Call this once per
 * successful login (post `bringIntoWorld`). Returns the gift info
 * (`{ gift, streak, granted: true }`) or null if not yet eligible.
 *
 * Idempotent within the same UTC day — won't re-grant on relog.
 */
export function checkAndGrantDailyReward(world, mob, account, opts = {}) {
  if (!account || !mob) return null;
  const now = Date.now();
  const last = Number(account.lastDailyAt) || 0;
  // Same UTC day → already claimed.
  if (last > 0) {
    const lastDay = Math.floor(last / DAY_MS);
    const nowDay  = Math.floor(now  / DAY_MS);
    if (lastDay === nowDay) return null;
  }
  // Compute streak: gap ≤ 36h keeps the streak alive; longer gap resets.
  let streak = Number(account.dailyStreak) || 0;
  if (last > 0 && (now - last) > (DAY_MS + 12 * 60 * 60 * 1000)) streak = 0;
  streak += 1;

  const pack = findPack(world, mob);
  if (!pack) return null;
  const gift = pickGift(streak);
  const grant = opts.grant ?? defaultGrant;
  const granted = grant(world, mob, pack, gift, streak);
  if (!granted) return null;

  account.lastDailyAt = now;
  account.dailyStreak = streak;
  mob.client?.sendSystemMessage?.(
    `Daily login reward (day ${streak}): ${gift.label}.`,
  );
  return { gift, streak, granted: true };
}

export const DAILY_GIFTS = Object.freeze(GIFTS);
