// `[multigump` — interactive multi-placement browser.
//
// Opens a server-driven gump (0xB0/0xDD via api.gumps.send) listing
// every multi from the catalogue with a "Place" button. Clicking
// Place triggers the same target-with-ghost-preview flow the chat
// `[placemulti <id>` command uses.
//
// Pagination: 12 multis per page, with a search field that filters
// by hex id substring (so the user can type "84" to find every boat
// id, "100" for the brick-cellar family, etc).

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Audit #43 — resolve relative to THIS file so the lookup works
// regardless of cwd (repo root vs `apps/server/`). User reported
// "multi.json not available — run the extractor" with the file
// actually present at `apps/client/public/assets/multi.json` (the
// candidates list missed because cwd wasn't repo root).
const __MG_FILE = fileURLToPath(import.meta.url);
const __MG_DIR  = dirname(__MG_FILE);

// Curated multi-id → display-name table. IDs come from
// `templates/ServUO/Scripts/Multis/Deeds.cs` (classic houses) and the
// boat / High Seas Multis. Boats use 4 contiguous slots for N/E/S/W,
// galleons use 4 × 3 damage states = 12 slots — we name only the
// "north" anchor and let the user see the offset via the hex id.
const MULTI_NAMES = {
  // Boats (BaseBoat.cs)
  0x00: 'Small Ship (N)',     0x01: 'Small Ship (E)',     0x02: 'Small Ship (S)',     0x03: 'Small Ship (W)',
  0x04: 'Small Dragon (N)',   0x05: 'Small Dragon (E)',   0x06: 'Small Dragon (S)',   0x07: 'Small Dragon (W)',
  0x08: 'Medium Ship (N)',    0x09: 'Medium Ship (E)',    0x0A: 'Medium Ship (S)',    0x0B: 'Medium Ship (W)',
  0x0C: 'Medium Dragon (N)',  0x0D: 'Medium Dragon (E)',  0x0E: 'Medium Dragon (S)',  0x0F: 'Medium Dragon (W)',
  0x10: 'Large Ship (N)',     0x11: 'Large Ship (E)',     0x12: 'Large Ship (S)',     0x13: 'Large Ship (W)',
  0x14: 'Large Dragon (N)',   0x15: 'Large Dragon (E)',   0x16: 'Large Dragon (S)',   0x17: 'Large Dragon (W)',
  0x18: 'Orcish Galleon',     0x24: 'Gargish Galleon',    0x30: 'Tokuno Galleon',
  0x3C: 'Rowboat (N)',        0x3D: 'Rowboat (E)',        0x3E: 'Rowboat (S)',        0x3F: 'Rowboat (W)',
  0x40: 'Britannian Ship',
  // Classic houses (Deeds.cs)
  0x64: 'Stone Plaster House',
  0x66: 'Field Stone House',
  0x68: 'Small Brick House',
  0x6A: 'Wood House',
  0x6C: 'Wood Plaster House',
  0x6E: 'Thatched Roof Cottage',
  0x74: 'Brick House (Guild)',
  0x76: 'Two-Story Wood Plaster',
  0x78: 'Two-Story Stone Plaster',
  0x7A: 'Tower',
  0x7C: 'Keep',
  0x7E: 'Castle',
  0x8C: 'Large Patio',
  0x96: 'Large Marble',
  0x98: 'Small Tower',
  0x9A: 'Log Cabin',
  0x9C: 'Sandstone Patio',
  0x9E: 'Villa',
  0xA0: 'Stone Workshop',
  0xA2: 'Marble Workshop',
};

function nameForMulti(id) {
  if (MULTI_NAMES[id]) return MULTI_NAMES[id];
  // Bucketed ranges for damage-state galleons (4 ids per dmg level × 3).
  if (id >= 0x18 && id <= 0x23) return 'Orcish Galleon';
  if (id >= 0x24 && id <= 0x2F) return 'Gargish Galleon';
  if (id >= 0x30 && id <= 0x3B) return 'Tokuno Galleon';
  if (id >= 0x40 && id <= 0x4B) return 'Britannian Ship';
  if (id >= 0x4000) return 'Custom House';   // post-AOS customizable plots
  if (id >= 0x2000) return 'AOS Housing Tile';
  return '';                                 // unknown — show only hex id
}

let _multiCache = null;
function loadMultis() {
  if (_multiCache) return _multiCache;
  // This file lives at `apps/scripts/src/commands/debug/multigump.js`
  // (5 levels from repo root). The previous walk-up used 4 levels
  // because it was authored when the file sat in `commands/` directly
  // — after the move into `commands/debug/` the lookup landed at
  // `apps/apps/client/...` and `existsSync` returned false on every
  // candidate, falling through to the "multi.json not available"
  // message even though `apps/client/public/assets/multi.json` (~8.7 MB)
  // is present.
  const candidates = [
    join(process.cwd(), 'apps/client/public/assets/multi.json'),
    join(process.cwd(), 'public/assets/multi.json'),
    // 5 levels: debug → commands → src → scripts → apps → REPO_ROOT
    join(__MG_DIR, '../../../../../apps/client/public/assets/multi.json'),
    join(__MG_DIR, '../../../../../apps/client/dist/assets/multi.json'),
    // Defensive: keep the old (4-up) candidates so a future move that
    // lifts the file back out of `debug/` still finds the catalogue.
    join(__MG_DIR, '../../../../apps/client/public/assets/multi.json'),
    join(__MG_DIR, '../../../../apps/client/dist/assets/multi.json'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      _multiCache = raw.multis ?? raw;
      return _multiCache;
    } catch { /* keep trying */ }
  }
  return null;
}

const PER_PAGE = 12;

function buildLayout(entries, page, totalPages, filter) {
  // Each Place button's id encodes the multi id directly so we don't
  // need a side table.
  const lines = [];
  // We pre-allocate text indices for: 0=header 1=filterLabel 2=pageLabel,
  // then per row two entries: id-hex + tile-count.
  const texts = ['Multi placement', `Filter: ${filter || ''}`, `Page ${page + 1} / ${totalPages}`];
  lines.push('{ resizepic 0 0 5054 480 400 }');
  lines.push('{ text 16 12 1153 0 }');
  lines.push('{ text 16 36 70 1 }');
  lines.push('{ textentry 100 34 280 22 70 1 100 }');
  lines.push('{ button 388 34 4011 4012 1 0 200 }');   // Apply filter, buttonId=200
  lines.push('{ text 320 12 70 2 }');                  // page label
  lines.push('{ button 388 12 4014 4015 1 0 201 }');   // prev, 201
  lines.push('{ button 410 12 4005 4006 1 0 202 }');   // next, 202

  let y = 64;
  for (const e of entries) {
    const idHex = '0x' + e.id.toString(16).padStart(4, '0');
    const count = e.tiles.length;
    const name = nameForMulti(e.id);
    // Wider row: hue 1153 cream for name, dim 70 for the technical
    // "(id, tiles)" suffix so the user can still cross-reference.
    const label = name ? `${name}` : `(unnamed)`;
    texts.push(label);
    const nameIdx = texts.length - 1;
    texts.push(`${idHex} · ${count} tiles`);
    const metaIdx = texts.length - 1;
    const preview = e.tiles.find((tile) => tile?.visible !== false) ?? e.tiles[0];
    if (preview?.id) lines.push(`{ tilepicfit 8 ${y - 8} ${preview.id | 0} 0 44 32 }`);
    lines.push(`{ text 58 ${y} 1153 ${nameIdx} }`);
    lines.push(`{ text 225 ${y} 70 ${metaIdx} }`);
    // Place button — id offset by +1 to skip 0 (which Pixi treats as
    // "no response"). Decoded as buttonId-1 server-side.
    lines.push(`{ button 440 ${y - 2} 4005 4007 1 0 ${1000 + e.id} }`);
    y += 24;
  }
  return { layout: lines.join(''), texts };
}

export default function register(api) {
  if (!api.commands || !api.gumps) return () => {};

  /** state per caster — page, filter substring. */
  const sessions = new WeakMap();

  function openGump(state) {
    const all = loadMultis();
    if (!all) {
      state.sendSystemMessage('multi.json not available — run the extractor.');
      return;
    }
    const s = sessions.get(state) ?? { page: 0, filter: '' };
    sessions.set(state, s);
    // Build the filtered list.
    const filter = (s.filter || '').toLowerCase();
    const list = [];
    for (const [k, v] of Object.entries(all)) {
      if (!Array.isArray(v) || v.length === 0) continue;
      const id = +k;
      if (!Number.isFinite(id)) continue;
      const hex = id.toString(16);
      const displayName = nameForMulti(id).toLowerCase();
      if (filter && !hex.includes(filter) && !String(id).includes(filter)
          && !displayName.includes(filter)) continue;
      list.push({ id, tiles: v });
    }
    list.sort((a, b) => a.id - b.id);
    const totalPages = Math.max(1, Math.ceil(list.length / PER_PAGE));
    if (s.page >= totalPages) s.page = totalPages - 1;
    if (s.page < 0) s.page = 0;
    const slice = list.slice(s.page * PER_PAGE, (s.page + 1) * PER_PAGE);

    const { layout, texts } = buildLayout(slice, s.page, totalPages, s.filter);
    api.gumps.send(state, {
      layout, texts, x: 80, y: 80, gumpId: 0x4D554C54, // 'MULT'
    }, (resp) => {
      const btn = resp.buttonId | 0;
      if (btn === 0) return;                          // close
      if (btn === 200) {                              // apply filter
        const entry = resp.textEntries?.find?.((e) => e.entryId === 1);
        s.filter = (entry?.text ?? '').trim();
        s.page = 0;
        openGump(state);
        return;
      }
      if (btn === 201) {                              // prev page
        s.page = Math.max(0, s.page - 1);
        openGump(state);
        return;
      }
      if (btn === 202) {                              // next page
        s.page = Math.min(totalPages - 1, s.page + 1);
        openGump(state);
        return;
      }
      if (btn >= 1000) {
        const multiId = btn - 1000;
        // Hand off to the placemulti command — emit an event the
        // placemulti.js bus subscriber listens for. Side effect: enters
        // multi-targeting mode with ghost preview.
        if (!api.events?.emit) {
          state.sendSystemMessage('Multi placement bus unavailable (api.events missing).');
          api.log?.('[multigump] api.events missing — cannot dispatch placemulti:request');
          return;
        }
        const listeners = api.events.listenerCount?.('placemulti:request') ?? 0;
        if (listeners === 0) {
          state.sendSystemMessage('Multi placement handler not registered (placemulti.js inactive).');
          api.log?.('[multigump] no subscriber on placemulti:request');
          return;
        }
        api.events.emit('placemulti:request', { state, multiId, hue: 0 });
      }
    });
  }

  api.commands.register({
    name: 'multigump',
    help: '[multigump — open the multi-placement browser (gump).',
    access: 'GM',
    run(ctx) { openGump(ctx.state); },
  });

  return () => api.commands.unregister('multigump');
}
