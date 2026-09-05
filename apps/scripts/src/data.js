// Data-driven registration.
//
// Reads JSON definitions from ./data/ and populates the shared registries
// provided by the server (item templates, loot tables, monster templates).
// This mirrors ServUO's `Data/` folder: authoring is done as plain data,
// scripts only supply behavior.
//
// Files consumed (all optional):
//   data/config/items.json         — array of ItemTemplate
//   data/config/loot-tables.json   — array of LootTable
//   data/config/monsters.json      — array of MonsterTemplate
//   data/config/npcs.json          — array of NpcTemplate
//   data/config/skills.json        — array of SkillEntry
//   data/config/gumps.json         — visual server-gump definitions
//   data/config/server-gump-catalog.json — source-linked server-gump inventory

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { registerLifecycleScripts } from './items/behaviors/lifecycle-scripts.js';
import { compileGumpDefinition } from './gumps/definition-runtime.js';
// Shared housedata accessor — shared with the in-game client and the
// admin editor so all three surfaces resolve `houseRole` / `doorPiece`
// identically. See apps/client/src/shared/housedata.js.
import { buildHousedataAccessor } from '../../client/src/shared/housedata.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));

function readJson(relPath) {
  const full = path.join(here, relPath);
  if (!fs.existsSync(full)) return null;
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    console.error(`[data-loader] failed to parse ${relPath}: ${e.message}`);
    return null;
  }
}

/** Validate the canonical item-config identity contract before registering a
 * single row. Shared art ids are deliberately allowed; stable definition ids
 * are the only unique gameplay keys. */
export function validateItemConfig(items) {
  if (!Array.isArray(items)) throw new Error('items.json must contain an array');
  const ids = new Set();
  const errors = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const at = `items[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const id = typeof item.definitionId === 'string' ? item.definitionId.trim() : '';
    if (!id) errors.push(`${at} missing definitionId`);
    else if (ids.has(id)) errors.push(`${at} duplicates definitionId '${id}'`);
    else ids.add(id);
    if (!Number.isInteger(item.artId) || item.artId <= 0 || item.artId > 0xFFFF) {
      errors.push(`${id || at} has invalid artId`);
    }
    if (item.hue != null && (!Number.isInteger(item.hue) || item.hue < 0 || item.hue > 0xFFFF)) {
      errors.push(`${id || at} has invalid hue`);
    }
    for (const field of ['paperdollGumpId', 'paperdollMaleGumpId', 'paperdollFemaleGumpId']) {
      if (item[field] != null && (!Number.isInteger(item[field]) || item[field] < 0 || item[field] > 0xFFFF)) {
        errors.push(`${id || at} has invalid ${field}`);
      }
    }
    if (item.equipLayer != null && (!Number.isInteger(item.equipLayer) || item.equipLayer < 0 || item.equipLayer > 29)) {
      errors.push(`${id || at} has invalid equipLayer`);
    }
    if (Object.hasOwn(item, 'itemId')) {
      errors.push(`${id || at} must use artId, not itemId, in canonical config`);
    }
    if (!Object.hasOwn(item, 'script')) {
      errors.push(`${id || at} must declare script explicitly (string or null)`);
    } else if (item.script !== null && (typeof item.script !== 'string' || !item.script.trim())) {
      errors.push(`${id || at} has invalid script`);
    }
  }
  if (errors.length) throw new Error(`invalid item config:\n${errors.join('\n')}`);
  return { count: items.length, definitions: ids.size };
}

/** Mobiles follow the same identity split as items: definitionId is the only
 * gameplay key, while bodyId and hue are freely reusable presentation data. */
export function validateMobileConfig(mobiles, label = 'mobiles') {
  if (!Array.isArray(mobiles)) throw new Error(`${label}.json must contain an array`);
  const ids = new Set();
  const errors = [];
  for (let index = 0; index < mobiles.length; index++) {
    const mobile = mobiles[index];
    const at = `${label}[${index}]`;
    if (!mobile || typeof mobile !== 'object' || Array.isArray(mobile)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const id = typeof mobile.definitionId === 'string' ? mobile.definitionId.trim() : '';
    if (!id) errors.push(`${at} missing definitionId`);
    else if (ids.has(id)) errors.push(`${at} duplicates definitionId '${id}'`);
    else ids.add(id);
    if (!Number.isInteger(mobile.bodyId) || mobile.bodyId <= 0 || mobile.bodyId > 0xFFFF) {
      errors.push(`${id || at} has invalid bodyId`);
    }
    if (mobile.hue != null && (!Number.isInteger(mobile.hue) || mobile.hue < 0 || mobile.hue > 0xFFFF)) {
      errors.push(`${id || at} has invalid hue`);
    }
    if (Object.hasOwn(mobile, 'kind')) {
      errors.push(`${id || at} must use definitionId, not kind, in canonical config`);
    }
    if (Object.hasOwn(mobile, 'body')) {
      errors.push(`${id || at} must use bodyId, not body, in canonical config`);
    }
  }
  if (errors.length) throw new Error(`invalid ${label} config:\n${errors.join('\n')}`);
  return { count: mobiles.length, definitions: ids.size };
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  const disposers = [];

  // PHASE BN: register all built-in item lifecycle scripts BEFORE the
  // template loader runs so items.json `script: 'torch'` references
  // resolve. The disposer pulls them back out on hot-reload.
  const itemScripts = api.itemScripts;
  const beforeScripts = new Set(itemScripts?.all?.().map((s) => s.name) ?? []);
  registerLifecycleScripts(api);
  const addedScripts = itemScripts?.all?.()
    .map((s) => s.name)
    .filter((n) => !beforeScripts.has(n)) ?? [];
  api.log(`data: ${addedScripts.length} item lifecycle scripts registered`);
  disposers.push(() => {
    for (const name of addedScripts) itemScripts?.unregister?.(name);
  });

  // --- Item templates -------------------------------------------------
  const items = readJson('data/config/items.json');
  if (items && api.templates) {
    validateItemConfig(items);
    const registered = [];
    for (const t of items) {
      const definitionId = t.definitionId ?? t.id ?? t.name;
      try {
        api.templates.registerTemplate(t);
        registered.push(definitionId);
      } catch (e) {
        api.log(`data: item template ${definitionId ?? '<unnamed>'} failed: ${e.message}`);
      }
    }
    api.log(`data: ${registered.length} item templates from items.json`);
    disposers.push(() => {
      for (const name of registered) api.templates.unregisterTemplate(name);
    });
  }

  // --- Loot tables ----------------------------------------------------
  const tables = readJson('data/config/loot-tables.json');
  if (tables && api.loot) {
    const registered = [];
    for (const t of tables) {
      try {
        api.loot.register(t);
        registered.push(t.name);
      } catch (e) {
        api.log(`data: loot table ${t.name} failed: ${e.message}`);
      }
    }
    api.log(`data: ${registered.length} loot tables from loot-tables.json`);
    disposers.push(() => {
      for (const name of registered) api.loot.unregister(name);
    });
  }

  // --- Monster templates ---------------------------------------------
  const mons = readJson('data/config/monsters.json');
  if (mons && api.monsters) {
    validateMobileConfig(mons, 'monsters');
    const registered = [];
    for (const m of mons) {
      try {
        api.monsters.register(m);
        registered.push(m.definitionId);
      } catch (e) {
        api.log(`data: monster ${m.definitionId} failed: ${e.message}`);
      }
    }
    api.log(`data: ${registered.length} monster templates from monsters.json`);
    disposers.push(() => {
      for (const kind of registered) api.monsters.unregister(kind);
    });
  }

  // --- NPC templates --------------------------------------------------
  // npcs.json may carry a leading `{ "_comment": ..., "_schema": ... }`
  // header for documentation; skip anything without a `kind` field.
  const npcs = readJson('data/config/npcs.json');
  if (npcs && api.npcs) {
    validateMobileConfig(npcs, 'npcs');
    const registered = [];
    for (const n of npcs) {
      try {
        api.npcs.register(n);
        registered.push(n.definitionId);
      } catch (e) {
        api.log(`data: npc ${n.definitionId} failed: ${e.message}`);
      }
    }
    api.log(`data: ${registered.length} npc templates from npcs.json`);
    disposers.push(() => {
      for (const kind of registered) api.npcs.unregister(kind);
    });
  }

  // --- House component data (walls/doors/floors/stairs/roofs/misc) ----
  // Accessor logic now lives in `apps/client/src/shared/housedata.js`
  // so the client (in-game placemulti preview) and the admin editor
  // (house customization gump) share the same role / pieceIdx tables.
  // We still load + parse the JSON here because the script API needs
  // an in-process accessor; the shared module is parameterised on the
  // parsed JSON so it works identically on server + browser.
  const housedata = readJson('data/config/housedata.json');
  if (housedata && api) {
    const acc = buildHousedataAccessor(housedata);
    if (acc) {
      api.housedata = { raw: housedata, ...acc };
      api.log(`data: housedata loaded (shared accessor; ${(housedata.doors ?? []).length} door categories)`);
      disposers.push(() => { delete api.housedata; });
    }
  }

  // --- Skills ---------------------------------------------------------
  const skills = readJson('data/config/skills.json');
  if (skills && api.skills) {
    const registered = [];
    for (const s of skills) {
      try {
        api.skills.register(s);
        registered.push(s.id);
      } catch (e) {
        api.log(`data: skill ${s.id} (${s.name}) failed: ${e.message}`);
      }
    }
    api.log(`data: ${registered.length} skills from skills.json`);
    disposers.push(() => {
      for (const id of registered) api.skills.unregister(id);
    });
  }

  // --- Data-driven server gumps --------------------------------------
  // The layout compiler lives in gumps/definition-runtime.js; this loader
  // owns only the hot-reloadable canonical records shared with Content Studio.
  const gumpDefinitions = readJson('data/config/gumps.json');
  const sourceLinkedGumps = readJson('data/config/server-gump-catalog.json');
  if ((Array.isArray(gumpDefinitions) || Array.isArray(sourceLinkedGumps)) && api.systems) {
    const previous = api.systems.gumpDefinitions;
    const previousResolver = api.systems.resolveServerGumpOverride;
    const registry = new Map();
    const byGumpId = new Map();
    const ambiguousGumpIds = new Set();
    for (const definition of [...(gumpDefinitions ?? []), ...(sourceLinkedGumps ?? [])]) {
      const id = String(definition?.definitionId ?? definition?.id ?? '').trim();
      if (!id) { api.log?.('data: skipped a gump without definitionId'); continue; }
      registry.set(id, definition);
      if (definition?.gumpId != null && Number.isFinite(Number(definition.gumpId))) {
        const gumpId = Number(definition.gumpId) >>> 0;
        if (byGumpId.has(gumpId)) { ambiguousGumpIds.add(gumpId); byGumpId.delete(gumpId); }
        else if (!ambiguousGumpIds.has(gumpId)) byGumpId.set(gumpId, definition);
      }
    }
    api.systems.gumpDefinitions = registry;
    const resolver = (gump) => {
      if (!gump || typeof gump !== 'object') return gump;
      const definitionId = String(gump.definitionId ?? '').trim();
      const definition = (definitionId ? registry.get(definitionId) : null)
        ?? (gump.gumpId != null ? byGumpId.get(Number(gump.gumpId) >>> 0) : null);
      if (!definition?.enabled || !Array.isArray(definition.controls) || !definition.controls.length) return gump;
      const compiled = compileGumpDefinition(definition, {
        texts: Array.isArray(gump.texts) ? gump.texts : [],
        original: gump,
        ...(gump.values && typeof gump.values === 'object' ? gump.values : {}),
      });
      const resolved = { ...gump, ...compiled };
      if (gump.gumpId != null) resolved.gumpId = gump.gumpId;
      else if (definition.gumpId == null) delete resolved.gumpId;
      return resolved;
    };
    api.systems.resolveServerGumpOverride = resolver;
    api.log?.(`data: ${registry.size} visual/source-linked gump definitions (${byGumpId.size} stable gumpId mappings)`);
    disposers.push(() => {
      if (api.systems.gumpDefinitions === registry) {
        if (previous === undefined) delete api.systems.gumpDefinitions;
        else api.systems.gumpDefinitions = previous;
      }
      if (api.systems.resolveServerGumpOverride === resolver) {
        if (previousResolver === undefined) delete api.systems.resolveServerGumpOverride;
        else api.systems.resolveServerGumpOverride = previousResolver;
      }
    });
  }

  return () => {
    for (const d of disposers.reverse()) {
      try { d(); } catch (e) { console.error('[data-loader] disposer threw:', e); }
    }
  };
}
