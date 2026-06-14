// Tokuno Sky Garden — bonsai + cherry blossom economy.
//
// ServUO `Engines/Plants/Sky Garden`: an open-air courtyard on Makoto-Jima
// where players grow bonsai/sakura trees in special pot variants. Each
// tree yields a bonsai item every 24h. Players can trade bonsai for
// `tokuno-pigments` via a Sky Garden Master NPC.
//
// We layer on top of the existing pot-plants system (apps/scripts/src/
// items/pot-plants.js). New species are added to a shared registry +
// hooked into the existing `[plant pot` flow. The Sky Garden Master
// NPC is spawned via this script on boot at the canonical coords.

// Sky Garden center + bonsai species + economy ratios —
// `data/world/spawns/tokuno-sky-garden.json`.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createItem, destroyItemBySerial } from '../_items.js';
import { findBackpack, packItems } from '../_inventory.js';
import { allItems, allMobiles } from '../_spatial.js';
import { canCreateMobile, createMobile } from '../_mobiles.js';

const __HERE = path.dirname(url.fileURLToPath(import.meta.url));
const __DATA = path.resolve(__HERE, '../data/world/spawns/tokuno-sky-garden.json');

let __CFG = {
  center: { x: 800, y: 1213, z: 25, map: 3 },
  harvestIntervalMs: 86_400_000, turnInRatio: 5, bonsaiSpecies: [],
};
try { __CFG = { ...__CFG, ...JSON.parse(fs.readFileSync(__DATA, 'utf8')) }; }
catch (e) { console.warn('[sky-garden] load failed:', e.message); }

const SKY_GARDEN_CENTER   = __CFG.center;
const BONSAI_SPECIES      = __CFG.bonsaiSpecies;
const HARVEST_INTERVAL_MS = __CFG.harvestIntervalMs;
const TURN_IN_RATIO       = __CFG.turnInRatio;

function placeMaster(api) {
  if (!canCreateMobile(api, api.world)) return null;
  try {
    const npc = createMobile(api, api.world, {
      name: 'Sky Garden Master',
      body: 0x0191, hue: 0x481,
      x: SKY_GARDEN_CENTER.x, y: SKY_GARDEN_CENTER.y, z: SKY_GARDEN_CENTER.z,
      map: SKY_GARDEN_CENTER.map,
      hp: 200, hpMax: 200, str: 100, dex: 50, int: 100,
      notoriety: 2,                        // Townfolk (yellow)
      kind: 'sky-garden-master',
    });
    if (npc) {
      npc._skyGardenMaster = true;
      npc.flags = (npc.flags | 0) | 0x10;          // frozen
    }
    return npc;
  } catch (e) {
    api.log?.(`[sky-garden] master spawn threw: ${e.message}`);
    return null;
  }
}

export default function register(api) {
  if (!api.commands || !api.world) return () => {};

  // Defer master placement until world.mobiles is ready.
  (api.lifecycle?.setImmediate ?? setImmediate)(() => { placeMaster(api); });

  api.commands.register({
    name: 'skygarden',
    help: '[skygarden list|harvest|turnin — Tokuno Sky Garden bonsai economy.',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const mob = ctx.sender;

      if (sub === 'list') {
        ctx.state.sendSystemMessage?.('Sky Garden bonsai species:');
        for (const sp of BONSAI_SPECIES) {
          ctx.state.sendSystemMessage?.(
            `  ${sp.key.padEnd(16)} — ${sp.name} (fame ${sp.fame})`,
          );
        }
        ctx.state.sendSystemMessage?.(
          `Bring ${TURN_IN_RATIO} bonsai to the Sky Garden Master (Makoto-Jima ${SKY_GARDEN_CENTER.x},${SKY_GARDEN_CENTER.y}) for 1 Greater Pigment.`,
        );
        return;
      }

      if (sub === 'harvest') {
        // Find a bonsai tree the user owns within 4 tiles.
        let target = null;
        for (const it of allItems(api)) {
          if (!it._skyGardenTree) continue;
          if (it.map !== mob.map) continue;
          if (it._skyGardenOwner !== mob.serial) continue;
          const d = Math.max(Math.abs(it.x - mob.x), Math.abs(it.y - mob.y));
          if (d > 4) continue;
          target = it; break;
        }
        if (!target) {
          ctx.state.sendSystemMessage?.('Stand next to one of your bonsai trees.');
          return;
        }
        const last = target._skyGardenLastHarvestAt ?? 0;
        const due = last + HARVEST_INTERVAL_MS;
        if (Date.now() < due) {
          const hrs = Math.ceil((due - Date.now()) / 3_600_000);
          ctx.state.sendSystemMessage?.(`Not ready — next harvest in ~${hrs}h.`);
          return;
        }
        const species = BONSAI_SPECIES.find((s) => s.key === target._skyGardenSpecies)
                      ?? BONSAI_SPECIES[0];
        try {
          const item = api.game?.mobile?.giveItem?.(mob, {
            itemId: species.itemId, hue: species.hue, name: species.name,
            movable: true, weight: 1,
          });
          if (!item) { ctx.state.sendSystemMessage?.('No backpack.'); return; }
          if (item) {
            item._skyGardenBonsai = true;
            item._skyGardenSpecies = species.key;
            target._skyGardenLastHarvestAt = Date.now();
            ctx.state.sendSystemMessage?.(`You harvest a ${species.name}.`);
          }
        } catch (e) { api.log?.(`[sky-garden] harvest threw: ${e.message}`); }
        return;
      }

      if (sub === 'turnin') {
        // Must stand within 4 tiles of the Sky Garden Master.
        const master = [...allMobiles(api)]
          .find((m) => m._skyGardenMaster && m.map === mob.map &&
                       Math.max(Math.abs(m.x - mob.x), Math.abs(m.y - mob.y)) <= 4);
        if (!master) {
          ctx.state.sendSystemMessage?.(`Stand at the Sky Garden Master (Makoto-Jima ${SKY_GARDEN_CENTER.x},${SKY_GARDEN_CENTER.y}).`);
          return;
        }
        const pack = findBackpack(api, mob);
        if (!pack) { ctx.state.sendSystemMessage?.('No backpack.'); return; }
        const bonsai = [...packItems(api, mob)]
          .filter((it) => it._skyGardenBonsai)
          .slice(0, TURN_IN_RATIO);
        if (bonsai.length < TURN_IN_RATIO) {
          ctx.state.sendSystemMessage?.(`You need ${TURN_IN_RATIO} bonsai — you have ${bonsai.length}.`);
          return;
        }
        for (const b of bonsai) {
          try { destroyItemBySerial(api, b.serial); }
          catch { /* ignore */ }
        }
        const pigment = api.game?.mobile?.giveItem?.(mob, {
          itemId: 0x4007, hue: 0x47E, name: 'greater pigments of Tokuno',
          movable: true, weight: 1,
        });
        if (pigment) {
          pigment.tokunoArtifact = true;
        }
        ctx.state.sendSystemMessage?.(
          `The Sky Garden Master accepts your ${TURN_IN_RATIO} bonsai and grants Greater Pigments of Tokuno.`,
        );
        return;
      }

      // No sub → admin spawn for a sky garden tree.
      const access = ctx.state?.account?.accessLevel ?? 'Player';
      if (access !== 'GM' && access !== 'Admin') {
        ctx.state.sendSystemMessage?.('Usage: [skygarden list|harvest|turnin');
        return;
      }
      const speciesKey = sub;
      const sp = BONSAI_SPECIES.find((s) => s.key === speciesKey);
      if (!sp) {
        ctx.state.sendSystemMessage?.('Usage: [skygarden <species>  (GM)');
        for (const s of BONSAI_SPECIES) ctx.state.sendSystemMessage?.(`  ${s.key}`);
        return;
      }
      try {
        const tree = createItem(api, api.world, {
          itemId: sp.itemId, hue: sp.hue, name: `${sp.name} (tree)`,
          x: mob.x, y: mob.y, z: mob.z, map: mob.map ?? 1,
          movable: false,
        });
        if (tree) {
          tree._skyGardenTree = true;
          tree._skyGardenSpecies = sp.key;
          tree._skyGardenOwner = mob.serial;
          tree._skyGardenLastHarvestAt = 0;
          ctx.state.sendSystemMessage?.(`A ${sp.name} tree appears.`);
        }
      } catch (e) {
        ctx.state.sendSystemMessage?.(`Tree spawn failed: ${e.message}`);
      }
    },
  });

  return () => api.commands.unregister('skygarden');
}
