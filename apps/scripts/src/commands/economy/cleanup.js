import { itemBySerial } from '../../_entities.js';
// [cleanup — Clean Up Britannia turn-in + reward browse + claim.
//
// Usage:
//   [cleanup status              — list current points + redeemed
//   [cleanup turnin <itemHex>    — turn-in an item from your pack
//   [cleanup rewards             — list reward catalog with costs
//   [cleanup claim <key>         — redeem a reward into your pack
//   [cleanup gump                — open the Reward Stone gump (paginated)

const REWARDS_PER_PAGE = 8;

function openRewardGump(api, ctx, sender, account) {
  if (!api.gumps?.send) {
    ctx.state.sendSystemMessage?.('Gump system unavailable — use [cleanup rewards.');
    return;
  }
  const CB = api.systems.cleanup;
  const list = CB.listRewards();
  const totalPages = Math.ceil(list.length / REWARDS_PER_PAGE);

  const page = (pageIdx) => {
    const slice = list.slice(pageIdx * REWARDS_PER_PAGE, (pageIdx + 1) * REWARDS_PER_PAGE);
    const W = 520;
    const H = 90 + slice.length * 30 + 50;
    const parts = [`{ resizepic 0 0 9200 ${W} ${H} }`];
    const texts = [];
    texts.push('Clean Up Britannia — Reward Stone');
    parts.push(`{ text 16 12 1153 ${texts.length - 1} }`);
    texts.push(`Points: ${CB.pointsOf(account)}     Page ${pageIdx + 1}/${totalPages}`);
    parts.push(`{ text 16 32 1149 ${texts.length - 1} }`);
    // Header.
    texts.push('Reward'); parts.push(`{ text 60  60 1149 ${texts.length - 1} }`);
    texts.push('Cost');   parts.push(`{ text 360 60 1149 ${texts.length - 1} }`);
    texts.push('Claim');  parts.push(`{ text 450 60 1149 ${texts.length - 1} }`);
    // Rows.
    slice.forEach((r, i) => {
      const y = 88 + i * 30;
      texts.push(r.name);
      parts.push(`{ text 60 ${y + 2} 1153 ${texts.length - 1} }`);
      texts.push(`${r.cost} pts`);
      const colourId = (account.cleanupPoints | 0) >= r.cost ? 1167 : 1149;
      parts.push(`{ text 360 ${y + 2} ${colourId} ${texts.length - 1} }`);
      if ((account.cleanupPoints | 0) >= r.cost) {
        parts.push(`{ button 450 ${y} 4005 4006 1 0 ${100 + i} }`);
      }
    });
    if (pageIdx > 0) {
      parts.push(`{ button 16 ${H - 28} 4014 4015 1 0 2000 }`);
      texts.push('< Prev');
      parts.push(`{ text 46 ${H - 26} 1153 ${texts.length - 1} }`);
    }
    if (pageIdx < totalPages - 1) {
      parts.push(`{ button ${W - 80} ${H - 28} 4005 4006 1 0 2001 }`);
      texts.push('Next >');
      parts.push(`{ text ${W - 52} ${H - 26} 1153 ${texts.length - 1} }`);
    }
    parts.push(`{ button ${W - 30} 8 4017 4018 1 0 0 }`);
    api.gumps.send(ctx.state, {
      definitionId: 'server:commands-economy-cleanup:page',
      x: 100, y: 80, layout: parts.join(''), texts,
    }, (resp) => {
      const b = resp.buttonId;
      if (b === 0) return;
      if (b === 2000) { page(pageIdx - 1); return; }
      if (b === 2001) { page(pageIdx + 1); return; }
      if (b >= 100 && b < 100 + REWARDS_PER_PAGE) {
        const pick = slice[b - 100];
        if (!pick) return;
        if (!api.game?.inventory?.findBackpack?.(sender)) {
          ctx.state.sendSystemMessage?.('You have no backpack for the reward.');
          page(pageIdx);
          return;
        }
        const r = CB.redeem(account, pick.key);
        if (!r.ok) {
          ctx.state.sendSystemMessage?.(`Claim failed: ${r.reason}`);
        } else {
          try {
            const item = api.game?.mobile?.giveItem?.(sender, {
              itemId: r.reward.itemId,
              hue: r.reward.hue ?? 0,
              name: r.reward.name,
              amount: r.reward.amount ?? 1,
              movable: true,
            }, { randomGrid: true });
            if (!item) throw new Error('no backpack');
            ctx.state.sendSystemMessage?.(
              `Claimed ${r.reward.name}. Remaining points: ${CB.pointsOf(account)}.`,
            );
          } catch (e) {
            ctx.state.sendSystemMessage?.(`Item spawn failed: ${e?.message ?? e}`);
          }
        }
        page(pageIdx);   // re-render to update points / disable buttons
      }
    });
  };
  page(0);
}

export default function register(api) {
  if (!api.commands || !api.systems?.cleanup) {
    api.log?.('cmd/cleanup: missing api.systems.cleanup; skipping');
    return () => {};
  }
  const CB = api.systems.cleanup;

  api.commands.register({
    name: 'cleanup',
    help: '[cleanup status|turnin <itemHex>|rewards|claim <key>',
    access: 'Player',
    run(ctx, args) {
      const sub = (args?.[0] ?? '').toLowerCase();
      const sender = ctx.sender;
      const account = ctx.state?.account;
      if (!account) { ctx.state.sendSystemMessage('No account context.'); return; }

      switch (sub) {
        case 'gump':
        case 'ui':
        case 'browse': {
          openRewardGump(api, ctx, sender, account);
          return;
        }
        case '':
        case 'status': {
          ctx.state.sendSystemMessage(`Clean Up Britannia — ${CB.pointsOf(account)} point(s).`);
          if (account.cleanupRedeemed?.length) {
            ctx.state.sendSystemMessage(`Redeemed: ${account.cleanupRedeemed.slice(-5).join(', ')}`);
          }
          return;
        }
        case 'turnin': {
          const iSerial = parseInt(args?.[1], 16) || 0;
          if (!iSerial) { ctx.state.sendSystemMessage('Usage: [cleanup turnin <hexSerial>'); return; }
          const item = itemBySerial(api, iSerial);
          if (!item || item.parent !== sender.serial) {
            ctx.state.sendSystemMessage('Item must be in your backpack.');
            return;
          }
          const pts = CB.turnIn(account, api.world, item);
          if (pts > 0) {
            ctx.state.sendSystemMessage(`Turned in ${item.name ?? 'item'} for ${pts} point(s). Total: ${CB.pointsOf(account)}.`);
          } else {
            ctx.state.sendSystemMessage('That item is worthless to the cleanup effort.');
          }
          return;
        }
        case 'rewards': {
          const list = CB.listRewards();
          ctx.state.sendSystemMessage('Clean Up rewards:');
          for (const r of list) {
            ctx.state.sendSystemMessage(`  ${r.key.padEnd(28)} ${r.cost} pts — ${r.name}`);
          }
          return;
        }
        case 'claim': {
          const key = (args?.[1] ?? '').toLowerCase();
          if (!key) { ctx.state.sendSystemMessage('Usage: [cleanup claim <reward-key>'); return; }
          if (!api.game?.inventory?.findBackpack?.(sender)) {
            ctx.state.sendSystemMessage('You have no backpack for the reward.');
            return;
          }
          const r = CB.redeem(account, key);
          if (!r.ok) { ctx.state.sendSystemMessage(`Claim failed: ${r.reason}`); return; }
          try {
            const item = api.game?.mobile?.giveItem?.(sender, {
              itemId: r.reward.itemId,
              hue: r.reward.hue ?? 0,
              name: r.reward.name,
              amount: r.reward.amount ?? 1,
            }, { randomGrid: true });
            if (!item) throw new Error('no backpack');
            ctx.state.sendSystemMessage(`Claimed ${r.reward.name}. Remaining points: ${CB.pointsOf(account)}.`);
          } catch (e) {
            ctx.state.sendSystemMessage(`Item spawn failed: ${e?.message ?? e}`);
          }
          return;
        }
        default:
          ctx.state.sendSystemMessage('Usage: [cleanup status|turnin|rewards|claim');
      }
    },
  });
  return () => {};
}
