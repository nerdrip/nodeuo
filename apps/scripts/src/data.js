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

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { registerLifecycleScripts } from './items/behaviors/lifecycle-scripts.js';
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

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  const disposers = [];

  // FAZA BN: register all built-in item lifecycle scripts BEFORE the
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
    const registered = [];
    for (const t of items) {
      try {
        api.templates.registerTemplate(t);
        registered.push(t.name);
      } catch (e) {
        api.log(`data: item template ${t.name} failed: ${e.message}`);
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
    const registered = [];
    for (const m of mons) {
      try {
        api.monsters.register(m);
        registered.push(m.kind);
      } catch (e) {
        api.log(`data: monster ${m.kind} failed: ${e.message}`);
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
    const registered = [];
    for (const n of npcs) {
      if (!n || typeof n.kind !== 'string') continue;
      try {
        api.npcs.register(n);
        registered.push(n.kind);
      } catch (e) {
        api.log(`data: npc ${n.kind} failed: ${e.message}`);
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

  return () => {
    for (const d of disposers.reverse()) {
      try { d(); } catch (e) { console.error('[data-loader] disposer threw:', e); }
    }
  };
}
