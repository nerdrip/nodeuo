import { allItems } from '../../_spatial.js';
import { itemBySerial } from '../../_entities.js';
import { bodsSystem } from '../../_bods.js';
// [bod — Bulk Order Deed browse + claim. Mirrors ServUO's
// "Combine Deed" / "Reward Choice" gumps in chat-driven form.
//
//   [bod list           — show all bulk orders in your pack
//   [bod rewards        — list available rewards for COMPLETED deeds
//   [bod claim <key>    — redeem a reward by recipe key
//   [bod combine <hexA> <hexB>  — bind small BOD A to large BOD B

export default function register(api) {
  if (!api.commands || !api.world || !api.game?.mobile?.giveItem) return () => {};

  const bods = bodsSystem(api);

  function ownedBods(playerSerial) {
    const out = [];
    for (const it of allItems(api)) {
      if (it.parent !== playerSerial) continue;
      if (!it.bod) continue;
      out.push(it);
    }
    return out;
  }

  api.commands.register({
    name: 'bod',
    help: '[bod list|rewards|claim <key>|combine <smallHex> <largeHex>',
    access: 'Player',
    run(ctx, args) {
      const sub = (args?.[0] ?? '').toLowerCase();
      const sender = ctx.sender;
      const list = ownedBods(sender.serial);

      switch (sub) {
        case 'largegump': {
          // Phase H.2 — open the LargeBodGump overlay for a specific
          // large BOD by serial hex.
          const hex = args?.[1] ?? '';
          const ser = parseInt(hex, 16) >>> 0;
          const it = list.find((x) => (x.serial >>> 0) === ser);
          if (!it || !it.bod?.large) {
            ctx.state.sendSystemMessage('No large BOD with that serial in your pack.');
            return;
          }
          const b = it.bod;
          const slots = b.slots.map((s) => `${s.material ?? ''}|${s.done ? 1 : 0}|${s.label ?? ''}`).join(';');
          const payload = [it.serial.toString(16), (b.label ?? '?').replace(/[|;]/g, '_'), slots].join('||');
          ctx.state.sendSystemMessage?.(`@@OPEN_LARGEBOD_GUMP@@${payload}`);
          return;
        }
        case 'rewardsgump': {
          // Phase H.2 — open the BOD rewards browser overlay.
          // Pulls all completed BODs and emits one row per available reward.
          if (!bods) { ctx.state.sendSystemMessage('BOD engine missing.'); return; }
          const rows = [];
          for (const it of list) {
            const b = it.bod;
            if (b.large && !bods.isLargeBodComplete(b)) continue;
            if (!b.large && b.progress < b.quantity) continue;
            const reward = bods.rollBodReward?.(b);
            if (!reward) continue;
            for (const e of reward) {
              rows.push(`${it.serial.toString(16)}|${e.itemId.toString(16)}|${e.amount ?? 1}|${(e.name ?? '?').replace(/[|;]/g, '_')}`);
            }
          }
          ctx.state.sendSystemMessage?.(`@@OPEN_BODREWARDS_GUMP@@${rows.join(';')}`);
          return;
        }
        case '':
        case 'list': {
          if (!list.length) { ctx.state.sendSystemMessage('You have no bulk orders.'); return; }
          ctx.state.sendSystemMessage(`Bulk orders (${list.length}):`);
          for (const it of list) {
            const b = it.bod;
            const status = b.large
              ? `${b.slots.filter((s) => s.done).length}/${b.slots.length} slots`
              : `${b.progress}/${b.quantity}`;
            const ex = b.exceptional ? '*' : ' ';
            ctx.state.sendSystemMessage(`  [${it.serial.toString(16)}]${ex} ${b.label} — ${status} — ${b.material}`);
          }
          return;
        }
        case 'rewards': {
          if (!bods) { ctx.state.sendSystemMessage('BOD engine missing.'); return; }
          let any = false;
          for (const it of list) {
            const b = it.bod;
            if (b.large && !bods.isLargeBodComplete(b)) continue;
            if (!b.large && b.progress < b.quantity) continue;
            const reward = bods.rollBodReward?.(b);
            if (!reward) continue;
            for (const e of reward) {
              const mat = e.material ? `[${e.material}]` : '';
              const amt = `×${e.amount ?? 1}`;
              ctx.state.sendSystemMessage(`REWARD ${e.itemId.toString(16)} ${amt} ${mat} :: ${e.name ?? '(reward)'}`);
              any = true;
            }
          }
          if (!any) ctx.state.sendSystemMessage('No completed bulk orders ready for reward.');
          return;
        }
        case 'claim': {
          const key = args?.[1];
          if (!key) { ctx.state.sendSystemMessage('Usage: [bod claim <itemHex>'); return; }
          // Spawn matching reward into pack — caller passed itemId hex.
          const itemId = parseInt(key, 16) || 0;
          if (!itemId) { ctx.state.sendSystemMessage('Bad key.'); return; }
          try {
            const item = api.game.mobile.giveItem(sender, {
              itemId,
              name: 'BOD reward',
              amount: 1,
            }, { randomGrid: true });
            if (!item) throw new Error('no backpack');
            ctx.state.sendSystemMessage('Reward claimed.');
          } catch (e) { ctx.state.sendSystemMessage(`Claim failed: ${e?.message ?? e}`); }
          return;
        }
        case 'combine': {
          if (!bods) { ctx.state.sendSystemMessage('BOD engine missing.'); return; }
          const sm = parseInt(args?.[1], 16) || 0;
          const lg = parseInt(args?.[2], 16) || 0;
          const small = itemBySerial(api, sm);
          const large = itemBySerial(api, lg);
          if (!small || !large) { ctx.state.sendSystemMessage('Bad serials.'); return; }
          const r = bods.bindSmallToLarge(large.bod, small);
          if (r.ok) ctx.state.sendSystemMessage('Small BOD bound to large.');
          else ctx.state.sendSystemMessage(`Combine failed: ${r.reason}`);
          return;
        }
        default:
          ctx.state.sendSystemMessage('Usage: [bod list|rewards|claim|combine');
      }
    },
  });
  return () => {};
}
