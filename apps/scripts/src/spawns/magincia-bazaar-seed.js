// Magincia Bazaar stall seeder + `[bazaar` controls.
//
// ServUO ships the bazaar as a fixed set of 16 stalls auctioned weekly.
// We seed 16 demo stalls in a 4×4 grid around (3713, 2113) (the
// canonical sigil tile) and expose `[bazaar` for player bidding /
// status / staff settle.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { destroyItemBySerial } from '../_items.js';
import { childrenOf, findBackpack } from '../_inventory.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../data/world/spawns/magincia-bazaar.json');

let CFG = { centerX: 3713, centerY: 2113, map: 1, gridStride: 4, gridRange: 6 };
try { CFG = { ...CFG, ...JSON.parse(fs.readFileSync(DATA, 'utf8')) }; }
catch (e) { console.warn('[magincia-bazaar] load failed:', e.message); }

function seedStalls(bazaar) {
  if (bazaar.listStalls().length > 0) return;
  // NxN grid, stalls spaced `gridStride` tiles apart, centred on (centerX,centerY).
  let id = 1;
  for (let dy = -CFG.gridRange; dy <= CFG.gridRange; dy += CFG.gridStride) {
    for (let dx = -CFG.gridRange; dx <= CFG.gridRange; dx += CFG.gridStride) {
      bazaar.registerStall({
        id: `magincia-${id++}`,
        x: CFG.centerX + dx,
        y: CFG.centerY + dy,
        map: CFG.map,
      });
    }
  }
}

function consumeGold(api, pack, amount) {
  if (!pack) return false;
  let need = amount;
  for (const it of childrenOf(api, pack)) {
    if (need <= 0) break;
    if (it.itemId !== 0x0EED) continue;
    const have = it.amount | 0;
    if (have <= need) {
      need -= have;
      try { destroyItemBySerial(api, it.serial); } catch { /* ignore */ }
    } else {
      it.amount = have - need;
      need = 0;
    }
  }
  return need <= 0;
}

export default function register(api) {
  if (!api.commands || !api.world) return () => {};
  const bazaar = api.systems?.maginciaBazaar;
  if (!bazaar) {
    api.log?.('magincia-bazaar: system unavailable');
    return () => {};
  }
  // Seed stalls if the persistence layer didn't restore any.
  seedStalls(bazaar);
  // Rent sweep — every hour evict tenants whose deposit ran out.
  const rentInterval = api.lifecycle?.setInterval?.(() => {
    try { bazaar.chargeRent(api.world); } catch (e) { console.warn('[bazaar] rent:', e?.message); }
  }, 60 * 60 * 1000) ?? setInterval(() => {
    try { bazaar.chargeRent(api.world); } catch (e) { console.warn('[bazaar] rent:', e?.message); }
  }, 60 * 60 * 1000);
  rentInterval.unref?.();

  api.commands.register({
    name: 'bazaar',
    help: '[bazaar list|status <id>|bid <id> <gp>|settle <id> — Magincia bazaar.',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const arg1 = String(ctx.args[1] ?? '');
      const mob = ctx.sender;

      if (sub === 'list') {
        const all = bazaar.listStalls();
        ctx.state.sendSystemMessage?.(`Magincia Bazaar — ${all.length} stalls:`);
        for (const s of all) {
          const top = s.bids.reduce((m, b) => Math.max(m, b.amount), 0);
          const status = s.owner ? `rented by ${s.ownerName}` :
                         s.auctionEndsAt ? `auction (top ${top}gp)` :
                                            'idle';
          ctx.state.sendSystemMessage?.(`  ${s.id.padEnd(14)} (${s.x},${s.y}) — ${status}`);
        }
        return;
      }

      if (sub === 'status') {
        const s = bazaar.stall(arg1);
        if (!s) { ctx.state.sendSystemMessage?.('No such stall.'); return; }
        const top = s.bids.reduce((m, b) => Math.max(m, b.amount), 0);
        ctx.state.sendSystemMessage?.(`Stall ${s.id} @ (${s.x},${s.y}):`);
        ctx.state.sendSystemMessage?.(`  owner: ${s.ownerName ?? '-'}`);
        ctx.state.sendSystemMessage?.(`  deposit: ${s.deposit}gp`);
        ctx.state.sendSystemMessage?.(`  bids: ${s.bids.length} (top: ${top}gp)`);
        if (s.auctionEndsAt) {
          const mins = Math.max(0, Math.ceil((s.auctionEndsAt - Date.now()) / 60_000));
          ctx.state.sendSystemMessage?.(`  auction closes in ~${mins} min`);
        }
        return;
      }

      if (sub === 'bid') {
        const amt = parseInt(ctx.args[2] ?? '0', 10) | 0;
        if (!arg1 || amt <= 0) {
          ctx.state.sendSystemMessage?.('Usage: [bazaar bid <id> <gold>');
          return;
        }
        const pack = findBackpack(api, mob);
        if (!consumeGold(api, pack, amt)) {
          ctx.state.sendSystemMessage?.(`You need ${amt}gp in your pack.`);
          return;
        }
        const r = bazaar.bid(arg1, mob, amt);
        if (!r.ok) {
          // Refund — give gold back as a single stack.
          api.game?.mobile?.giveItem?.(mob, {
            itemId: 0x0EED,
            amount: amt,
            name: 'gold',
            stackable: true,
            movable: true,
          }, { randomGrid: true });
          ctx.state.sendSystemMessage?.(r.reason);
          return;
        }
        ctx.state.sendSystemMessage?.(`Bid placed (top: ${r.top}gp).`);
        return;
      }

      if (sub === 'settle') {
        const access = ctx.state?.account?.accessLevel ?? 'Player';
        if (access !== 'GM' && access !== 'Admin') {
          ctx.state.sendSystemMessage?.('GM only.');
          return;
        }
        const winner = bazaar.settle(arg1);
        ctx.state.sendSystemMessage?.(
          winner ? `Winner: ${winner.name} (${winner.amount}gp).`
                 : 'No winner (auction not yet closed or no bids).',
        );
        return;
      }

      ctx.state.sendSystemMessage?.('Usage: [bazaar list|status <id>|bid <id> <gp>|settle <id>');
    },
  });

  return () => {
    if (!api.lifecycle) clearInterval(rentInterval);
    api.commands.unregister('bazaar');
  };
}
