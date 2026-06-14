import { allMobiles } from '../../_spatial.js';
import { mobileBySerial } from '../../_entities.js';
// `[vendorbio` — lifetime stats for the nearest vendor. Reads from
// the runtime fields wave 13-17 carved out:
//   `_lifetimeBuys`        — global buy counter (drives prestige tier)
//   `_customerHistory`     — per-customer Map (visits/buys/sells/haggle*)
//   `_transactionLog`      — last 50 transactions ring buffer
//   `_originalHue`         — pre-promotion baseline body colour
//   `title`                — current honorific (set by refreshVendorTitle)
//
// Output is multi-line text (no gump) — fast to scaffold and works
// over chat. A future polish pass can wire a real "career page" gump.
//
// Useful for shard managers tracking economy hotspots and players
// curious how busy their favourite NPC really is.

const RANGE = 6;

function findNearestVendor(world, mob) {
  let best = null, bestD = RANGE + 1;
  for (const m of allMobiles({ world })) {
    if (!m.vendorKind) continue;
    if (m.map !== mob.map) continue;
    const d = Math.max(Math.abs(m.x - mob.x), Math.abs(m.y - mob.y));
    if (d <= bestD) { best = m; bestD = d; }
  }
  return best;
}

function ago(ms) {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

export default function (api) {
  const { commands, world } = api;
  if (!commands) return () => {};

  commands.register({
    name: 'vendorbio',
    help: '[vendorbio — lifetime stats for the nearest vendor.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      if (!mob) return;
      const vendor = findNearestVendor(world, mob);
      if (!vendor) {
        ctx.state.sendSystemMessage('No vendor within 6 tiles.');
        return;
      }
      const log = vendor._transactionLog ?? [];
      const history = vendor._customerHistory;        // Map or null
      const buys = vendor._lifetimeBuys ?? 0;

      // Aggregate from the transaction ring (only the last 50, but
      // good for "throughput per current cycle"). For long-term
      // totals we lean on _lifetimeBuys + _customerHistory.
      let logBuyGold = 0, logSellGold = 0, logBuys = 0, logSells = 0;
      for (const t of log) {
        if (t.type === 'buy')  { logBuys++;  logBuyGold  += t.gold ?? 0; }
        if (t.type === 'sell') { logSells++; logSellGold += t.gold ?? 0; }
      }

      // Customer counts.
      let uniqueCustomers = 0;
      let topCustomer = null;
      let mostHaggleFails = 0;
      let mostHaggleFailsCust = null;
      if (history && history instanceof Map) {
        uniqueCustomers = history.size;
        for (const [cs, h] of history) {
          if (!topCustomer || (h.buys ?? 0) > (topCustomer.buys ?? -1)) {
            topCustomer = { ...h, serial: cs };
          }
          if ((h.haggleFails ?? 0) > mostHaggleFails) {
            mostHaggleFails = h.haggleFails;
            mostHaggleFailsCust = cs;
          }
        }
      }

      // First / last transaction timestamps drive "career length".
      const firstTs = log.length ? log[0].ts : null;
      const lastTs = log.length ? log[log.length - 1].ts : null;

      // Wave 19: split log into 24h windows for a "last week" stripe.
      // Each window aggregates buy/sell counts + gold so the GM can
      // see shopping cadence at a glance ("3 days ago was the spike").
      const now = Date.now();
      const DAY = 24 * 60 * 60 * 1000;
      const windows = [];
      for (let d = 0; d < 7; d++) {
        windows.push({ startsAt: now - (d + 1) * DAY, buys: 0, sells: 0, buyGp: 0, sellGp: 0 });
      }
      for (const t of log) {
        const idx = Math.floor((now - (t.ts ?? 0)) / DAY);
        if (idx < 0 || idx >= windows.length) continue;
        if (t.type === 'buy')  { windows[idx].buys++;  windows[idx].buyGp  += t.gold ?? 0; }
        if (t.type === 'sell') { windows[idx].sells++; windows[idx].sellGp += t.gold ?? 0; }
      }

      // Tier ladder breakdown — pre-computed snapshot, not derived
      // from current state, so we mirror what the player sees on the
      // mob tooltip.
      const tier = vendor.title?.match(/the (\w+) /)?.[1] ?? 'none';

      const lines = [
        `╓ ${vendor.name}${vendor.title ? `, ${vendor.title}` : ''} ╖`,
        `║  Trade:           ${vendor.vendorKind ?? 'generic'}`,
        `║  Tier:            ${tier} (lifetime buys: ${buys})`,
        `╠ Activity (last 7 days)`,
      ];
      for (let d = 0; d < windows.length; d++) {
        const w = windows[d];
        const dayLabel = d === 0 ? 'today' : `${d}d ago`;
        if (w.buys + w.sells === 0) {
          lines.push(`║   ${dayLabel.padEnd(8)} —`);
        } else {
          lines.push(
            `║   ${dayLabel.padEnd(8)} ${w.buys}b/${w.sells}s  +${w.buyGp}gp/-${w.sellGp}gp`,
          );
        }
      }
      lines.push(`╠ Customers`);
      lines.push(`║   Unique tracked: ${uniqueCustomers}`);
      if (topCustomer) {
        lines.push(
          `║   Top buyer: 0x${(topCustomer.serial >>> 0).toString(16)}  ` +
          `(${topCustomer.buys ?? 0} buys / ${topCustomer.visits ?? 0} visits)`,
        );
      }
      if (mostHaggleFailsCust) {
        lines.push(
          `║   Most haggle fails: 0x${(mostHaggleFailsCust >>> 0).toString(16)} (${mostHaggleFails})`,
        );
      }
      lines.push(`╠ Log`);
      lines.push(`║   Recent: ${logBuys}b (+${logBuyGold}gp) / ${logSells}s (-${logSellGold}gp)`);
      lines.push(`║   Oldest entry: ${ago(firstTs)}    Last activity: ${ago(lastTs)}`);
      lines.push(`╙─`);

      // Wave 22: paginated full-log secondary gump. Defined before
      // the main bio gump send so the response handler can reference
      // it. Recursive: prev/next buttons re-call sendLogPage(idx).
      const PAGE_SIZE = 10;
      const sendLogPage = (pageIdx) => {
        if (!api.gumps?.send) return;
        const totalPages = Math.max(1, Math.ceil(log.length / PAGE_SIZE));
        const safe = Math.max(0, Math.min(totalPages - 1, pageIdx));
        const start = log.length - (safe + 1) * PAGE_SIZE;
        const slice = log.slice(Math.max(0, start), Math.max(0, start + PAGE_SIZE));
        const W = 460, H = 280;
        const lout = [
          `{ resizepic 0 0 5054 ${W} ${H} }`,
          `{ text 16 14 1153 0 }`,
        ];
        const tx = [`${vendor.name} — Transaction Log (page ${safe + 1}/${totalPages})`];
        let yy = 40;
        let ti = 1;
        for (let i = slice.length - 1; i >= 0; i--) {
          const t = slice[i];
          const cust = t.customerName ?? `0x${(t.customerSerial >>> 0).toString(16)}`;
          lout.push(`{ text 16 ${yy} 1152 ${ti} }`);
          tx.push(`${ago(t.ts).padEnd(8)} ${t.type.toUpperCase().padEnd(4)} ${cust}  ${t.itemCount} item(s)  ${t.gold} gp`);
          ti++; yy += 14;
        }
        if (!slice.length) {
          lout.push(`{ text 16 ${yy} 1152 ${ti} }`);
          tx.push('  (empty page)');
          ti++;
        }
        // Pagination buttons.
        if (safe + 1 < totalPages) {
          lout.push(`{ button 16 ${H - 30} 4014 4015 1 0 300 }`);
          lout.push(`{ text 48 ${H - 30} 1153 ${ti} }`);
          tx.push('Older');
          ti++;
        }
        if (safe > 0) {
          lout.push(`{ button 130 ${H - 30} 4014 4015 1 0 301 }`);
          lout.push(`{ text 162 ${H - 30} 1153 ${ti} }`);
          tx.push('Newer');
          ti++;
        }
        lout.push(`{ button ${W - 60} ${H - 30} 4020 4021 1 0 0 }`);
        lout.push(`{ text ${W - 30} ${H - 30} 1153 ${ti} }`);
        tx.push('OK');
        api.gumps.send(ctx.state, {
          gumpId: 0xB10B10B3, x: 80, y: 60,
          layout: lout.join(''), texts: tx,
        }, (r) => {
          const b = r?.buttonId | 0;
          if (b === 300) sendLogPage(safe + 1);
          else if (b === 301) sendLogPage(safe - 1);
        });
      };

      // Wave 20: prefer the proper server-gump UI when the gump host
      // is wired (most clients on this shard). The text readout is
      // kept as fallback for headless / scripted clients.
      if (api.gumps?.send) {
        const PAGE_W = 380;
        const PAGE_H = 320;
        const layout = [
          `{ resizepic 0 0 5054 ${PAGE_W} ${PAGE_H} }`,
          // Header
          `{ text 16 14 1153 0 }`,
          `{ text 16 30 1152 1 }`,
          `{ text 16 46 1152 2 }`,
        ];
        const texts = [
          `${vendor.name}${vendor.title ? `, ${vendor.title}` : ''}`,
          `Trade: ${vendor.vendorKind ?? 'generic'}    Tier: ${tier}`,
          `Lifetime buys: ${buys}    Unique customers: ${uniqueCustomers}`,
        ];
        let txIdx = 3;
        let y = 70;
        // Activity stripe
        layout.push(`{ text 16 ${y} 1153 ${txIdx} }`);
        texts.push('— Activity (last 7 days) —');
        txIdx++; y += 16;
        for (let d = 0; d < windows.length; d++) {
          const w = windows[d];
          const dayLabel = d === 0 ? 'today' : `${d}d ago`;
          const line = (w.buys + w.sells === 0)
            ? `${dayLabel.padEnd(8)} —`
            : `${dayLabel.padEnd(8)} ${w.buys}b/${w.sells}s  +${w.buyGp}gp/-${w.sellGp}gp`;
          layout.push(`{ text 32 ${y} 1152 ${txIdx} }`);
          texts.push(line);
          txIdx++; y += 14;
        }
        y += 6;
        // Customers — Wave 21 makes each customer name a button that
        // dumps that player's transaction history with the vendor as
        // a system message (acts like `[shoplog player <name>`).
        layout.push(`{ text 16 ${y} 1153 ${txIdx} }`); txIdx++; y += 16;
        texts.push('— Customers —');
        const customerButtons = new Map();
        if (topCustomer) {
          // Button (4011/4012 = small arrow up) just left of the text.
          const btnId = 100;
          customerButtons.set(btnId, topCustomer.serial);
          layout.push(`{ button 32 ${y} 4011 4012 1 0 ${btnId} }`);
          layout.push(`{ text 56 ${y} 1152 ${txIdx} }`);
          texts.push(`Top buyer: 0x${(topCustomer.serial >>> 0).toString(16)} (${topCustomer.buys ?? 0} buys)`);
          txIdx++; y += 18;
        }
        if (mostHaggleFailsCust) {
          const btnId = 101;
          customerButtons.set(btnId, mostHaggleFailsCust);
          layout.push(`{ button 32 ${y} 4011 4012 1 0 ${btnId} }`);
          layout.push(`{ text 56 ${y} 1152 ${txIdx} }`);
          texts.push(`Most failed haggles: 0x${(mostHaggleFailsCust >>> 0).toString(16)} (${mostHaggleFails})`);
          txIdx++; y += 18;
        }
        // Footer log
        y += 6;
        layout.push(`{ text 16 ${y} 1153 ${txIdx} }`); txIdx++; y += 16;
        texts.push('— Log —');
        layout.push(`{ text 32 ${y} 1152 ${txIdx} }`);
        texts.push(`Recent: ${logBuys}b (+${logBuyGold}gp) / ${logSells}s (-${logSellGold}gp)`);
        txIdx++; y += 14;
        layout.push(`{ text 32 ${y} 1152 ${txIdx} }`);
        texts.push(`Oldest: ${ago(firstTs)}    Last: ${ago(lastTs)}`);
        txIdx++;
        // Wave 22: "View Full Log" button — opens a secondary gump
        // listing the entire transaction ring buffer with simple
        // pagination (10 entries per page, prev/next controls).
        layout.push(`{ button 16 ${PAGE_H - 30} 4014 4015 1 0 200 }`);
        layout.push(`{ text 48 ${PAGE_H - 30} 1153 ${txIdx} }`);
        texts.push('View Full Log');
        txIdx++;
        // Wave 23: "Export CSV" button — writes a CSV with the full
        // transaction log to saves/. Useful for spreadsheet pivot
        // analysis, balance audits, refund disputes.
        layout.push(`{ button 160 ${PAGE_H - 30} 4014 4015 1 0 201 }`);
        layout.push(`{ text 192 ${PAGE_H - 30} 1153 ${txIdx} }`);
        texts.push('Export CSV');
        txIdx++;
        // Wave 24: "Haggle History" button — opens a secondary gump
        // listing every customer with non-zero haggle activity (wins
        // or fails), sorted by total attempts.
        layout.push(`{ button 270 ${PAGE_H - 30} 4014 4015 1 0 202 }`);
        layout.push(`{ text 302 ${PAGE_H - 30} 1153 ${txIdx} }`);
        texts.push('Haggle Log');
        txIdx++;
        // Wave 25: "Top 10" button — secondary gump listing the top
        // customers by total gold spend across the transaction ring.
        // Buy gold counted as positive contribution; sells subtract
        // (the player took gold OUT of the vendor) — the resulting
        // metric is "net throughput" per customer.
        layout.push(`{ button 16 ${PAGE_H - 56} 4014 4015 1 0 203 }`);
        layout.push(`{ text 48 ${PAGE_H - 56} 1153 ${txIdx} }`);
        texts.push('Top 10');
        txIdx++;
        // Wave 26: GM-only title override (textentry + Set button).
        // Empty input clears `_customTitle` (reverts to auto-tier).
        const isStaffBio = ctx.state?.account?.accessLevel === 'GM'
                        || ctx.state?.account?.accessLevel === 'Admin';
        let titleEntryId = -1;
        if (isStaffBio) {
          const ty = PAGE_H - 56;
          layout.push(`{ text 130 ${ty} 1153 ${txIdx} }`); texts.push('Title:'); txIdx++;
          titleEntryId = 1;
          layout.push(`{ textentry 170 ${ty} 130 18 1152 ${titleEntryId} ${txIdx} }`);
          texts.push(vendor._customTitle ?? '');
          txIdx++;
          layout.push(`{ button 304 ${ty} 4023 4024 1 0 204 }`);
          layout.push(`{ text 332 ${ty} 1153 ${txIdx} }`); texts.push('Set'); txIdx++;
        }
        // Close button
        layout.push(`{ button ${PAGE_W - 60} ${PAGE_H - 30} 4020 4021 1 0 0 }`);
        layout.push(`{ text ${PAGE_W - 30} ${PAGE_H - 30} 1153 ${txIdx} }`);
        texts.push('OK');
        api.gumps.send(ctx.state, {
          gumpId: 0xB10B10B1,
          x: 120, y: 80,
          layout: layout.join(''),
          texts,
        }, (resp) => {
          const btnId = resp?.buttonId | 0;
          // Wave 22: "View Full Log" button → secondary paginated gump.
          // Opens at page 1; pageBtn ids 300/301 navigate. Recursive
          // re-send keeps the open page in scope.
          if (btnId === 200) {
            sendLogPage(0);
            return;
          }
          // Wave 26: Set custom title (GM textentry + Set button).
          if (btnId === 204 && isStaffBio) {
            const entry = resp?.textEntries?.find?.((e) => e.entryId === titleEntryId);
            const raw = String(entry?.text ?? '').trim();
            if (raw.length > 60) {
              ctx.state.sendSystemMessage('Custom title too long (max 60 chars).');
              return;
            }
            if (!raw) {
              delete vendor._customTitle;
              // Don't blow away vendor.title — refreshVendorTitle on
              // next [vendor refreshVendorTitle invocation (next buy)
              // will recompute. For immediate visual, clear so the
              // mob OPL renders the bare name.
              vendor.title = null;
              ctx.state.sendSystemMessage(`Cleared custom title on ${vendor.name} (auto-tier resumes on next sale).`);
            } else {
              vendor._customTitle = raw;
              vendor.title = raw;
              ctx.state.sendSystemMessage(`Set custom title on ${vendor.name}: "${raw}".`);
            }
            const provider = ctx.state?.ctx?.propertyProvider;
            if (provider && api.properties?.nudge && api.properties?.computeHash) {
              const r = provider(vendor.serial, ctx.state);
              if (r?.entries) api.properties.nudge(ctx.state, vendor.serial, api.properties.computeHash(r.entries));
            }
            return;
          }
          // Wave 25: "Top 10" button — secondary gump z customer
          // throughput ranking (sum buy gold − sum sell gold per
          // customer in transaction log).
          if (btnId === 203) {
            if (!api.gumps?.send) {
              ctx.state.sendSystemMessage('Gump host unavailable.');
              return;
            }
            const tally = new Map();
            for (const t of (log ?? [])) {
              const cs = t.customerSerial >>> 0;
              const cn = t.customerName ?? null;
              const row = tally.get(cs) ?? { serial: cs, name: cn, buyGp: 0, sellGp: 0, buys: 0, sells: 0 };
              row.name ??= cn;
              if (t.type === 'buy')  { row.buys++;  row.buyGp  += t.gold ?? 0; }
              if (t.type === 'sell') { row.sells++; row.sellGp += t.gold ?? 0; }
              tally.set(cs, row);
            }
            const rows = [...tally.values()]
              .map((r) => ({ ...r, net: r.buyGp - r.sellGp }))
              .filter((r) => r.buys + r.sells > 0)
              .sort((a, b) => b.net - a.net)
              .slice(0, 10);
            const W = 480, ROW_H = 16;
            const H = 80 + Math.max(rows.length, 1) * ROW_H + 40;
            const lout = [
              `{ resizepic 0 0 5054 ${W} ${H} }`,
              `{ text 16 14 1153 0 }`,
              `{ text 16 30 1153 1 }`,
              `{ text 200 30 1153 2 }`,
              `{ text 270 30 1153 3 }`,
              `{ text 340 30 1153 4 }`,
              `{ text 410 30 1153 5 }`,
            ];
            const tx = [
              `${vendor.name} — Top 10 customers (current ring of ${(log ?? []).length})`,
              'Customer', 'Buys', 'Sells', 'Net gp', 'Δ',
            ];
            let ti = 6;
            let yy = 50;
            for (let i = 0; i < rows.length; i++) {
              const r = rows[i];
              const target = mobileBySerial({ world }, r.serial);
              const dispName = r.name ?? target?.name ?? `0x${r.serial.toString(16)}`;
              const delta = r.net >= 0 ? `+${r.net}` : String(r.net);
              lout.push(`{ text 16 ${yy} 1152 ${ti} }`); tx.push(`${i + 1}. ${dispName}`); ti++;
              lout.push(`{ text 200 ${yy} 1152 ${ti} }`); tx.push(String(r.buys)); ti++;
              lout.push(`{ text 270 ${yy} 1152 ${ti} }`); tx.push(String(r.sells)); ti++;
              lout.push(`{ text 340 ${yy} 1152 ${ti} }`); tx.push(`${r.buyGp}/${r.sellGp}`); ti++;
              lout.push(`{ text 410 ${yy} 1152 ${ti} }`); tx.push(delta); ti++;
              yy += ROW_H;
            }
            if (!rows.length) {
              lout.push(`{ text 16 ${yy} 1152 ${ti} }`); tx.push('(no transactions in current ring)'); ti++;
            }
            lout.push(`{ button ${W - 60} ${H - 30} 4020 4021 1 0 0 }`);
            lout.push(`{ text ${W - 30} ${H - 30} 1153 ${ti} }`);
            tx.push('OK');
            api.gumps.send(ctx.state, {
              gumpId: 0xB10B10B6, x: 80, y: 60,
              layout: lout.join(''), texts: tx,
            });
            return;
          }
          // Wave 24: "Haggle Log" button — secondary gump.
          if (btnId === 202) {
            if (!api.gumps?.send) {
              ctx.state.sendSystemMessage('Gump host unavailable.');
              return;
            }
            const rows = [];
            if (history && history instanceof Map) {
              for (const [serial, h] of history) {
                const wins = h.haggleWins ?? 0;
                const fails = h.haggleFails ?? 0;
                if (wins + fails === 0) continue;
                rows.push({ serial, wins, fails, total: wins + fails });
              }
            }
            rows.sort((a, b) => b.total - a.total);
            const W = 420, ROW_H = 16;
            const cap = 16;
            const slice = rows.slice(0, cap);
            const H = 80 + Math.max(slice.length, 1) * ROW_H + 40;
            const lout = [
              `{ resizepic 0 0 5054 ${W} ${H} }`,
              `{ text 16 14 1153 0 }`,
              `{ text 16 30 1153 1 }`,
              `{ text 220 30 1153 2 }`,
              `{ text 280 30 1153 3 }`,
              `{ text 340 30 1153 4 }`,
            ];
            const tx = [
              `${vendor.name} — Haggle Log (${rows.length} customers)`,
              'Customer', 'Wins', 'Fails', 'Total',
            ];
            let ti = 5;
            let yy = 50;
            for (const r of slice) {
              const target = mobileBySerial({ world }, r.serial >>> 0);
              const name = target?.name ?? `0x${(r.serial >>> 0).toString(16)}`;
              lout.push(`{ text 16 ${yy} 1152 ${ti} }`); tx.push(name); ti++;
              lout.push(`{ text 220 ${yy} 1152 ${ti} }`); tx.push(String(r.wins)); ti++;
              lout.push(`{ text 280 ${yy} 1152 ${ti} }`); tx.push(String(r.fails)); ti++;
              lout.push(`{ text 340 ${yy} 1152 ${ti} }`); tx.push(String(r.total)); ti++;
              yy += ROW_H;
            }
            if (!slice.length) {
              lout.push(`{ text 16 ${yy} 1152 ${ti} }`); tx.push('(no haggle activity recorded)'); ti++;
            }
            if (rows.length > cap) {
              lout.push(`{ text 16 ${yy + 4} 1152 ${ti} }`); tx.push(`… ${rows.length - cap} more not shown.`); ti++;
            }
            lout.push(`{ button ${W - 60} ${H - 30} 4020 4021 1 0 0 }`);
            lout.push(`{ text ${W - 30} ${H - 30} 1153 ${ti} }`);
            tx.push('OK');
            api.gumps.send(ctx.state, {
              gumpId: 0xB10B10B5, x: 100, y: 80,
              layout: lout.join(''), texts: tx,
            });
            return;
          }
          // Wave 23: "Export CSV" button.
          if (btnId === 201) {
            (async () => {
              try {
                const fs = await import('node:fs');
                const path = await import('node:path');
                const saveDir = api.persistence?.saveDir
                             ?? path.resolve(process.cwd(), 'saves');
                const fname = `vendor-csv-${(vendor.serial >>> 0).toString(16)}-${Date.now()}.csv`;
                const target = path.join(saveDir, fname);
                const header = 'timestamp,iso_time,type,customer_serial,customer_name,item_count,gold\n';
                const rows = (log ?? []).map((t) => {
                  const cust = (t.customerName ?? '').replace(/[",\n]/g, ' ');
                  return [
                    t.ts ?? 0,
                    new Date(t.ts ?? 0).toISOString(),
                    t.type ?? '',
                    `0x${(t.customerSerial >>> 0).toString(16)}`,
                    `"${cust}"`,
                    t.itemCount ?? 0,
                    t.gold ?? 0,
                  ].join(',');
                }).join('\n');
                await fs.promises.mkdir(saveDir, { recursive: true });
                await fs.promises.writeFile(target, header + rows + '\n');
                ctx.state.sendSystemMessage(`Exported ${(log ?? []).length} rows to ${target}`);
              } catch (e) {
                ctx.state.sendSystemMessage(`Export failed: ${e.message}`);
              }
            })();
            return;
          }
          // Wave 21: customer button → dump that player's transactions
          // with this vendor as a system message. Mirrors what the
          // GM would get from `[shoplog player <name>`.
          const targetSerial = customerButtons.get(btnId);
          if (!targetSerial) return;
          const targetMob = mobileBySerial({ world }, targetSerial >>> 0);
          const name = targetMob?.name ?? `0x${(targetSerial >>> 0).toString(16)}`;
          const matches = (vendor._transactionLog ?? []).filter(
            (t) => (t.customerSerial >>> 0) === (targetSerial >>> 0),
          );
          if (!matches.length) {
            ctx.state.sendSystemMessage(`No transactions on file for ${name}.`);
            return;
          }
          const buys = matches.filter((t) => t.type === 'buy');
          const sells = matches.filter((t) => t.type === 'sell');
          const buyGold = buys.reduce((s, t) => s + (t.gold ?? 0), 0);
          const sellGold = sells.reduce((s, t) => s + (t.gold ?? 0), 0);
          const out = [`${name} ↔ ${vendor.name}: ${matches.length} transactions`];
          for (let i = matches.length - 1; i >= 0 && out.length < 20; i--) {
            const t = matches[i];
            const dt = ago(t.ts);
            out.push(`  ${dt.padEnd(8)} ${t.type.toUpperCase().padEnd(4)} ${t.itemCount} item(s)  ${t.gold} gp`);
          }
          out.push(`  ── ${buys.length} buys (${buyGold} gp) / ${sells.length} sells (${sellGold} gp)`);
          ctx.state.sendSystemMessage(out.join('\n'));
        });
        return;
      }
      ctx.state.sendSystemMessage(lines.join('\n'));
    },
  });

  return () => commands.unregister('vendorbio');
}
