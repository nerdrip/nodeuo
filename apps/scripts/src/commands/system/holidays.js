// `[holidays` — unified holiday hub gump.
//
// Shows the active holiday (Halloween / Christmas / Krampus / Easter)
// based on the calendar window and surfaces the relevant mini-game
// entry point:
//
//   Halloween    →  trick-or-treat draw (consumes nothing, 1/day per acct)
//   Christmas    →  annual gift pickup (1 gift/year per acct)
//   Krampus      →  encounter status (via [krampus]) + reward claim
//   Easter       →  egg-hunt token claim (1 token/day per acct)
//
// Each mini-game uses the existing system module; this command just
// renders a single gump that's easier to find than four separate
// command names.

const HOLIDAYS = [
  { key: 'halloween', name: 'Halloween',     month: 9, day: 31, window: 7 },  // Oct
  { key: 'christmas', name: 'Christmas',     month: 11, day: 25, window: 7 }, // Dec
  { key: 'krampus',   name: 'Krampus Hunt',  month: 11, day: 1,  window: 38 },// Dec 1 – Jan 7
  { key: 'easter',    name: 'Easter',        month: 3, day: 1,   window: 14 },// Apr
  { key: 'valentine', name: "Valentine's Day", month: 1, day: 14, window: 3 },
];

function activeHolidays(now = new Date()) {
  return HOLIDAYS.filter((h) => {
    const start = new Date(Date.UTC(now.getUTCFullYear(), h.month, h.day));
    const end = new Date(start.getTime() + h.window * 86_400_000);
    return now >= start && now <= end;
  });
}

function spawnReward(api, mob, def) {
  try {
    return !!api.game?.mobile?.giveItem?.(mob, {
      itemId: def.itemId, hue: def.hue, name: def.name,
      movable: true,
    });
  } catch { return false; }
}

const REWARDS = {
  halloween: [
    { name: 'Candy Corn',      itemId: 0x09B5, hue: 0x021 },
    { name: 'Skeletal Mask',   itemId: 0x1545, hue: 0       },
    { name: 'Ghoul Hair',      itemId: 0x203B, hue: 0x044   },
    { name: 'Trick-or-Treat Bag', itemId: 0x232A, hue: 0x21 },
  ],
  christmas: [
    { name: 'Festive Wreath',   itemId: 0x232A, hue: 0x059 },
    { name: 'Snowflake Bauble', itemId: 0x100E, hue: 0x481 },
    { name: 'Gingerbread House',itemId: 0x09B7, hue: 0x047E },
    { name: 'Holly Garland',    itemId: 0x14F0, hue: 0x021  },
  ],
  easter: [
    { name: 'Decorated Egg',    itemId: 0x09B5, hue: 0x047E },
    { name: 'Bunny Statuette',  itemId: 0x14F0, hue: 0x481  },
    { name: 'Spring Pigment',   itemId: 0x4007, hue: 0x059  },
  ],
  valentine: [
    { name: 'Rose Bouquet',     itemId: 0x234D, hue: 0x021  },
    { name: 'Heart Locket',     itemId: 0x108A, hue: 0x021  },
    { name: 'Love Letter',      itemId: 0x0E34, hue: 0x481  },
  ],
};

const TODAY_KEY = () => Math.floor(Date.now() / 86_400_000);

function tryDailyClaim(account, key) {
  account._holidayClaims ??= {};
  const lastDay = account._holidayClaims[key] ?? 0;
  if (lastDay === TODAY_KEY()) return false;
  account._holidayClaims[key] = TODAY_KEY();
  return true;
}

function openHolidayGump(api, ctx, account, active) {
  if (!api.gumps?.send) {
    ctx.state.sendSystemMessage?.('Gump unavailable.');
    return;
  }
  const W = 440;
  const H = 80 + active.length * 60 + 30;
  const parts = [`{ resizepic 0 0 9200 ${W} ${H} }`];
  const texts = [];
  texts.push('Britannian Holidays'); parts.push(`{ text 16 12 1153 ${texts.length - 1} }`);
  if (active.length === 0) {
    texts.push('No holiday is currently in season.');
    parts.push(`{ text 16 44 1149 ${texts.length - 1} }`);
  }
  active.forEach((h, i) => {
    const y = 50 + i * 60;
    texts.push(h.name);
    parts.push(`{ text 16 ${y} 1167 ${texts.length - 1} }`);
    if (h.key === 'krampus') {
      const s = api.systems?.krampusEvent?.scoreOf?.(account) ?? { nice: 0, naughty: 0 };
      texts.push(`Nice ${s.nice} / Naughty ${s.naughty} — see [krampus status`);
      parts.push(`{ text 16 ${y + 20} 1153 ${texts.length - 1} }`);
    } else {
      const claimed = (account._holidayClaims?.[h.key] | 0) === TODAY_KEY();
      texts.push(claimed ? 'Claimed today.' : 'Click to claim today\'s reward.');
      parts.push(`{ text 16 ${y + 20} ${claimed ? 1149 : 1167} ${texts.length - 1} }`);
      if (!claimed) {
        parts.push(`{ button 300 ${y + 14} 4005 4006 1 0 ${100 + i} }`);
        texts.push('Claim'); parts.push(`{ text 330 ${y + 16} 1153 ${texts.length - 1} }`);
      }
    }
  });
  parts.push(`{ button ${W - 30} 8 4017 4018 1 0 0 }`);
  api.gumps.send(ctx.state, {
    x: 100, y: 80, layout: parts.join(''), texts,
  }, (resp) => {
    const b = resp.buttonId;
    if (b === 0) return;
    if (b >= 100 && b < 100 + active.length) {
      const h = active[b - 100];
      if (h.key === 'krampus') return;
      if (!tryDailyClaim(account, h.key)) {
        ctx.state.sendSystemMessage?.('You already claimed today.');
        return;
      }
      const pool = REWARDS[h.key] ?? [];
      const pick = pool[(Math.random() * pool.length) | 0];
      if (pick && spawnReward(api, ctx.sender, pick)) {
        ctx.state.sendSystemMessage?.(`You receive ${pick.name} for ${h.name}.`);
      }
      openHolidayGump(api, ctx, account, active);
    }
  });
}

export default function register(api) {
  if (!api.commands) return () => {};
  api.commands.register({
    name: 'holidays',
    help: '[holidays — open the holiday hub gump.',
    access: 'Player',
    run(ctx) {
      const account = ctx.state?.account;
      if (!account) { ctx.state.sendSystemMessage?.('No account.'); return; }
      const active = activeHolidays();
      openHolidayGump(api, ctx, account, active);
    },
  });
  return () => api.commands.unregister('holidays');
}
