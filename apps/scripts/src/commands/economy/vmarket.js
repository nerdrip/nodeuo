// `[vmarket <query>` — Vendor Search Stone / Market UI.
//
// Paginated gump variant of `[vsearch`. Each row shows an item + price
// + vendor name and clicking the row teleports the caller next to the
// vendor (mirrors ServUO `Engines/VendorSearching/SearchVendorsGump.cs`
// "Goto" button). Free for staff; consumes 100gp from the caller's
// backpack per teleport for players (mirrors ServUO's "Vendor Search
// Stone" 100gp travel-fee).
//
//   [vmarket <query> [min:N] [max:N]
//
// e.g.  [vmarket scroll min:50 max:500

import { destroyItemBySerial } from '../../_items.js';
import { childrenOf, findBackpack } from '../../_inventory.js';
import { moveMobile } from '../../_movement.js';

const PAGE_SIZE = 10;
const GOTO_COST_GP = 100;

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

function teleport(api, mob, x, y, z, map) {
  moveMobile(api, mob, { x, y, z, ...(map != null ? { map } : {}) });
}

export default function register(api) {
  if (!api.commands || !api.gumps?.send) return () => {};
  const vendorSearch = api.systems?.vendorSearch;
  if (!vendorSearch) {
    api.log?.('vmarket: vendor search system unavailable');
    return () => {};
  }

  api.commands.register({
    name: 'vmarket',
    help: '[vmarket <query> [min:N] [max:N] — vendor search UI with teleport.',
    access: 'Player',
    run(ctx) {
      const q = { text: '', minPrice: 0, maxPrice: Infinity, limit: 200 };
      const text = [];
      for (const a of ctx.args ?? []) {
        const m = String(a).match(/^(min|max|kind|prop|sort):(.+)$/i);
        if (m) {
          const k = m[1].toLowerCase();
          const v = m[2];
          if (k === 'min')      q.minPrice = parseInt(v, 10) | 0;
          else if (k === 'max') q.maxPrice = parseInt(v, 10) | 0;
          else if (k === 'kind') q.kind = v.toLowerCase();
          else if (k === 'prop') q.property = v.toLowerCase();
          else if (k === 'sort') q.sort =
            (v.toLowerCase() === 'asc'  ? 'price-asc' :
             v.toLowerCase() === 'desc' ? 'price-desc' :
             v.toLowerCase());
        } else text.push(a);
      }
      q.text = text.join(' ');
      const results = vendorSearch.searchVendors(api.world, q);
      if (results.length === 0) {
        ctx.state.sendSystemMessage('No matching wares.');
        return;
      }

      const total = results.length;
      const totalPages = Math.ceil(total / PAGE_SIZE);
      const page = (pageIdx) => {
        const slice = results.slice(pageIdx * PAGE_SIZE, (pageIdx + 1) * PAGE_SIZE);
        const W = 500;
        const H = 60 + slice.length * 32 + 50;
        const parts = [`{ resizepic 0 0 9200 ${W} ${H} }`];
        const texts = [];
        // Title.
        texts.push(`Vendor Market — ${total} matches (page ${pageIdx + 1}/${totalPages})`);
        parts.push(`{ text 16 12 1153 ${texts.length - 1} }`);
        // Header row.
        texts.push('Item');                parts.push(`{ text 50 38 1149 ${texts.length - 1} }`);
        texts.push('Price');               parts.push(`{ text 220 38 1149 ${texts.length - 1} }`);
        texts.push('Vendor');              parts.push(`{ text 290 38 1149 ${texts.length - 1} }`);
        texts.push('Location');            parts.push(`{ text 410 38 1149 ${texts.length - 1} }`);
        // Rows.
        slice.forEach((r, i) => {
          const y = 60 + i * 32;
          // Goto button.
          parts.push(`{ button 16 ${y} 4005 4006 1 0 ${100 + i} }`);
          texts.push(r.itemName.slice(0, 22));
          parts.push(`{ text 50 ${y + 2} 1153 ${texts.length - 1} }`);
          texts.push(`${r.price}gp`);
          parts.push(`{ text 220 ${y + 2} 1153 ${texts.length - 1} }`);
          texts.push(r.vendorName.slice(0, 18));
          parts.push(`{ text 290 ${y + 2} 1153 ${texts.length - 1} }`);
          texts.push(`(${r.x},${r.y})`);
          parts.push(`{ text 410 ${y + 2} 1153 ${texts.length - 1} }`);
        });
        // Prev/Next.
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
        // Close X.
        parts.push(`{ button ${W - 30} 8 4017 4018 1 0 0 }`);

        api.gumps.send(ctx.state, {
          x: 100, y: 80,
          layout: parts.join(''),
          texts,
        }, (resp) => {
          const b = resp.buttonId;
          if (b === 0) return;
          if (b === 2000) { page(pageIdx - 1); return; }
          if (b === 2001) { page(pageIdx + 1); return; }
          if (b >= 100 && b < 100 + PAGE_SIZE) {
            const pick = slice[b - 100];
            if (!pick) return;
            // Gold gate (skip for staff).
            const access = ctx.state?.account?.accessLevel ?? 'Player';
            const isStaff = access === 'GM' || access === 'Admin' || access === 'Seer';
            if (!isStaff) {
              const pack = findBackpack(api, ctx.sender);
              if (!pack || !consumeGold(api, pack, GOTO_COST_GP)) {
                ctx.state.sendSystemMessage?.(
                  `You need ${GOTO_COST_GP}gp in your pack to teleport to a vendor.`,
                );
                return;
              }
            }
            teleport(api, ctx.sender, pick.x + 1, pick.y, pick.z, pick.map);
            ctx.state.sendSystemMessage?.(
              `Teleported to ${pick.vendorName} (${pick.x},${pick.y}).`,
            );
          }
        });
      };
      page(0);
    },
  });

  return () => api.commands.unregister('vmarket');
}
