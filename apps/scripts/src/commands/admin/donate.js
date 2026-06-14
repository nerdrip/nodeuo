// `[donate` — Community Collections donation flow.
//   [donate list                    → list collections
//   [donate <id> status             → tier + total
//   [donate <id> top                → top 10 donors
//   [donate <id>                    → target an item, contribute

import { itemBySerial } from '../../_entities.js';
import { destroyItemBySerial } from '../../_items.js';

export default function register(api) {
  if (!api.commands || !api.targeting) return () => {};
  const collections = api.systems?.communityCollections;
  if (!collections) {
    api.log?.('donate: community collections system unavailable');
    return () => {};
  }

  api.commands.register({
    name: 'donate',
    help: '[donate list | gump | <id> [status|top] | <id> — Community Collections.',
    access: 'Player',
    run(ctx, args) {
      const a = String(args?.[0] ?? '').toLowerCase();
      if (a === 'gump') {
        // Compact ledger sent as sentinel so the client overlay can render.
        const rows = collections.listCollections().map((id) => {
          const c = collections.collectionInfo(id);
          const s = collections.status(api.world, id) ?? { total: 0, nextTier: null, tiersAwarded: 0 };
          const mine = api.world?._communityCollections?.[id]?.donors?.[ctx.sender.serial >>> 0] ?? 0;
          return `${id}|${c.label}|${s.total}|${s.nextTier ?? 0}|${s.tiersAwarded}|${mine}`;
        }).join(';');
        ctx.state.sendSystemMessage?.(`@@OPEN_COMMUNITY_GUMP@@${rows}`);
        return;
      }
      if (a === '' || a === 'list') {
        ctx.state.sendSystemMessage('Collections:');
        for (const id of collections.listCollections()) {
          const c = collections.collectionInfo(id);
          ctx.state.sendSystemMessage(`  ${id} — ${c.label}  (rate ${c.rate}/item, accepts: ${c.accepts.join(',')})`);
        }
        return;
      }
      const c = collections.collectionInfo(a);
      if (!c) { ctx.state.sendSystemMessage(`Unknown collection '${a}'.`); return; }
      const sub = String(args?.[1] ?? '').toLowerCase();
      if (sub === 'status') {
        const s = collections.status(api.world, a);
        ctx.state.sendSystemMessage(
          `${s.label} — total ${s.total}, next tier ${s.nextTier ?? 'max'}, awarded ${s.tiersAwarded}.`,
        );
        return;
      }
      if (sub === 'top') {
        const top = collections.topDonors(api.world, a, 10);
        if (top.length === 0) { ctx.state.sendSystemMessage('No donors yet.'); return; }
        ctx.state.sendSystemMessage(`Top donors (${c.label}):`);
        top.forEach((d, i) => ctx.state.sendSystemMessage(`  ${i + 1}. ${d.serial.toString(16)} — ${d.points}`));
        return;
      }
      ctx.state.sendSystemMessage(`Target an item to donate to ${c.label}.`);
      api.targeting.request(ctx.state, (picked) => {
        if (!picked) { ctx.state.sendSystemMessage('Cancelled.'); return; }
        const item = itemBySerial(api, picked.serial >>> 0);
        if (!item) { ctx.state.sendSystemMessage('That is not an item.'); return; }
        const r = collections.donate(api.world, a, ctx.sender, item);
        if (!r.ok) { ctx.state.sendSystemMessage(r.reason); return; }
        try { destroyItemBySerial(api, item.serial); } catch { /* donation already consumed */ }
        ctx.state.sendSystemMessage(
          `+${r.points} points (total ${r.total})${r.crossed ? ` — tier ${r.crossed} reached!` : ''}.`,
        );
      });
    },
  });
  return () => api.commands.unregister('donate');
}
