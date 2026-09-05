// Champion altar registrations + the `[champ` admin command.
//
// Three demo altars wired to the ServUO canonical zones (Shame for Rikktor
// in classic UO; we just borrow the locations to give playtesters a fixed
// place to start a champ). Each altar is a `ChampionAltar` instance owned
// by this script and ticked off `setInterval`. Admin commands let a GM
// start/stop/status each altar by name.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { allItems, allMobiles } from '../_spatial.js';
import { canCreateItem, createItem, destroyItemBySerial } from '../_items.js';
import { registerWorldContentSeed } from '../_world-content.js';
import { itemBySerial } from '../_entities.js';

const __dirname_ = dirname(fileURLToPath(import.meta.url));
// Lazy-load the artifact catalogue once. Same file the imbue / unravel
// commands read. We filter to the "lesser" / "greater" tiers for
// champion drops (matches ServUO `BaseChampion.GiveArtifactTo`).
let _artifactPool = null;
function loadArtifacts() {
  if (_artifactPool) return _artifactPool;
  const p = resolve(__dirname_, '..', 'data', 'world', 'artifacts.json');
  if (!existsSync(p)) { _artifactPool = { lesser: [], greater: [] }; return _artifactPool; }
  try {
    const all = JSON.parse(readFileSync(p, 'utf8'));
    _artifactPool = {
      lesser:  all.filter((a) => a.tier === 'lesser'),
      greater: all.filter((a) => a.tier === 'greater'),
    };
  } catch { _artifactPool = { lesser: [], greater: [] }; }
  return _artifactPool;
}

// Champion altar definitions — moved to data/world/spawns/champions.json
// on 2026-05-16 (13 altars: 3 classic + 6 canonical ServUO champ spawns
// + 4 mini-champion variants). Edit the JSON to add/tweak altars; the
// thin loader below pipes the array into the runtime ChampionAltar
// constructor.
const ALTARS_PATH = resolve(__dirname_, '..', 'data', 'world', 'spawns', 'champions.json');
let ALTARS = [];
try {
  ALTARS = JSON.parse(readFileSync(ALTARS_PATH, 'utf8'));
} catch (e) {
  console.warn('[champions] failed to load altars JSON:', e.message);
}


export default function register(api) {
  if (!api.spawner || !api.commands) return () => {};
  const { ChampionAltar } = api.systems?.champion ?? {};
  if (!ChampionAltar) {
    api.log?.('champions: champion system unavailable');
    return () => {};
  }

  /** @type {Map<string, any>} */
  const altars = new Map();
  /** @type {Map<string, any>} */
  const visuals = new Map();
  const spawnFactory = (world, kind, pos) => {
    const ctx = api.ctx;
    if (!ctx?.spawnFactory) return null;
    return ctx.spawnFactory(world, kind, pos);
  };

  // Send a typed status payload to every enhanced player within the
  // altar's `radius * 4` (so the bar appears before they aggro mobs but
  // not for someone on the other side of the map). Boss spawn / kill
  // / tier advance / kill counter all flow through this.
  function broadcastStatus(world, cfg, status) {
    const feature = 'world.champion';
    const range = cfg.radius * 4;
    for (const m of allMobiles({ world })) {
      if (!m.client) continue;
      if (!m.client.supportsNodeUO?.(feature)) continue;
      if (m.map !== cfg.map) continue;
      if (Math.abs(m.x - cfg.cx) > range) continue;
      if (Math.abs(m.y - cfg.cy) > range) continue;
      api.nodeUO?.send?.(m.client, { feature, namespace: 'nodeuo.champion', payload: status });
    }
  }

  // PHASE BT bugfix #36: tell observers the despawned mob is gone.
  function despawn(world, serial) {
    const removeFn = api.protocol?.removeEntity;
    if (!removeFn) return;
    const pkt = removeFn(serial);
    for (const m of allMobiles({ world })) {
      if (!m.client) continue;
      m.client.send(pkt);
    }
  }

  // 1-based skill ids matching skills.json. Power-scrolls only roll for
  // trainable combat / magic / craft skills — Hiding, Stealing etc. are
  // intentionally excluded. Earlier passes used wrong ids (32 instead of
  // 50 for Necromancy, 60 instead of 56 for Mysticism, etc.) — fixed here.
  const SCROLL_SKILLS = [
    8,  // Blacksmithy
    9,  // Bowcraft/Fletching
    12, // Carpentry
    17, // Evaluating Intelligence
    24, // Inscription
    26, // Magery
    27, // Resisting Spells
    28, // Tactics
    36, // Animal Taming
    41, // Swordsmanship
    50, // Necromancy
    52, // Chivalry
    53, // Bushido
    54, // Ninjitsu
    55, // Spellweaving
    56, // Mysticism
  ];
  // Power-scroll item ids by amount. Real UO uses 0x14EF + colour swap;
  // we ship one sprite per tier so the drop is visually distinct on the
  // ground.
  const SCROLL_ITEM_BY_AMOUNT = {
    5:  0x14EF,
    10: 0x14EF,
    15: 0x14EF,
    20: 0x14EF,
  };

  // Spawn the visual altar item at every champion location. Mirrors
  // ServUO `Items/Functional/ChampionAltar.cs` — a non-movable item
  // tile players can navigate to. Without this the champ system runs
  // with no on-map landmark.
  function placeAltarVisual(cfg) {
    const existing = [...allItems(api)].find((item) =>
      (item.champion === cfg.name || item.name === `Champion Altar: ${cfg.name}`) &&
      item.map === cfg.map && item.x === cfg.cx && item.y === cfg.cy && item.z === cfg.cz);
    if (existing) {
      existing.champion = cfg.name;
      visuals.set(cfg.name, existing);
      return { item: existing, added: 0 };
    }
    if (!canCreateItem(api, api.world)) return { item: null, added: 0, failed: 1 };
    try {
      const altarItem = createItem(api, api.world, {
        itemId: 0x32F0,                 // ServUO peerless/champion altar art
        x: cfg.cx, y: cfg.cy, z: cfg.cz,
        map: cfg.map,
        name: `Champion Altar: ${cfg.name}`,
        movable: false,
        hue: 0x47E,
      });
      altarItem.champion = cfg.name;
      visuals.set(cfg.name, altarItem);
      return { item: altarItem, added: 1 };
    } catch (e) {
      api.log?.(`[champ] altar visual for ${cfg.name} failed: ${e.message}`);
      return { item: null, added: 0, failed: 1 };
    }
  }

  for (const cfg of ALTARS) {
    const a = new ChampionAltar(api.world, cfg, { spawnFactory, broadcastStatus, despawn });
    a.onBossDeath = () => {
      const text = `The champion of ${cfg.name} has fallen!`;
      const pkt = api.protocol?.unicodeMessage?.({
        text, hue: 0x35, font: 3, name: 'System',
      });
      if (pkt) {
        for (const m of allMobiles(api)) {
          if (m.client) m.client.send(pkt);
        }
      }
      // Surface to the shard-event log so the news board / event
      // scroll consumers pick it up.
      try { api.systems?.shardEvents?.emit?.('champion-defeat', text, { altar: cfg.name }); }
      catch { /* ignore */ }
      // Power-scroll cluster — drop 5..7 random scrolls in the pool, mostly
      // +5 with a sprinkle of +10 and a rare +15. Players within the altar
      // radius all see the drop and can race to pick them up.
      const cluster = 5 + Math.floor(Math.random() * 3);
      for (let i = 0; i < cluster; i++) {
        const skillId = SCROLL_SKILLS[(Math.random() * SCROLL_SKILLS.length) | 0];
        const roll = Math.random();
        const amount = roll < 0.05 ? 15 : roll < 0.30 ? 10 : 5;
        const skillName = api.skills?.byId?.get?.(skillId)?.name ?? `Skill ${skillId}`;
        const offsetX = ((Math.random() - 0.5) * 4) | 0;
        const offsetY = ((Math.random() - 0.5) * 4) | 0;
        // Mark the scroll with its payload via custom fields. The use-handler
        // (PHASE O part 3) reads `powerScroll` to apply the cap upgrade and
        // delete the scroll. For now the scroll is just a labelled item on
        // the floor that visibly proves the boss kill paid off.
        const item = createItem(api, api.world, {
          itemId: SCROLL_ITEM_BY_AMOUNT[amount] ?? 0x14EF,
          x: cfg.cx + offsetX, y: cfg.cy + offsetY, z: cfg.cz, map: cfg.map,
          name: `Powerscroll: +${amount} ${skillName}`,
          hue: amount === 15 ? 0x09 : amount === 10 ? 0x05 : 0x00,
          movable: true,
        });
        item.powerScroll = { skillId, amount };
        // BUGFIX #68 (PHASE CZ): visibility-gate. Each cluster spawn
        // is 5–7 power-scrolls; without filtering, a champ kill flooded
        // every connected client with 5–7 worldItemSA packets each.
        // Filter to the canon UO 18-tile radius around the drop tile.
        const wi = api.protocol?.worldItemSA?.({
          serial: item.serial, itemId: item.itemId, hue: item.hue,
          amount: item.amount, x: item.x, y: item.y, z: item.z,
        });
        if (wi) {
          for (const m of allMobiles(api)) {
            if (!m.client) continue;
            if (m.map !== item.map) continue;
            if (Math.abs(m.x - item.x) > 18 || Math.abs(m.y - item.y) > 18) continue;
            m.client.send(wi);
          }
        }
      }
      // Artifact drop — mirrors ServUO `BaseChampion.GiveArtifactTo`.
      // 30% chance of a "lesser" artifact for every champion kill, 5%
      // for a "greater" artifact (peerless-grade). Drops at the boss
      // tile so the kill cluster's contributors can race for it. The
      // canonical artifact's stat block lives in `artifacts.json` and
      // is applied via the magic-properties pipeline on pickup.
      const pool = loadArtifacts();
      const r = Math.random();
      let artifact = null;
      if (r < 0.05 && pool.greater.length > 0) {
        artifact = pool.greater[(Math.random() * pool.greater.length) | 0];
      } else if (r < 0.35 && pool.lesser.length > 0) {
        artifact = pool.lesser[(Math.random() * pool.lesser.length) | 0];
      }
      if (artifact) {
        try {
          // Drop one tile away from the boss in a small radius so the
          // power-scroll cluster doesn't stack-overlay the artifact.
          const offX = ((Math.random() - 0.5) * 4) | 0;
          const offY = ((Math.random() - 0.5) * 4) | 0;
          const baseItem = api.templates?.spawn?.(api.world, artifact.base, {
            x: cfg.cx + offX, y: cfg.cy + offY, z: cfg.cz, map: cfg.map,
            movable: true,
            name: artifact.name,
            hue: artifact.tier === 'greater' ? 0x481 : 0x47E,
          });
          if (baseItem) {
            // Copy the canonical attribute block onto the spawned item.
            // Magic-properties reader on equip will surface them as
            // tooltip rows + apply combat / resist bonuses.
            baseItem.artifact = artifact.name;
            if (artifact.attributes)       Object.assign(baseItem, { attributes: artifact.attributes });
            if (artifact.weaponAttributes) Object.assign(baseItem, { weaponAttributes: artifact.weaponAttributes });
            if (artifact.armorAttributes)  Object.assign(baseItem, { armorAttributes: artifact.armorAttributes });
            if (artifact.skillBonuses)     Object.assign(baseItem, { skillBonuses: artifact.skillBonuses });
            if (artifact.resists)          Object.assign(baseItem, { resists: artifact.resists });
            if (artifact.slayer)           baseItem.slayer = artifact.slayer;
            const tier = artifact.tier === 'greater' ? 'GREATER' : 'lesser';
            // Yell + broadcast — same channel as the boss-defeat line.
            const pkt = api.protocol?.unicodeMessage?.({
              text: `A ${tier} artifact has appeared at the altar of ${cfg.name}!`,
              hue: artifact.tier === 'greater' ? 0x35 : 0x44, font: 3, name: 'System',
            });
            if (pkt) {
              for (const m of allMobiles(api)) {
                if (m.client) m.client.send(pkt);
              }
            }
            // worldItemSA so nearby clients see the drop without relog.
            const wi2 = api.protocol?.worldItemSA?.({
              serial: baseItem.serial, itemId: baseItem.itemId, hue: baseItem.hue,
              amount: 1, x: baseItem.x, y: baseItem.y, z: baseItem.z,
            });
            if (wi2) {
              for (const m of allMobiles(api)) {
                if (!m.client || m.map !== baseItem.map) continue;
                if (Math.abs(m.x - baseItem.x) > 18 || Math.abs(m.y - baseItem.y) > 18) continue;
                m.client.send(wi2);
              }
            }
            api.log?.(`[champ] ${cfg.name} dropped ${tier} artifact "${artifact.name}"`);
          }
        } catch (e) {
          api.log?.(`[champ] artifact drop failed: ${e.message}`);
        }
      }
    };
    altars.set(cfg.name, a);
  }

  const applyChampionLandmarks = (opts = {}) => {
    const facets = opts.facets ? new Set(opts.facets) : null;
    const result = { added: 0, failed: 0 };
    for (const cfg of ALTARS) {
      if (facets && !facets.has(cfg.map)) continue;
      const row = placeAltarVisual(cfg);
      result.added += row?.added ?? 0;
      result.failed += row?.failed ?? 0;
    }
    return result;
  };
  const removeChampionLandmarks = (opts = {}) => {
    const facets = opts.facets ? new Set(opts.facets) : null;
    const eligible = ALTARS.filter((cfg) => !facets || facets.has(cfg.map));
    for (const cfg of eligible) altars.get(cfg.name)?.stop?.();
    const names = new Set(eligible.map((cfg) => cfg.name));
    const serials = new Set();
    for (const item of allItems(api)) {
      const champion = item.champion ?? String(item.name ?? '').replace(/^Champion Altar: /, '');
      if (names.has(champion) && String(item.name ?? '').startsWith('Champion Altar:') &&
          (!facets || facets.has(item.map))) {
        serials.add(item.serial >>> 0);
      }
    }
    for (const name of names) {
      const item = visuals.get(name);
      if (item) serials.add(item.serial >>> 0);
    }
    let removed = 0;
    for (const serial of serials) {
      try { if (itemBySerial(api, serial)) { destroyItemBySerial(api, serial); removed++; } }
      catch (e) { api.log?.(`[champ] altar removal failed: ${e.message}`); }
    }
    for (const name of names) visuals.delete(name);
    return { removed };
  };
  const unregisterSeed = registerWorldContentSeed(api, 'champion-altars', {
    apply: applyChampionLandmarks,
    remove: removeChampionLandmarks,
  });
  if (api.world._createWorldDone !== false) applyChampionLandmarks();

  // 5-second tick — slow enough that the wave isn't constantly thrashing
  // the spawner, fast enough that players see refresh within 5 seconds
  // of clearing a wave.
  const tick = () => {
    for (const a of altars.values()) {
      try { a.tick(); }
      catch (e) { console.error('[champ] tick failed:', e); }
    }
  };
  const timer = api.lifecycle?.setInterval?.(tick, 5000) ?? setInterval(tick, 5000);
  timer.unref?.();

  api.commands.register({
    name: 'champ',
    help: '[champ <start|stop|status> <name>',
    access: 'Admin',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const name = String(ctx.args[1] ?? '').toLowerCase();
      const altar = altars.get(name);
      if (sub === 'list' || !altar) {
        ctx.state.sendSystemMessage(`Altars: ${[...altars.keys()].join(', ')}`);
        return;
      }
      switch (sub) {
        case 'start':  altar.start();  ctx.state.sendSystemMessage(`${name} altar started.`); break;
        case 'stop':   altar.stop();   ctx.state.sendSystemMessage(`${name} altar stopped.`); break;
        case 'status': {
          const s = altar.status();
          ctx.state.sendSystemMessage(
            `${s.name}: active=${s.active} tier=${s.tier}/${s.tiersTotal} ` +
            `kills=${s.killsAtTier}/${s.killsToAdvance} alive=${s.spawnedAlive} ` +
            `boss=${s.bossSerial ? '0x' + s.bossSerial.toString(16) : '-'}`,
          );
          break;
        }
        default: ctx.state.sendSystemMessage('Usage: [champ <start|stop|status> <name>');
      }
    },
  });

  return () => {
    unregisterSeed();
    if (!api.lifecycle) clearInterval(timer);
    for (const a of altars.values()) a.stop();
    altars.clear();
    api.commands.unregister('champ');
  };
}
