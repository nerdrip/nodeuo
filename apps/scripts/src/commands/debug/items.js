// [items — admin item spawner. Two modes:
//
//   [items                            → open the gump catalogue (paginated grid)
//   [items <name|substring>           → spawn the first matching template in pack
//   [items list <substring>           → list matching template names (no spawn)
//   [items category <slot>            → filter gump by slot tag
//
// Catalogue source: every `api.templates` entry (which now includes
// the full data-driven items.json — 473+ rows after the ServUO content
// port). The previous version pulled from a tiny content/items registry
// (~80 entries) so the user couldn't browse or spawn the long tail.

// User-report — earlier 2-column-with-tilepic layout was unreadable.
// They explicitly asked for "just names, no visualization or columns".
// Plain vertical list: one entry per row, clickable name, that's it.
import { findBackpack } from '../../_inventory.js';
import { createItem } from '../../_items.js';

const ROWS_PER_PAGE = 24;
const ITEMS_PER_PAGE = ROWS_PER_PAGE;
const ROW_H = 22;

// Slot/role tabs. 'all' is special — no filter. Each entry's `match()`
// returns true for templates that should appear under that tab. Earlier
// the tabs filtered on `slot === <id>` directly which hid 48+ entries
// whose slot was a specific clothing layer (head, pants, feet, tunic,
// shirt, outertorso, innerlegs, cloak, waist, arms, neck, gloves) —
// none of those matched any tab so they were invisible regardless of
// which page the user paged to.
const CLOTHING_SLOTS = new Set([
  'clothing', 'shirt', 'pants', 'feet', 'shoes', 'tunic', 'outertorso',
  'innerlegs', 'innertorso', 'cloak', 'robe', 'waist', 'arms', 'neck',
  'gloves', 'head', 'helm', 'sleeves', 'skirt', 'leggings',
]);
const KIND_TABS = [
  { id: 'all',      label: 'All',      match: () => true },
  { id: 'weapon',   label: 'Weapons',  match: (d) => d.slot === 'weapon' },
  { id: 'armor',    label: 'Armor',    match: (d) => d.slot === 'armor' },
  { id: 'shield',   label: 'Shields',  match: (d) => d.slot === 'shield' },
  { id: 'clothing', label: 'Clothing', match: (d) => CLOTHING_SLOTS.has(d.slot) },
  { id: 'jewelry',  label: 'Jewelry',  match: (d) => d.slot === 'jewelry' },
  { id: 'world',    label: 'World',    match: (d) => d.slot === 'world' },
  { id: 'misc',     label: 'Misc',     match: (d) =>
      d.slot === 'misc'
      || (d.slot !== 'weapon' && d.slot !== 'armor' && d.slot !== 'shield'
          && d.slot !== 'jewelry' && d.slot !== 'world' && !CLOTHING_SLOTS.has(d.slot))
  },
];

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  const { commands, gumps, protocol, templates } = api;
  if (!commands || !templates) return () => {};

  /** Resolve every template into a { id, name, slot, role, label } row. */
  function listAll() {
    const names = templates.templateNames?.() ?? [];
    const out = [];
    for (const n of names) {
      const t = templates.getTemplate?.(n);
      if (!t) continue;
      const id = t.itemId | 0;
      if (!id) continue;
      out.push({
        id, name: n, slot: t.slot ?? 'misc', role: t.role ?? null,
        label: t.label ?? n,
      });
    }
    return out;
  }

  function filterFor(kind, query) {
    let pool = listAll();
    if (kind && kind !== 'all') {
      const tab = KIND_TABS.find((t) => t.id === kind);
      if (tab) pool = pool.filter((d) => tab.match(d));
    }
    if (query) {
      const q = query.toLowerCase();
      pool = pool.filter((d) =>
        d.name.toLowerCase().includes(q) || d.label.toLowerCase().includes(q),
      );
    }
    pool.sort((a, b) => a.name.localeCompare(b.name));
    return pool;
  }

  commands.register({
    name: 'items',
    access: 'Admin',
    help: '[items [<name>|list <q>|category <slot>] — open catalogue / spawn / list',
    run(ctx, args) {
      const sub = (args[0] ?? '').toLowerCase();
      // [items list <q> — print up to 30 matching templates by name.
      if (sub === 'list') {
        const q = args.slice(1).join(' ');
        const matches = filterFor(null, q).slice(0, 30);
        if (matches.length === 0) {
          ctx.state.sendSystemMessage(`No template matches "${q}".`);
        } else {
          ctx.state.sendSystemMessage(
            `Templates matching "${q}":\n  ${matches.map((m) => m.name).join(', ')}`,
          );
        }
        return;
      }
      // [items category <slot>
      if (sub === 'category' && gumps) {
        openCatalogue(ctx, args[1] || 'all', 0, '');
        return;
      }
      // [items <name|substring> — direct spawn first match.
      if (sub) {
        const q = args.join(' ');
        const found = filterFor(null, q);
        if (found.length === 0) {
          ctx.state.sendSystemMessage(`No template matches "${q}".`);
          return;
        }
        spawnInBackpack(ctx, found[0]);
        if (found.length > 1) {
          ctx.state.sendSystemMessage(
            `Spawned ${found[0].name}. ${found.length - 1} more match — use [items list ${q} to see them.`,
          );
        }
        return;
      }
      // No args → open the gump.
      if (gumps) openCatalogue(ctx, 'all', 0, '');
      else ctx.state.sendSystemMessage('Usage: [items <name> | list <q> | category <slot>');
    },
  });

  function openCatalogue(ctx, kind, page, query) {
    const state = ctx.state;
    if (!state) return;
    const list = filterFor(kind, query);
    const totalPages = Math.max(1, Math.ceil(list.length / ITEMS_PER_PAGE));
    page = Math.max(0, Math.min(page, totalPages - 1));
    const slice = list.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);

    const W = 420;
    const H = 90 + ROWS_PER_PAGE * ROW_H + 40;
    const parts = [`{ page 0 }`, `{ resizepic 0 0 5054 ${W} ${H} }`];
    const texts = [];

    // Title row: name + status + close. No icon tabs — they rendered as
    // a vertical column on the user's gump because the button graphics
    // I picked weren't sized for a horizontal strip. To filter by kind
    // the GM just types the slot name in the filter input ("weapon",
    // "armor", "shield"...) — filterFor() already matches against the
    // template name AND the slot tag from the substring.
    texts.push('Items');
    parts.push(`{ text 20 12 1153 ${texts.length - 1} }`);
    texts.push(`${list.length} entries · page ${page + 1}/${totalPages}`);
    parts.push(`{ text 70 14 70 ${texts.length - 1} }`);
    parts.push(`{ button ${W - 32} 10 4017 4018 1 0 0 }`);

    // Filter row, with a hint of supported keywords.
    texts.push('Filter:');
    parts.push(`{ text 20 42 70 ${texts.length - 1} }`);
    texts.push(query || '');
    parts.push(`{ textentry 70 40 280 22 70 1 ${texts.length - 1} }`);
    parts.push(`{ button 360 40 4011 4012 1 0 2002 }`);

    // Body — plain name list, one clickable text per row, no tilepic.
    const BODY_TOP = 76;
    slice.forEach((def, i) => {
      const y = BODY_TOP + i * ROW_H;
      parts.push(`{ button 18 ${y + 2} 4005 4007 1 0 ${100 + i} }`);
      texts.push(def.name);
      parts.push(`{ text 44 ${y + 2} 1153 ${texts.length - 1} }`);
    });

    // Footer pagination.
    const footY = H - 32;
    if (page > 0) {
      parts.push(`{ button 20 ${footY} 4014 4015 1 0 2000 }`);
      texts.push('Prev');
      parts.push(`{ text 46 ${footY + 2} 1153 ${texts.length - 1} }`);
    }
    if (page < totalPages - 1) {
      parts.push(`{ button ${W - 80} ${footY} 4005 4006 1 0 2001 }`);
      texts.push('Next');
      parts.push(`{ text ${W - 56} ${footY + 2} 1153 ${texts.length - 1} }`);
    }

    // Stable gumpId so the client's `_onGumpOpen` recognises page-flips
    // as a replacement of the same gump and (with the new position
    // preservation hook) keeps the user-dragged x/y intact. Without a
    // stable id every re-open got a fresh serial and snapped back to
    // x=60,y=60 each click — the gump appeared to "jump".
    const STABLE_ID = 0x49544D53;     // 'ITMS'
    gumps.send(state, {
      x: 60, y: 60, gumpId: STABLE_ID, layout: parts.join(''), texts,
    }, (resp) => {
      const b = resp.buttonId;
      if (b === 0) return;
      if (b === 2000) { openCatalogue(ctx, kind, page - 1, query); return; }
      if (b === 2001) { openCatalogue(ctx, kind, page + 1, query); return; }
      if (b === 2002) {
        const entry = resp.textEntries?.find?.((e) => e.entryId === 1);
        const next = (entry?.text ?? '').trim();
        openCatalogue(ctx, kind, 0, next);
        return;
      }
      if (b >= 100 && b < 100 + ITEMS_PER_PAGE) {
        const def = slice[b - 100];
        if (!def) { openCatalogue(ctx, kind, page, query); return; }
        spawnInBackpack(ctx, def);
        openCatalogue(ctx, kind, page, query);
      }
    });
  }

  function spawnInBackpack(ctx, def) {
    const sender = ctx.sender;
    const w = ctx.world;
    const backpack = findBackpack({ world: w }, sender);
    if (!backpack) {
      ctx.state.sendSystemMessage?.('No backpack found on your character.');
      return;
    }
    // Use the template path if available so onCreate fires (spellbook
    // registration, weapon descriptor copy, etc.). Falls back to direct
    // createItem when the row isn't a registered template.
    let item;
    try {
      item = templates.spawn(w, def.name, {
        x: 0, y: 0, z: 0, map: sender.map,
        parent: backpack.serial, layer: 0,
        gridX: 40 + Math.floor(Math.random() * 80),
        gridY: 40 + Math.floor(Math.random() * 80),
      });
    } catch {
      item = api.game?.mobile?.giveItem?.(sender, {
        itemId: def.id, amount: 1, hue: 0,
        map: sender.map,
        movable: true,
      }, { notify: false, randomGrid: true }) ?? createItem(api, w, {
        itemId: def.id, amount: 1, hue: 0,
        x: 0, y: 0, z: 0, map: sender.map,
        parent: backpack.serial, layer: 0,
        gridX: 40 + Math.floor(Math.random() * 80),
        gridY: 40 + Math.floor(Math.random() * 80),
        movable: true,
      });
    }
    if (ctx.state?.send && protocol?.containerContentUpdate) {
      ctx.state.send(protocol.containerContentUpdate({
        serial: item.serial, itemId: item.itemId,
        amount: item.amount ?? 1,
        gridX: item.gridX ?? 0, gridY: item.gridY ?? 0,
        gridLocation: 0, hue: item.hue ?? 0,
      }, backpack.serial));
    }
    ctx.state.sendSystemMessage?.(`Spawned ${def.name} (0x${def.id.toString(16)}) in your backpack.`);
  }

  return () => commands.unregister('items');
}
