// Champion Skulls + Braziers + Harrower summon. Mirrors ServUO
// `Engines/Spawners/ChampionSkull.cs` + `HarrowerGate.cs`:
//
//   1. Each champion altar publishes a "skull track" — 4 stacked skulls
//      that light up as tiers advance. Tier 0 → 0 skulls, Tier 4 (boss
//      down) → all 4 skulls. Visualized via brazier flames at the altar.
//
//   2. After a champion boss is killed, the altar drops a *Champion Skull*
//      item (one of 5 colors, depending on the champion type):
//        Abyss=Pestilence skull, Forest=Power, Vermin=Greed,
//        Cold Blood=Pain, Glade=Venom.
//
//   3. Players bring 5 different-colored skulls to the Harrower
//      Summoning Altar. Drop all 5 at once → Harrower spawns (the
//      ultimate champion, drops 12 Greater scrolls + a +25 stat scroll).
//
// API:
//   skullSystem.advanceTier(altarKey, tier)        — refresh brazier visuals
//   skullSystem.dropChampionSkull(world, altar)    — spawn the skull item
//   skullSystem.tryHarrowerSummon(world, skulls)   — collect 5 → summon
//
// State:
//   altarSkulls: Map<altarKey, { tier, brazierSerials[] }>
//   harrowerCooldown: Date.now() + 24h after last summon

import { destroyItem } from '../../world/items.js';

const SKULL_COLORS = Object.freeze({
  abyss:      { hue: 0x0021, name: 'Skull of Pestilence', code: 'pestilence' },
  vermin:     { hue: 0x0489, name: 'Skull of Greed',      code: 'greed'      },
  forestlord: { hue: 0x0445, name: 'Skull of Power',      code: 'power'      },
  coldblood:  { hue: 0x0496, name: 'Skull of Pain',       code: 'pain'       },
  glade:      { hue: 0x004F, name: 'Skull of Venom',      code: 'venom'      },
  // Pestilence + Rikktor share Abyss for simplicity.
  pestilence: { hue: 0x0021, name: 'Skull of Pestilence', code: 'pestilence' },
  rikktor:    { hue: 0x0489, name: 'Skull of Greed',      code: 'greed'      },
});

const BRAZIER_ITEM_ID = 0x19AA;        // OSI brazier graphic
const SKULL_ITEM_ID   = 0x1AE0;        // OSI champion-skull graphic
const HARROWER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const _altarSkulls = new Map();        // altarKey → state
let _harrowerSpawnedAt = 0;

function altarKey(cfg) { return `${cfg.map}|${cfg.cx}|${cfg.cy}|${cfg.name}`; }

/**
 * Refresh brazier visuals when the altar's tier changes. Spawns 4 brazier
 * items in a square; each lit if tier ≥ index.
 */
export function advanceTier(world, altarCfg, tier, deps = {}) {
  const key = altarKey(altarCfg);
  let state = _altarSkulls.get(key);
  if (!state) {
    state = { tier: 0, brazierSerials: [] };
    _altarSkulls.set(key, state);
  }
  state.tier = tier;

  // Despawn old braziers + spawn fresh ones with the right hue.
  for (const s of state.brazierSerials) {
    deps.despawnItem?.(world, s);
    try { destroyItem(world, s); }
    catch { /* already despawned */ }
  }
  state.brazierSerials = [];
  const offsets = [
    { dx: -2, dy: -2 }, { dx:  2, dy: -2 },
    { dx: -2, dy:  2 }, { dx:  2, dy:  2 },
  ];
  for (let i = 0; i < 4; i++) {
    const lit = i < tier;
    const item = world.createItem({
      itemId: BRAZIER_ITEM_ID,
      x: altarCfg.cx + offsets[i].dx,
      y: altarCfg.cy + offsets[i].dy,
      z: altarCfg.cz,
      map: altarCfg.map,
      name: lit ? 'lit brazier' : 'unlit brazier',
      hue: lit ? 0x0021 : 0x0000,
      decorative: true,
    });
    state.brazierSerials.push(item.serial);
  }
  return state;
}

/** Drop a colored skull at the altar tile when the boss dies. */
export function dropChampionSkull(world, altarCfg, championKind) {
  const cfg = SKULL_COLORS[championKind] ?? SKULL_COLORS.abyss;
  return world.createItem({
    itemId: SKULL_ITEM_ID,
    x: altarCfg.cx, y: altarCfg.cy, z: altarCfg.cz, map: altarCfg.map,
    name: cfg.name, hue: cfg.hue,
    weight: 1,
    championSkull: { code: cfg.code },
  });
}

/**
 * Try to summon Harrower. Caller passes 5 candidate skulls (already
 * verified to be in the player's pack). Each must be a different color.
 * Returns:
 *   { ok:true, location:{x,y,map} }  — Harrower spawned
 *   { ok:false, reason:'cooldown' | 'duplicate-colors' | 'not-enough' }
 */
export function tryHarrowerSummon(world, skulls, summonAt, opts = {}) {
  const now = Date.now();
  if (now - _harrowerSpawnedAt < HARROWER_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown', expiresAt: _harrowerSpawnedAt + HARROWER_COOLDOWN_MS };
  }
  if (!Array.isArray(skulls) || skulls.length < 5) {
    return { ok: false, reason: 'not-enough' };
  }
  const colors = new Set();
  for (const s of skulls) {
    const c = s?.championSkull?.code;
    if (!c) return { ok: false, reason: 'invalid' };
    colors.add(c);
  }
  if (colors.size < 5) return { ok: false, reason: 'duplicate-colors' };

  // Consume the skulls.
  for (const s of skulls) {
    try { destroyItem(world, s.serial); }
    catch { /* already consumed */ }
  }

  _harrowerSpawnedAt = now;

  // Spawn Harrower at the summoning altar.
  const harrower = opts.spawnFactory?.(world, 'harrower', summonAt);
  return { ok: true, harrower, location: summonAt };
}

/** GM hook to reset cooldown — used in `[champreset` admin command. */
export function resetHarrowerCooldown() { _harrowerSpawnedAt = 0; }

export function getSkullState(altarCfg) {
  return _altarSkulls.get(altarKey(altarCfg)) ?? null;
}

export const CHAMPION_SKULLS_CONST = Object.freeze({
  SKULL_COLORS, BRAZIER_ITEM_ID, SKULL_ITEM_ID, HARROWER_COOLDOWN_MS,
});
