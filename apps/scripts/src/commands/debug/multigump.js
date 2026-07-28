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
import { multiKind, nameForMulti } from '../housing/multi-catalog.js';

// Audit #43 — resolve relative to THIS file so the lookup works
// regardless of cwd (repo root vs `apps/server/`). User reported
// "multi.json not available — run the extractor" with the file
// actually present at `apps/client/public/assets/multi.json` (the
// candidates list missed because cwd wasn't repo root).
const __MG_FILE = fileURLToPath(import.meta.url);
const __MG_DIR  = dirname(__MG_FILE);

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

function buildLayout(entries, page, totalPages, filter, category) {
  // Each Place button's id encodes the multi id directly so we don't
  // need a side table.
  const lines = [];
  // We pre-allocate text indices for: 0=header 1=filterLabel 2=pageLabel,
  // then per row two entries: id-hex + tile-count.
  const texts = ['Multi placement', `Filter: ${filter || ''}`, `Page ${page + 1} / ${totalPages}`, 'Houses', 'Boats', 'Other'];
  lines.push('{ resizepic 0 0 5054 480 430 }');
  lines.push('{ text 16 12 1153 0 }');
  lines.push('{ text 16 36 70 1 }');
  lines.push('{ textentry 100 34 280 22 70 1 100 }');
  lines.push('{ button 388 34 4011 4012 1 0 200 }');   // Apply filter, buttonId=200
  lines.push('{ text 320 12 70 2 }');                  // page label
  lines.push('{ button 388 12 4014 4015 1 0 201 }');   // prev, 201
  lines.push('{ button 410 12 4005 4006 1 0 202 }');   // next, 202
  for (const [i, key] of ['house', 'boat', 'other'].entries()) {
    const x = 16 + i * 92;
    lines.push(`{ button ${x} 62 4005 4007 1 0 ${210 + i} }`);
    lines.push(`{ text ${x + 26} 64 ${category === key ? 1153 : 70} ${3 + i} }`);
  }

  let y = 94;
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
    // Render the complete footprint. The old first-component `tilepicfit`
    // frequently displayed a candle, a single wall or a roof shard and had
    // no visual relationship to the selected house/boat.
    lines.push(`{ multipic 5 ${y - 7} ${e.id} 48 30 }`);
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
    const s = sessions.get(state) ?? { page: 0, filter: '', category: 'house' };
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
      if (multiKind(id) !== s.category) continue;
      if (filter && !hex.includes(filter) && !String(id).includes(filter)
          && !displayName.includes(filter)) continue;
      list.push({ id, tiles: v });
    }
    list.sort((a, b) => a.id - b.id);
    const totalPages = Math.max(1, Math.ceil(list.length / PER_PAGE));
    if (s.page >= totalPages) s.page = totalPages - 1;
    if (s.page < 0) s.page = 0;
    const slice = list.slice(s.page * PER_PAGE, (s.page + 1) * PER_PAGE);

    const { layout, texts } = buildLayout(slice, s.page, totalPages, s.filter, s.category);
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
      if (btn >= 210 && btn <= 212) {
        s.category = ['house', 'boat', 'other'][btn - 210];
        s.page = 0;
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
