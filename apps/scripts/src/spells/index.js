// Spell registry — single source of truth.
//
// `apps/scripts/src/data/config/spells.json` is the catalog. One row per
// spell id with every piece of metadata needed to register and cast:
//   { id, name, school, skillId, circle, minSkill, mana, delayMs,
//     soundId, requiresTarget, reagents, script }
//
// At module load we top-level-await `import('./'+row.script)` for every
// row that carries a `script` path. The imported default export
// supplies the per-spell `cast(api, ctx, target)` implementation.
//
// Editing balance / cast time / sound / reagent cost is a JSON change.
// Adding a new spell is: drop a `.js` next to its peers + add the row
// to `spells.json` (with a path in `script`). No edits to this file.
//
// `SPELLS`, `SPELLS_BY_CIRCLE` and `ALL` are exported for the
// spellbook gump + callers who need to enumerate the catalog without
// touching the registry. They derive from the same JSON+per-spell-cast
// data so there's exactly one place to update.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { SPELL_MANTRAS } from './_helpers.js';

const _HERE = path.dirname(url.fileURLToPath(import.meta.url));
const _SPELLS_JSON = path.resolve(_HERE, '../data/config/spells.json');

/** Raw catalog rows keyed by id-string. */
const SPELL_DATA = (() => {
  try { return JSON.parse(fs.readFileSync(_SPELLS_JSON, 'utf8')); }
  catch (e) {
    console.warn('[spells] cannot read spells.json:', e.message);
    return {};
  }
})();

// ---------------------------------------------------------------------------
// Dynamic import of every per-spell `cast` module declared in the JSON.
// We use Promise.all with top-level await so the module's `register`
// export sees a fully populated `SPELLS` map; ScriptRuntime in turn
// awaits this module's import() at boot, so all loads sequence
// correctly.
const _CAST_ENTRIES = await Promise.all(
  Object.values(SPELL_DATA)
    .filter((row) => typeof row?.script === 'string')
    .map(async (row) => {
      try {
        const mod = await import(/* @vite-ignore */ `./${row.script}`);
        return [row, mod.default];
      } catch (e) {
        console.warn(`[spells] failed to load ${row.script}: ${e.message}`);
        return null;
      }
    }),
);

/** id-keyed map of `{ ...row, slug, cast, needsTarget, reagents, ... }`.
 *  We deliberately KEEP `row.name` (proper-case display) and surface
 *  the per-spell file's kebab-case `name` as `slug` — merging the two
 *  in a single field would clobber the registry's display name (the
 *  spellbook gump renders this). `cast` is always the per-spell
 *  module's `cast` function. */
const _BY_ID = {};
/** kebab-case slug → spell, mirrors per-spell file's `name` export. */
const _BY_SLUG = {};
for (const entry of _CAST_ENTRIES) {
  if (!entry) continue;
  const [row, mod] = entry;
  if (!mod || typeof mod.cast !== 'function') continue;
  const merged = {
    ...row,                              // id, name (proper-case), school, …
    slug:        mod.name,               // 'magic-arrow' — for lookups
    cast:        mod.cast,
    // Per-spell file's `needsTarget` is the legacy field name (cast.js
    // reads it). JSON uses `requiresTarget`. Per-spell files were
    // stripped of metadata, so the JSON value is the source of truth
    // now. Mirror onto BOTH names so every caller path (cast.js +
    // server registry) sees a consistent flag.
    needsTarget: mod.needsTarget ?? row.requiresTarget ?? false,
    targetKind:  mod.targetKind ?? row.targetKind,
    // reagents come from JSON post-strip; per-spell files no longer
    // declare them. Keep mod.reagents as fallback for any file the
    // strip pass missed.
    reagents:    row.reagents ?? mod.reagents,
    // Chivalry spends tithing points instead of reagents. Older rows
    // omitted the explicit field and `[cast]` defaulted to 5; mirror
    // that default here so spellbook/AI paths through castSpell() pay
    // the same cost.
    tithe:       row.tithe ?? row.tithing ?? mod.tithe ?? (row.school === 'chivalry' ? 5 : undefined),
  };
  _BY_ID[row.id] = merged;
  _BY_SLUG[mod.name] = merged;
}

/** Every spell, in insertion order (matches spells.json walk). */
export const ALL = Object.values(_BY_ID);

/** Spell catalog keyed by per-spell kebab-case slug. Callers consume
 *  `SPELLS['magic-arrow']` etc., matching the previous shape. */
export const SPELLS = _BY_SLUG;

/** Spells grouped by circle (1..8) — useful for spellbook page rendering. */
export const SPELLS_BY_CIRCLE = ALL.reduce((acc, s) => {
  if (s.circle != null) (acc[s.circle] ??= []).push(s);
  return acc;
}, /** @type {Record<number, typeof ALL>} */ ({}));

// ---------------------------------------------------------------------------
// Script api/ctx shims — every per-spell `cast()` reads through these so
// missing root keys never throw inside an effect. Spread `rootApi` first
// so additions (api.ai, api.poison, api.monsters, ...) flow through
// without per-shim updates.
function _buildScriptApi(rootApi) {
  return {
    ...rootApi,
    // Combat stubs MERGED under whatever rootApi.combat exposes — the
    // test setup wires `combat-formulas.js` (pure helpers, no `damage`
    // / `animate` / `awardSkill`), so a stub-only fallback wouldn't
    // help (the namespace was truthy, just missing methods). Merging
    // adds no-ops for absent methods while preserving real ones in
    // production (handlers.js builds a richer `combat` object that
    // wins on the spread).
    combat: { damage: () => {}, animate: () => {}, awardSkill: () => {}, playSoundNear: () => {}, ...(rootApi.combat ?? {}) },
    statusEffects: { apply: () => {}, remove: () => {}, ...(rootApi.statusEffects ?? {}) },
    // Protocol stub — helpers like `broadcastSound` / `broadcastEffect`
    // / `reveal` call `api.protocol.playSound(...)` /
    // `api.protocol.mobileIncoming(...)` unconditionally. In unit
    // tests (where the protocol module isn't injected) this used to
    // throw mid-cast, which the outer try/catch swallowed silently —
    // the FAZA HJ Reveal test never saw `hidden` flip to false because
    // `broadcastSound` threw before the spell's own loop ran.
    // Tolerate the absence: provide no-op builders that return empty
    // `Uint8Array` payloads. ScriptRuntime always injects the real
    // protocol at boot, so production paths are unaffected.
    protocol: rootApi.protocol ?? {
      playSound:      () => new Uint8Array(0),
      huedEffect:     () => new Uint8Array(0),
      mobileIncoming: () => new Uint8Array(0),
      mobileUpdate:   () => new Uint8Array(0),
      healthUpdate:   () => new Uint8Array(0),
      unicodeMessage: () => new Uint8Array(0),
      EffectKind: { Moving: 1, FromSource: 2, Lightning: 1 },
    },
  };
}

function _buildScriptCtx(caster) {
  const sysMsg = (line) => caster.client?.sendSystemMessage?.(line);
  const state = caster.client ?? { sendSystemMessage: sysMsg };
  return { sender: caster, state };
}

/** Default export consumed by ScriptRuntime — registers every spell into
 *  `api.systems.spells.registerSpell`. */
export default function register(rootApi) {
  const spellSys = rootApi.systems?.spells;
  if (!spellSys?.registerSpell) {
    rootApi.log?.('spells/index: api.systems.spells missing — registration skipped');
    return () => {};
  }
  const api = _buildScriptApi(rootApi);
  let registered = 0;
  for (const spell of ALL) {
    spellSys.registerSpell({
      id:       spell.id,
      name:     spell.name,                  // proper-case from JSON
      school:   spell.school,
      skillId:  spell.skillId,
      minSkill: spell.minSkill,
      mana:     spell.mana,
      delayMs:  spell.delayMs,
      soundId:  spell.soundId,
      tithing:  spell.tithe,
      // Power-words mantra. castSpell() reads `def.mantra` and fires a
      // broadcastSpellWords (overhead label). Lookup table is keyed
      // on the per-spell file slug — `SPELL_MANTRAS['magic-arrow']`.
      mantra:   SPELL_MANTRAS[spell.slug],
      requiresTarget: !!(spell.requiresTarget ?? spell.needsTarget),
      targetKind:     spell.targetKind ?? 'object',
      reagents:       spell.reagents ?? null,
      effect: (ctx) => {
        try {
          // Per-call api: overlay `ctx.world` so unit tests + cast paths
          // that supply a fresh World don't fall through to the
          // closed-over `api.world` (which is set only at server boot).
          // Without this, broadcastSound / broadcastEffect / reveal —
          // all of which iterate `api.world.mobiles` — threw "Cannot
          // read properties of undefined (reading 'mobiles')" mid-cast
          // and the outer try/catch swallowed it, so spells silently
          // no-op'd in any context where rootApi lacked `world`.
          const baseApi = ctx.world ? { ...api, world: ctx.world } : api;
          // The central cast pipeline owns the caster's preparation gesture.
          // Legacy per-spell modules also call combat.animate(caster, 0x10),
          // which otherwise produces a second cast animation after target
          // selection. Preserve hit/reaction animations on the victim while
          // suppressing only that duplicate caster gesture.
          const baseCombat = baseApi.combat ?? {};
          const callApi = {
            ...baseApi,
            combat: {
              ...baseCombat,
              animate: (world, mob, ...args) => {
                if (mob === ctx.caster) return undefined;
                return baseCombat.animate?.(world, mob, ...args);
              },
            },
          };
          spell.cast(callApi, _buildScriptCtx(ctx.caster), ctx.target);
        } catch (e) {
          rootApi.log?.(`spell ${spell.name} effect threw: ${e?.message ?? e}`);
          if (globalThis.process?.env?.DEBUG_SPELL_THROW) console.error(`[spell ${spell.name}]`, e);
        }
      },
    });
    registered++;
  }
  rootApi.log?.(`spells/index: registered ${registered} spells from data/config/spells.json`);
  return () => {};
}
