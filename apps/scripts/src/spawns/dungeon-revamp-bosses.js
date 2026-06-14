// Dungeon-revamp bosses — Hythloth Lord, Wrong Warden, Despise Lich-King.
//
// Three bosses for the existing revamped regions in
// `regions/revamped-dungeons.js`. They follow the same scaffold as
// `aetheric-sanctuary.js`: `[<boss> start` spawns the boss + 2 waves
// at the canonical region tile, the kill hook drops a guaranteed
// minor artifact + 10% major + shard-wide announce.

// Boss encounter blueprints — `data/world/spawns/dungeon-revamp-bosses.json`.
// `region` arrives as a regex source string; compile to RegExp here.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { allMobiles } from '../_spatial.js';
import { createItem } from '../_items.js';
import { createMobile, destroyMobileBySerial } from '../_mobiles.js';
const __HERE = path.dirname(url.fileURLToPath(import.meta.url));
const __DATA = path.resolve(__HERE, '../data/world/spawns/dungeon-revamp-bosses.json');

let ENCOUNTERS = [];
try {
  const cfg = JSON.parse(fs.readFileSync(__DATA, 'utf8'));
  ENCOUNTERS = (cfg.encounters ?? []).map((e) => ({
    ...e,
    region: typeof e.region === 'string' ? new RegExp(e.region, 'i') : e.region,
  }));
} catch (e) {
  console.warn('[dungeon-revamp-bosses] load failed:', e.message);
}

function spawnMob(api, kind, x, y, z, map) {
  const factory = api.ctx?.spawnFactory ?? api.spawnFactory;
  if (factory) {
    try { return factory(api.world, kind, { x, y, z, map }); }
    catch { /* fall through */ }
  }
  return createMobile(api, api.world, {
    name: kind, body: 0x1A, x, y, z, map,
    hp: 100, hpMax: 100, notoriety: 5, kind,
  });
}

function dropArtifact(api, pos, def, major = false) {
  try {
    const item = createItem(api, api.world, {
      itemId: def.itemId, hue: def.hue, name: def.name,
      x: pos.x, y: pos.y, z: pos.z, map: pos.map,
      movable: true,
    });
    if (item) {
      item.artifact = def.name;
      if (major) item.major = true;
    }
  } catch (e) { api.log?.(`[dungeon-boss] drop failed: ${e.message}`); }
}

function announce(api, text, hue = 0x35) {
  const pkt = api.protocol?.unicodeMessage?.({ text, hue, font: 3, name: 'System' });
  if (!pkt) return;
  for (const m of allMobiles(api)) {
    if (m.client) m.client.send(pkt);
  }
}

function registerCommand(api, enc) {
  api.commands.register({
    name: enc.name,
    help: `[${enc.name} start|status — ${enc.name} dungeon-revamp boss.`,
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      if (sub === 'status') {
        const alive = [...allMobiles(api)].filter((m) =>
          m._dungeonRevampEnc === enc.name).length;
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
      const aliveAlready = [...allMobiles(api)].find((m) =>
        m._dungeonRevampEnc === enc.name);
      if (aliveAlready) {
        ctx.state.sendSystemMessage?.(`Already underway.`);
        return;
      }
      const boss = spawnMob(api, enc.boss.kind,
        enc.bossPos.x, enc.bossPos.y, enc.bossPos.z, enc.bossPos.map);
      if (boss) {
        boss.hp = enc.boss.hp; boss.hpMax = enc.boss.hp;
        boss.fame = enc.boss.fame;
        boss._dungeonRevampEnc = enc.name;
        boss._dungeonRevampBoss = true;
      }
      let trash = 0;
      for (const wave of enc.waves) {
        for (let i = 0; i < wave.count; i++) {
          const kind = wave.kinds[(Math.random() * wave.kinds.length) | 0];
          const dx = ((Math.random() - 0.5) * 12) | 0;
          const dy = ((Math.random() - 0.5) * 12) | 0;
          const t = spawnMob(api, kind,
            enc.spawn.x + dx, enc.spawn.y + dy, enc.spawn.z, enc.spawn.map);
          if (t) { t._dungeonRevampEnc = enc.name; trash++; }
        }
      }
      announce(api, `The ${enc.name} stirs — ${ctx.sender.name ?? 'a hero'} has triggered the encounter.`);
      ctx.state.sendSystemMessage?.(`Encounter started: boss + ${trash} trash mobs.`);
    },
  });
}

export default function register(api) {
  if (!api.commands || !api.world) return () => {};

  for (const enc of ENCOUNTERS) registerCommand(api, enc);

  const unhook = api.corpse?.addKillHook?.((_world, victim) => {
    if (!victim?._dungeonRevampBoss) return;
    const enc = ENCOUNTERS.find((e) => e.name === victim._dungeonRevampEnc);
    if (!enc) return;
    const pos = { x: victim.x, y: victim.y, z: victim.z, map: victim.map };
    const minor = enc.minor[(Math.random() * enc.minor.length) | 0];
    if (minor) dropArtifact(api, pos, minor, false);
    if (Math.random() < 0.10) {
      dropArtifact(api, pos, enc.major, true);
      announce(api, `★ The ${enc.major.name} drops from the corpse!`, 0x47E);
    }
    announce(api,
      `The ${enc.name} boss has been defeated!`,
      0x35);
    // Clean up trailing trash mobs.
    for (const m of allMobiles(api)) {
      if (m._dungeonRevampEnc !== enc.name || m === victim) continue;
      if (m._dungeonRevampBoss) continue;
      try { destroyMobileBySerial(api, m.serial); } catch { /* ignore */ }
    }
  });

  return () => {
    try { unhook?.(); } catch { /* ignore */ }
    for (const enc of ENCOUNTERS) {
      try { api.commands.unregister(enc.name); } catch { /* ignore */ }
    }
  };
}
