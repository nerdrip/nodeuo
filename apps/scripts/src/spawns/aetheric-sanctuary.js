// Aetheric Citadel + The Sanctuary boss encounters.
//
// Both are Mondain's Legacy / Stygian Abyss mid-tier zones. Each has
// a single boss-room at fixed coords; on entry the script spawns
// trash mobs (waves) and the boss; on boss kill it drops a guaranteed
// minor artifact + 10% chance major artifact and broadcasts a
// shard-wide announce.
//
// Region rectangles are defined in `regions/revamped-dungeons.js`
// (Aetheric Citadel — Inner Sanctum / Sanctuary — Heart Pool).
// We just spawn into those tiles on `[citadel start` / `[sanctuary start`.

// Encounter blueprints (region name regex source + boss + waves +
// artifact pools) — `data/world/spawns/aetheric-sanctuary.json`.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { allMobiles } from '../_spatial.js';
import { createItem } from '../_items.js';
import { createMobile, destroyMobileBySerial } from '../_mobiles.js';
const __HERE = path.dirname(url.fileURLToPath(import.meta.url));
const __DATA = path.resolve(__HERE, '../data/world/spawns/aetheric-sanctuary.json');

let ENCOUNTERS = [];
try {
  const cfg = JSON.parse(fs.readFileSync(__DATA, 'utf8'));
  ENCOUNTERS = (cfg.encounters ?? []).map((e) => ({
    ...e,
    // region is stored as a string in JSON; compile to RegExp here so
    // the consumer code stays the same.
    region: typeof e.region === 'string' ? new RegExp(e.region, 'i') : e.region,
  }));
} catch (e) {
  console.warn('[aetheric-sanctuary] load failed:', e.message);
}

function spawnMob(api, kind, x, y, z, map) {
  const factory = api.ctx?.spawnFactory ?? api.spawnFactory;
  if (factory) {
    try { return factory(api.world, kind, { x, y, z, map }); }
    catch { /* fall through to manual create */ }
  }
  return createMobile(api, api.world, {
    name: kind, body: 0x1A, x, y, z, map,
    hp: 100, hpMax: 100, notoriety: 5, kind,
  });
}

function dropArtifact(api, pos, def, isMajor = false) {
  try {
    const item = createItem(api, api.world, {
      itemId: def.itemId, hue: def.hue, name: def.name,
      x: pos.x, y: pos.y, z: pos.z, map: pos.map,
      movable: true,
    });
    if (item) {
      item.artifact = def.name;
      if (isMajor) item.major = true;
    }
    return item;
  } catch (e) {
    api.log?.(`[encounter] drop "${def.name}" failed: ${e.message}`);
    return null;
  }
}

function announce(api, text, hue = 0x35) {
  const pkt = api.protocol?.unicodeMessage?.({
    text, hue, font: 3, name: 'System',
  });
  if (!pkt) return;
  for (const m of allMobiles(api)) {
    if (m.client) m.client.send(pkt);
  }
}

function registerEncounterCommand(api, enc) {
  api.commands.register({
    name: enc.name,
    help: `[${enc.name} start|status — boss encounter at ${enc.region.source}.`,
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const mob = ctx.sender;

      if (sub === 'status') {
        const alive = [...allMobiles(api)].filter((m) =>
          m._encounter === enc.name).length;
        ctx.state.sendSystemMessage?.(
          alive > 0
            ? `${enc.name} encounter active — ${alive} hostiles remaining.`
            : `${enc.name} encounter is idle.`,
        );
        return;
      }
      if (sub !== 'start') {
        ctx.state.sendSystemMessage?.(`Usage: [${enc.name} start|status`);
        return;
      }
      // Refuse if a wave is already up.
      const aliveAlready = [...allMobiles(api)].find((m) =>
        m._encounter === enc.name);
      if (aliveAlready) {
        ctx.state.sendSystemMessage?.(`The ${enc.name} encounter is already underway.`);
        return;
      }
      // Spawn the boss + waves.
      const boss = spawnMob(api, enc.boss.kind,
        enc.bossPos.x, enc.bossPos.y, enc.bossPos.z, enc.bossPos.map);
      if (boss) {
        boss.hp = enc.boss.hp; boss.hpMax = enc.boss.hp;
        boss.fame = enc.boss.fame;
        boss._encounter = enc.name;
        boss._encounterBoss = true;
      }
      let trashCount = 0;
      for (const wave of enc.waves) {
        for (let i = 0; i < wave.count; i++) {
          const kind = wave.kinds[(Math.random() * wave.kinds.length) | 0];
          const dx = ((Math.random() - 0.5) * 12) | 0;
          const dy = ((Math.random() - 0.5) * 12) | 0;
          const t = spawnMob(api, kind,
            enc.spawn.x + dx, enc.spawn.y + dy, enc.spawn.z, enc.spawn.map);
          if (t) { t._encounter = enc.name; trashCount++; }
        }
      }
      announce(api, `The ${enc.name === 'aetheric' ? 'Aetheric Citadel' : 'Sanctuary'} stirs — ${mob.name ?? 'a hero'} has triggered the encounter.`);
      ctx.state.sendSystemMessage?.(
        `Encounter started: boss + ${trashCount} trash mobs.`,
      );
    },
  });
}

export default function register(api) {
  if (!api.commands || !api.world) return () => {};

  for (const enc of ENCOUNTERS) registerEncounterCommand(api, enc);

  // Kill hook — when an encounter boss dies, drop a guaranteed minor +
  // 10% major.
  const unhook = api.corpse?.addKillHook?.((_world, victim) => {
    if (!victim?._encounterBoss) return;
    const enc = ENCOUNTERS.find((e) => e.name === victim._encounter);
    if (!enc) return;
    const pos = { x: victim.x, y: victim.y, z: victim.z, map: victim.map };
    const minor = enc.minorArtifacts[(Math.random() * enc.minorArtifacts.length) | 0];
    if (minor) dropArtifact(api, pos, minor, false);
    if (Math.random() < 0.10) {
      dropArtifact(api, pos, enc.major, true);
      announce(api, `★ The ${enc.major.name} drops from the corpse!`, 0x47E);
    }
    announce(api,
      `The ${enc.name === 'aetheric' ? 'Aetheric Lord' : 'Sanctuary Warden'} has been defeated!`,
      0x35);
    // Clean up any remaining wave mobs for this encounter.
    for (const m of allMobiles(api)) {
      if (m._encounter !== enc.name || m === victim) continue;
      if (m._encounterBoss) continue;          // (defensive — only one boss)
      try { destroyMobileBySerial(api, m.serial); }
      catch { /* ignore */ }
    }
  });

  return () => {
    try { unhook?.(); } catch { /* ignore */ }
    for (const enc of ENCOUNTERS) {
      try { api.commands.unregister(enc.name); } catch { /* ignore */ }
    }
  };
}
