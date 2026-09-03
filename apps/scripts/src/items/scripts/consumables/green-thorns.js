// Green thorns — native NodeUO port of ServUO GreenThorns.cs.
//
// The original item chooses one of five effects from the land tile under the
// target: reagent eruption, vorpal bunny, whipping vine, ice creatures, or a
// temporary solen-hive entrance.  NodeUO keeps those behaviours in one item
// script instead of reproducing ServUO's Timer subclass hierarchy.

import { createItem, destroyItemBySerial } from '../../../_items.js';
import { createMobile } from '../../../_mobiles.js';
import { isInPack } from '../../../_inventory.js';

export const SERVUO_GREEN_THORNS_CLASSES = [
  'GreenThorns', 'GreenThornsEffect', 'DirtGreenThornsEffect',
  'FurrowsGreenThornsEffect', 'SwampGreenThornsEffect',
  'SnowGreenThornsEffect', 'SandGreenThornsEffect',
  'GreenThornsSHTeleporter', 'InternalTarget', 'EndActionTimer', 'InternalTimer',
];

const TERRAIN = [
  ['dirt', [[0x71, 0x7C], [0x82, 0xA7], [0xDC, 0xE3], [0xE8, 0xEB],
    [0x141, 0x144], [0x14C, 0x14F], [0x169, 0x174], [0x1DC, 0x1E7],
    [0x1EC, 0x1EF], [0x272, 0x275], [0x27E, 0x281], [0x2D0, 0x2D7],
    [0x2E5, 0x2FF], [0x303, 0x31F], [0x32C, 0x32F], [0x33D, 0x340],
    [0x345, 0x34C], [0x355, 0x358], [0x367, 0x36E], [0x377, 0x37A],
    [0x38D, 0x390], [0x395, 0x39C], [0x3A5, 0x3A8], [0x3F6, 0x405],
    [0x547, 0x54E], [0x553, 0x556], [0x597, 0x59E], [0x623, 0x63A],
    [0x6F3, 0x6FA], [0x777, 0x791], [0x79A, 0x7A9], [0x7AE, 0x7B1]]],
  ['furrows', [[0x9, 0x15], [0x150, 0x15C]]],
  ['swamp', [[0x9C4, 0x9EB], [0x3D65, 0x3D65], [0x3DC0, 0x3DD9],
    [0x3DDB, 0x3DDC], [0x3DDE, 0x3EF0], [0x3FF6, 0x3FF6], [0x3FFC, 0x3FFE]]],
  ['snow', [[0x10C, 0x10F], [0x114, 0x117], [0x119, 0x11D], [0x179, 0x18A],
    [0x385, 0x38C], [0x391, 0x394], [0x39D, 0x3A4], [0x3A9, 0x3AC],
    [0x5BF, 0x5D6], [0x5DF, 0x5E2], [0x745, 0x748], [0x751, 0x758],
    [0x75D, 0x760], [0x76D, 0x773]]],
  ['sand', [[0x16, 0x3A], [0x44, 0x4B], [0x11E, 0x121], [0x126, 0x12D],
    [0x192, 0x192], [0x1A8, 0x1AB], [0x1B9, 0x1D1], [0x282, 0x285],
    [0x28A, 0x291], [0x335, 0x33C], [0x341, 0x344], [0x34D, 0x354],
    [0x359, 0x35C], [0x3B7, 0x3BE], [0x3C7, 0x3CA], [0x5A7, 0x5B2],
    [0x64B, 0x652], [0x657, 0x65A], [0x663, 0x66A], [0x66F, 0x672],
    [0x7BD, 0x7D0]]],
];

const REAGENTS = [
  ['BlackPearl', 0x0F7A], ['Bloodmoss', 0x0F7B], ['Garlic', 0x0F84],
  ['Ginseng', 0x0F85], ['MandrakeRoot', 0x0F86], ['Nightshade', 0x0F88],
  ['SulfurousAsh', 0x0F8C], ['SpidersSilk', 0x0F8D], ['FertileDirt', 0x0F81],
];

export function greenThornsTerrain(tileId) {
  if (!Number.isInteger(tileId)) return null;
  for (const [name, ranges] of TERRAIN) {
    if (ranges.some(([lo, hi]) => tileId >= lo && tileId <= hi)) return name;
  }
  return null;
}

function nearbySpot(origin, n = 0) {
  const offsets = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]];
  const [dx, dy] = offsets[n % offsets.length];
  return { x: origin.x + dx, y: origin.y + dy, z: origin.z, map: origin.map };
}

function monsterData(api, servuoClass, fallback) {
  const kind = String(servuoClass).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  return { ...(api.monsters?.get?.(kind) ?? fallback), kind, servuoClass,
    servuoClasses: [servuoClass] };
}

function spawnMonster(api, world, at, servuoClass, fallback, index = 0) {
  const cfg = monsterData(api, servuoClass, fallback);
  const mob = createMobile(api, world, { ...cfg, ...nearbySpot(at, index),
    hp: cfg.hp ?? cfg.hpMax ?? 50, hpMax: cfg.hpMax ?? cfg.hp ?? 50,
    aiBehavior: cfg.aiBehavior ?? cfg.ai ?? 'aggressive', notoriety: cfg.notoriety ?? 5 });
  if (mob) {
    mob.combatTarget = at.fromSerial;
    api.ai?.attach?.(mob, mob.aiBehavior, {
      home: { x: mob.x, y: mob.y }, targetSerial: at.fromSerial,
      nextAttackAt: 0, nextStepAt: 0, nextCastAt: 0,
    });
  }
  return mob;
}

function consume(api, item) {
  if ((item.amount ?? 1) > 1) {
    item.amount -= 1;
    api.items?.invalidateProps?.(item.serial);
  } else {
    destroyItemBySerial(api, item.serial);
  }
}

/** Apply the selected terrain outcome immediately. Exported for deterministic tests. */
export function applyGreenThornsEffect(api, world, terrain, at, from) {
  const point = { ...at, fromSerial: from?.serial >>> 0 };
  if (terrain === 'dirt') {
    for (let i = 0; i < 8; i++) {
      const [servuoClass, itemId] = REAGENTS[Math.floor(Math.random() * REAGENTS.length)];
      createItem(api, world, { ...nearbySpot(point, i), itemId,
        name: servuoClass.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(),
        amount: 10 + Math.floor(Math.random() * 16), stackable: true, movable: true,
        servuoClass, servuoClasses: [servuoClass] });
    }
    return { ok: true, terrain, spawned: 8 };
  }
  if (terrain === 'furrows') {
    return { ok: !!spawnMonster(api, world, point, 'VorpalBunny', { name: 'a vorpal bunny', body: 0xCD, hp: 2000 }, 1), terrain, spawned: 1 };
  }
  if (terrain === 'swamp') {
    return { ok: !!spawnMonster(api, world, point, 'WhippingVine', { name: 'a whipping vine', body: 8, hp: 50 }, 1), terrain, spawned: 1 };
  }
  if (terrain === 'snow') {
    const worm = spawnMonster(api, world, point, 'GiantIceWorm', { name: 'a giant ice worm', body: 0x59, hp: 147 }, 1);
    let spawned = worm ? 1 : 0;
    for (let i = 0; i < 3; i++) {
      if (spawnMonster(api, world, point, 'IceSnake', { name: 'an ice snake', body: 0x34, hp: 50 }, i + 2)) spawned++;
    }
    return { ok: spawned > 0, terrain, spawned };
  }
  if (terrain === 'sand') {
    const hole = createItem(api, world, { ...nearbySpot(point), itemId: 0x0913,
      hue: 1, movable: false, name: 'a hole', script: 'green-thorns-solen-hole',
      expiresAt: Date.now() + 180_000, servuoClass: 'GreenThornsSHTeleporter',
      servuoClasses: ['GreenThornsSHTeleporter', 'InternalTimer'] });
    return { ok: !!hole, terrain, spawned: hole ? 1 : 0 };
  }
  return { ok: false, reason: 'unsupported-terrain', spawned: 0 };
}

export default function buildGreenThorns(api) {
  return {
    name: 'green-thorns',
    servuoClasses: SERVUO_GREEN_THORNS_CLASSES,
    onUse(world, item, user) {
      const state = user?.client;
      if (!state) return true;
      if (!isInPack(api, item, user)) {
        state.sendSystemMessage?.('You must have the green thorns in your backpack.');
        return true;
      }
      const now = Date.now();
      if ((user._greenThornsNextAt ?? 0) > now) {
        state.sendSystemMessage?.('You must wait before planting another thorn.');
        return true;
      }
      state.sendSystemMessage?.('Choose the ground where you wish to plant the thorn.');
      api.targeting?.request?.(state, (picked) => {
        if (!picked || !Number.isFinite(picked.x) || !Number.isFinite(picked.y)) return;
        const map = picked.map ?? user.map ?? 1;
        if (map !== 0 && map !== 1) {
          state.sendSystemMessage?.('No solen lairs exist on this facet.');
          return;
        }
        if (Math.max(Math.abs(picked.x - user.x), Math.abs(picked.y - user.y)) > 3) {
          state.sendSystemMessage?.('That location is too far away.');
          return;
        }
        const land = api.landProvider?.landAt?.(map, picked.x | 0, picked.y | 0);
        const terrain = greenThornsTerrain(picked.tileId ?? land?.tileId);
        if (!terrain) {
          state.sendSystemMessage?.('You sense it would be useless to plant a green thorn there.');
          return;
        }
        const at = { x: picked.x | 0, y: picked.y | 0, z: picked.z ?? land?.z ?? user.z, map };
        const result = applyGreenThornsEffect(api, world, terrain, at, user);
        if (!result.ok) return;
        consume(api, item);
        user._greenThornsNextAt = now + 180_000;
        state.sendSystemMessage?.('You push the strange green thorn into the ground.');
      }, { kind: 1, range: 3 });
      return true;
    },
  };
}

export function buildGreenThornsSolenHole(api) {
  return {
    name: 'green-thorns-solen-hole',
    hasTick: true,
    servuoClasses: ['GreenThornsSHTeleporter', 'InternalTimer'],
    onTick(_world, item) {
      if (item.expiresAt && Date.now() >= item.expiresAt) destroyItemBySerial(api, item.serial);
    },
    onUse(_world, item, user) {
      if (!user?.client) return true;
      if (Math.max(Math.abs(user.x - item.x), Math.abs(user.y - item.y)) > 2) {
        user.client.sendSystemMessage?.('I cannot reach that.');
        return true;
      }
      user.x = 5738; user.y = 1856; user.z = 0; user.map = item.map ?? user.map ?? 1;
      api.protocol?.teleport?.(user.client, user);
      user.client.sendSystemMessage?.('You descend into the solen hive.');
      return true;
    },
  };
}
