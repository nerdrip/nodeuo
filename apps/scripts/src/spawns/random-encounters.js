// Random Encounters — port of ServUO `Scripts/Misc/RandomEncounter.cs`.
//
// As players walk through the wilderness (non-town, non-dungeon regions),
// there's a small chance per step of triggering a themed ambush — bandits
// jump out of the bushes, a wisp leads you off the road, a wandering
// merchant offers a quick trade, etc.
//
// We poll a slow tick (every 30s for each connected player) so the
// chance is bounded by real time, not movement. ServUO's per-step trigger
// has been adapted to a time-tick to avoid spam during long auto-walks
// in macro setups.

// Encounter pool + cadence + chance — `data/world/spawns/random-encounters.json`.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { allMobiles } from '../_spatial.js';

const __HERE = path.dirname(url.fileURLToPath(import.meta.url));
const __DATA = path.resolve(__HERE, '../data/world/spawns/random-encounters.json');

let __CFG = {
  pollMs: 30_000, encounterChance: 0.04, cooldownMs: 600_000,
  regionTags: ['wilderness', 'forest', 'graveyard'], encounters: [],
};
try { __CFG = { ...__CFG, ...JSON.parse(fs.readFileSync(__DATA, 'utf8')) }; }
catch (e) { console.warn('[random-encounters] load failed:', e.message); }

const POLL_MS = __CFG.pollMs;
const ENCOUNTER_CHANCE = __CFG.encounterChance;
const COOLDOWN_MS = __CFG.cooldownMs;
const ENCOUNTERS = __CFG.encounters;
const REGION_TAGS = __CFG.regionTags;

function classifyRegion(api, mob) {
  const r = api.ctx?.regions?.primary?.(mob.map, mob.x, mob.y);
  if (!r) return 'wilderness';
  const name = (r.name ?? '').toLowerCase();
  // Town / dungeon → not eligible.
  if (r.type === 'town' || r.type === 'dungeon') return null;
  if (name.includes('graveyard')) return 'graveyard';
  if (name.includes('forest') || name.includes('yew') || name.includes('haven')) return 'forest';
  return 'wilderness';
}

function pickEncounter(tag) {
  const eligible = ENCOUNTERS.filter((e) => e.region === tag);
  if (eligible.length === 0) return null;
  const total = eligible.reduce((s, e) => s + e.weight, 0);
  let roll = Math.random() * total;
  for (const e of eligible) {
    if ((roll -= e.weight) <= 0) return e;
  }
  return eligible[eligible.length - 1];
}

function spawnEncounter(api, mob, enc) {
  const factory = api.ctx?.spawnFactory ?? api.spawnFactory;
  const spawned = [];
  for (const cfg of enc.mobs) {
    for (let i = 0; i < cfg.count; i++) {
      const dx = ((Math.random() - 0.5) * 8) | 0;
      const dy = ((Math.random() - 0.5) * 8) | 0;
      let m = null;
      if (factory) {
        try { m = factory(api.world, cfg.kind, {
          x: mob.x + dx, y: mob.y + dy, z: mob.z, map: mob.map ?? 1,
        }); } catch { /* fall through */ }
      }
      if (m) {
        m._randomEncounter = enc.name;
        spawned.push(m);
      }
    }
  }
  return spawned;
}

export default function register(api) {
  if (!api.world) return () => {};

  /** @type {Map<number, number>} */
  const lastEncounterAt = new Map();           // mobSerial → epoch ms

  const poll = () => {
    const now = Date.now();
    for (const mob of allMobiles(api)) {
      if (!mob.client) continue;
      // Cooldown gate.
      const last = lastEncounterAt.get(mob.serial) ?? 0;
      if (now - last < COOLDOWN_MS) continue;
      // Skip ghosts.
      if (mob.ghost) continue;
      // Region eligibility.
      const tag = classifyRegion(api, mob);
      if (!tag || !REGION_TAGS.includes(tag)) continue;
      // Roll.
      if (Math.random() >= ENCOUNTER_CHANCE) continue;
      const enc = pickEncounter(tag);
      if (!enc) continue;
      const spawned = spawnEncounter(api, mob, enc);
      if (spawned.length === 0) continue;
      lastEncounterAt.set(mob.serial, now);
      try {
        mob.client.sendSystemMessage?.(enc.speech);
      } catch { /* ignore */ }
    }
  };
  const interval = api.lifecycle?.setInterval?.(poll, POLL_MS) ?? setInterval(poll, POLL_MS);
  interval.unref?.();

  // Admin command to disable / force-spawn / status.
  if (api.commands) {
    api.commands.register({
      name: 'encounter',
      help: '[encounter status|force <name> — random encounter controls.',
      access: 'Player',
      run(ctx) {
        const sub = String(ctx.args[0] ?? '').toLowerCase();
        const access = ctx.state?.account?.accessLevel ?? 'Player';
        if (sub === 'force') {
          if (access !== 'GM' && access !== 'Admin') {
            ctx.state.sendSystemMessage?.('GM only.');
            return;
          }
          const name = String(ctx.args[1] ?? '').toLowerCase();
          const enc = ENCOUNTERS.find((e) => e.name === name)
                   ?? pickEncounter(classifyRegion(api, ctx.sender) ?? 'wilderness');
          if (!enc) { ctx.state.sendSystemMessage?.('No such encounter.'); return; }
          const spawned = spawnEncounter(api, ctx.sender, enc);
          ctx.state.sendSystemMessage?.(`Spawned ${spawned.length} mob(s) for "${enc.name}".`);
          ctx.sender.client.sendSystemMessage?.(enc.speech);
          return;
        }
        // Status.
        ctx.state.sendSystemMessage?.(`Random encounters (${ENCOUNTERS.length} types):`);
        for (const e of ENCOUNTERS) {
          ctx.state.sendSystemMessage?.(`  ${e.name.padEnd(12)} (${e.region}, weight ${e.weight})`);
        }
        const last = lastEncounterAt.get(ctx.sender.serial) ?? 0;
        const due = Math.max(0, last + COOLDOWN_MS - Date.now());
        ctx.state.sendSystemMessage?.(
          due > 0 ? `Your cooldown: ${Math.ceil(due / 60000)}m`
                  : 'No active cooldown.',
        );
      },
    });
  }

  return () => {
    if (!api.lifecycle) clearInterval(interval);
    try { api.commands?.unregister?.('encounter'); } catch { /* ignore */ }
  };
}
