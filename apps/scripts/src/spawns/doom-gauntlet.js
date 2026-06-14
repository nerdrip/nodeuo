// Doom Gauntlet — endgame dungeon mechanic. Mirrors ServUO
// `Engines/Doom/GauntletSpawner.cs` + the Dark Father summoning ritual.
//
// Lore: 10 themed "tribute" rooms each guarded by a unique boss. Killing
// a boss drops its named GAUNTLET KEY (a one-time-use item). Bringing
// all 10 keys to the Dark Altar lets the carrier summon Dark Father
// (the gauntlet's final boss, a massive demon with custom AI). Dark
// Father's corpse drops Doom Artifacts at the canonical rates (10
// pre-AOS major artifacts + later additions).
//
// We layer this on top of the existing Doom region + spawner zone
// (`spawns/default.js` doom-gauntlet block). No new mob templates are
// added — we just hook the existing daemon kinds to drop their keys
// when killed inside the Doom region. The Dark Altar item is spawned
// at the canonical center coordinate.

// Altar coords + gauntlet keys + doom artifacts pool —
// `data/world/spawns/doom-gauntlet.json`.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { canCreateItem, createItem, destroyItemBySerial } from '../_items.js';
import { allItems, allMobiles } from '../_spatial.js';
import { createMobile } from '../_mobiles.js';

const __HERE = path.dirname(url.fileURLToPath(import.meta.url));
const __DATA = path.resolve(__HERE, '../data/world/spawns/doom-gauntlet.json');

let __CFG = { darkAltar: {}, darkFather: {}, gauntletKeys: [], doomArtifacts: [] };
try { __CFG = JSON.parse(fs.readFileSync(__DATA, 'utf8')); }
catch (e) { console.warn('[doom-gauntlet] load failed:', e.message); }

const DARK_ALTAR_X   = __CFG.darkAltar.x   ?? 2351;
const DARK_ALTAR_Y   = __CFG.darkAltar.y   ?? 1255;
const DARK_ALTAR_Z   = __CFG.darkAltar.z   ?? 0;
const DARK_ALTAR_MAP = __CFG.darkAltar.map ?? 1;
const DARK_FATHER_X  = __CFG.darkFather.x  ?? 2350;
const DARK_FATHER_Y  = __CFG.darkFather.y  ?? 1240;
const DARK_FATHER_Z  = __CFG.darkFather.z  ?? 0;

const GAUNTLET_KEYS = __CFG.gauntletKeys;
const BOSS_KIND_TO_KEY = new Map(GAUNTLET_KEYS.map((k) => [k.bossKind, k]));
const DOOM_ARTIFACTS = __CFG.doomArtifacts;

/** Walk world.items for ALL gauntlet keys the player carries. Returns
 *  a Map<keyId, item> so the caller can verify all 10 are present and
 *  consume them on the summon ritual. */
function findCarriedKeys(world, mob) {
  const out = new Map();
  for (const it of allItems({ world })) {
    if (!it._gauntletKey) continue;
    if (it.parent !== mob.serial) continue;
    out.set(it._gauntletKey.keyId, it);
  }
  return out;
}

/** Drop a gauntlet key at the boss's corpse location. The key is a
 *  movable item that any nearby player can grab. Each boss kind drops
 *  at most ONE key per kill (no double-tap farming). */
function spawnKeyDrop(api, world, def, corpse) {
  if (!def || !corpse) return null;
  try {
    const item = createItem(api, world, {
      itemId: def.itemId,
      hue: def.hue,
      name: def.name,
      x: corpse.x, y: corpse.y, z: corpse.z,
      map: corpse.map,
      movable: true,
    });
    item._gauntletKey = { keyId: def.keyId, name: def.name };
    return item;
  } catch (e) {
    api.log?.(`[doom] key spawn for ${def.bossKind} failed: ${e.message}`);
    return null;
  }
}

/** Place the Dark Altar visual + interactive sign at the canonical
 *  Doom center. Used by `[doom summon` players to trigger the ritual.
 *  Marked `_isDarkAltar` so the use-hook can identify it. */
function placeDarkAltar(api) {
  if (!canCreateItem(api, api.world)) return null;
  try {
    const altar = createItem(api, api.world, {
      itemId: 0x4977,                  // ServUO peerless altar art (dark)
      x: DARK_ALTAR_X, y: DARK_ALTAR_Y, z: DARK_ALTAR_Z,
      map: DARK_ALTAR_MAP,
      name: 'Dark Altar',
      movable: false,
      hue: 0x489,                       // bruise-purple
    });
    altar._isDarkAltar = true;
    return altar;
  } catch (e) {
    api.log?.(`[doom] altar place threw: ${e.message}`);
    return null;
  }
}

/** Summon Dark Father at the canonical spawn tile. Removes the 10
 *  gauntlet keys from the caller's pack + creates the boss mob. Drops
 *  a Doom artifact on his corpse via the `_onCorpse` hook stamped on
 *  the boss instance. */
function summonDarkFather(api, mob, carried) {
  // Consume the keys first so a failed mob create doesn't leave the
  // caller with both keys + boss alive.
  for (const key of carried.values()) {
    try { destroyItemBySerial(api, key.serial); }
    catch { /* ignore */ }
  }
  const factory = api.ctx?.spawnFactory ?? api.spawnFactory;
  let boss = null;
  try {
    if (factory) {
      boss = factory(api.world, 'darkfather', {
        x: DARK_FATHER_X, y: DARK_FATHER_Y, z: DARK_FATHER_Z, map: DARK_ALTAR_MAP,
      });
    }
  } catch { /* template missing — fall through */ }
  if (!boss) {
    // Generic fallback if the darkfather template isn't catalogued.
    // 8 000 HP + ×3 daemon stats so the fight is still meaningful.
    boss = createMobile(api, api.world, {
      name: 'Dark Father', body: 0x1A,
      x: DARK_FATHER_X, y: DARK_FATHER_Y, z: DARK_FATHER_Z, map: DARK_ALTAR_MAP,
      hp: 8000, hpMax: 8000, str: 600, dex: 300, int: 600,
      mana: 1000, manaMax: 1000,
      notoriety: 5,                   // Enemy
      kind: 'darkfather',
    });
  }
  if (!boss) return null;
  // Stamp the artifact-drop hook + paragon-like aura so the corpse
  // loot path picks it up. Artifact pool is a small subset of the
  // ServUO Doom table (12 major artifacts).
  boss._doomBoss = true;
  boss._lootArtifactPool = DOOM_ARTIFACTS;
  // Shard-wide announcement.
  try {
    const pkt = api.protocol?.unicodeMessage?.({
      text: `${mob.name ?? 'A hero'} has summoned the Dark Father!`,
      hue: 0x35, font: 3, name: 'System',
    });
    if (pkt) for (const m of allMobiles(api)) {
      if (m.client) m.client.send(pkt);
    }
  } catch { /* announce optional */ }
  api.log?.(`[doom] Dark Father summoned by ${mob.name ?? 'unknown'}`);
  return boss;
}

export default function register(api) {
  if (!api.commands || !api.world) return () => {};
  let altarItem = null;
  // Defer placement — script-init runs before world.items might be
  // ready in some test harnesses. setImmediate gets us past the boot
  // tick so the altar lands cleanly.
  (api.lifecycle?.setImmediate ?? setImmediate)(() => { altarItem = placeDarkAltar(api); });

  // ---- Boss-kill hook ----------------------------------------------
  // Register with `corpse.addKillHook` — the canonical post-death
  // fan-out for content scripts. Runs once per death (player + NPC)
  // after the corpse is spawned. We filter to the 10 Doom boss kinds
  // + the Doom region, then drop the matching gauntlet key on the
  // corpse tile. Same hook also services the Dark Father artifact
  // drop below.
  api.corpse?.addKillHook?.((_world, victim, killer) => {
    if (!victim || victim.map !== DARK_ALTAR_MAP) return;
    // Dark Father loot — runs even if the kill happens outside the
    // named region (e.g. boss dragged out by ranged attackers).
    if (victim._doomBoss) {
      const pool = victim._lootArtifactPool ?? DOOM_ARTIFACTS;
      const pick = pool[(Math.random() * pool.length) | 0];
      if (pick) {
        try {
          // Drop the artifact on the death tile. Lucky-looter / corpse
          // ownership is handled by the standard corpse loot pipeline
          // — items on the same tile get swept into the corpse.
          const artifact = createItem(api, api.world, {
            itemId: pick.itemId,
            x: victim.x, y: victim.y, z: victim.z, map: victim.map,
            name: pick.name, hue: pick.hue, movable: true,
          });
          if (artifact) {
            artifact.artifact = pick.name;
            if (pick.slayer) artifact.slayer = pick.slayer;
            const pkt = api.protocol?.unicodeMessage?.({
              text: `Dark Father has fallen — the ${pick.name} appears!`,
              hue: 0x35, font: 3, name: 'System',
            });
            if (pkt) for (const m of allMobiles(api)) {
              if (m.client) m.client.send(pkt);
            }
            api.log?.(`[doom] Dark Father dropped "${pick.name}"`);
          }
        } catch (e) {
          api.log?.(`[doom] artifact drop failed: ${e.message}`);
        }
      }
    }
    // Region gate for the 10 themed gauntlet boss key drops.
    const regions = api.ctx?.regions ?? api.regions;
    const r = regions?.primary?.(victim.map, victim.x, victim.y);
    if (!r || !/Doom/.test(r.name ?? '')) return;
    const def = BOSS_KIND_TO_KEY.get(victim.kind);
    if (!def) return;
    // Drop the key on the freshly-spawned corpse (best-effort — falls
    // back to the death tile if no corpse was created).
    const corpse = [...allItems(api)].find?.((it) =>
      it.isCorpse && Math.abs((it.x | 0) - (victim.x | 0)) <= 1 &&
                     Math.abs((it.y | 0) - (victim.y | 0)) <= 1) ?? null;
    const dropTile = corpse ?? victim;
    spawnKeyDrop(api, api.world, def, dropTile);
    api.log?.(`[doom] ${def.bossKind} kill by ${killer?.name ?? '?'} → dropped "${def.name}"`);
  });

  // ---- `[doom` admin/player command --------------------------------
  api.commands.register({
    name: 'doom',
    help: '[doom status|summon|altar — Doom Gauntlet ritual + key inspection.',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const mob = ctx.sender;
      if (sub === 'status') {
        const carried = findCarriedKeys(api.world, mob);
        const have = [...carried.keys()].sort((a, b) => a - b);
        const need = GAUNTLET_KEYS
          .filter((k) => !carried.has(k.keyId))
          .map((k) => `${k.keyId}. ${k.name}`);
        ctx.state.sendSystemMessage(
          `Gauntlet keys: ${have.length}/10 (${have.join(', ') || '-'})`,
        );
        if (need.length) {
          ctx.state.sendSystemMessage('Still need:');
          for (const ln of need) ctx.state.sendSystemMessage('  ' + ln);
        } else {
          ctx.state.sendSystemMessage('You have all keys — stand at the Dark Altar and use [doom summon.');
        }
        return;
      }
      if (sub === 'altar') {
        const access = ctx.state?.account?.accessLevel ?? 'Player';
        if (access !== 'GM' && access !== 'Admin') {
          ctx.state.sendSystemMessage('Only staff can re-spawn the Dark Altar.');
          return;
        }
        altarItem = placeDarkAltar(api);
        ctx.state.sendSystemMessage(
          altarItem
            ? `Dark Altar placed at (${DARK_ALTAR_X},${DARK_ALTAR_Y}).`
            : 'Altar placement failed (see log).',
        );
        return;
      }
      if (sub === 'summon') {
        // Range check — caller must stand at the altar (within 4 tiles).
        const dx = Math.abs((mob.x | 0) - DARK_ALTAR_X);
        const dy = Math.abs((mob.y | 0) - DARK_ALTAR_Y);
        if (mob.map !== DARK_ALTAR_MAP || Math.max(dx, dy) > 4) {
          ctx.state.sendSystemMessage('You must stand at the Dark Altar in Doom.');
          return;
        }
        const carried = findCarriedKeys(api.world, mob);
        if (carried.size < GAUNTLET_KEYS.length) {
          ctx.state.sendSystemMessage(
            `The altar rejects you — only ${carried.size}/10 keys. Use [doom status to see what you need.`,
          );
          return;
        }
        const boss = summonDarkFather(api, mob, carried);
        if (!boss) {
          ctx.state.sendSystemMessage('The altar shudders, but the summons fails.');
          return;
        }
        ctx.state.sendSystemMessage('The Dark Father materializes!');
        return;
      }
      ctx.state.sendSystemMessage('Usage: [doom status|summon|altar');
    },
  });

  return () => {
    try { api.commands.unregister('doom'); } catch { /* ignore */ }
  };
}
