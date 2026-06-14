// `[createworld` / `[deleteworld` — agregator porting ServUO's
// `CreateWorld.cs`. Runs every world-population sub-command in sequence:
//
//   1. [decorate     — 107 951 statics + furniture across 6 facets
//   2. [signgen      — 868 sign placements (Felucca + Trammel)
//   3. [doorgen      — door / gate items wired to the door script
//   4. [telgen       — 1374 teleporter pads (5 facets)
//
// The aggregator is idempotent: each underlying command tracks an
// "applied" flag per facet on the world, so re-running [createworld
// without [deleteworld is a no-op. ServUO supports a `nogump` argument
// to skip the menu — we always run "all on" since we don't have the
// gump yet.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { applyDecorations,  deleteDecorations  } from './decorate.js';
import { applySigns,        deleteSigns        } from './signgen.js';
import { applyDoors,        deleteDoors        } from './doorgen.js';
import { applyTeleporters,  deleteTeleporters  } from './telgen.js';
import { applyXmlSpawners,  deleteXmlSpawners  } from './xmlload.js';
import { applyMoongates,    deleteMoongates    } from '../../spawns/moongates.js';
import { placeRegionalNpcs } from '../../spawns/regional-npcs.js';
import { broadcastBulkPlacement } from '../_bulk-broadcast.js';
import { registerStandardSigils } from '../../items/scripts/functional/sigil.js';
import { allMobiles } from '../../_spatial.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// admin → commands → src, then data/world/. Used by the gump's
// estimateStageCounts() preview; the actual apply functions resolve
// their own DECO_PATH/SIGNS_PATH/etc inside each sub-command module.
const DATA_DIR  = resolve(__dirname, '..', '..', 'data', 'world');

const STAGES = [
  { name: 'Decorations', apply: applyDecorations,  remove: deleteDecorations  },
  { name: 'Signs',       apply: applySigns,        remove: deleteSigns        },
  { name: 'Doors',       apply: applyDoors,        remove: deleteDoors        },
  { name: 'Teleporters', apply: applyTeleporters,  remove: deleteTeleporters  },
  // Public moongates — 21 visible portals across 4 facets. Player asked
  // for these to be part of `[createworld` so the cycle wipe + repopulate
  // covers them too instead of relying on the auto-spawn at boot.
  { name: 'Moongates',   apply: applyMoongates,    remove: deleteMoongates    },
  // XmlSpawner registration runs last so the world has all decorations
  // in place first (some spawners want to deposit chests at known anchor
  // tiles created by the decoration pass).
  { name: 'XmlSpawners', apply: applyXmlSpawners,  remove: deleteXmlSpawners,
    countKey: 'added', removeKey: 'removed', useGroups: true },
  // Regional named NPCs — canon characters like "Hawkins the banker of
  // Britain", placed at a deterministic spot inside their region.
  // (Old `CivicNPCs` stage removed 2026-05-16: it placed anonymous
  // duplicates of vendors that regional already covers.)
  { name: 'RegionalNPCs',
    apply: (api) => {
      const r = placeRegionalNpcs(api);
      return { added: r.placed };
    },
    remove: () => ({ removed: 0 }),
  },
  // Faction sigils — 5 town stones at canonical coords. Idempotent
  // (registerStandardSigils skips if already populated). Batch #18
  // deferred.
  { name: 'Sigils',
    apply: (api) => { registerStandardSigils(api); return { added: 5 }; },
    remove: () => ({ removed: 0 }),
  },
];

function countNonPlayerMobs(world) {
  let n = 0;
  for (const m of allMobiles({ world })) if (!m.isPlayer) n++;
  return n;
}

/** Run the selected stages in sequence + post-process (spawner prime,
 *  broadcast, save). Shared by the no-args fast path and the gump's
 *  "Run" button. `enabled` is a bitmask aligned to STAGES.indexOf. */
function runStages(api, state, opts, enabled = 0xffff) {
  const totals = { added: 0, ran: 0 };
  state.sendSystemMessage('CreateWorld: starting bulk population…');
  for (let i = 0; i < STAGES.length; i++) {
    if (!((enabled >> i) & 1)) {
      state.sendSystemMessage(`  ${STAGES[i].name}: skipped`);
      continue;
    }
    const stage = STAGES[i];
    try {
      const r = stage.apply(api, opts);
      const n = r.added ?? 0;
      totals.added += n;
      totals.ran++;
      state.sendSystemMessage(`  ${stage.name}: +${n}`);
    } catch (e) {
      state.sendSystemMessage(`  ${stage.name}: FAILED — ${e.message}`);
      api.log?.(`[createworld] ${stage.name} threw: ${e.stack ?? e.message}`);
    }
  }
  // Drain the spawner once so the first wave of mobs lands before save.
  // ORDERING — `_createWorldDone` must be set BEFORE priming the spawner.
  // The spawner's `tick()` early-outs when `world._createWorldDone === false`
  // (the gate exists to prevent respawn-during-bulk-population phantom
  // mobs), so without flipping the flag first these 4 prime ticks were
  // silent no-ops — bankers, blacksmiths, miners and ~150 other
  // canonical vendors never spawned at `[createworld` time, only
  // trickling in 10 s/tick afterward. User report 2026-05-19 "no NPCs
  // in Britain (banker should be there)". Set the flag now, prime the
  // spawner, then continue with broadcast + save.
  if (totals.ran === STAGES.length) api.world._createWorldDone = true;
  try {
    if (api.spawner?.tick) for (let i = 0; i < 4; i++) api.spawner.tick(Date.now());
  } catch (e) { api.log?.(`[createworld] spawner prime: ${e.message}`); }
  try {
    const sent = broadcastBulkPlacement(api);
    if (sent > 0) state.sendSystemMessage(`  Broadcast: ${sent} item frames`);
  } catch (e) { api.log?.(`[createworld] broadcast threw: ${e.message}`); }
  try {
    const refresh = api.ctx?.handlers?.refreshSurroundings;
    if (refresh) {
      for (const m of allMobiles(api)) {
        if (m.client) refresh(m.client);
      }
    }
  } catch (e) { api.log?.(`[createworld] mob refresh: ${e.message}`); }
  // `_createWorldDone` was set above (before the spawner prime tick).
  try {
    const r = api.persistence?.requestSave?.(api.world, api.persistence.saveDir);
    if (r?.then) {
      r.then(({ bytes, ms }) => {
        state.sendSystemMessage(`  Saved: ${(bytes/1024)|0} KB in ${ms} ms`);
      }).catch((e) => api.log?.(`[createworld] save threw: ${e.message}`));
    }
  } catch (e) { api.log?.(`[createworld] save trigger threw: ${e.message}`); }
  const npcCount = countNonPlayerMobs(api.world);
  state.sendSystemMessage(
    `CreateWorld done. Total items added: ${totals.added}. NPCs in world: ${npcCount}.`,
  );
}

/** Cheap estimate of "how many items this stage will produce". Reads
 *  the JSON catalogs the bulk apply functions consume — fires only when
 *  the gump opens, never at boot. Missing files leave the count at 0
 *  which the gump renders as a no-suffix label. */
function estimateStageCounts() {
  /** @type {Record<string, number>} */
  const out = {};
  for (const s of STAGES) out[s.name] = 0;
  const safeCount = (name) => {
    try {
      const p = join(DATA_DIR, name);
      if (!existsSync(p)) return 0;
      const json = JSON.parse(readFileSync(p, 'utf8'));
      return Array.isArray(json) ? json.length : 0;
    } catch { return 0; }
  };
  out.Decorations = safeCount('decorations.json');
  out.Signs       = safeCount('signs.json');
  out.Doors       = safeCount('doors.json');
  out.Teleporters = safeCount('teleporters.json');
  // XmlSpawners / Moongates / Sigils have small fixed counts
  // or are runtime-derived; leave at 0 so the gump shows the stage name
  // without a misleading number.
  return out;
}

/** Build the create-world preview gump (resizepic + 1 toggle button per
 *  stage + Run / Cancel). Each stage's button cycles enabled/disabled.
 *  buttonId convention:
 *    0     close (cancel)
 *    1     RUN with current toggle mask
 *    100+i toggle stage i
 *  We re-render the gump after every toggle so the checkboxes update.
 */
function openCreateWorldGump(api, state, enabledMask) {
  const counts = estimateStageCounts();
  const W = 460;
  const headerH = 48;
  const rowH = 26;
  const footerH = 64;
  const H = headerH + STAGES.length * rowH + footerH;
  const texts = [];
  const lines = [`{ resizepic 0 0 5054 ${W} ${H} }`];
  // Title
  texts.push('── CreateWorld preview ──');
  lines.push(`{ text 20 14 1153 ${texts.length - 1} }`);
  // Hint row
  texts.push('Click each stage to toggle. Run executes only selected stages.');
  lines.push(`{ text 20 30 70 ${texts.length - 1} }`);
  // Per-stage rows
  for (let i = 0; i < STAGES.length; i++) {
    const y = headerH + i * rowH;
    const on = ((enabledMask >> i) & 1) === 1;
    // 4017/4018 = empty button (cancel art); 4023/4024 = filled (apply
    // art). Use them as our checkbox-on / checkbox-off pair so the
    // visual state is obvious without needing a separate {checkbox …}
    // primitive (the layout parser doesn't support that opcode yet).
    const upArt   = on ? 4023 : 4017;
    const downArt = on ? 4024 : 4018;
    lines.push(`{ button 20 ${y} ${upArt} ${downArt} 1 0 ${100 + i} }`);
    const c = counts[STAGES[i].name];
    const cTxt = (c != null && c > 0) ? `  (~${c} items)` : '';
    texts.push(`${on ? '[x]' : '[ ]'}  ${STAGES[i].name}${cTxt}`);
    lines.push(`{ text 52 ${y + 4} ${on ? 70 : 904} ${texts.length - 1} }`);
  }
  // Run / Cancel
  const btnY = headerH + STAGES.length * rowH + 12;
  lines.push(`{ button 20  ${btnY} 4023 4024 1 0 1 }`);
  texts.push(`Run selected (${popcount(enabledMask)} of ${STAGES.length})`);
  lines.push(`{ text 50  ${btnY + 4} 1153 ${texts.length - 1} }`);
  lines.push(`{ button 260 ${btnY} 4017 4018 1 0 0 }`);
  texts.push('Cancel');
  lines.push(`{ text 290 ${btnY + 4} 1153 ${texts.length - 1} }`);
  api.gumps.send(state, { x: 80, y: 80, layout: lines.join(''), texts }, (resp) => {
    const btn = resp.buttonId | 0;
    if (btn === 0) return;                  // cancel
    if (btn >= 100 && btn < 100 + STAGES.length) {
      // Toggle and re-open. Mask XOR with the bit so the +/- cycle
      // reads naturally to the operator.
      const idx = btn - 100;
      openCreateWorldGump(api, state, enabledMask ^ (1 << idx));
      return;
    }
    if (btn === 1) {
      runStages(api, state, {}, enabledMask);
    }
  });
}

function popcount(n) { let c = 0; while (n) { c += n & 1; n >>>= 1; } return c; }

export default function register(api) {
  if (!api.commands || !api.items) return () => {};

  api.commands.register({
    name: 'createworld',
    help: '[createworld [facet... | gump | force] — populate every facet with decorations, signs, doors and teleporters extracted from ServUO data. `[createworld gump` opens a preview with per-stage toggles. Refuses if the world is already populated; use [wipeworld first or [recreateworld to re-run.',
    access: 'Admin',
    run(ctx) {
      const args = ctx.args ?? [];
      // Preview gump path. Lets the operator inspect what each stage
      // would do (and which catalog files have data) before committing.
      // Marcin asked for this so [createworld doesn't feel like a black
      // box — every batch surfaces its plan first.
      if (args[0] === 'gump') {
        if (!api.gumps?.send) {
          ctx.state.sendSystemMessage('Gump runtime unavailable — use `[createworld` without `gump` to run.');
          return;
        }
        const enabled = (1 << STAGES.length) - 1;   // all on by default
        openCreateWorldGump(api, ctx.state, enabled);
        return;
      }
      // Hard-block: refuse a second invocation. ServUO's CreateWorld is
      // also single-shot (it tracks per-stage applied flags) but ours
      // logged "skipped" silently — the operator couldn't tell it had
      // already run. Use a single explicit guard so the message is loud
      // and easy to recover from.
      const force = args[0] === 'force';
      if (api.world._createWorldDone && !force && !args.length) {
        ctx.state.sendSystemMessage(
          'CreateWorld: already run on this shard. Use [wipeworld for a clean slate or [recreateworld to wipe-and-repopulate in one step. Or `[createworld gump` for a per-stage preview.',
        );
        return;
      }
      const facetArgs = force ? args.slice(1) : args;
      const facets = facetArgs.length ? facetArgs.map((s) => parseInt(s, 10)).filter(Number.isFinite) : null;
      const opts = facets ? { facets } : {};
      runStages(api, ctx.state, opts);
    },
  });

  api.commands.register({
    name: 'deleteworld',
    help: '[deleteworld [facet...] — remove everything [createworld placed.',
    access: 'Admin',
    run(ctx) {
      const args = ctx.args ?? [];
      const facets = args.length ? args.map((s) => parseInt(s, 10)).filter(Number.isFinite) : null;
      const opts = facets ? { facets } : {};
      ctx.state.sendSystemMessage('DeleteWorld: removing generated content…');
      const totals = { removed: 0 };
      for (const stage of STAGES) {
        try {
          const r = stage.remove(api, opts);
          const n = r.removed ?? 0;
          totals.removed += n;
          ctx.state.sendSystemMessage(`  ${stage.name}: -${n}`);
        } catch (e) {
          ctx.state.sendSystemMessage(`  ${stage.name}: FAILED — ${e.message}`);
        }
      }
      // Lift the hard-block so a follow-on `[createworld` is allowed.
      // Per-facet runs leave it alone — the world is still partially
      // populated and a bare `[createworld` would skip the leftover
      // facets without us needing to re-stamp anything.
      if (!facets) delete api.world._createWorldDone;
      ctx.state.sendSystemMessage(`DeleteWorld done. Total items removed: ${totals.removed}.`);
    },
  });

  api.commands.register({
    name: 'recreateworld',
    // Note: also clears the hard-block flag below so the inner
    // createworld-style apply pass re-stamps it after success.
    help: '[recreateworld [facet...] — wipe + repopulate the generated content.',
    access: 'Admin',
    run(ctx) {
      const args = ctx.args ?? [];
      const facets = args.length ? args.map((s) => parseInt(s, 10)).filter(Number.isFinite) : null;
      const opts = facets ? { facets } : {};
      let removed = 0; let added = 0;
      for (const stage of STAGES) {
        try { removed += stage.remove(api, opts).removed ?? 0; } catch { /* tolerate */ }
      }
      // Clear the hard-block so a follow-on `[createworld` can run
      // without arguments. Per-facet runs (`[recreateworld 1`) leave
      // the flag alone since the world is still partially populated.
      if (!facets) delete api.world._createWorldDone;
      for (const stage of STAGES) {
        try { added += stage.apply(api, opts).added ?? 0; } catch { /* tolerate */ }
      }
      try { broadcastBulkPlacement(api); } catch { /* ignore */ }
      try {
        if (api.spawner?.tick) for (let i = 0; i < 4; i++) api.spawner.tick(Date.now());
      } catch { /* ignore */ }
      api.world._createWorldDone = true;
      ctx.state.sendSystemMessage(`RecreateWorld: -${removed} +${added}.`);
    },
  });

  return () => {};
}
