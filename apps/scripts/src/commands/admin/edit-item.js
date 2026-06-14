import { allMobiles } from '../../_spatial.js';
import { itemBySerial } from '../../_entities.js';
// `[edititem [serial]` — GM editor for an item's basic display
// fields. Without a serial argument, the command opens a cursor
// target prompt and the GM clicks the item they want to edit. Once
// the item is identified, a gump appears with text inputs for
// `name`, `hue`, `itemId`, `amount`, plus Save / Close buttons.
// Saving mutates the item in-place, broadcasts a worldItemSA so
// nearby clients see the new visual, and nudges the tooltip cache.
//
// This is the GM's bread-and-butter "make it look right" tool — no
// scripting required to recolor a quest reward, rename a gift, or
// change a stack size.

const HUE_MAX = 0xFFFF;
const ITEM_ID_MAX = 0xFFFF;
const AMOUNT_MAX = 60000;
const NAME_MAX = 60;

function broadcastItemRefresh(api, world, item) {
  if (!api.protocol?.worldItemSA) return;
  // For container-parented items, push the targeted client a
  // containerContentUpdate; for ground items, broadcast worldItemSA
  // to every observer in range.
  if (item.parent) {
    return; // skip — caller refreshes the tooltip via OPL nudge
  }
  const pkt = api.protocol.worldItemSA({
    serial: item.serial, itemId: item.itemId, hue: item.hue ?? 0,
    amount: item.amount ?? 1,
    x: item.x | 0, y: item.y | 0, z: item.z | 0,
  });
  for (const m of allMobiles({ world })) {
    if (!m.client || m.map !== item.map) continue;
    if (Math.abs((m.x | 0) - (item.x | 0)) > 18) continue;
    if (Math.abs((m.y | 0) - (item.y | 0)) > 18) continue;
    m.client.send(pkt);
  }
}

/** CUO checkbox graphic ids — unchecked / checked. ServUO `Gumps.cs`
 *  ids 0x00D2 / 0x00D3 = standard "tick" checkbox. */
const CHECKBOX_OFF = 0x00D2;
const CHECKBOX_ON  = 0x00D3;

/** Map S/E/N/W → housedata 8-piece slot of the closed-side sprite. */
const FACING_SLOT = { south: 0, east: 2, north: 4, west: 6 };

/** Find the door style + piece index in the housedata catalogue.
 *  Returns null when the item isn't a recognised door — caller hides
 *  the facing row in that case. */
function findDoorStyle(housedata, graphicId) {
  let id = graphicId | 0;
  let info = housedata?.doorPiece?.(id);
  let isOpenGraphic = false;
  if (!info) {
    info = housedata?.doorPiece?.(id - 1);
    if (!info) return null;
    id -= 1;
    isOpenGraphic = true;
  }
  const cat = housedata.raw?.doors?.find?.((c) => c.category === info.category);
  if (!cat) return null;
  for (const style of cat.styles ?? []) {
    const pieces = style.pieces ?? [];
    const idx = pieces.indexOf(id);
    if (idx >= 0) return { pieces, pieceIdx: idx, isOpenGraphic };
  }
  return null;
}

/** Apply a door facing flip in-place (used by the gump's facing
 *  buttons). Mirrors the standalone `[doorface` command. */
function flipDoorFacing(api, ctx, item, facing) {
  const style = findDoorStyle(api.housedata, item.itemId);
  if (!style) {
    ctx.state.sendSystemMessage('Not a recognised door — facing change unavailable.');
    return false;
  }
  const slot = FACING_SLOT[facing];
  const closedId = style.pieces[slot];
  const openId   = closedId + 1;
  if (!closedId) {
    ctx.state.sendSystemMessage(`Style is missing slot ${slot}.`);
    return false;
  }
  const wasOpen = item.door?.isOpen ?? style.isOpenGraphic;
  item.itemId = wasOpen ? openId : closedId;
  item.door = {
    ...(item.door ?? {}),
    closedId, openId, isOpen: wasOpen, facing,
  };
  return true;
}

function openEditGump(api, ctx, item) {
  // Gump grows to fit the new rows. Doors get an extra 30 px for the
  // facing buttons; non-doors keep the compact layout.
  const isDoor = !!findDoorStyle(api.housedata, item.itemId);
  const W = 380;
  const H = isDoor ? 320 : 290;

  // Initial flag state — `movable` defaults to true, everything else
  // to false. The save handler diffs against these so an unchanged
  // checkbox is a no-op.
  const initMovable    = item.movable !== false;
  const initNoDecay    = !!item._noDecay;
  const initIsDeco     = !!item.isDecoration;

  const layout = [
    `{ resizepic 0 0 5054 ${W} ${H} }`,
    `{ text 16 14 1153 0 }`,                       // title
    // Labels
    `{ text 16 44 1152 1 }`,
    `{ text 16 70 1152 2 }`,
    `{ text 16 96 1152 3 }`,
    `{ text 16 122 1152 4 }`,
    // Text entries (entryId 1..4 = name/hue/itemId/amount)
    `{ textentry 110 44 250 18 1152 1 5 }`,
    `{ textentry 110 70 250 18 1152 2 6 }`,
    `{ textentry 110 96 250 18 1152 3 7 }`,
    `{ textentry 110 122 250 18 1152 4 8 }`,
    // Flag checkboxes — switchId 1=movable, 2=_noDecay, 3=isDecoration.
    `{ checkbox 16  154 ${CHECKBOX_OFF} ${CHECKBOX_ON} ${initMovable ? 1 : 0} 1 }`,
    `{ text 38  154 1152 11 }`,                    // "Movable"
    `{ checkbox 130 154 ${CHECKBOX_OFF} ${CHECKBOX_ON} ${initNoDecay ? 1 : 0} 2 }`,
    `{ text 152 154 1152 12 }`,                    // "No Decay"
    `{ checkbox 240 154 ${CHECKBOX_OFF} ${CHECKBOX_ON} ${initIsDeco  ? 1 : 0} 3 }`,
    `{ text 262 154 1152 13 }`,                    // "Decoration"
  ];
  const texts = [
    `Edit item 0x${(item.serial >>> 0).toString(16)}`,
    'Name:',
    'Hue (decimal or 0x..):',
    'Item ID (0x..):',
    'Amount:',
    String(item.name ?? ''),
    String((item.hue ?? 0) | 0),
    `0x${((item.itemId ?? 0) | 0).toString(16)}`,
    String((item.amount ?? 1) | 0),
    'Save',
    'Close',
    'Movable',
    'No Decay',
    'Decoration',
  ];

  // Door-only facing row. Each button immediately flips the facing,
  // re-broadcasts, and re-opens the gump so the gump's "Item ID" field
  // reflects the new graphic. ButtonIds 100..103 are reserved.
  if (isDoor) {
    layout.push(`{ text 16 188 1153 14 }`);        // "Facing:"
    const facings = ['S', 'E', 'N', 'W'];
    facings.forEach((f, i) => {
      const x = 84 + i * 60;
      const btnId = 100 + i;
      layout.push(`{ button ${x} 186 4005 4006 1 0 ${btnId} }`);
      layout.push(`{ text ${x + 24} 188 1152 ${15 + i} }`);
    });
    texts.push('Facing:', 'S', 'E', 'N', 'W');
  }

  // Save / Close at the bottom.
  layout.push(`{ button 24  ${H - 30} 4023 4024 1 0 1 }`);
  layout.push(`{ text 56  ${H - 30} 1153 9 }`);
  layout.push(`{ button 220 ${H - 30} 4020 4021 1 0 0 }`);
  layout.push(`{ text 252 ${H - 30} 1153 10 }`);

  api.gumps.send(ctx.state, {
    gumpId: 0xED17ED17, x: 100, y: 80,
    layout: layout.join(''), texts,
  }, (resp) => {
    const btn = resp?.buttonId | 0;

    // Door facing buttons (100..103). Apply, refresh, re-open.
    if (isDoor && btn >= 100 && btn <= 103) {
      const facing = ['south', 'east', 'north', 'west'][btn - 100];
      if (flipDoorFacing(api, ctx, item, facing)) {
        const ctxWorld = ctx.state.ctx?.world ?? api.world;
        broadcastItemRefresh(api, ctxWorld, item);
        ctx.state.sendSystemMessage(`Door faced ${facing} (itemId=0x${item.itemId.toString(16)}).`);
      }
      // Re-open with the (possibly) new itemId so the user can keep tweaking.
      openEditGump(api, ctx, item);
      return;
    }

    if (btn !== 1) return;                          // Close (or unknown)

    const findText = (id) => resp.textEntries?.find?.((e) => e.entryId === id)?.text ?? '';
    const newName = findText(1).trim().slice(0, NAME_MAX);
    const newHueRaw = findText(2).trim();
    const newItemIdRaw = findText(3).trim();
    const newAmountRaw = findText(4).trim();
    const parseNum = (s) => /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);

    const newHue = newHueRaw ? parseNum(newHueRaw) : (item.hue ?? 0);
    const newItemId = newItemIdRaw ? parseNum(newItemIdRaw) : item.itemId;
    const newAmount = newAmountRaw ? parseNum(newAmountRaw) : (item.amount ?? 1);

    if (!Number.isFinite(newHue) || newHue < 0 || newHue > HUE_MAX) {
      ctx.state.sendSystemMessage(`Hue out of range (0..0x${HUE_MAX.toString(16)}).`);
      return;
    }
    if (!Number.isFinite(newItemId) || newItemId < 1 || newItemId > ITEM_ID_MAX) {
      ctx.state.sendSystemMessage(`Item ID out of range (1..0x${ITEM_ID_MAX.toString(16)}).`);
      return;
    }
    if (!Number.isFinite(newAmount) || newAmount < 1 || newAmount > AMOUNT_MAX) {
      ctx.state.sendSystemMessage(`Amount out of range (1..${AMOUNT_MAX}).`);
      return;
    }
    // Resolve the checked switches. CUO sends only the switchIds whose
    // checkbox ended in the "on" state; absent ids = unchecked.
    const onSet = new Set((resp.switches ?? []).map((s) => (s.switchId ?? s) | 0));
    const newMovable = onSet.has(1);
    const newNoDecay = onSet.has(2);
    const newIsDeco  = onSet.has(3);

    const changes = [];
    if (newName !== (item.name ?? '')) {
      changes.push(`name="${newName}"`);
      item.name = newName || undefined;
    }
    if (newHue !== (item.hue ?? 0)) {
      changes.push(`hue=0x${newHue.toString(16)}`);
      item.hue = newHue;
    }
    if (newItemId !== item.itemId) {
      changes.push(`itemId=0x${newItemId.toString(16)}`);
      item.itemId = newItemId;
    }
    if (newAmount !== (item.amount ?? 1)) {
      changes.push(`amount=${newAmount}`);
      item.amount = newAmount;
    }
    if (newMovable !== initMovable) {
      changes.push(`movable=${newMovable}`);
      item.movable = newMovable;
    }
    if (newNoDecay !== initNoDecay) {
      changes.push(`_noDecay=${newNoDecay}`);
      // `undefined` rather than `false` so the field is dropped from the
      // serialized snapshot when toggled off — keeps the save tidy.
      item._noDecay = newNoDecay ? true : undefined;
    }
    if (newIsDeco !== initIsDeco) {
      changes.push(`isDecoration=${newIsDeco}`);
      item.isDecoration = newIsDeco ? true : undefined;
    }
    if (!changes.length) {
      ctx.state.sendSystemMessage('No changes.');
      return;
    }
    // Visual broadcast (ground items) + tooltip cache invalidate.
    const ctxWorld = ctx.state.ctx?.world ?? api.world;
    broadcastItemRefresh(api, ctxWorld, item);
    if (item.parent && api.protocol?.containerContentUpdate) {
      // Container item — push containerContentUpdate to the parent owner.
      ctx.state.send(api.protocol.containerContentUpdate(item, item.parent));
    }
    const provider = ctx.state?.ctx?.propertyProvider;
    if (provider && api.properties?.nudge && api.properties?.computeHash) {
      const r = provider(item.serial, ctx.state);
      if (r?.entries) api.properties.nudge(ctx.state, item.serial, api.properties.computeHash(r.entries));
    }
    ctx.state.sendSystemMessage(`Updated 0x${(item.serial >>> 0).toString(16)}: ${changes.join(', ')}.`);
  });
}

export default function (api) {
  const { commands, world } = api;
  if (!commands) return () => {};

  commands.register({
    name: 'edititem',
    help: '[edititem [serial] | [edititem multi <N> — single or batch GM gump editor.',
    access: 'GM',
    run(ctx) {
      if (!api.gumps?.send) {
        ctx.state.sendSystemMessage('Gump host unavailable.');
        return;
      }
      // Wave 35: `[edititem multi <N>` — chain N cursor target
      // prompts, accumulate items, then open ONE gump that applies
      // hue/itemId/amount changes to every item. Name is skipped in
      // multi mode (each item likely deserves its own).
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      if (sub === 'multi') {
        const n = Math.max(1, Math.min(10, parseInt(ctx.args[1], 10) || 0));
        if (!n) {
          ctx.state.sendSystemMessage('Usage: [edititem multi <N>  (N=1..10)');
          return;
        }
        if (!api.targeting?.request) {
          ctx.state.sendSystemMessage('Targeting host unavailable.');
          return;
        }
        const picked = [];
        // Wave 36: bad-pick recovery. Three consecutive misclicks
        // (mob, ground tile) abort the chain so a flailing GM
        // doesn't loop forever. Each valid pick resets the counter.
        let consecutiveBad = 0;
        const collectNext = () => {
          ctx.state.sendSystemMessage(`Pick item ${picked.length + 1}/${n}…`);
          api.targeting.request(ctx.state, (sel) => {
            if (!sel) {
              if (picked.length === 0) { ctx.state.sendSystemMessage('Multi-edit canceled.'); return; }
              ctx.state.sendSystemMessage(`Pick aborted — proceeding with ${picked.length} items.`);
              openMultiEditGump(api, ctx, picked);
              return;
            }
            const it = itemBySerial({ world }, sel.serial >>> 0);
            if (!it) {
              consecutiveBad++;
              if (consecutiveBad >= 3) {
                if (picked.length === 0) {
                  ctx.state.sendSystemMessage('Three bad picks — multi-edit aborted.');
                  return;
                }
                ctx.state.sendSystemMessage(
                  `Three bad picks — proceeding with ${picked.length} items collected so far.`,
                );
                openMultiEditGump(api, ctx, picked);
                return;
              }
              ctx.state.sendSystemMessage(
                `Selection was not an item (${consecutiveBad}/3 bad picks) — try again.`,
              );
              collectNext();
              return;
            }
            consecutiveBad = 0;
            picked.push(it);
            if (picked.length >= n) {
              openMultiEditGump(api, ctx, picked);
              return;
            }
            collectNext();
          });
        };
        collectNext();
        return;
      }

      const arg = ctx.args[0];
      if (arg) {
        const serial = (/^0x/i.test(arg) ? parseInt(arg, 16) : parseInt(arg, 10)) >>> 0;
        const item = itemBySerial({ world }, serial);
        if (!item) { ctx.state.sendSystemMessage('No such item.'); return; }
        openEditGump(api, ctx, item);
        return;
      }
      // No serial → cursor target prompt.
      if (!api.targeting?.request) {
        ctx.state.sendSystemMessage('Targeting host unavailable. Pass a serial.');
        return;
      }
      ctx.state.sendSystemMessage('Target the item to edit…');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked) { ctx.state.sendSystemMessage('Edit canceled.'); return; }
        const item = itemBySerial({ world }, picked.serial >>> 0);
        if (!item) { ctx.state.sendSystemMessage('Selection was not an item.'); return; }
        openEditGump(api, ctx, item);
      });
    },
  });

  return () => commands.unregister('edititem');
}

/**
 * Wave 35: batch edit gump — applies a single hue/itemId/amount
 * value to every item in `items[]`. Name is intentionally omitted
 * (mass-renaming would usually be a script job, not a quick GM
 * adjustment). Empty fields = leave unchanged for that field.
 */
function openMultiEditGump(api, ctx, items) {
  const W = 380, H = 240;
  const layout = [
    `{ resizepic 0 0 5054 ${W} ${H} }`,
    `{ text 16 14 1153 0 }`,
    `{ text 16 36 1152 1 }`,
    `{ text 16 70 1152 2 }`,
    `{ text 16 96 1152 3 }`,
    `{ text 16 122 1152 4 }`,
    `{ textentry 110 70 230 18 1152 1 5 }`,
    `{ textentry 110 96 230 18 1152 2 6 }`,
    `{ textentry 110 122 230 18 1152 3 7 }`,
    `{ button 24 ${H - 30} 4023 4024 1 0 1 }`,
    `{ text 56 ${H - 30} 1153 8 }`,
    `{ button 200 ${H - 30} 4020 4021 1 0 0 }`,
    `{ text 232 ${H - 30} 1153 9 }`,
  ];
  const texts = [
    `Batch edit — ${items.length} items`,
    'Leave a field blank to keep its current value.',
    'Hue:', 'Item ID (0x..):', 'Amount:',
    '', '', '',     // entries empty
    'Apply', 'Close',
  ];
  api.gumps.send(ctx.state, {
    gumpId: 0xED17ED18, x: 100, y: 80,
    layout: layout.join(''), texts,
  }, (resp) => {
    if ((resp?.buttonId | 0) !== 1) return;
    const findText = (id) => resp.textEntries?.find?.((e) => e.entryId === id)?.text ?? '';
    const parseNum = (s) => /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
    const hueRaw = findText(1).trim();
    const itemIdRaw = findText(2).trim();
    const amountRaw = findText(3).trim();
    const newHue = hueRaw ? parseNum(hueRaw) : null;
    const newItemId = itemIdRaw ? parseNum(itemIdRaw) : null;
    const newAmount = amountRaw ? parseNum(amountRaw) : null;
    if (newHue != null && (!Number.isFinite(newHue) || newHue < 0 || newHue > 0xFFFF)) {
      ctx.state.sendSystemMessage('Hue out of range.'); return;
    }
    if (newItemId != null && (!Number.isFinite(newItemId) || newItemId < 1 || newItemId > 0xFFFF)) {
      ctx.state.sendSystemMessage('Item ID out of range.'); return;
    }
    if (newAmount != null && (!Number.isFinite(newAmount) || newAmount < 1 || newAmount > 60000)) {
      ctx.state.sendSystemMessage('Amount out of range.'); return;
    }
    if (newHue == null && newItemId == null && newAmount == null) {
      ctx.state.sendSystemMessage('Nothing to apply (all fields empty).');
      return;
    }
    const world = ctx.state.ctx?.world ?? api.world;
    let touched = 0;
    // Wave 37: per-field counters so the GM sees exactly which
    // fields actually changed across the batch (e.g. if 3 items
    // already had the requested hue, the tally distinguishes them
    // from items where every field was a no-op).
    let hueChanges = 0, itemIdChanges = 0, amountChanges = 0;
    for (const item of items) {
      let changed = false;
      if (newHue != null && (item.hue ?? 0) !== newHue) {
        item.hue = newHue; changed = true; hueChanges++;
      }
      if (newItemId != null && item.itemId !== newItemId) {
        item.itemId = newItemId; changed = true; itemIdChanges++;
      }
      if (newAmount != null && (item.amount ?? 1) !== newAmount) {
        item.amount = newAmount; changed = true; amountChanges++;
      }
      if (!changed) continue;
      touched++;
      // Broadcast — same logic as single-edit but inline.
      if (!item.parent && api.protocol?.worldItemSA) {
        const pkt = api.protocol.worldItemSA({
          serial: item.serial, itemId: item.itemId, hue: item.hue ?? 0,
          amount: item.amount ?? 1,
          x: item.x | 0, y: item.y | 0, z: item.z | 0,
        });
        for (const m of allMobiles({ world })) {
          if (!m.client || m.map !== item.map) continue;
          if (Math.abs((m.x | 0) - (item.x | 0)) > 18) continue;
          if (Math.abs((m.y | 0) - (item.y | 0)) > 18) continue;
          m.client.send(pkt);
        }
      } else if (item.parent && api.protocol?.containerContentUpdate) {
        ctx.state.send(api.protocol.containerContentUpdate(item, item.parent));
      }
      const provider = ctx.state?.ctx?.propertyProvider;
      if (provider && api.properties?.nudge && api.properties?.computeHash) {
        const r = provider(item.serial, ctx.state);
        if (r?.entries) api.properties.nudge(ctx.state, item.serial, api.properties.computeHash(r.entries));
      }
    }
    // Wave 37: per-field counters in the message body. Skip a field
    // from the readout if it was left blank (newX == null) so the
    // line stays terse for partial edits.
    const parts = [];
    if (newHue != null) parts.push(`hue ${hueChanges}`);
    if (newItemId != null) parts.push(`itemId ${itemIdChanges}`);
    if (newAmount != null) parts.push(`amount ${amountChanges}`);
    const breakdown = parts.length ? ` (${parts.join(', ')})` : '';
    ctx.state.sendSystemMessage(`Batch edit applied to ${touched}/${items.length} items${breakdown}.`);
  });
}
