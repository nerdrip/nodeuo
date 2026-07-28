// `[loyalty` — show your city loyalty status. `[loyalty join <city>` to
// declare citizenship, `[loyalty leave` to renounce, `[loyaltyaward
// <player> <city> <amount>` (GM) to grant points.
//
// Adds `[loyalty gump` — Renaissance-style City Loyalty UI showing all
// 8 cities, current points + tier, citizen badge, and a "Declare /
// Renounce" button per row.

const ALL_CITIES = [
  'Britain', 'Jhelom', 'Magincia', 'Minoc',
  'Moonglow', 'Trinsic', 'Vesper', 'Yew',
];

function openLoyaltyGump(api, ctx, account) {
  if (!api.gumps?.send) {
    ctx.state.sendSystemMessage?.('Gump system unavailable — use [loyalty status instead.');
    return;
  }
  const cityLoyalty = api.cityLoyalty;
  const W = 460;
  const H = 110 + ALL_CITIES.length * 28 + 30;
  const parts = [`{ resizepic 0 0 9200 ${W} ${H} }`];
  const texts = [];
  texts.push('City Loyalty');
  parts.push(`{ text 16 12 1153 ${texts.length - 1} }`);
  texts.push(`Account: ${account}`);
  parts.push(`{ text 16 32 1149 ${texts.length - 1} }`);
  // Headers
  texts.push('City');     parts.push(`{ text 30  60 1149 ${texts.length - 1} }`);
  texts.push('Points');   parts.push(`{ text 130 60 1149 ${texts.length - 1} }`);
  texts.push('Tier');     parts.push(`{ text 200 60 1149 ${texts.length - 1} }`);
  texts.push('Action');   parts.push(`{ text 340 60 1149 ${texts.length - 1} }`);

  ALL_CITIES.forEach((city, i) => {
    const y = 84 + i * 28;
    const s = cityLoyalty.status(account, city);
    texts.push(s.citizen ? `${city} ★` : city);
    parts.push(`{ text 30 ${y + 2} ${s.citizen ? 1167 : 1153} ${texts.length - 1} }`);
    texts.push(String(s.points));
    parts.push(`{ text 130 ${y + 2} 1153 ${texts.length - 1} }`);
    texts.push(s.tierName ?? '-');
    parts.push(`{ text 200 ${y + 2} 1153 ${texts.length - 1} }`);
    // Action button — Declare if not citizen, Renounce if is.
    const buttonId = 100 + i;            // Declare (100..) / Renounce (200..)
    const renounceId = 200 + i;
    if (s.citizen) {
      parts.push(`{ button 340 ${y} 4014 4015 1 0 ${renounceId} }`);
      texts.push('Renounce');
      parts.push(`{ text 370 ${y + 2} 1153 ${texts.length - 1} }`);
    } else if (s.points >= 2000) {
      parts.push(`{ button 340 ${y} 4005 4006 1 0 ${buttonId} }`);
      texts.push('Declare');
      parts.push(`{ text 370 ${y + 2} 1153 ${texts.length - 1} }`);
    } else {
      texts.push(`need ${2000 - s.points}`);
      parts.push(`{ text 340 ${y + 2} 1149 ${texts.length - 1} }`);
    }
  });

  // Close X
  parts.push(`{ button ${W - 30} 8 4017 4018 1 0 0 }`);

  api.gumps.send(ctx.state, {
    definitionId: 'server:commands-economy-loyalty:open-loyalty-gump',
    x: 100, y: 80,
    layout: parts.join(''),
    texts,
  }, (resp) => {
    const b = resp.buttonId;
    if (b === 0) return;
    if (b >= 100 && b < 100 + ALL_CITIES.length) {
      const city = ALL_CITIES[b - 100];
      if (cityLoyalty.declareCitizen(account, city)) {
        ctx.state.sendSystemMessage?.(`You are now a citizen of ${city}.`);
      } else {
        ctx.state.sendSystemMessage?.(`Cannot declare ${city} (need ≥2000).`);
      }
      openLoyaltyGump(api, ctx, account);   // refresh
      return;
    }
    if (b >= 200 && b < 200 + ALL_CITIES.length) {
      const city = ALL_CITIES[b - 200];
      if (cityLoyalty.renounce(account, city)) {
        ctx.state.sendSystemMessage?.(`You renounce citizenship of ${city}.`);
      } else {
        ctx.state.sendSystemMessage?.(`Not a citizen of ${city}.`);
      }
      openLoyaltyGump(api, ctx, account);
    }
  });
}

export default function register(api) {
  if (!api.commands || !api.cityLoyalty) return () => {};
  const { commands, cityLoyalty } = api;

  commands.register({
    name: 'loyalty',
    help: '[loyalty [join <city>|leave|status] — view or change your city loyalty.',
    access: 'Player',
    run(ctx) {
      const account = ctx.state.accountName ?? '?';
      const args = ctx.args ?? [];
      const sub = (args[0] ?? 'status').toLowerCase();
      if (sub === 'gump' || sub === 'ui') {
        openLoyaltyGump(api, ctx, account);
        return;
      }
      if (sub === 'status' || !sub) {
        const list = api.systems?.cityLoyalty?.listCities?.() ?? ALL_CITIES;
        ctx.state.sendSystemMessage(`Loyalty status for ${account}:`);
        for (const city of list) {
          const s = cityLoyalty.status(account, city);
          if (s.points === 0 && !s.citizen) continue;
          ctx.state.sendSystemMessage(
            `  ${city.padEnd(12)} ${s.points.toString().padStart(5)} (${s.tierName})${s.citizen ? ' [CITIZEN]' : ''}`,
          );
        }
        return;
      }
      if (sub === 'join') {
        const city = args[1];
        if (!city) { ctx.state.sendSystemMessage('Usage: [loyalty join <city>'); return; }
        if (!cityLoyalty.declareCitizen(account, city)) {
          ctx.state.sendSystemMessage(`Cannot declare citizenship in ${city} (need 2000+ loyalty).`);
        } else {
          ctx.state.sendSystemMessage(`You are now a citizen of ${city}.`);
        }
        return;
      }
      if (sub === 'leave') {
        const city = args[1];
        if (!city) { ctx.state.sendSystemMessage('Usage: [loyalty leave <city>'); return; }
        if (!cityLoyalty.renounce(account, city)) {
          ctx.state.sendSystemMessage(`You are not a citizen of ${city}.`);
        } else {
          ctx.state.sendSystemMessage(`You renounce citizenship of ${city}.`);
        }
        return;
      }
      ctx.state.sendSystemMessage('Usage: [loyalty [status|join <city>|leave <city>]');
    },
  });

  commands.register({
    name: 'loyaltyaward',
    help: '[loyaltyaward <accountName> <city> <amount> — GM-only, grant city loyalty points.',
    access: 'GM',
    run(ctx) {
      const args = ctx.args ?? [];
      const [acc, city, amountStr] = args;
      if (!acc || !city || !amountStr) {
        ctx.state.sendSystemMessage('Usage: [loyaltyaward <account> <city> <amount>');
        return;
      }
      const amount = parseInt(amountStr, 10);
      if (!Number.isFinite(amount)) {
        ctx.state.sendSystemMessage('Amount must be a number.');
        return;
      }
      const total = cityLoyalty.award(acc, city, amount);
      ctx.state.sendSystemMessage(`${acc} loyalty(${city}) = ${total}.`);
    },
  });

  return () => {
    commands.unregister('loyalty');
    commands.unregister('loyaltyaward');
  };
}
