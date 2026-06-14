// Bulk quest registrar — loads every entry from `data/world/quests-extracted.json`
// (the 154 ServUO `BaseQuest` subclasses we pulled from `Scripts/Quests/`)
// and registers them as discoverable quests in the quest system.
//
// Coverage tradeoff: extracted entries ship objective + reward shapes but
// NOT bespoke per-quest scripts (specific dialog branches, side-effects,
// or scripted spawns). We give each a generic implementation backed by
// the existing objective handlers:
//
//   ObtainObjective       — players bring N of `type` to the giver NPC
//   DeliverObjective      — players carry an item from giver to recipient
//   SlayObjective         — players kill N of `type` monsters
//   CollectionsObjective  — turn-in to a collections NPC for points
//   BloodCreaturesObjective / AcidCreaturesObjective — kill-flagged variants
//   InternalObjective     — opaque scripted; we treat as "ask the questgiver"
//
// Title / description / refuse / complete fields are cliloc IDs from the
// original ServUO data — we surface them verbatim. Authored quest scripts
// (heartwood / haven-heritage / etc.) take precedence: this loader skips
// any quest already registered by name.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname_ = dirname(fileURLToPath(import.meta.url));
const CATALOG = resolve(__dirname_, '..', 'data', 'world', 'quests-extracted.json');

/** Convert a ServUO class name like `AemaethOneQuest` to a kebab-case
 *  registry id `aemaeth-one-quest`. Stable across re-extractions. */
function classToId(className) {
  return String(className ?? '')
    .replace(/Quest$/, '')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    || 'unnamed-quest';
}

/** Wrap a raw extracted entry as the runtime quest shape the quests
 *  module accepts. Objectives are normalised so the in-game UI can
 *  show progress without per-quest custom logic. */
function buildQuestFromEntry(entry) {
  const id = classToId(entry.class);
  const objectives = (entry.objectives ?? []).map((o, i) => {
    const count = Math.max(1, o.qty | 0);
    const type = String(o.type ?? o.label ?? 'unknown')
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/\s+/g, '-')
      .toLowerCase();
    switch (o.kind) {
      case 'SlayObjective':
      case 'BloodCreaturesObjective':
      case 'AcidCreaturesObjective':
        return {
          id: `${id}-obj${i}`,
          type: 'slay',
          kind: type,
          count,
          label: o.label ?? `Slay ${o.qty | 0}× ${o.type ?? ''}`,
        };
      case 'DeliverObjective':
        return {
          id: `${id}-obj${i}`,
          type: 'deliver',
          itemType: type,
          count,
          label: o.label ?? `Deliver ${o.qty | 0}× ${o.type ?? ''}`,
        };
      case 'ObtainObjective':
      case 'CollectionsObtainObjective':
        return {
          id: `${id}-obj${i}`,
          type: 'collect',
          itemType: type,
          count,
          label: o.label ?? `Obtain ${o.qty | 0}× ${o.type ?? ''}`,
        };
      case 'InternalObjective':
      default:
        return {
          id: `${id}-obj${i}`,
          type: 'talk',
          keyword: id,
          label: o.label ?? 'Speak with the questgiver',
        };
    }
  });
  const rewards = (entry.rewards ?? []).map((r) => ({
    type: 'item',
    itemType: String(r.type ?? 'unknown')
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/\s+/g, '-')
      .toLowerCase(),
    // ServUO sometimes uses `qty` as a cliloc id when the reward is a
    // localised mystery package (e.g. "MeagerImbuingBag" → cliloc
    // 1072706). Carry it through so the journal can resolve to text.
    qty: r.qty | 0,
  }));
  return {
    id,
    className: entry.class,
    title: entry.title ?? entry.class,
    description: entry.description,
    refuse: entry.refuse,
    uncomplete: entry.uncomplete,
    complete: entry.complete,
    objectives,
    rewards,
    extracted: true,
  };
}

/** Read + normalise the entire catalogue once. Cached for the rest of
 *  the session — the JSON is committed content that never changes at
 *  runtime. */
let _cache = null;
function loadCatalog() {
  if (_cache) return _cache;
  if (!existsSync(CATALOG)) { _cache = []; return _cache; }
  try {
    const raw = JSON.parse(readFileSync(CATALOG, 'utf8'));
    _cache = (Array.isArray(raw) ? raw : []).map(buildQuestFromEntry);
  } catch { _cache = []; }
  return _cache;
}

export default function register(api) {
  // Two engines coexist in the codebase:
  //   • `api.mlQuests.registerQuest` — Mondain's Legacy / Tokuno / SA
  //     extracted quests; supports objective + reward shapes we ship.
  //   • `api.quests.register`        — pre-ML newbie-zone quest engine.
  // Try ML first; fall back to the classic engine when ML isn't loaded
  // (test harness / minimal boot).
  const reg = api.mlQuests?.registerQuest
           ?? api.systems?.mlQuests?.registerQuest
           ?? api.quests?.register;
  if (!reg) {
    api.log?.('quests/bulk-extracted: no quest registrar available, skipping');
    return () => {};
  }
  const catalog = loadCatalog();
  let registered = 0;
  let skipped = 0;
  for (const q of catalog) {
    // Don't overwrite an authored quest. mlquests' `Duplicate` throw
    // is the canonical signal; quests engine `has` is the alternative.
    if (api.quests?.has?.(q.id)) { skipped++; continue; }
    try {
      reg({
        id: q.id,
        title: q.title,
        description: q.description,
        refuseCliloc: q.refuse,
        uncompleteCliloc: q.uncomplete,
        completeCliloc: q.complete,
        objectives: q.objectives,
        rewards: q.rewards,
        extracted: true,
      });
      registered++;
    } catch (e) {
      if (!String(e?.message ?? '').includes('Duplicate')) {
        api.log?.(`quests/bulk-extracted: ${q.id} register failed: ${e.message}`);
      }
      skipped++;
    }
  }
  api.log?.(`quests/bulk-extracted: registered ${registered} quests (${skipped} skipped)`);

  // `[quests catalog` — quick-survey command listing every bulk-loaded
  // quest with its objective summary. Players use the standard
  // questgiver flow (`[quest` on an NPC); this is the encyclopedia
  // for staff verifying that the extract pulled everything in.
  if (api.commands?.register) {
    api.commands.register({
      name: 'quests-catalog',
      help: '[quests-catalog [substring] — list extracted quests (optionally filtered).',
      access: 'Player',
      run(ctx) {
        const needle = String(ctx.args[0] ?? '').toLowerCase();
        const rows = catalog.filter((q) =>
          !needle ||
          q.id.includes(needle) ||
          (q.title?.toLowerCase?.()?.includes?.(needle)),
        );
        ctx.state.sendSystemMessage(`Quests catalog: ${rows.length} of ${catalog.length} entries`);
        for (const q of rows.slice(0, 25)) {
          const objSummary = q.objectives
            .map((o) =>
              o.kind === 'slay'    ? `slay ${o.target}× ${o.mobType}`
            : o.kind === 'obtain'  ? `obtain ${o.target}× ${o.itemType}`
            : o.kind === 'deliver' ? `deliver ${o.target}× ${o.itemType}`
            : o.label)
            .join(' · ');
          ctx.state.sendSystemMessage(`  ${q.id.padEnd(36)} — ${objSummary}`);
        }
        if (rows.length > 25) {
          ctx.state.sendSystemMessage(`  ... ${rows.length - 25} more (refine with substring)`);
        }
      },
    });
  }

  return () => {
    try { api.commands?.unregister?.('quests-catalog'); } catch { /* ignore */ }
  };
}
