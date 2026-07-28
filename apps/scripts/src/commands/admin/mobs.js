import { createMobile } from '../../_mobiles.js';
// [mobs — admin monster spawner. Mirrors [items but for the monster
// catalogue (api.monsters). Two modes:
//
//   [mobs                          → open paginated gump catalogue
//   [mobs <kind|substring>         → spawn the first matching kind here
//   [mobs list <substring>         → list matching kinds (no spawn)
//
// Backed by `api.monsters` (data-driven monsters.json — 423+ kinds
// after the ServUO content port). Spawning routes through the existing
// `[spawnmob` factory so AI behavior + loot table + gold pile fire
// just like a wild spawn.

// Visual single-column rows. `mobilepic` is a NodeUO web-client extension;
// classic clients ignore the preview verb but retain every standard button
// and label, preserving emulator/client compatibility.
const ROWS_PER_PAGE = 11;
const MOBS_PER_PAGE = ROWS_PER_PAGE;
const ROW_H = 56;

const ROLE_TABS = [
  { id: 'all',   label: 'All',     match: () => true },
  { id: 'normal',label: 'Normal',  match: (m) => !m.boss && m.role !== 'named' },
  { id: 'boss',  label: 'Bosses',  match: (m) => !!m.boss && m.role !== 'named' },
  { id: 'named', label: 'Named',   match: (m) => m.role === 'named' },
  { id: 'tame',  label: 'Tameable',match: (m) => !!(m.tamable || m.tameable) },
  { id: 'mage',  label: 'Mage AI', match: (m) => !!m.mageAI },
];

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  const { commands, gumps, monsters, ai, world } = api;
  if (!commands || !monsters) return () => {};

  /** Find every monster whose kind / name matches the (optional) query
   *  AND passes the active tab predicate. Returns sorted records. */
  function filterFor(tabId, query) {
    const tab = ROLE_TABS.find((t) => t.id === tabId) ?? ROLE_TABS[0];
    const out = [];
    // Re-fetch at every gump open — `monsters.kinds()` may have been
    // empty when this script registered (load-order race vs data.js)
    // but is fully populated by the time the player runs `[mobs`.
    let kinds = [];
    try { kinds = monsters.kinds?.() ?? []; } catch { /* noop */ }
    // Wave 37: silenced the per-call "catalogue empty" warning — it
    // fired noisily on every filterFor invocation (3+ per gump open
    // through the [mobs sub-modes). The gump itself surfaces an
    // empty list with `0 entries, page 1/1`, which is the real
    // signal a GM would notice. Keep the registry probe in case a
    // future caller wants to branch on emptiness.
    for (const kind of kinds) {
      const cfg = monsters.get(kind);
      if (!cfg) continue;
      if (!tab.match(cfg)) continue;
      if (query) {
        const q = query.toLowerCase();
        if (!kind.toLowerCase().includes(q)
            && !(cfg.name ?? '').toLowerCase().includes(q)) continue;
      }
      out.push({ kind, cfg });
    }
    out.sort((a, b) => a.kind.localeCompare(b.kind));
    return out;
  }

  /** Fire the same factory that wild spawners + [spawnmob use, falling
   *  back to a manual world.createMobile when the factory isn't wired. */
  function spawnHere(ctx, kind) {
    const cfg = monsters.get(kind);
    if (!cfg) {
      ctx.state.sendSystemMessage(`Unknown kind '${kind}'.`);
      return null;
    }
    const pos = { x: ctx.sender.x, y: ctx.sender.y, z: ctx.sender.z, map: ctx.sender.map };
    let mob = null;
    const factory = api.ctx?.spawnFactory ?? api.spawnFactory;
    if (factory) {
      try { mob = factory(world, kind, pos); } catch (e) {
        api.log?.(`[mobs] spawnFactory threw: ${e?.message}`);
      }
    }
    if (!mob) {
      // Defensive fallback — minimal mobile with the canonical fields.
      mob = createMobile(api, world, {
        name: cfg.name, body: cfg.body, hue: cfg.hue ?? 0,
        x: pos.x, y: pos.y, z: pos.z, map: pos.map,
        notoriety: cfg.notoriety ?? 5,
        hp: cfg.hp, hpMax: cfg.hp,
        str: cfg.str, dex: cfg.dex, int: cfg.int,
      });
      // Best-effort behavior attach (boss vs normal aggressive).
      const behavior = cfg.boss ? 'boss' : (cfg.behavior ?? 'aggressive');
      try { ai?.attach?.(mob, behavior); } catch { /* ignore */ }
    }
    return mob;
  }

  commands.register({
    name: 'mobs',
    access: 'Admin',
    help: '[mobs [<kind>|list <q>] — open monster catalogue / spawn / list',
    run(ctx, args) {
      const sub = (args[0] ?? '').toLowerCase();
      // [mobs list <q>
      if (sub === 'list') {
        const q = args.slice(1).join(' ');
        const matches = filterFor('all', q).slice(0, 40);
        if (matches.length === 0) {
          ctx.state.sendSystemMessage(`No monster matches "${q}".`);
        } else {
          ctx.state.sendSystemMessage(
            `Monsters matching "${q}":\n  ${matches.map((m) => m.kind).join(', ')}`,
          );
        }
        return;
      }
      // [mobs <kind|q>
      if (sub) {
        const q = args.join(' ');
        const found = filterFor('all', q);
        if (found.length === 0) {
          ctx.state.sendSystemMessage(`No monster matches "${q}".`);
          return;
        }
        const mob = spawnHere(ctx, found[0].kind);
        if (mob) {
          ctx.state.sendSystemMessage(
            `Spawned ${found[0].cfg.name} (kind=${found[0].kind}, serial=0x${mob.serial.toString(16)}).`,
          );
          if (found.length > 1) {
            ctx.state.sendSystemMessage(
              `${found.length - 1} more match — use [mobs list ${q} to see them.`,
            );
          }
        }
        return;
      }
      // No args → gump
      if (gumps) openCatalogue(ctx, 'all', 0, '');
      else ctx.state.sendSystemMessage('Usage: [mobs <kind> | list <q>');
    },
  });

  function openCatalogue(ctx, tabId, page, query) {
    const state = ctx.state;
    if (!state) return;
    const list = filterFor(tabId, query);
    const totalPages = Math.max(1, Math.ceil(list.length / MOBS_PER_PAGE));
    page = Math.max(0, Math.min(page, totalPages - 1));
    const slice = list.slice(page * MOBS_PER_PAGE, (page + 1) * MOBS_PER_PAGE);

    const W = 520;
    const H = 118 + ROWS_PER_PAGE * ROW_H + 40;
    const parts = [`{ page 0 }`, `{ resizepic 0 0 5054 ${W} ${H} }`];
    const texts = [];

    // Title row: name + status + close. No icon tabs — they rendered
    // as a vertical column. Filter by tag instead (type "boss", "tame",
    // "named" in the filter — substring match against kind/name).
    texts.push('Monsters');
    parts.push(`{ text 20 12 1153 ${texts.length - 1} }`);
    texts.push(`${list.length} entries · page ${page + 1}/${totalPages}`);
    parts.push(`{ text 90 14 70 ${texts.length - 1} }`);
    parts.push(`{ button ${W - 32} 10 4017 4018 1 0 0 }`);

    // Filter row.
    texts.push('Filter:');
    parts.push(`{ text 20 42 70 ${texts.length - 1} }`);
    texts.push(query || '');
    parts.push(`{ textentry 70 40 280 22 70 1 ${texts.length - 1} }`);
    parts.push(`{ button 360 40 4011 4012 1 0 2002 }`);

    // Actual category tabs. ROLE_TABS existed before but the UI never
    // rendered it, so every spawner looked like one enormous flat list.
    ROLE_TABS.forEach((tab, i) => {
      const x = 18 + i * 65;
      parts.push(`{ button ${x} 70 ${tab.id === tabId ? 4006 : 4005} 4007 1 0 ${3000 + i} }`);
      texts.push(tab.label);
      parts.push(`{ text ${x + 19} 70 ${tab.id === tabId ? 1153 : 70} ${texts.length - 1} }`);
    });

    // Body — creature preview, friendly name and template/body metadata.
    const BODY_TOP = 104;
    slice.forEach((row, i) => {
      const y = BODY_TOP + i * ROW_H;
      parts.push(`{ mobilepic 16 ${y} ${row.cfg.body | 0} ${row.cfg.hue ?? 0} 0 52 52 }`);
      parts.push(`{ button 76 ${y + 14} 4005 4007 1 0 ${100 + i} }`);
      // Tag suffix gives the GM a hint that this row is a BOSS / tame
      // / named without a dedicated column.
      const tag = row.cfg.boss ? ' [BOSS]'
        : (row.cfg.tamable || row.cfg.tameable) ? ' [tame]'
        : row.cfg.role === 'named' ? ' [named]'
        : '';
      texts.push(`${row.cfg.name ?? row.kind}${tag}`);
      parts.push(`{ text 106 ${y + 7} 1153 ${texts.length - 1} }`);
      texts.push(`${row.kind} · body 0x${(row.cfg.body | 0).toString(16).padStart(4, '0')} · ${row.cfg.behavior ?? 'aggressive'} AI`);
      parts.push(`{ croppedtext 106 ${y + 29} 380 18 70 ${texts.length - 1} }`);
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

    // Stable gumpId — see items.js for the rationale.
    const STABLE_ID = 0x4D4F4253;     // 'MOBS'
    gumps.send(state, {
      definitionId: 'server:commands-admin-mobs:open-catalogue',
      x: 60, y: 60, gumpId: STABLE_ID, layout: parts.join(''), texts,
    }, (resp) => {
      const b = resp.buttonId;
      if (b === 0) return;
      if (b === 2000) { openCatalogue(ctx, tabId, page - 1, query); return; }
      if (b === 2001) { openCatalogue(ctx, tabId, page + 1, query); return; }
      if (b === 2002) {
        const entry = resp.textEntries?.find?.((e) => e.entryId === 1);
        const next = (entry?.text ?? '').trim();
        openCatalogue(ctx, tabId, 0, next);
        return;
      }
      if (b >= 3000 && b < 3000 + ROLE_TABS.length) {
        openCatalogue(ctx, ROLE_TABS[b - 3000].id, 0, query);
        return;
      }
      if (b >= 100 && b < 100 + MOBS_PER_PAGE) {
        const row = slice[b - 100];
        if (!row) { openCatalogue(ctx, tabId, page, query); return; }
        const mob = spawnHere(ctx, row.kind);
        if (mob) ctx.state.sendSystemMessage(`Spawned ${row.cfg.name}.`);
        openCatalogue(ctx, tabId, page, query);
      }
    });
  }

  return () => commands.unregister('mobs');
}
