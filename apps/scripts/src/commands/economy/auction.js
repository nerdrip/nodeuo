import { itemBySerial } from '../../_entities.js';
// [auction list|consign|bid|info <id>|reclaim — auction house commands.

export default function register(api) {
  if (!api.commands || !api.systems?.auctionHouse) return () => {};
  const A = api.systems.auctionHouse;

  api.commands.register({
    name: 'auction',
    help: '[auction list|consign <itemHex> <startingBid> [buyoutPrice]|bid <lotId> <amount>|info <lotId>',
    access: 'Player',
    run(ctx, args) {
      const sub = (args?.[0] ?? 'list').toLowerCase();
      const sender = ctx.sender;

      switch (sub) {
        case '':
        case 'list': {
          const open = A.listOpen(api.world);
          if (open.length === 0) { ctx.state.sendSystemMessage('No open auctions.'); return; }
          ctx.state.sendSystemMessage(`Open auctions (${open.length}):`);
          for (const lot of open.slice(0, 20)) {
            const remH = Math.ceil((lot.expiresAt - Date.now()) / 3_600_000);
            const cur = lot.currentBid > 0 ? `bid ${lot.currentBid}gp by ${lot.currentBidderName}` : `start ${lot.startingBid}gp`;
            ctx.state.sendSystemMessage(`  #${lot.id}  ${lot.item.name}  ${cur}  ${remH}h left`);
          }
          return;
        }
        case 'consign': {
          const itemHex = parseInt(args[1], 16) || 0;
          const startingBid = parseInt(args[2], 10) || 0;
          const buyoutPrice = parseInt(args[3], 10) || 0;
          if (!itemHex || startingBid <= 0) {
            ctx.state.sendSystemMessage('Usage: [auction consign <itemHex> <startingBid> [buyout]');
            return;
          }
          const item = itemBySerial(api, itemHex);
          if (!item || item.parent !== sender.serial) {
            ctx.state.sendSystemMessage('Item must be in your pack.');
            return;
          }
          const r = A.consign(api.world, sender, item, { startingBid, buyoutPrice });
          if (r.ok) ctx.state.sendSystemMessage(`Listed as lot #${r.lotId}. Listing fee: ${r.fee}gp.`);
          else ctx.state.sendSystemMessage(`Consign failed: ${r.reason}`);
          return;
        }
        case 'bid': {
          const lotId = parseInt(args[1], 10) || 0;
          const amount = parseInt(args[2], 10) || 0;
          const r = A.bid(api.world, sender, lotId, amount);
          if (r.ok) ctx.state.sendSystemMessage(`Bid placed on lot #${lotId}.`);
          else ctx.state.sendSystemMessage(`Bid failed: ${r.reason}`);
          return;
        }
        case 'info': {
          const lotId = parseInt(args[1], 10) || 0;
          const lot = A.lotById(api.world, lotId);
          if (!lot) { ctx.state.sendSystemMessage('No such lot.'); return; }
          ctx.state.sendSystemMessage(`Lot #${lot.id} — ${lot.item.name} ×${lot.item.amount}`);
          ctx.state.sendSystemMessage(`  Consigner: ${lot.consignerName}`);
          ctx.state.sendSystemMessage(`  Starting:  ${lot.startingBid}gp${lot.buyoutPrice ? `  Buyout: ${lot.buyoutPrice}gp` : ''}`);
          ctx.state.sendSystemMessage(`  Current:   ${lot.currentBid > 0 ? `${lot.currentBid}gp by ${lot.currentBidderName}` : '(no bids)'}`);
          ctx.state.sendSystemMessage(`  Status:    ${lot.status}`);
          return;
        }
        default:
          ctx.state.sendSystemMessage('Usage: [auction list|consign|bid|info');
      }
    },
  });
  return () => {};
}
