// Housing Lotto — port of ServUO `Scripts/Services/Housing Lotto/`.
// Some plots are flagged as lottery instead of first-come-first-serve.
// Players buy 1k-gp tickets during the open window, the system rolls
// a winner at close, the deed is awarded. ServUO uses a 7-day window;
// our shard collapses to 24h for faster iteration.
//
// State is kept on the world object (`world._lottos`) keyed by plot id.

const TICKET_COST = 1_000;
const ROUND_MS = 24 * 60 * 60 * 1000;

export function ensureRound(world, plotId, now = Date.now()) {
  world._lottos ??= {};
  if (!world._lottos[plotId] || world._lottos[plotId].closesAt < now) {
    world._lottos[plotId] = {
      plotId, opensAt: now, closesAt: now + ROUND_MS,
      tickets: [], winner: null,
    };
  }
  return world._lottos[plotId];
}

export function buyTicket(world, plotId, mob) {
  const round = ensureRound(world, plotId);
  if (round.winner) return { ok: false, reason: 'Round already drawn.' };
  const pack = mob?.backpack ?? mob?.equipment?.get?.(21);
  let g = 0; for (const it of pack?.contents?.() ?? []) if (it.itemId === 0x0EED) g += it.amount ?? 0;
  if (g < TICKET_COST) return { ok: false, reason: `Need ${TICKET_COST} gold.` };
  // Take gold.
  let need = TICKET_COST;
  for (const it of (pack?.contents?.() ?? []).slice()) {
    if (need <= 0) break;
    if (it.itemId !== 0x0EED) continue;
    const take = Math.min(need, it.amount ?? 1);
    if (it.amount && it.amount > take) it.amount -= take;
    else pack?.remove?.(it);
    need -= take;
  }
  round.tickets.push({ serial: mob.serial, name: mob.name ?? 'player', ts: Date.now() });
  return { ok: true, ticketCount: round.tickets.length };
}

export function drawWinner(world, plotId, now = Date.now()) {
  const round = world?._lottos?.[plotId];
  if (!round) return null;
  if (round.winner) return round.winner;
  if (now < round.closesAt) return null;
  if (round.tickets.length === 0) return null;
  const w = round.tickets[Math.floor(Math.random() * round.tickets.length)];
  round.winner = w;
  return w;
}

export function status(world, plotId, now = Date.now()) {
  const round = ensureRound(world, plotId, now);
  return {
    plotId, tickets: round.tickets.length,
    closesAt: round.closesAt, winner: round.winner,
    msUntilClose: Math.max(0, round.closesAt - now),
  };
}
