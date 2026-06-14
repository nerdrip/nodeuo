// Harvest Quotas — daily mining / lumberjacking ticket reward.
//
// ServUO `Engines/HarvestQuotas/` (community-mod variant). Each day a
// player mines or chops, the server tracks the count. Hitting a tier
// threshold (50 / 100 / 250 / 500 ore-or-log harvests) earns a "Quota
// Ticket" that the player can turn in for runic tools or skill scrolls.
//
// State is per-account on `account.harvestQuota = { day, mining, lumber,
// tickets }`. Day is the calendar day index (UTC); resetting when the
// day rolls over.
//
// API:
//   recordHarvest(account, kind, count)   bump count + maybe award ticket
//   awardTicket(account, tier)            (internal) bump tickets
//   ticketsOf(account)                    read current ticket pool
//   redeemTicket(account, reward)         consume + return spawn config

const TIERS = [
  { kind: 'mining',  threshold: 50,  ticket: 'bronze' },
  { kind: 'mining',  threshold: 100, ticket: 'silver' },
  { kind: 'mining',  threshold: 250, ticket: 'gold' },
  { kind: 'mining',  threshold: 500, ticket: 'platinum' },
  { kind: 'lumber',  threshold: 50,  ticket: 'bronze' },
  { kind: 'lumber',  threshold: 100, ticket: 'silver' },
  { kind: 'lumber',  threshold: 250, ticket: 'gold' },
  { kind: 'lumber',  threshold: 500, ticket: 'platinum' },
];

const TICKET_REWARDS = {
  bronze:   { name: 'Bronze Quota Ticket',   redeem: 'shadow-iron-tool' },
  silver:   { name: 'Silver Quota Ticket',   redeem: 'verite-tool' },
  gold:     { name: 'Gold Quota Ticket',     redeem: 'valorite-tool' },
  platinum: { name: 'Platinum Quota Ticket', redeem: 'powerscroll-110' },
};

const REDEEM_SPAWN = {
  'shadow-iron-tool':   { itemId: 0x13E3, hue: 0x966, name: 'shadow iron runic hammer' },
  'verite-tool':        { itemId: 0x13E3, hue: 0x96D, name: 'verite runic hammer' },
  'valorite-tool':      { itemId: 0x13E3, hue: 0x972, name: 'valorite runic hammer' },
  'powerscroll-110':    { itemId: 0x14EF, hue: 0x481, name: '+10 power scroll' },
};

function currentDay(now = Date.now()) {
  return Math.floor(now / 86_400_000);
}

function ensureState(account, now = Date.now()) {
  const today = currentDay(now);
  if (!account.harvestQuota || account.harvestQuota.day !== today) {
    account.harvestQuota = { day: today, mining: 0, lumber: 0, tickets: {} };
  }
  return account.harvestQuota;
}

/** Record a successful harvest swing. `kind` is 'mining' or 'lumber';
 *  `count` is typically 1 (per swing). Returns the array of new ticket
 *  keys awarded by this call (may be empty). */
export function recordHarvest(account, kind, count = 1, now = Date.now()) {
  if (!account || (kind !== 'mining' && kind !== 'lumber')) return [];
  const st = ensureState(account, now);
  const before = st[kind] | 0;
  st[kind] = before + (count | 0);
  const awarded = [];
  for (const t of TIERS) {
    if (t.kind !== kind) continue;
    if (before < t.threshold && st[kind] >= t.threshold) {
      st.tickets[t.ticket] = (st.tickets[t.ticket] | 0) + 1;
      awarded.push(t.ticket);
    }
  }
  return awarded;
}

export function ticketsOf(account) {
  if (!account?.harvestQuota?.tickets) return {};
  return { ...account.harvestQuota.tickets };
}

export function harvestCounts(account, now = Date.now()) {
  const st = ensureState(account, now);
  return { mining: st.mining | 0, lumber: st.lumber | 0 };
}

/** Redeem one ticket of the named tier. Returns `{ ok, reward? }`. */
export function redeemTicket(account, tier) {
  if (!account?.harvestQuota?.tickets) return { ok: false, reason: 'no-tickets' };
  const have = account.harvestQuota.tickets[tier] | 0;
  if (have <= 0) return { ok: false, reason: 'no-ticket-of-tier' };
  const meta = TICKET_REWARDS[tier];
  if (!meta) return { ok: false, reason: 'unknown-tier' };
  const reward = REDEEM_SPAWN[meta.redeem];
  if (!reward) return { ok: false, reason: 'no-spawn-config' };
  account.harvestQuota.tickets[tier] = have - 1;
  return { ok: true, reward, tier };
}

export const HARVEST_QUOTA_CONST = Object.freeze({
  TIERS, TICKET_REWARDS, REDEEM_SPAWN,
});
