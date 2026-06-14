// `[imbueinfo <serial>` — visual budget breakdown for a magic item.
// Mirrors ServUO's "Imbuing Info" gump: a horizontal progress bar
// showing used/total weight, plus a per-property table with each
// affix's individual weight contribution.
//
// Falls back to a system message when the gump host isn't wired so
// headless / scripted clients still get the data.

import { recordImbueAuditEvent } from './imbue-audit.js';
import { resolveItemArg } from '../_targeting-helpers.js';
import { findBackpack, isInPack } from '../../_inventory.js';

const PAGE_W = 380;
const PAGE_H = 260;
const BAR_X = 24;
const BAR_Y = 60;
const BAR_W = PAGE_W - 48;
const BAR_H = 18;
const DEFAULT_BUDGET = 500;

export default function (api) {
  const { commands } = api;
  if (!commands) return () => {};

  // Wave 28: locked items also reject double-click Use. Returning
  // truthy from a useItem hook short-circuits the chain — the system
  // message lands in the player's journal so they know why nothing
  // happened. Only triggers when the item itself carries the lock.
  api.templates?.addUseItemHook?.((world, item, user) => {
    if (!item._imbueLocked) return false;
    user.client?.sendSystemMessage?.('That item is locked and cannot be used.');
    return true;
  });

  commands.register({
    name: 'imbueinfo',
    help: '[imbueinfo [serial] — visual breakdown of a magic item\'s budget. No serial → cursor target.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      if (!mob) return;
      // Wave 34: cursor target fallback when called without args.
      resolveItemArg(api, ctx, 0, (item) => {
        if (!item) return;
      const pack = findBackpack(api, mob);
      if (!pack || !isInPack(api, item, mob)) {
        ctx.state.sendSystemMessage('You can only inspect items you carry.');
        return;
      }
      const props = Array.isArray(item._magicProps) ? item._magicProps : [];
      if (props.length === 0) {
        ctx.state.sendSystemMessage('That item has no magic properties.');
        return;
      }
      // Resolve magic-properties catalog so we can look up scale per
      // attribute. Aggregate weight + per-row data.
      const allProps = api.systems?.loot?.allMagicProperties?.()
                    ?? api.loot?.allMagicProperties?.()
                    ?? [];
      const rows = [];
      let used = 0;
      for (const p of props) {
        if (p.kind !== 'attr') continue;
        const def = allProps.find((a) => a.attribute === p.attribute);
        const scale = def?.scale ?? 1;
        const weight = Math.max(1, Math.round((p.intensity ?? 0) * (scale || 1)));
        used += weight;
        rows.push({
          attribute: p.attribute,
          intensity: p.intensity ?? 0,
          scale,
          weight,
          isFlag: !!p.isFlag,
        });
      }
      const cap = Number.isFinite(item._imbueBudget) ? item._imbueBudget : DEFAULT_BUDGET;
      const filledW = Math.max(0, Math.min(BAR_W, Math.round((used / cap) * BAR_W)));

      // Fallback: text dump.
      if (!api.gumps?.send) {
        const lines = [
          `${item.name ?? 'Item'} — imbue budget ${used}/${cap}:`,
          ...rows.map((r) =>
            `  ${r.attribute.padEnd(28)} i=${String(r.intensity).padStart(3)}  weight=${r.weight}` +
            (r.isFlag ? ' (flag)' : ''),
          ),
        ];
        ctx.state.sendSystemMessage(lines.join('\n'));
        return;
      }

      // Gump path. resizepic 5054 (parchment) bg; gumpic 9300 / 9304
      // make passable progress-bar fill (the inner bar uses a flat
      // ResizePic 5057 stretched to the filled width — a budget hint
      // bar, not a UI staple, so we keep it simple).
      const layout = [
        `{ resizepic 0 0 5054 ${PAGE_W} ${PAGE_H} }`,
        `{ text 16 14 1153 0 }`,                               // header
        `{ text 16 32 1152 1 }`,                               // sub
        // Background bar (frame).
        `{ resizepic ${BAR_X} ${BAR_Y} 5057 ${BAR_W} ${BAR_H} }`,
      ];
      const texts = [
        `${item.name ?? `item id 0x${(item.itemId | 0).toString(16)}`} — Imbue Info`,
        `Weight: ${used} / ${cap}`,
      ];
      if (filledW > 0) {
        // Inner fill — use a different resizepic id so visually distinct.
        // 9300 = "leaf" graphic, gives a green-ish strip under the frame.
        layout.push(`{ resizepic ${BAR_X + 2} ${BAR_Y + 2} 9300 ${Math.max(8, filledW - 4)} ${BAR_H - 4} }`);
      }

      let txIdx = 2;
      let y = BAR_Y + BAR_H + 14;
      // Column headers.
      layout.push(`{ text 24 ${y} 1153 ${txIdx} }`); texts.push('Property'); txIdx++;
      layout.push(`{ text 220 ${y} 1153 ${txIdx} }`); texts.push('Intensity'); txIdx++;
      layout.push(`{ text 300 ${y} 1153 ${txIdx} }`); texts.push('Weight'); txIdx++;
      y += 16;
      const rowMax = 8;
      for (const r of rows.slice(0, rowMax)) {
        layout.push(`{ text 24 ${y} 1152 ${txIdx} }`); texts.push(r.isFlag ? `${r.attribute} ✦` : r.attribute); txIdx++;
        layout.push(`{ text 220 ${y} 1152 ${txIdx} }`); texts.push(r.isFlag ? '—' : String(r.intensity)); txIdx++;
        layout.push(`{ text 300 ${y} 1152 ${txIdx} }`); texts.push(String(r.weight)); txIdx++;
        y += 14;
      }
      if (rows.length > rowMax) {
        layout.push(`{ text 24 ${y} 1152 ${txIdx} }`); texts.push(`(${rows.length - rowMax} more not shown)`); txIdx++;
      }
      // Wave 24: GMs see an inline budget editor — text input pre-
      // populated with current cap + Save button. Mirrors the
      // `[setbudget` command but skips the typing step. Players see
      // the gump without these controls.
      const isStaff = ctx.state?.account?.accessLevel === 'GM'
                   || ctx.state?.account?.accessLevel === 'Admin';
      let budgetEntryId = -1;
      if (isStaff) {
        // Label + textentry just above the close row.
        const ey = PAGE_H - 56;
        layout.push(`{ text 16 ${ey} 1153 ${txIdx} }`); texts.push('Set budget:'); txIdx++;
        budgetEntryId = 1;
        // textentry x y w h hue entryId initial-text-id
        layout.push(`{ textentry 110 ${ey} 60 18 1152 ${budgetEntryId} ${txIdx} }`);
        texts.push(String(cap));
        txIdx++;
        // Save button (id 100) sits next to the entry.
        layout.push(`{ button 180 ${ey} 4023 4024 1 0 100 }`);
        layout.push(`{ text 210 ${ey} 1153 ${txIdx} }`); texts.push('Save'); txIdx++;
        // Wave 25: "Reset" button (id 101) — wipes _magicProps,
        // clears _artifact / _unidentified / _magicResists / budget
        // override. Useful when GM wants to use an item as a fresh
        // imbuing canvas without re-rolling drop tables.
        layout.push(`{ button 250 ${ey} 4017 4018 1 0 101 }`);
        layout.push(`{ text 280 ${ey} 1153 ${txIdx} }`); texts.push('Reset'); txIdx++;
        // Wave 26: "Roll" button (id 102) — calls loot.js
        // rollMagicProperties to mint random props with the current
        // budget percentage interpreted from cap (cap=500 baseline =
        // budget 0.5; cap=1000 = budget 1.0). Count defaults to 4.
        // The roll respects existing budget; final mix is bounded
        // by intensity × scale just like a normal magic-item drop.
        layout.push(`{ button 320 ${ey} 4023 4024 1 0 102 }`);
        layout.push(`{ text 348 ${ey} 1153 ${txIdx} }`); texts.push('Roll'); txIdx++;
        // Wave 27: Lock toggle (id 103). `_imbueLocked` flag — when
        // true, `[imbue` and `[disenchant` reject the item with a
        // helpful message. GM toggles freely. Useful for canonical
        // boss artifacts the shard wants to preserve verbatim.
        const ly = PAGE_H - 80;
        const isLocked = !!item._imbueLocked;
        // 4011/4012 = up arrow (unlocked), 4017/4018 = X (locked).
        layout.push(`{ button 16 ${ly} ${isLocked ? 4017 : 4011} ${isLocked ? 4018 : 4012} 1 0 103 }`);
        layout.push(`{ text 40 ${ly} 1153 ${txIdx} }`);
        texts.push(isLocked ? 'Locked (click to unlock)' : 'Unlocked (click to lock)');
        txIdx++;
      }

      // Close button.
      layout.push(`{ button ${PAGE_W - 60} ${PAGE_H - 30} 4020 4021 1 0 0 }`);
      layout.push(`{ text ${PAGE_W - 30} ${PAGE_H - 30} 1153 ${txIdx} }`);
      texts.push('OK');

      api.gumps.send(ctx.state, {
        gumpId: 0xB10B10B2,
        x: 120, y: 80,
        layout: layout.join(''),
        texts,
      }, (resp) => {
        if (!isStaff) return;
        const btnId = resp?.buttonId | 0;
        // Wave 27: Lock toggle.
        // Wave 29: stamp who/when on lock so GMs can audit retroactively.
        if (btnId === 103) {
          // Wave 32: also emit a timeline event so [imbueaudit
          // timeline shows lock and unlock history (per-item record
          // only stores latest, not the full history).
          const auditName = item.name ?? `item id 0x${(item.itemId | 0).toString(16)}`;
          if (item._imbueLocked) {
            const wasBy = item._imbueLockedBy;
            delete item._imbueLocked;
            delete item._imbueLockedBy;
            delete item._imbueLockedAt;
            recordImbueAuditEvent({
              type: 'unlock', serial: item.serial >>> 0,
              name: auditName,
              by: ctx.sender?.name ?? '(unknown)',
              prevLockedBy: wasBy,
            });
            ctx.state.sendSystemMessage(`Unlocked 0x${(item.serial >>> 0).toString(16)}.`);
          } else {
            const lockedBy = ctx.sender?.name ?? `0x${(ctx.sender?.serial >>> 0).toString(16)}`;
            item._imbueLocked = true;
            item._imbueLockedBy = lockedBy;
            item._imbueLockedAt = Date.now();
            recordImbueAuditEvent({
              type: 'lock', serial: item.serial >>> 0,
              name: auditName, by: lockedBy,
            });
            ctx.state.sendSystemMessage(
              `Locked 0x${(item.serial >>> 0).toString(16)} — imbue/disenchant blocked.`,
            );
          }
          // Refresh tooltip so the lock readout updates.
          const provider = ctx.state?.ctx?.propertyProvider;
          if (provider && api.properties?.nudge && api.properties?.computeHash) {
            const r = provider(item.serial, ctx.state);
            if (r?.entries) api.properties.nudge(ctx.state, item.serial, api.properties.computeHash(r.entries));
          }
          return;
        }
        // Wave 26: Roll random props.
        if (btnId === 102) {
          const roller = api.systems?.loot?.rollMagicProperties
                      ?? api.loot?.rollMagicProperties;
          if (typeof roller !== 'function') {
            ctx.state.sendSystemMessage('Magic-properties roller not available.');
            return;
          }
          // Map cap → budget 0..1 (cap 500 → 0.5, cap 1000 → 1.0).
          const budget = Math.max(0.1, Math.min(1.0, cap / 1000));
          const rolled = roller({ count: 4, budget });
          if (!Array.isArray(rolled) || !rolled.length) {
            ctx.state.sendSystemMessage('Roll produced no properties.');
            return;
          }
          item._magicProps = rolled.map((p) => ({
            kind: 'attr',
            attribute: p.attribute, group: p.group,
            intensity: p.intensity, cliloc: p.cliloc,
            isFlag: !!p.isFlag,
          }));
          // Refresh tooltip immediately.
          const provider = ctx.state?.ctx?.propertyProvider;
          if (provider && api.properties?.nudge && api.properties?.computeHash) {
            const r = provider(item.serial, ctx.state);
            if (r?.entries) api.properties.nudge(ctx.state, item.serial, api.properties.computeHash(r.entries));
          }
          const summary = rolled.map((p) =>
            p.isFlag ? p.attribute : `${p.attribute}@${p.intensity}`).join(', ');
          ctx.state.sendSystemMessage(
            `Rolled ${rolled.length} props (budget ${(budget * 100).toFixed(0)}%): ${summary}`,
          );
          return;
        }
        // Wave 25: Reset button.
        if (btnId === 101) {
          delete item._magicProps;
          delete item._artifact;
          delete item._magicResists;
          delete item._unidentified;
          delete item._imbueBudget;
          const provider = ctx.state?.ctx?.propertyProvider;
          if (provider && api.properties?.nudge && api.properties?.computeHash) {
            const r = provider(item.serial, ctx.state);
            if (r?.entries) api.properties.nudge(ctx.state, item.serial, api.properties.computeHash(r.entries));
          }
          ctx.state.sendSystemMessage(`Reset 0x${(item.serial >>> 0).toString(16)} — magic props cleared.`);
          return;
        }
        if (btnId !== 100) return;
        const entry = resp?.textEntries?.find?.((e) => e.entryId === budgetEntryId);
        const want = parseInt(entry?.text ?? '', 10);
        if (!Number.isFinite(want) || want < 0 || want > 5000) {
          ctx.state.sendSystemMessage('Budget must be 0..5000.');
          return;
        }
        if (want === 0) delete item._imbueBudget;
        else item._imbueBudget = want;
        const provider = ctx.state?.ctx?.propertyProvider;
        if (provider && api.properties?.nudge && api.properties?.computeHash) {
          const r = provider(item.serial, ctx.state);
          if (r?.entries) api.properties.nudge(ctx.state, item.serial, api.properties.computeHash(r.entries));
        }
        ctx.state.sendSystemMessage(`Budget on 0x${(item.serial >>> 0).toString(16)} → ${want === 0 ? 'default' : want}.`);
      });
      });   // close resolveItemArg cb
    },
  });

  return () => commands.unregister('imbueinfo');
}
