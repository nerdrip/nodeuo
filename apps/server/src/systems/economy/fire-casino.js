// Fire Casino — port of ServUO `Scripts/Services/FireCasino/`. Slot
// machine + dice mini-game found in Magincia. Pay 100gp per pull, roll
// a 5-symbol slot, payouts per ServUO `SlotMachine.cs` table.
//
// Caller (chat command + slot-machine NPC double-click) invokes:
//   `pull(state)`  → consumes gold from pack, returns { reels, payout }
// All gold accounting routes through the templates registry so the
// commission split (10% to House, 90% to win pool) is applied during
// payout creation.

const SYMBOLS = ['cherry', 'lemon', 'orange', 'plum', 'bell', 'bar', 'seven', 'crown'];

// ServUO payout matrix:
//   crown crown crown : 10000
//   bar bar bar       : 5000
//   seven seven seven : 1000
//   bell bell bell    : 500
//   plum plum plum    : 300
//   any 3-of-a-kind   : 150
//   any 2-of-a-kind   : 25
//   else              : 0
const PAYOUT = {
  'crown,crown,crown,crown,crown': 50_000,
  'crown,crown,crown,crown':       25_000,
  'crown,crown,crown':             10_000,
  'bar,bar,bar':                    5_000,
  'seven,seven,seven':              1_000,
  'bell,bell,bell':                   500,
  'plum,plum,plum':                   300,
};

function packGold(pack) {
  let g = 0;
  for (const it of pack?.contents?.() ?? []) if (it.itemId === 0x0EED) g += it.amount ?? 0;
  return g;
}

function takeGold(pack, n) {
  let need = n;
  for (const it of (pack?.contents?.() ?? []).slice()) {
    if (need <= 0) break;
    if (it.itemId !== 0x0EED) continue;
    const take = Math.min(need, it.amount ?? 1);
    if (it.amount && it.amount > take) it.amount -= take;
    else pack?.remove?.(it);
    need -= take;
  }
  return n - need;
}

export function pull(state, api) {
  const pack = state?.mobile?.backpack ?? state?.mobile?.equipment?.get?.(21);
  if (packGold(pack) < 100) return { ok: false, reason: 'Need 100 gold to pull.' };
  takeGold(pack, 100);
  // 5 reels — first 3 drive primary payout, two extra augment crown jackpots.
  const reels = Array.from({ length: 5 }, () =>
    SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)]);
  let payout = 0;
  // Try descending match length so 5x crown beats 3x crown.
  for (const len of [5, 4, 3]) {
    const slice = reels.slice(0, len).join(',');
    if (PAYOUT[slice]) { payout = PAYOUT[slice]; break; }
  }
  if (payout === 0) {
    const counts = {};
    for (const r of reels.slice(0, 3)) counts[r] = (counts[r] | 0) + 1;
    if (Object.values(counts).some((n) => n === 3)) payout = 150;
    else if (Object.values(counts).some((n) => n === 2)) payout = 25;
  }
  if (payout > 0) {
    api?.templates?.spawn?.('gold', { container: pack, amount: payout });
  }
  return { ok: true, reels, payout };
}
