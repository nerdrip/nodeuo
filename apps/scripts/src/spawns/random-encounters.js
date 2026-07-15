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
import { allMobiles, nearbyMobiles } from '../_spatial.js';

const __HERE = path.dirname(url.fileURLToPath(import.meta.url));
const __DATA = path.resolve(__HERE, '../data/world/spawns/random-encounters.json');

let __CFG = {
  pollMs: 60_000, encounterChance: 0.01, cooldownMs: 2_700_000,
  regionTags: ['wilderness', 'forest', 'graveyard'], encounters: [],
};
try { __CFG = { ...__CFG, ...JSON.parse(fs.readFileSync(__DATA, 'utf8')) }; }
catch (e) { console.warn('[random-encounters] load failed:', e.message); }

const POLL_MS = __CFG.pollMs;
const ENCOUNTER_CHANCE = __CFG.encounterChance;
const COOLDOWN_MS = __CFG.cooldownMs;
const ENCOUNTERS = __CFG.encounters;
const REGION_TAGS = __CFG.regionTags;

export function classifyRegion(api, mob) {
  const regions = api.regions ?? api.ctx?.regions;
  const here = regions?.at?.(mob.map ?? 1, mob.x | 0, mob.y | 0) ?? [];
  // A random hostile event must never materialise inside a guarded/no-kill
  // town. Previously this script looked only at api.ctx.regions (undefined
  // in the live API), classified every tile as wilderness and ambushed
  // players at Moonglow/Britain banks.
  if (here.some((r) => r.guarded || r.noKill || r.type === 'town' || r.type === 'dungeon')) {
    return null;
  }
  const r = regions?.primary?.(mob.map ?? 1, mob.x | 0, mob.y | 0) ?? null;
  if (!r) return 'wilderness';
  const name = (r.name ?? '').toLowerCase();
  // Town / dungeon → not eligible.
  if (r.type === 'town' || r.type === 'dungeon') return null;
  if (name.includes('graveyard')) return 'graveyard';
  if (name.includes('forest') || name.includes('yew') || name.includes('haven')) return 'forest';
  return 'wilderness';
}

/** Pick a spawn tile that is still in the same eligible region. This matters
 * on city borders: the traveller can stand one tile outside Moonglow while a
 * random offset lands the brigand on the guarded side of the wall. */
export function encounterSpawnPoint(api, mob, expectedTag, random = Math.random) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const angle = random() * Math.PI * 2;
    const radius = 4 + Math.floor(random() * 4);
    const point = {
      x: (mob.x | 0) + Math.round(Math.cos(angle) * radius),
      y: (mob.y | 0) + Math.round(Math.sin(angle) * radius),
      z: mob.z | 0,
      map: mob.map ?? 1,
    };
    if (classifyRegion(api, point) !== expectedTag) continue;
    return point;
  }
  return null;
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

function spawnEncounter(api, mob, enc, { allowProtected = false } = {}) {
  const factory = api.ctx?.spawnFactory ?? api.spawnFactory;
  const spawned = [];
  for (const cfg of enc.mobs) {
    for (let i = 0; i < cfg.count; i++) {
      const point = allowProtected
        ? { x: mob.x, y: mob.y, z: mob.z, map: mob.map ?? 1 }
        : encounterSpawnPoint(api, mob, enc.region);
      if (!point) continue;
      let m = null;
      if (factory) {
        try { m = factory(api.world, cfg.kind, {
          x: point.x, y: point.y, z: point.z, map: point.map,
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
  /** @type {Map<string, number>} */
  const areaCooldownUntil = new Map();          // 64×64 world cell → epoch ms
  /** @type {Map<number, {x:number,y:number,map:number}>} */
  const lastSamplePosition = new Map();

  const poll = () => {
    const now = Date.now();
    if (areaCooldownUntil.size > 1024) {
      for (const [key, due] of areaCooldownUntil) {
        if (due <= now) areaCooldownUntil.delete(key);
      }
    }
    for (const mob of allMobiles(api)) {
      if (!mob.client) continue;
      const position = { x: mob.x | 0, y: mob.y | 0, map: mob.map ?? 1 };
      const sampled = lastSamplePosition.get(mob.serial);
      lastSamplePosition.set(mob.serial, position);
      // Encounters reward/risk wilderness travel, not standing AFK. Require
      // at least four tiles since the previous one-minute sample and skip the
      // first sample after login/facet change.
      if (!sampled || sampled.map !== position.map) continue;
      if (Math.max(Math.abs(position.x - sampled.x), Math.abs(position.y - sampled.y)) < 4) continue;
      // Cooldown gate.
      const nextAllowed = Math.max(
        lastEncounterAt.get(mob.serial) ?? 0,
        mob._nextRandomEncounterAt ?? 0,
      );
      if (now < nextAllowed) continue;
      // Skip ghosts.
      if (mob.ghost) continue;
      // Region eligibility.
      const tag = classifyRegion(api, mob);
      if (!tag || !REGION_TAGS.includes(tag)) continue;
      const areaKey = `${mob.map ?? 1}:${(mob.x | 0) >> 6}:${(mob.y | 0) >> 6}`;
      if ((areaCooldownUntil.get(areaKey) ?? 0) > now) continue;
      // Do not stack another event while survivors of the previous random
      // encounter are still fighting/standing around this player.
      let activeNearby = false;
      for (const other of nearbyMobiles(api, mob, mob, 24)) {
        if (other?._randomEncounter) { activeNearby = true; break; }
      }
      if (activeNearby) continue;
      // Roll.
      if (Math.random() >= ENCOUNTER_CHANCE) continue;
      const enc = pickEncounter(tag);
      if (!enc) continue;
      const spawned = spawnEncounter(api, mob, enc);
      if (spawned.length === 0) continue;
      const due = now + COOLDOWN_MS;
      lastEncounterAt.set(mob.serial, due);
      mob._nextRandomEncounterAt = due;
      areaCooldownUntil.set(areaKey, due);
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
          // Explicit GM force is a debugging operation and may intentionally
          // be used inside a town; automatic encounters remain protected.
          const spawned = spawnEncounter(api, ctx.sender, enc, { allowProtected: true });
          ctx.state.sendSystemMessage?.(`Spawned ${spawned.length} mob(s) for "${enc.name}".`);
          ctx.sender.client.sendSystemMessage?.(enc.speech);
          return;
        }
        // Status.
        ctx.state.sendSystemMessage?.(`Random encounters (${ENCOUNTERS.length} types):`);
        for (const e of ENCOUNTERS) {
          ctx.state.sendSystemMessage?.(`  ${e.name.padEnd(12)} (${e.region}, weight ${e.weight})`);
        }
        const due = Math.max(0,
          (lastEncounterAt.get(ctx.sender.serial) ?? ctx.sender._nextRandomEncounterAt ?? 0)
          - Date.now(),
        );
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
