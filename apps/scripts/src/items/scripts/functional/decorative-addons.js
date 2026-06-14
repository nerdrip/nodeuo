import { broadcastItemUpdate } from '../_shared/broadcast.js';
import { createItem, destroyItemBySerial } from '../../../_items.js';
import { createMobile } from '../../../_mobiles.js';
import { itemBySerial, mobileBySerial } from '../../../_entities.js';
import { childrenOf, equipped, findBackpack, findInPack, isInPack } from '../../../_inventory.js';
import { moveItem } from '../../../_movement.js';
import { allItems, allMobiles } from '../../../_spatial.js';

// Decorative addon scripts. ServUO `Items/Addons/` ships ~390 unique
// composed multi-tile addons; we don't need every one as a script —
// most are pure decor (no onUse). The set below covers the entries
// that DO have interactive behaviour (gain skill, give a buff, play
// music, etc.). Each builder returns a single registered ItemScript.

function addServuoClasses(item, classes) {
  item.servuoClasses = [...new Set([
    ...(item.servuoClasses ?? []),
    ...classes.filter(Boolean),
  ])];
}

function pickTargetSerial(picked) {
  return picked?.serial ?? picked?.targetSerial ?? picked?.itemSerial ?? picked?.mobileSerial ?? 0;
}

function targetItem(api, world, picked) {
  return itemBySerial({ ...api, world }, pickTargetSerial(picked)) ?? (picked?.itemId != null ? picked : null);
}

function playSound(api, client, soundId, center) {
  const pkt = api.protocol?.playSound?.({
    soundId,
    x: center?.x ?? 0,
    y: center?.y ?? 0,
    z: center?.z ?? 0,
  });
  if (pkt) client?.send?.(pkt);
}

function inRange(a, b, range) {
  if (!a || !b) return false;
  if ((a.map ?? 0) !== (b.map ?? 0)) return false;
  return Math.max(Math.abs((a.x | 0) - (b.x | 0)), Math.abs((a.y | 0) - (b.y | 0))) <= range;
}

export function buildArcheryButte(api) {
  function currentRangedWeapon(user) {
    if (user?._weapon && ((user._weapon.range | 0) > 1 || user._weapon.skill === 32 || user._weapon.skill === 58)) {
      return { item: null, weapon: user._weapon };
    }
    for (const item of equipped(api, user)) {
      const weapon = item.weapon;
      if (!weapon) continue;
      if ((weapon.range | 0) > 1 || weapon.skill === 32 || weapon.skill === 58) return { item, weapon };
    }
    return null;
  }
  function consumeAmmo(user, ammoId) {
    if (!ammoId) return true;
    const ammo = findInPack(api, user, (it) => (it.itemId | 0) === (ammoId | 0));
    if (!ammo) return false;
    if ((ammo.amount ?? 1) > 1) ammo.amount = (ammo.amount | 0) - 1;
    else destroyItemBySerial(api, ammo.serial);
    return true;
  }
  function gatherAmmo(world, item, user) {
    const arrows = item.archeryButteArrows | 0;
    const bolts = item.archeryButteBolts | 0;
    if (arrows <= 0 && bolts <= 0) return false;
    const pack = findBackpack(api, user);
    if (!pack) {
      user.client?.sendSystemMessage?.('You have no place to put the arrows and bolts.');
      return true;
    }
    if (arrows > 0) {
      createItem(api, world, { itemId: 0x0F3F, name: 'arrow', amount: arrows, stackable: true, parent: pack.serial, x: 44, y: 44, z: 0, map: 0 });
    }
    if (bolts > 0) {
      createItem(api, world, { itemId: 0x1BFB, name: 'crossbow bolt', amount: bolts, stackable: true, parent: pack.serial, x: 64, y: 44, z: 0, map: 0 });
    }
    item.archeryButteArrows = 0;
    item.archeryButteBolts = 0;
    item.archeryButteEntries = {};
    user.client?.sendSystemMessage?.('You gather the arrows and bolts.');
    return true;
  }
  function scoreEntry(item, user) {
    item.archeryButteEntries ??= {};
    const key = String(user?.serial ?? 0);
    item.archeryButteEntries[key] ??= { servuoClass: 'ScoreEntry', total: 0, count: 0 };
    return item.archeryButteEntries[key];
  }
  function recordScore(item, user, score) {
    const entry = scoreEntry(item, user);
    entry.total = (entry.total | 0) + (score | 0);
    entry.count = (entry.count | 0) + 1;
    user.client?.sendSystemMessage?.(entry.count === 1
      ? `Score: ${entry.total}.`
      : `Score: ${entry.total} after ${entry.count} shots.`);
    return entry;
  }
  function isFacingEast(item) {
    return (item.archeryButteFacing ?? ((item.itemId | 0) === 0x100A ? 'east' : 'south')) === 'east';
  }
  function lineCheck(item, user) {
    const east = isFacingEast(item);
    if (east ? (user.x | 0) <= (item.x | 0) : (user.y | 0) <= (item.y | 0)) return 'You would do better to stand in front of the archery butte.';
    if (east ? (user.y | 0) !== (item.y | 0) : (user.x | 0) !== (item.x | 0)) return "You aren't properly lined up with the archery butte to get an accurate shot.";
    const dist = Math.max(Math.abs((user.x | 0) - (item.x | 0)), Math.abs((user.y | 0) - (item.y | 0)));
    if (dist > 6) return 'You are too far away from the archery butte to get an accurate shot.';
    if (dist <= 4) return 'You are too close to the target.';
    return null;
  }
  return {
    name: 'archery-butte',
    onCreate(_world, item) {
      item.archeryButteMinSkill ??= -25;
      item.archeryButteMaxSkill ??= 25;
      item.archeryButteArrows ??= 0;
      item.archeryButteBolts ??= 0;
      item.archeryButteEntries ??= {};
      item.archeryButteFacing ??= ((item.itemId | 0) === 0x100A ? 'east' : 'south');
      item.servuoClass ??= 'ArcheryButte';
      item.servuoClasses = [...new Set([
        ...(item.servuoClasses ?? []),
        'ArcheryButte',
        'ArcheryButteAddon',
        'ArcheryButteDeed',
        'ScoreEntry',
        'FlipableAttribute',
      ])];
    },
    onUse(world, item, user) {
      if (!user) return false;
      const dist = Math.max(Math.abs((user.x | 0) - (item.x | 0)), Math.abs((user.y | 0) - (item.y | 0)));
      const ranged = currentRangedWeapon(user);
      if ((item.archeryButteArrows > 0 || item.archeryButteBolts > 0) && dist <= 1 && !ranged) {
        return gatherAmmo(world, item, user);
      }
      if (!ranged) {
        user.client?.sendSystemMessage?.('You must practice with ranged weapons on the archery butte.');
        return true;
      }
      if (Date.now() < (item.archeryButteLastUseAt ?? 0) + 2000) return true;
      const lineError = lineCheck(item, user);
      if (lineError) {
        user.client?.sendSystemMessage?.(lineError);
        return true;
      }
      const ammoId = ranged.weapon.ammoId ?? null;
      const isArrow = (ammoId | 0) === 0x0F3F;
      const isBolt = (ammoId | 0) === 0x1BFB;
      if (ammoId && !consumeAmmo(user, ammoId)) {
        user.client?.sendSystemMessage?.(isBolt
          ? 'You do not have any crossbow bolts with which to practice.'
          : 'You do not have any arrows with which to practice.');
        return true;
      }
      item.archeryButteLastUseAt = Date.now();
      const skill = ranged.weapon.skill ?? 32;
      const min = item.archeryButteMinSkill ?? -25;
      const max = item.archeryButteMaxSkill ?? 25;
      api.skillGain?.tryGain?.(user, skill, min, max);
      const skillValue = user.skills?.[skill] ?? user.skills?.[String(skill)] ?? 0;
      const chance = Math.max(0.05, Math.min(0.95, ((skillValue / 10) - min) / Math.max(1, max - min)));
      if (Math.random() > chance) {
        user.client?.sendSystemMessage?.('You miss the target altogether.');
        recordScore(item, user, 0);
        return true;
      }
      const rand = Math.random();
      const score = rand < 0.10 ? 50 : rand < 0.25 ? 10 : rand < 0.50 ? 5 : 2;
      const splitScore = score === 50 ? 100 : score === 10 ? 20 : score === 5 ? 15 : 5;
      const canSplit = isArrow || isBolt;
      const split = canSplit && (((item.archeryButteArrows | 0) + (item.archeryButteBolts | 0)) * 0.02) > Math.random();
      if (split) {
        user.client?.sendSystemMessage?.(`You split another ${isBolt ? 'bolt' : 'arrow'} on the target.`);
      } else {
        if (isArrow) item.archeryButteArrows = (item.archeryButteArrows | 0) + 1;
        if (isBolt) item.archeryButteBolts = (item.archeryButteBolts | 0) + 1;
        user.client?.sendSystemMessage?.(`You hit the target for ${score} point(s).`);
      }
      recordScore(item, user, split ? splitScore : score);
      playSound(api, user.client, 0x2B1, item);
      api.events?.emit?.('combat:practice', { player: user, dummy: item, kind: 'archery', score: split ? splitScore : score });
      return true;
    },
  };
}

export function buildBanner(_api) {
  return {
    name: 'banner',
    onCreate(_world, item) {
      item.movable = false;
      item.forceShowProperties = true;
      item.servuoClass ??= 'Banner';
      item.servuoClasses = [...new Set([...(item.servuoClasses ?? []),
        'Banner',
        'BannerDeed',
        'InternalGump',
        'InternalTarget',
        'FacingGump',
        'RewardDemolitionGump',
        'IDyable',
        'IRewardItem',
      ])];
    },
    onUse(world, item, user) {
      // Banners are pure decor in ServUO; clicking gives a flavour line.
      user?.client?.sendSystemMessage?.('A heraldic banner sways in the breeze.');
      return true;
    },
  };
}

const FLAMING_HEAD_BASE_IDS = Object.freeze({
  'north-west-wall': 0x10F5,
  'north-wall': 0x10FC,
  'west-wall': 0x110F,
});
const FLAMING_HEAD_FIRE_IDS = Object.freeze({
  'north-west-wall': 0x10F7,
  'north-wall': 0x10FE,
  'west-wall': 0x1111,
});

function houseRole(api, house, mob) {
  if (!house || !mob) return null;
  if ((mob.accessLevel | 0) > 0 || mob.isAdmin === true) return 'owner';
  return api.houses?.roleOf?.(house, mob.serial) ?? (
    (house.ownerSerial >>> 0) === (mob.serial >>> 0) ? 'owner' : 'visitor'
  );
}

function houseAt(api, x, y, map) {
  return api.houses?.houseAt?.(x | 0, y | 0, map ?? 1) ?? null;
}

function isHouseOwner(api, mob, x, y, map) {
  const house = houseAt(api, x, y, map);
  if (!house) return !api.houses?.houseAt;
  return houseRole(api, house, mob) === 'owner';
}

function isWallishItem(item) {
  if (!item || item.parent != null) return false;
  if (item.solid === true) return true;
  if (item.kind === 'wall' || item.kind === 'door' || item.kind === 'pillar') return true;
  return /\b(wall|door|pillar|column)\b/i.test(item.name ?? '');
}

function isStaticWallish(api, map, x, y, z) {
  const provider = api.landProvider;
  const statics = provider?.staticsAt?.(map ?? 0, x | 0, y | 0) ?? [];
  const table = api.tileData?.table?.();
  const FLAG_IMPASSABLE = 1 << 6;
  for (const s of statics) {
    const sz = s.z ?? s.Z ?? 0;
    if (Math.abs((sz | 0) - (z | 0)) > 24) continue;
    const id = s.tileId ?? s.id ?? s.itemId;
    const flags = table?.statics?.[id | 0]?.flags ?? 0;
    if ((flags & FLAG_IMPASSABLE) !== 0) return true;
  }
  return false;
}

function hasWallAt(api, world, x, y, z, map) {
  for (const item of allItems({ ...api, world })) {
    if ((item.x | 0) !== (x | 0) || (item.y | 0) !== (y | 0) || (item.map ?? 1) !== (map ?? 1)) continue;
    if (Math.abs((item.z | 0) - (z | 0)) > 24) continue;
    if (isWallishItem(item)) return true;
  }
  return isStaticWallish(api, map, x, y, z);
}

function flamingHeadTypeFromItem(item) {
  if (item.flamingHeadType) return item.flamingHeadType;
  switch (item.itemId | 0) {
    case 0x10F5:
    case 0x10F6:
    case 0x10F7:
      return 'north-west-wall';
    case 0x110F:
    case 0x1110:
    case 0x1111:
      return 'west-wall';
    case 0x10FC:
    case 0x10FD:
    case 0x10FE:
    default:
      return 'north-wall';
  }
}

function stampFlamingHead(item, type = null) {
  const headType = type ?? flamingHeadTypeFromItem(item);
  item.flamingHeadType = headType;
  item.itemId = FLAMING_HEAD_BASE_IDS[headType] ?? FLAMING_HEAD_BASE_IDS['north-wall'];
  item.labelNumber ??= 1041266;
  item.movable = false;
  item.blessed = true;
  item.forceShowProperties = true;
  item.light ??= 9;
  item.servuoClass ??= 'FlamingHead';
  addServuoClasses(item, [
    'FlamingHead',
    'FlamingHeadDeed',
    'StoneFaceTrapNoDamage',
    'StoneFaceTrap',
    'StoneFaceTrapType',
    'RewardDemolitionGump',
    'InternalTarget',
    'IRewardItem',
  ]);
}

function animateFlamingHead(api, world, item) {
  const type = flamingHeadTypeFromItem(item);
  item._flamingHeadBaseItemId = FLAMING_HEAD_BASE_IDS[type] ?? FLAMING_HEAD_BASE_IDS['north-wall'];
  item.itemId = FLAMING_HEAD_FIRE_IDS[type] ?? FLAMING_HEAD_FIRE_IDS['north-wall'];
  item._flamingHeadBreathingUntil = Date.now() + 2000;
  broadcastItemUpdate(api, world, item);
  playSound(api, item._lastUser?.client, 0x359, item);
}

function findPlacementType(api, world, loc) {
  const north = hasWallAt(api, world, loc.x, loc.y - 1, loc.z, loc.map);
  const west = hasWallAt(api, world, loc.x - 1, loc.y, loc.z, loc.map);
  if (north && west) return 'north-west-wall';
  if (north) return 'north-wall';
  if (west) return 'west-wall';
  return null;
}

function createFlamingHeadDeed(api, world, item, user) {
  const pack = findBackpack({ ...api, world }, user);
  return createItem(api, world, {
    itemId: 0x14F0,
    name: 'a flaming head deed',
    tagId: 'flaming-head-deed',
    script: 'flaming-head-deed',
    labelNumber: 1041050,
    weight: 1,
    blessed: true,
    parent: pack?.serial,
    x: pack ? 44 : item.x,
    y: pack ? 44 : item.y,
    z: pack ? 0 : item.z,
    map: pack ? 0 : item.map,
    isRewardItem: item.isRewardItem ?? item.rewardItem ?? false,
    servuoClass: 'FlamingHeadDeed',
    servuoClasses: ['FlamingHeadDeed', 'FlamingHead', 'InternalTarget', 'IRewardItem'],
  });
}

function confirmFlamingHeadDemolition(api, world, item, user) {
  const redeed = () => {
    createFlamingHeadDeed(api, world, item, user);
    destroyItemBySerial({ ...api, world }, item.serial);
    user?.client?.sendSystemMessage?.('The flaming head has been returned to deed form.');
    return true;
  };
  if (!api.gumps?.send || !user?.client) return redeed();
  api.gumps.send(user.client, {
    gumpId: 0xF1A4EAD,
    x: 120,
    y: 80,
    layout: [
      '{ resizepic 0 0 5054 330 150 }',
      '{ text 24 20 1152 0 }',
      '{ button 36 88 4005 4007 1 0 1 }',
      '{ text 70 88 1153 1 }',
      '{ button 190 88 4017 4018 1 0 0 }',
      '{ text 224 88 1153 2 }',
    ].join(' '),
    texts: ['Do you wish to re-deed this skull?', 'Yes', 'No'],
  }, (resp) => {
    if ((resp?.buttonId | 0) === 1) redeed();
  });
  return true;
}

export function buildFlamingHead(api) {
  return {
    name: 'flaming-head',
    hasTick: true,
    onCreate(_world, item) {
      stampFlamingHead(item);
    },
    onUse(world, item, user) {
      if (!user) return false;
      stampFlamingHead(item);
      item._lastUser = user;
      if (!inRange(item, user, 2)) {
        user.client?.sendSystemMessage?.("I can't reach that.");
        return true;
      }
      if (!isHouseOwner(api, user, item.x, item.y, item.map)) {
        user.client?.sendSystemMessage?.('You can only re-deed a skull if you placed it or you are the owner of the house.');
        animateFlamingHead(api, world, item);
        return true;
      }
      return confirmFlamingHeadDemolition(api, world, item, user);
    },
    onWalkOn(world, item, mob) {
      if (!mob?.dead && !mob?.ghost) {
        item._lastUser = mob;
        animateFlamingHead(api, world, item);
      }
      return true;
    },
    onTick(world, item) {
      if (!item._flamingHeadBreathingUntil || item._flamingHeadBreathingUntil > Date.now()) return;
      item._flamingHeadBreathingUntil = 0;
      item.itemId = item._flamingHeadBaseItemId ?? FLAMING_HEAD_BASE_IDS[flamingHeadTypeFromItem(item)] ?? 0x10FC;
      broadcastItemUpdate(api, world, item);
    },
  };
}

export function buildFlamingHeadDeed(api) {
  function place(world, deed, user, loc) {
    if (!loc) {
      user?.client?.sendSystemMessage?.('Placement canceled.');
      return true;
    }
    if (!isHouseOwner(api, user, loc.x, loc.y, loc.map)) {
      user?.client?.sendSystemMessage?.('That location is not in your house.');
      return true;
    }
    const type = findPlacementType(api, world, loc);
    if (!type) {
      user?.client?.sendSystemMessage?.('The head must be placed next to a wall.');
      return true;
    }
    const head = createItem(api, world, {
      itemId: FLAMING_HEAD_BASE_IDS[type],
      name: 'Flaming Head',
      tagId: 'flaming-head',
      script: 'flaming-head',
      x: loc.x | 0,
      y: loc.y | 0,
      z: loc.z | 0,
      map: loc.map ?? user.map ?? 1,
      flamingHeadType: type,
      isRewardItem: deed.isRewardItem ?? deed.rewardItem ?? false,
    });
    if (head) stampFlamingHead(head, type);
    destroyItemBySerial({ ...api, world }, deed.serial);
    user?.client?.sendSystemMessage?.('You place the flaming head.');
    return true;
  }
  return {
    name: 'flaming-head-deed',
    onCreate(_world, item) {
      item.labelNumber ??= 1041050;
      item.weight ??= 1;
      item.blessed = true;
      item.servuoClass ??= 'FlamingHeadDeed';
      addServuoClasses(item, ['FlamingHeadDeed', 'FlamingHead', 'InternalTarget', 'IRewardItem']);
    },
    onUse(world, item, user) {
      if (!user) return false;
      const pack = findBackpack({ ...api, world }, user);
      if (!pack || (item.parent >>> 0) !== (pack.serial >>> 0)) {
        user.client?.sendSystemMessage?.('You must have the object in your backpack to use it.');
        return true;
      }
      if (!isHouseOwner(api, user, user.x, user.y, user.map)) {
        user.client?.sendSystemMessage?.('You must be in your house to do this.');
        return true;
      }
      user.client?.sendSystemMessage?.('Where would you like to place this head?');
      if (!api.targeting?.request || !user.client) {
        return place(world, item, user, { x: user.x, y: user.y - 1, z: user.z, map: user.map ?? 1 });
      }
      api.targeting.request(user.client, (picked) => {
        if (!picked) return place(world, item, user, null);
        place(world, item, user, {
          x: picked.x | 0,
          y: picked.y | 0,
          z: picked.z ?? (user.z | 0),
          map: picked.map ?? user.map ?? 1,
        });
      }, { kind: 0 });
      return true;
    },
  };
}

export function buildFireplace(api) {
  // Variant of campfire — full fireplace addon (chimney, hearth). Same
  // warmth buff.
  return {
    name: 'fireplace',
    onUse(world, item, user) {
      if (!user) return false;
      user.client?.sendSystemMessage?.('Warmth radiates from the hearth.');
      if (user.hp != null && user.hpMax != null) {
        user.hp = Math.min(user.hpMax, user.hp + 8);
        api.protocol?.broadcastMobileHits?.(user);
      }
      return true;
    },
  };
}

const DISTURBING_PORTRAIT_SOUTH = Object.freeze({
  day: 0x2A5D,
  dawn: 0x2A5E,
  dusk: 0x2A5F,
  night: 0x2A60,
});
const DISTURBING_PORTRAIT_EAST = Object.freeze({
  day: 0x2A61,
  dawn: 0x2A62,
  dusk: 0x2A63,
  night: 0x2A64,
});

function currentUoHour(api) {
  const hour = api.dayNight?.hourOfDay?.();
  if (Number.isFinite(hour)) return hour;
  const cycleMs = api.dayNight?.cyclePeriodMs ?? 24 * 60_000;
  const started = api.dayNight?._startedAt ?? 0;
  const elapsed = ((Date.now() - started) % cycleMs + cycleMs) % cycleMs;
  return (elapsed / cycleMs) * 24;
}

function portraitPhase(hour) {
  if (hour < 4 || hour >= 20) return 'night';
  if (hour < 6 || (hour >= 16 && hour < 18)) return 'dawn';
  if (hour < 8 || (hour >= 18 && hour < 20)) return 'dusk';
  return 'day';
}

function portraitFacing(item) {
  if (item.portraitFacing === 'east' || item._portraitFacing === 'east') return 'east';
  if (item.portraitFacing === 'south' || item._portraitFacing === 'south') return 'south';
  return (item.itemId | 0) >= 0x2A61 ? 'east' : 'south';
}

function updateDisturbingPortrait(api, world, item) {
  const facing = portraitFacing(item);
  const ids = facing === 'east' ? DISTURBING_PORTRAIT_EAST : DISTURBING_PORTRAIT_SOUTH;
  const next = ids[portraitPhase(currentUoHour(api))] ?? ids.day;
  if ((item.itemId | 0) !== next) {
    item.itemId = next;
    broadcastItemUpdate(api, world, item);
  }
  item._portraitFacing = facing;
  item._portraitNextUpdateAt = Date.now() + 10 * 60_000;
}

export function buildAwesomeDisturbingPortrait(api) {
  return {
    name: 'awesome-disturbing-portrait',
    hasTick: true,
    onCreate(world, item) {
      item.labelNumber ??= 1074479;
      item.servuoClass ??= 'AwesomeDisturbingPortraitComponent';
      addServuoClasses(item, [
        'AwesomeDisturbingPortraitComponent',
        'AwesomeDisturbingPortraitAddon',
        'AwesomeDisturbingPortraitDeed',
      ]);
      updateDisturbingPortrait(api, world, item);
    },
    onUse(world, item, user) {
      if (!user) return false;
      if (!inRange(item, user, 2)) {
        user.client?.sendSystemMessage?.("I can't reach that.");
        return true;
      }
      const hour = currentUoHour(api);
      if (hour < 4 || hour > 20) playSound(api, user.client, 0x569, item);
      updateDisturbingPortrait(api, world, item);
      return true;
    },
    onTick(world, item) {
      if ((item._portraitNextUpdateAt ?? 0) > Date.now()) return;
      updateDisturbingPortrait(api, world, item);
    },
  };
}

function bedOfNailsFacing(item) {
  if (item.bedOfNailsFacing === 'east' || item._bedOfNailsFacing === 'east') return 'east';
  if ((item.itemId | 0) === 0x2A89 || (item.itemId | 0) === 0x2A8A) return 'east';
  return 'south';
}

function bedOfNailsScreamSound(mob) {
  const female = mob?.female || mob?.gender === 'female' || mob?.sex === 1
    || (mob?.body | 0) === 0x0191 || (mob?.body | 0) === 0x0193;
  if (female) return 0x53B + Math.floor(Math.random() * 3);
  return 0x53E + Math.floor(Math.random() * 3);
}

function spawnBedBlood(api, world, mob) {
  const amount = Math.floor(Math.random() * 8);
  for (let i = 0; i < amount; i++) {
    const blood = createItem(api, world, {
      itemId: 0x122C + Math.floor(Math.random() * 4),
      name: 'Blood',
      x: (mob.x | 0) + Math.floor(Math.random() * 3) - 1,
      y: (mob.y | 0) + Math.floor(Math.random() * 3) - 1,
      z: mob.z | 0,
      map: mob.map ?? 1,
      movable: false,
      servuoClass: 'Blood',
      servuoClasses: ['Blood'],
      decayAt: Date.now() + 3_000,
    });
    const destroy = () => destroyItemBySerial({ ...api, world }, blood.serial);
    const timer = api.lifecycle?.setTimeout?.(destroy, 3_000) ?? setTimeout(destroy, 3_000);
    timer?.unref?.();
  }
}

export function buildBedOfNails(api) {
  return {
    name: 'bed-of-nails',
    hasTick: true,
    onCreate(_world, item) {
      item.labelNumber ??= 1074801;
      item.servuoClass ??= 'BedOfNailsComponent';
      item._bedOfNailsFacing ??= bedOfNailsFacing(item);
      addServuoClasses(item, [
        'BedOfNailsComponent',
        'BedOfNailsAddon',
        'BedOfNailsDeed',
      ]);
    },
    onUse(world, item, user) {
      if (!user) return false;
      // Masochist gain — small amount of damage in exchange for a
      // tiny meditation/willpower bonus. Mirrors Khaldun lore object.
      api.combat?.damage?.(world, user, 3 + Math.floor(Math.random() * 3), 'physical');
      api.skillGain?.tryGain?.(user, 47, 0, 60);
      user.client?.sendSystemMessage?.('Pain sharpens your focus.');
      return true;
    },
    onWalkOn(world, item, mob) {
      if (!mob || mob.dead || mob.ghost) return true;
      if (!mob.client && mob.hidden) return true;
      if (mob.client) playSound(api, mob.client, bedOfNailsScreamSound(mob), item);
      if (!item._bedOfNailsTrail || item._bedOfNailsTrail.ticksLeft <= 0) {
        item._bedOfNailsTrail = {
          mobSerial: mob.serial,
          ticksLeft: 5,
          lastX: null,
          lastY: null,
          lastZ: null,
          lastMap: null,
        };
      }
      return true;
    },
    onTick(world, item) {
      const trail = item._bedOfNailsTrail;
      if (!trail || trail.ticksLeft <= 0) return;
      const mob = mobileBySerial({ ...api, world }, trail.mobSerial);
      if (!mob || mob.dead || mob.ghost) {
        item._bedOfNailsTrail = null;
        return;
      }
      if (trail.lastX !== (mob.x | 0) || trail.lastY !== (mob.y | 0)
        || trail.lastZ !== (mob.z | 0) || trail.lastMap !== (mob.map ?? 1)) {
        spawnBedBlood(api, world, mob);
        trail.lastX = mob.x | 0;
        trail.lastY = mob.y | 0;
        trail.lastZ = mob.z | 0;
        trail.lastMap = mob.map ?? 1;
      }
      trail.ticksLeft -= 1;
      if (trail.ticksLeft <= 0) item._bedOfNailsTrail = null;
    },
  };
}

const STEALING_SKILL_ID = 34;
const PICKPOCKET_SWING_MS = 3000;

function pickpocketBaseItemId(item) {
  const id = item.itemId | 0;
  if (id >= 0x1EC0 && id <= 0x1EC5) return 0x1EC0 + Math.floor((id - 0x1EC0) / 3) * 3;
  return id === 0x1EC3 ? 0x1EC3 : 0x1EC0;
}

function pickpocketSkillValue(mob) {
  const raw = mob?.skills?.[STEALING_SKILL_ID] ?? mob?.skills?.[String(STEALING_SKILL_ID)] ?? mob?.skills?.Stealing ?? 0;
  return raw > 100 ? raw / 10 : raw;
}

function setPickpocketSwing(api, world, item, swinging) {
  item._pickpocketBaseItemId ??= pickpocketBaseItemId(item);
  item.itemId = (item._pickpocketBaseItemId | 0) + (swinging ? 1 : 0);
  item._pickpocketSwingUntil = swinging ? Date.now() + PICKPOCKET_SWING_MS : 0;
  broadcastItemUpdate(api, world, item);
}

export function buildPickpocketDip(api) {
  return {
    name: 'pickpocket-dip',
    hasTick: true,
    onCreate(_world, item) {
      item.pickpocketMinSkill ??= -25;
      item.pickpocketMaxSkill ??= 25;
      item._pickpocketBaseItemId ??= pickpocketBaseItemId(item);
      item.servuoClass ??= 'PickpocketDip';
      addServuoClasses(item, [
        'PickpocketDip',
        'PickpocketDipEastAddon',
        'PickpocketDipEastDeed',
        'PickpocketDipSouthAddon',
        'PickpocketDipSouthDeed',
        'InternalTimer',
        'FlipableAttribute',
      ]);
    },
    onUse(world, item, user) {
      if (!user) return false;
      if (!inRange(item, user, 1)) {
        user.client?.sendSystemMessage?.('You are too far away to do that.');
        return true;
      }
      if ((item._pickpocketSwingUntil ?? 0) > Date.now()) {
        user.client?.sendSystemMessage?.('You have to wait until it stops swinging.');
        return true;
      }
      if (user.mounted || user.mountedFrom) {
        user.client?.sendSystemMessage?.("You can't practice on this while on a mount.");
        return true;
      }
      const min = item.pickpocketMinSkill ?? -25;
      const max = item.pickpocketMaxSkill ?? 25;
      const skill = pickpocketSkillValue(user);
      if (skill >= max) {
        user.client?.sendSystemMessage?.('Your ability to steal cannot improve any further by simply practicing on a dummy.');
        return true;
      }
      playSound(api, user.client, 0x4F, item);
      api.skillGain?.tryGain?.(user, STEALING_SKILL_ID, min, max);
      const chance = Math.max(0.05, Math.min(0.95, (skill - min) / Math.max(1, max - min)));
      if (Math.random() <= chance) {
        user.client?.sendSystemMessage?.('You successfully avoid disturbing the dip while searching it.');
        return true;
      }
      playSound(api, user.client, 0x390, item);
      user.client?.sendSystemMessage?.('You carelessly bump the dip and start it swinging.');
      setPickpocketSwing(api, world, item, true);
      return true;
    },
    onTick(world, item) {
      if (!item._pickpocketSwingUntil || item._pickpocketSwingUntil > Date.now()) return;
      setPickpocketSwing(api, world, item, false);
      return true;
    },
  };
}

export function buildEasel(api) {
  return {
    name: 'easel',
    onUse(world, item, user) {
      user?.client?.sendSystemMessage?.('You contemplate the canvas — what shall you paint?');
      api.events?.emit?.('craft:open', { player: user, station: 'easel', skill: 'Cartography' });
      return true;
    },
  };
}

export function buildMusicBox(api) {
  const MUSIC_RANGE = 10;
  const DEFAULT_TRACKS = [
    0x3D, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47,
    0x48, 0x49, 0x4A, 0x4B, 0x4C, 0x4D, 0x4E, 0x4F,
  ];
  const stopMusic = (client) => {
    try {
      const pkt = api.protocol?.playMusic?.(0x1FFF);
      if (pkt) client?.send?.(pkt);
    } catch { /* best effort */ }
  };
  const playMusic = (client, trackId) => {
    try {
      const pkt = api.protocol?.playMusic?.(trackId | 0);
      if (pkt) client?.send?.(pkt);
    } catch { /* best effort */ }
  };
  const ensureMusicState = (item) => {
    item._musicTracks ??= item.musicTracks ?? [item.musicId || DEFAULT_TRACKS[(Math.random() * DEFAULT_TRACKS.length) | 0]];
    item.servuoClass ??= 'DawnsMusicBox';
    addServuoClasses(item, [
      'DawnsMusicBox',
      'DawnsMusicInfo',
      'DawnsMusicRarity',
      'PlayingTimer',
      'MusicGump',
      'StopMusic',
      'FlipableAttribute',
    ]);
  };
  const inRangeMobiles = (world, item) => [...allMobiles({ ...api, world })]
    .filter((m) => m?.client && (m.map | 0) === (item.map | 0)
      && Math.max(Math.abs((m.x | 0) - (item.x | 0)), Math.abs((m.y | 0) - (item.y | 0))) <= MUSIC_RANGE);
  const stopBox = (world, item, announce = true) => {
    if (!item._musicPlayingUntil) return;
    item._musicPlayingUntil = 0;
    item._musicActualSong = 0;
    if (item._musicOriginalItemId) {
      item.itemId = item._musicOriginalItemId;
      broadcastItemUpdate(api, world, item);
    }
    for (const m of inRangeMobiles(world, item)) stopMusic(m.client);
    if (announce) {
      for (const m of inRangeMobiles(world, item)) {
        m.client.sendSystemMessage?.('* The music box stops *', 0x5D);
      }
    }
  };
  const animate = (world, item) => {
    const nextById = {
      0x2AF9: 0x2AFB, 0x2AFB: 0x2AFC, 0x2AFC: 0x2AF9,
      0x2AFD: 0x2AFF, 0x2AFF: 0x2B00, 0x2B00: 0x2AFD,
    };
    const next = nextById[item.itemId | 0];
    if (!next) return;
    item.itemId = next;
    broadcastItemUpdate(api, world, item);
  };
  const startBox = (world, item, user, trackOverride = null) => {
    for (const other of allItems({ world })) {
      if (other === item || other.script !== 'music-box' || !other._musicPlayingUntil) continue;
      if ((other.map | 0) !== (item.map | 0)) continue;
      if (Math.max(Math.abs((other.x | 0) - (item.x | 0)), Math.abs((other.y | 0) - (item.y | 0))) > MUSIC_RANGE) continue;
      stopBox(world, other, false);
    }
    ensureMusicState(item);
    const track = Number.isFinite(trackOverride)
      ? (trackOverride | 0)
      : item._musicTracks[(Math.random() * item._musicTracks.length) | 0] | 0;
    item._musicOriginalItemId ||= item.itemId | 0;
    item._musicActualSong = track;
    item._musicPlayingUntil = Date.now() + (item.musicDurationMs ?? 120_000);
    item._musicNextAnimAt = Date.now();
    for (const m of inRangeMobiles(world, item)) {
      playMusic(m.client, track);
      m.client.sendSystemMessage?.('* The music box starts playing a song *', 0x5D);
    }
    if (user?.client && !inRangeMobiles(world, item).includes(user)) playMusic(user.client, track);
  };
  const trackLabel = (track) => `Track 0x${(track | 0).toString(16).toUpperCase().padStart(2, '0')}`;
  const openMusicGump = (world, item, user) => {
    const state = user?.client;
    if (!state || !api.gumps?.send) {
      if (item._musicPlayingUntil && item._musicPlayingUntil > Date.now()) stopBox(world, item, true);
      else startBox(world, item, user);
      return;
    }
    ensureMusicState(item);
    const tracks = item._musicTracks.slice(0, 12);
    const layout = [
      '{ resizepic 0 0 5054 290 350 }',
      '{ text 24 18 1152 0 }',
      '{ button 24 48 4005 4007 1 0 2 }',
      '{ text 58 48 1153 1 }',
      '{ button 154 48 4017 4018 1 0 1 }',
      '{ text 188 48 1153 2 }',
    ];
    const texts = ["Dawn's Music Box", 'Random', 'Stop'];
    tracks.forEach((track, i) => {
      const y = 86 + i * 20;
      layout.push(`{ button 28 ${y} 4005 4007 1 0 ${100 + i} }`);
      layout.push(`{ text 62 ${y - 2} 1149 ${texts.length} }`);
      texts.push(trackLabel(track));
    });
    api.gumps.send(state, { gumpId: 0xDA0001, x: 90, y: 70, layout: layout.join(' '), texts }, (resp) => {
      const button = resp?.buttonId | 0;
      if (button === 1) {
        stopBox(world, item, true);
      } else if (button === 2) {
        startBox(world, item, user);
      } else if (button >= 100) {
        const track = tracks[button - 100];
        if (track != null) startBox(world, item, user, track);
      }
    });
  };
  return {
    name: 'music-box',
    hasTick: true,
    onCreate(_world, item) {
      ensureMusicState(item);
    },
    onUse(world, item, user) {
      openMusicGump(world, item, user);
      return true;
    },
    onTick(world, item) {
      if (!item._musicPlayingUntil) return;
      const now = Date.now();
      if (now >= item._musicPlayingUntil) {
        stopBox(world, item, true);
        return;
      }
      if ((item._musicNextAnimAt ?? 0) <= now) {
        animate(world, item);
        item._musicNextAnimAt = now + 500;
      }
      return true;
    },
  };
}

const GRANITE_REWARD_TYPES = Object.freeze([
  { servuoClass: 'Granite', name: 'Granite' },
  { servuoClass: 'DullCopperGranite', name: 'Dull Copper Granite', hue: 0x0973 },
  { servuoClass: 'ShadowIronGranite', name: 'Shadow Iron Granite', hue: 0x0966 },
  { servuoClass: 'CopperGranite', name: 'Copper Granite', hue: 0x096D },
  { servuoClass: 'BronzeGranite', name: 'Bronze Granite', hue: 0x0972 },
  { servuoClass: 'GoldGranite', name: 'Gold Granite', hue: 0x08A5 },
  { servuoClass: 'AgapiteGranite', name: 'Agapite Granite', hue: 0x0979 },
  { servuoClass: 'VeriteGranite', name: 'Verite Granite', hue: 0x089F },
  { servuoClass: 'ValoriteGranite', name: 'Valorite Granite', hue: 0x08AB },
]);

function ensureGraniteCartState(item) {
  item.graniteRewardCount ??= 0;
  item.graniteNextUseAt ??= Date.now() + 24 * 60 * 60_000;
  item.graniteSecureLevel ??= 'coOwners';
  item.labelNumber ??= 1126338;
  item.servuoClass ??= 'EnchantedGraniteCartComponent';
  addServuoClasses(item, [
    'EnchantedGraniteCartComponent',
    'EnchantedGraniteCartAddon',
    'EnchantedGraniteCartAddonDeed',
    'IRewardItem',
    'IRewardOption',
    'InternalTimer',
  ]);
}

export function buildEnchantedGraniteCart(api) {
  return {
    name: 'enchanted-granite-cart',
    hasTick: true,
    onCreate(_world, item) {
      ensureGraniteCartState(item);
    },
    onUse(world, item, user) {
      if (!user) return false;
      ensureGraniteCartState(item);
      if (!inRange(item, user, 3)) {
        user.client?.sendSystemMessage?.("I can't reach that.");
        return true;
      }
      if ((item.graniteRewardCount | 0) < 2) {
        user.client?.sendSystemMessage?.('There are no more resources available at this time.');
        return true;
      }
      const pack = findBackpack(api, user);
      if (!pack) {
        user.client?.sendSystemMessage?.('You have no place to put the granite.');
        return true;
      }
      const reward = GRANITE_REWARD_TYPES[(Math.random() * GRANITE_REWARD_TYPES.length) | 0];
      createItem(api, world, {
        itemId: 0x1779,
        name: reward.name,
        hue: reward.hue ?? 0,
        amount: 2,
        stackable: true,
        weight: 2,
        parent: pack.serial,
        x: 44,
        y: 44,
        z: 0,
        map: 0,
        kind: 'resource',
        resource: 'granite',
        servuoClass: reward.servuoClass,
        servuoClasses: [reward.servuoClass, 'Granite'],
      });
      item.graniteRewardCount = Math.max(0, (item.graniteRewardCount | 0) - 2);
      user.client?.sendSystemMessage?.('You take two pieces of granite from the cart.');
      return true;
    },
    onTick(_world, item) {
      ensureGraniteCartState(item);
      const now = Date.now();
      if ((item.graniteNextUseAt ?? 0) > now) return;
      if ((item.graniteRewardCount | 0) <= 20) {
        item.graniteRewardCount = Math.min(20, (item.graniteRewardCount | 0) + 2);
      }
      item.graniteNextUseAt = now + 24 * 60 * 60_000;
    },
  };
}

export function buildBlessedStatue(_api) {
  return {
    name: 'blessed-statue',
    onUse(world, item, user) {
      if (!user) return false;
      // Light bless — small mana regen pulse.
      user.client?.sendSystemMessage?.('A serene presence touches your mind.');
      if (user.mana != null && user.manaMax != null) {
        user.mana = Math.min(user.manaMax, user.mana + 10);
      }
      return true;
    },
  };
}

export function buildJewelryStand(api) {
  return {
    name: 'jewelry-stand',
    onUse(world, item, user) {
      user?.client?.sendSystemMessage?.('Glittering trinkets catch the light.');
      api.events?.emit?.('craft:open', { player: user, station: 'jewelry-stand', skill: 'Tinkering' });
      return true;
    },
  };
}

export function buildAbattoirBlock(api) {
  return {
    name: 'abattoir-block',
    onUse(world, item, user) {
      user?.client?.sendSystemMessage?.('Dried blood stains the chopping block.');
      api.events?.emit?.('craft:open', { player: user, station: 'abattoir-block', skill: 'Cooking' });
      return true;
    },
  };
}

export function buildArcaneCircle(api) {
  return {
    name: 'arcane-circle',
    onUse(world, item, user) {
      if (!user) return false;
      user.client?.sendSystemMessage?.('You step into the arcane circle and feel its power.');
      // Mage rite: small mana boost plus reagent-cost reduction tag.
      api.statusEffects?.apply?.(world, user, 'arcane-focus', { ticks: 60, intensity: 1 });
      return true;
    },
  };
}

export function buildScarecrow(_api) {
  return {
    name: 'scarecrow',
    onUse(world, item, user) {
      user?.client?.sendSystemMessage?.('The scarecrow watches the field with empty eyes.');
      return true;
    },
  };
}

export function buildClawFootTub(api) {
  return {
    name: 'claw-foot-tub',
    onUse(world, item, user) {
      if (!user) return false;
      const anchor = item._addonAnchor;
      if (!anchor) {
        user.client?.sendSystemMessage?.('The tub fittings do not respond.');
        return true;
      }
      let changed = 0;
      for (const piece of allItems({ world })) {
        const a = piece._addonAnchor;
        if (!a || a.x !== anchor.x || a.y !== anchor.y || a.z !== anchor.z) continue;
        if (piece._addon !== item._addon) continue;
        if (piece.itemId === 0x996D) piece.itemId = 0x9972;
        else if (piece.itemId === 0x9972) piece.itemId = 0x996D;
        else if (piece.itemId === 0x9978) piece.itemId = 0x997D;
        else if (piece.itemId === 0x997D) piece.itemId = 0x9978;
        else continue;
        changed++;
        broadcastItemUpdate(api, world, piece);
      }
      user.client?.sendSystemMessage?.(changed ? 'You adjust the claw foot tub.' : 'Nothing happens.');
      return true;
    },
  };
}

const FLOUR_TABLES = [
  [0x1920, 0x1921, 0x1925],
  [0x1922, 0x1923, 0x1926],
  [0x1924, 0x1924, 0x1928],
  [0x192C, 0x192D, 0x1931],
  [0x192E, 0x192F, 0x1932],
  [0x1930, 0x1930, 0x1934],
];

function setFlourMillStage(api, world, anchor, stage) {
  for (const piece of allItems({ world })) {
    const a = piece._addonAnchor;
    if (!a || a.x !== anchor.x || a.y !== anchor.y || a.z !== anchor.z) continue;
    const row = FLOUR_TABLES.find((ids) => ids.includes(piece.itemId));
    if (!row) continue;
    piece.itemId = row[stage] ?? row[0];
    broadcastItemUpdate(api, world, piece);
  }
}

function backpackOf(world, user) {
  for (const item of allItems({ world })) {
    if ((item.parent >>> 0) !== (user.serial >>> 0)) continue;
    if ((item.layer | 0) === 0x1D || item.container || /backpack/i.test(item.name ?? '')) return item;
  }
  return null;
}

const BANDAGE_ITEM_ID = 0x0E21;
const ENHANCED_BANDAGE_HUE = 0x08A5;
const ENHANCED_BANDAGE_BONUS = 10;
const FOUNTAIN_RECHARGE_MS = 24 * 60 * 60 * 1000;

function classesOf(item) {
  return [item?.servuoClass, ...(item?.servuoClasses ?? [])].filter(Boolean);
}

function isBandageItem(item) {
  if (!item) return false;
  if ((item.itemId | 0) === BANDAGE_ITEM_ID) return true;
  if (item.tagId === 'bandage' || item.tagId === 'enhanced-bandage') return true;
  const classes = classesOf(item);
  return classes.includes('Bandage') || classes.includes('EnhancedBandage');
}

function isEnhancedBandage(item) {
  if (!isBandageItem(item)) return false;
  if ((item.bandageHealingBonus | 0) > 0) return true;
  if (item.tagId === 'enhanced-bandage') return true;
  if (classesOf(item).includes('EnhancedBandage')) return true;
  if ((item.itemId | 0) === BANDAGE_ITEM_ID && (item.hue | 0) === ENHANCED_BANDAGE_HUE) return true;
  return /enhanced bandage/i.test(item.name ?? '');
}

function notifyContainer(api, world, container, item, removed = false) {
  if (!container || !item) return;
  const parent = container.serial >>> 0;
  const packet = removed
    ? api.protocol?.removeEntity?.(item.serial)
    : api.protocol?.containerContentUpdate?.({
        serial: item.serial,
        itemId: item.itemId,
        amount: item.amount ?? 1,
        hue: item.hue ?? 0,
        gridX: item.gridX ?? 0,
        gridY: item.gridY ?? 0,
        gridLocation: item.gridLocation ?? 0,
      }, parent);
  if (!packet) return;
  for (const mob of allMobiles({ ...api, world })) {
    if (mob.client?.openContainers?.has?.(parent)) mob.client.send?.(packet);
  }
}

function ensureFountainState(item, now = Date.now()) {
  item.container = true;
  item.gumpId ||= 0x0484;
  item.capacity ??= 125;
  item.maxWeight ??= 400;
  item.fountainMaxCharges ??= 10;
  item.fountainCharges = Math.max(0, Math.min(item.fountainMaxCharges | 0, item.fountainCharges ?? item.charges ?? 10));
  item.fountainNextRechargeAt ??= now + FOUNTAIN_RECHARGE_MS;
}

function findEnhancedStack(api, fountain) {
  for (const item of childrenOf(api, fountain)) {
    if (isEnhancedBandage(item)) return item;
  }
  return null;
}

function addEnhancedBandages(api, world, fountain, amount) {
  if ((amount | 0) <= 0) return null;
  const existing = findEnhancedStack({ ...api, world }, fountain);
  if (existing) {
    existing.amount = (existing.amount ?? 1) + amount;
    existing.bandageHealingBonus ??= ENHANCED_BANDAGE_BONUS;
    existing.servuoClass ??= 'EnhancedBandage';
    existing.servuoClasses = [...new Set([
      existing.servuoClass,
      ...(existing.servuoClasses ?? []),
      'EnhancedBandage',
      'Bandage',
      'ICommodity',
    ].filter(Boolean))];
    notifyContainer(api, world, fountain, existing);
    return existing;
  }
  const item = createItem(api, world, {
    itemId: BANDAGE_ITEM_ID,
    hue: ENHANCED_BANDAGE_HUE,
    name: 'enhanced bandage',
    tagId: 'enhanced-bandage',
    amount,
    parent: fountain.serial,
    x: 44,
    y: 44,
    z: 0,
    map: 0,
    stackable: true,
    script: 'bandage',
    bandageHealingBonus: ENHANCED_BANDAGE_BONUS,
    servuoClass: 'EnhancedBandage',
    servuoClasses: ['EnhancedBandage', 'Bandage', 'ICommodity'],
  });
  notifyContainer(api, world, fountain, item);
  return item;
}

function enhanceBandagesInFountain(api, world, fountain) {
  ensureFountainState(fountain);
  let charges = fountain.fountainCharges | 0;
  if (charges <= 0) return 0;
  let enhanced = 0;
  const contents = [...childrenOf({ ...api, world }, fountain)];
  for (const item of contents) {
    if (charges <= 0) break;
    if (!isBandageItem(item) || isEnhancedBandage(item)) continue;
    const have = Math.max(1, item.amount ?? 1);
    const take = Math.min(have, charges);
    if (have > take) {
      item.amount = have - take;
      notifyContainer(api, world, fountain, item);
    } else {
      destroyItemBySerial({ ...api, world }, item.serial);
      notifyContainer(api, world, fountain, item, true);
    }
    addEnhancedBandages(api, world, fountain, take);
    charges -= take;
    enhanced += take;
  }
  fountain.fountainCharges = charges;
  return enhanced;
}

export function buildFountainAddon(_api) {
  return {
    name: 'fountain',
    onCreate(_world, item) {
      item.movable = false;
      item.servuoClass ??= 'FountainAddon';
      addServuoClasses(item, ['FountainAddon', 'FountainDeed', 'StoneFountainAddon', 'AddonComponent']);
    },
    onUse(_world, _item, user) {
      user?.client?.sendSystemMessage?.('Water flows steadily through the fountain.');
      return true;
    },
  };
}

export function buildFountainOfLife(api) {
  return {
    name: 'fountain-of-life',
    hasTick: true,
    onCreate(_world, item) {
      ensureFountainState(item);
      item.servuoClass ??= 'FountainOfLife';
      item.servuoClasses = [...new Set([
        item.servuoClass,
        ...(item.servuoClasses ?? []),
        'FountainOfLife',
        'FountainOfLifeDeed',
        'EnhancedBandage',
        'BaseAddonContainer',
      ].filter(Boolean))];
    },
    onUse(world, item, user) {
      ensureFountainState(item);
      if ((item.fountainNextRechargeAt ?? 0) <= Date.now()) {
        item.fountainCharges = item.fountainMaxCharges ?? 10;
        item.fountainNextRechargeAt = Date.now() + FOUNTAIN_RECHARGE_MS;
        enhanceBandagesInFountain(api, world, item);
      }
      user?.client?.sendSystemMessage?.(`Fountain of Life: ${item.fountainCharges | 0} charge(s) remaining.`);
      return false;
    },
    onDrop(world, fountain, dropped, dropper) {
      ensureFountainState(fountain);
      if (!isBandageItem(dropped)) {
        dropper?.client?.sendSystemMessage?.('Only bandages may be dropped into the fountain.');
        return { handled: true, consumeHeld: false };
      }
      if (isEnhancedBandage(dropped)) return false;
      moveItem(api, dropped, {
        parent: fountain.serial,
        x: dropped.gridX ?? 44,
        y: dropped.gridY ?? 44,
        z: 0,
        map: 0,
      });
      notifyContainer(api, world, fountain, dropped);
      const made = enhanceBandagesInFountain(api, world, fountain);
      if (made > 0) {
        dropper?.client?.sendSystemMessage?.(`The fountain enhances ${made} bandage(s).`);
      } else {
        dropper?.client?.sendSystemMessage?.('The fountain is out of charges.');
      }
      return true;
    },
    onTick(world, item) {
      ensureFountainState(item);
      const now = Date.now();
      if ((item.fountainNextRechargeAt ?? 0) > now) return;
      item.fountainCharges = item.fountainMaxCharges ?? 10;
      item.fountainNextRechargeAt = now + FOUNTAIN_RECHARGE_MS;
      enhanceBandagesInFountain(api, world, item);
    },
  };
}

const DOLPHIN_RUG_RECHARGE_MS = 7 * 24 * 60 * 60 * 1000;

function ensureDolphinRugState(item, now = Date.now()) {
  item.dolphinResourceCount = Math.max(0, Math.min(10, item.dolphinResourceCount ?? item.resourceCount ?? 0));
  item.dolphinNextResourceAt ??= now + DOLPHIN_RUG_RECHARGE_MS;
  item.labelNumber ??= 1150122;
  item.forceShowProperties = true;
  item.movable = false;
  item.servuoClass ??= 'DolphinRugAddon';
  addServuoClasses(item, [
    'DolphinRugAddon',
    'InternalAddonComponent',
    'DolphinRugAddonDeed',
    'RugType',
    'RewardOptionGump',
    'IRewardItem',
    'IRewardOption',
  ]);
}

function rechargeDolphinRug(item, now = Date.now()) {
  ensureDolphinRugState(item, now);
  if ((item.dolphinNextResourceAt ?? 0) > now) return false;
  item.dolphinResourceCount = Math.min(10, (item.dolphinResourceCount | 0) + 1);
  item.dolphinNextResourceAt = now + DOLPHIN_RUG_RECHARGE_MS;
  return true;
}

function dolphinRugStateItem(world, item) {
  const anchor = item?._addonAnchor;
  if (!anchor) return item;
  let fallback = item;
  for (const piece of allItems({ world })) {
    const a = piece._addonAnchor;
    if (!a || a.x !== anchor.x || a.y !== anchor.y || a.z !== anchor.z) continue;
    if (piece._addon !== item._addon) continue;
    if (piece.dolphinRugState) return piece;
    if (!fallback || (piece.serial >>> 0) < (fallback.serial >>> 0)) fallback = piece;
  }
  return fallback ?? item;
}

function canUseHouseResource(api, item, user) {
  if (!api.houses?.houseAt) return true;
  const house = houseAt(api, item.x, item.y, item.map);
  if (!house) return false;
  const role = houseRole(api, house, user);
  return role === 'owner' || role === 'coowner';
}

export function buildDolphinRug(api) {
  return {
    name: 'dolphin-rug',
    hasTick: true,
    onCreate(_world, item) {
      ensureDolphinRugState(item);
    },
    onUse(world, item, user) {
      if (!user) return false;
      const state = dolphinRugStateItem(world, item);
      ensureDolphinRugState(state);
      rechargeDolphinRug(state);
      if (!canUseHouseResource(api, item, user)) {
        user.client?.sendSystemMessage?.('You must be in your house to do this.');
        return true;
      }
      if ((state.dolphinResourceCount | 0) <= 0) {
        user.client?.sendSystemMessage?.('There are no messages in bottles available.');
        return true;
      }
      const pack = findBackpack({ ...api, world }, user);
      const bottle = createItem(api, world, {
        itemId: 0x099F,
        name: 'Message in a Bottle',
        tagId: 'message-in-bottle',
        script: 'message-in-bottle',
        parent: pack?.serial,
        x: pack ? 44 : user.x,
        y: pack ? 44 : user.y,
        z: pack ? 0 : user.z,
        map: pack ? 0 : user.map ?? 1,
        weight: 1,
        mib: { level: 1, map: user.map ?? 1 },
        servuoClass: 'MessageInABottle',
        servuoClasses: ['MessageInABottle'],
      });
      state.dolphinResourceCount = Math.max(0, (state.dolphinResourceCount | 0) - 1);
      state.dolphinNextResourceAt = Date.now() + DOLPHIN_RUG_RECHARGE_MS;
      user.client?.sendSystemMessage?.(pack && bottle
        ? 'An item has been placed in your backpack.'
        : 'The dolphin rug releases a message in a bottle.');
      return true;
    },
    onTick(_world, item) {
      if (item._addonAnchor && !item.dolphinRugState) return;
      rechargeDolphinRug(item);
    },
  };
}

const RESOURCE_ADDON_RECHARGE_MS = 7 * 24 * 60 * 60 * 1000;
const RESOURCE_ADDON_SKILLS = Object.freeze([
  'Alchemy', 'Anatomy', 'Animal Lore', 'Animal Taming', 'Archery', 'Blacksmithy',
  'Bushido', 'Carpentry', 'Cartography', 'Chivalry', 'Discordance', 'Eval Int',
  'Fencing', 'Fishing', 'Focus', 'Healing', 'Inscription', 'Magery', 'Meditation',
  'Mining', 'Musicianship', 'Necromancy', 'Ninjitsu', 'Parrying', 'Peacemaking',
  'Poisoning', 'Provocation', 'Resisting Spells', 'Spirit Speak', 'Stealth',
  'Swords', 'Tactics', 'Tailoring', 'Tinkering', 'Veterinary', 'Wrestling',
]);

function randomTreasureSpot(user) {
  const map = Math.random() < 0.5 ? 1 : 2;
  const x = 512 + ((Math.random() * 5120) | 0);
  const y = 512 + ((Math.random() * 3584) | 0);
  return { x: user?.x ?? x, y: user?.y ?? y, map: user?.map ?? map };
}

function createSeedReward(api, world, pack, user) {
  return createItem(api, world, {
    itemId: 0x0DCF,
    name: 'Seed',
    tagId: 'plant-seed',
    parent: pack.serial,
    x: 44,
    y: 44,
    z: 0,
    map: 0,
    weight: 1,
    servuoClass: 'Seed',
    servuoClasses: ['Seed'],
    seed: { plantType: 'random', hue: 0, fromAddon: true, ownerSerial: user?.serial },
  });
}

function createTreasureMapReward(api, world, pack, user) {
  const level = 1 + ((Math.random() * 4) | 0);
  const spot = randomTreasureSpot(user);
  return createItem(api, world, {
    itemId: 0x14EB,
    name: `Tattered Treasure Map (level ${level})`,
    tagId: 'treasure-map',
    parent: pack.serial,
    x: 44,
    y: 44,
    z: 0,
    map: 0,
    weight: 1,
    treasureMap: {
      level,
      x: spot.x | 0,
      y: spot.y | 0,
      map: spot.map | 0,
      decoded: false,
      completed: false,
    },
    servuoClass: 'TreasureMap',
    servuoClasses: ['TreasureMap'],
  });
}

function createTranscendenceScrollReward(api, world, pack) {
  const skill = RESOURCE_ADDON_SKILLS[(Math.random() * RESOURCE_ADDON_SKILLS.length) | 0];
  return createItem(api, world, {
    itemId: 0x14F0,
    name: `Scroll of Transcendence (${skill} +0.1)`,
    tagId: 'scroll-of-transcendence',
    parent: pack.serial,
    x: 44,
    y: 44,
    z: 0,
    map: 0,
    hue: 0x0490,
    weight: 1,
    powerScroll: { skill, value: 0.1, transcendence: true },
    servuoClass: 'ScrollOfTranscendence',
    servuoClasses: ['ScrollOfTranscendence', 'SpecialScroll', 'IAccountRestricted'],
  });
}

function createHeavyPowderReward(api, world, pack) {
  return createItem(api, world, {
    itemId: 0x4224,
    name: 'Heavy Powder Charge',
    tagId: 'heavy-powder-charge',
    parent: pack.serial,
    x: 44,
    y: 44,
    z: 0,
    map: 0,
    hue: 0x07EF,
    weight: 1,
    stackable: true,
    amount: 1,
    kind: 'resource',
    servuoClass: 'HeavyPowderCharge',
    servuoClasses: ['HeavyPowderCharge', 'ICommodity'],
  });
}

const RESOURCE_ADDON_CONFIG = Object.freeze({
  'rose-rug': {
    kind: 'rose-rug',
    servuoClass: 'RoseRugAddon',
    classes: ['RoseRugAddon', 'RoseRugAddonDeed', 'InternalAddonComponent', 'RugType', 'RewardOptionGump', 'IRewardItem', 'IRewardOption'],
    labelNumber: 1150121,
    countLabelNumber: 1150102,
    max: 10,
    rechargeAmount: 1,
    emptyMessage: 'There are no seeds available.',
    successMessage: 'Seeds have been placed in your backpack.',
    reward: createSeedReward,
  },
  'skull-rug': {
    kind: 'skull-rug',
    servuoClass: 'SkullRugAddon',
    classes: ['SkullRugAddon', 'SkullRugAddonDeed', 'InternalAddonComponent', 'RugType', 'RewardOptionGump', 'IRewardItem', 'IRewardOption'],
    labelNumber: 1150120,
    countLabelNumber: 1150101,
    max: 10,
    rechargeAmount: 1,
    emptyMessage: 'There are no treasure maps available.',
    successMessage: 'A treasure map has been placed in your backpack.',
    reward: createTreasureMapReward,
  },
  'fire-painting': {
    kind: 'fire-painting',
    servuoClass: 'FirePaintingAddon',
    componentClass: 'FirePaintingComponent',
    classes: ['FirePaintingAddon', 'FirePaintingComponent', 'FirePaintingDeed', 'AddonOptionGump', 'DirectionType', 'IRewardOption'],
    labelNumber: 1098378,
    countLabelNumber: 1154179,
    max: 140,
    rechargeAmount: 1,
    emptyMessage: 'There are no Scrolls of Transcendence available.',
    successMessage: 'Scrolls of Transcendence have been placed in your backpack.',
    reward: createTranscendenceScrollReward,
  },
  'ship-painting': {
    kind: 'ship-painting',
    servuoClass: 'ShipPaintingAddon',
    componentClass: 'ShipPaintingComponent',
    classes: ['ShipPaintingAddon', 'ShipPaintingComponent', 'ShipPaintingDeed', 'AddonOptionGump', 'DirectionType', 'IRewardOption'],
    labelNumber: 1098378,
    countLabelNumber: 1154175,
    max: 210,
    rechargeAmount: 42,
    emptyMessage: 'There are no powder charges available.',
    successMessage: 'Powder charges have been placed in your backpack.',
    reward: createHeavyPowderReward,
  },
});

function ensureResourceAddonState(item, cfg, now = Date.now()) {
  const max = cfg.max | 0;
  item.addonResourceKind ??= cfg.kind;
  item.addonResourceCount = Math.max(0, Math.min(max, item.addonResourceCount ?? item.resourceCount ?? 0));
  item.addonResourceMax ??= max;
  item.addonResourceRechargeAmount ??= cfg.rechargeAmount | 0;
  item.addonNextResourceAt ??= now + RESOURCE_ADDON_RECHARGE_MS;
  item.addonResourceLabelNumber ??= cfg.countLabelNumber;
  item.labelNumber ??= cfg.labelNumber;
  item.forceShowProperties = true;
  item.movable = false;
  item.servuoClass ??= cfg.componentClass ?? cfg.servuoClass;
  addServuoClasses(item, cfg.classes);
}

function resourceAddonStateItem(world, item, cfg) {
  const anchor = item?._addonAnchor;
  if (!anchor) return item;
  let fallback = item;
  for (const piece of allItems({ world })) {
    const a = piece._addonAnchor;
    if (!a || a.x !== anchor.x || a.y !== anchor.y || a.z !== anchor.z) continue;
    if (piece._addon !== item._addon) continue;
    if (piece.addonResourceState && piece.addonResourceKind === cfg.kind) return piece;
    if (!fallback || (piece.serial >>> 0) < (fallback.serial >>> 0)) fallback = piece;
  }
  return fallback ?? item;
}

function rechargeResourceAddon(item, cfg, now = Date.now()) {
  ensureResourceAddonState(item, cfg, now);
  if ((item.addonNextResourceAt ?? 0) > now) return false;
  item.addonResourceCount = Math.min(
    item.addonResourceMax ?? cfg.max,
    (item.addonResourceCount | 0) + (item.addonResourceRechargeAmount ?? cfg.rechargeAmount | 0),
  );
  item.addonNextResourceAt = now + RESOURCE_ADDON_RECHARGE_MS;
  return true;
}

function buildResourceAddon(api, cfg) {
  return {
    name: cfg.kind,
    hasTick: true,
    onCreate(_world, item) {
      ensureResourceAddonState(item, cfg);
    },
    onUse(world, item, user) {
      if (!user) return false;
      const state = resourceAddonStateItem(world, item, cfg);
      ensureResourceAddonState(state, cfg);
      rechargeResourceAddon(state, cfg);
      if (!inRange(item, user, 3)) {
        user.client?.sendSystemMessage?.("I can't reach that.");
        return true;
      }
      if (!canUseHouseResource(api, item, user)) {
        user.client?.sendSystemMessage?.('You must be in your house to do this.');
        return true;
      }
      if ((state.addonResourceCount | 0) <= 0) {
        user.client?.sendSystemMessage?.(cfg.emptyMessage);
        return true;
      }
      const pack = findBackpack({ ...api, world }, user);
      if (!pack) {
        user.client?.sendSystemMessage?.('Your backpack is full! Please make room and try again.');
        return true;
      }
      cfg.reward(api, world, pack, user);
      state.addonResourceCount = Math.max(0, (state.addonResourceCount | 0) - 1);
      state.addonNextResourceAt = Date.now() + RESOURCE_ADDON_RECHARGE_MS;
      user.client?.sendSystemMessage?.(cfg.successMessage);
      return true;
    },
    onTick(_world, item) {
      if (item._addonAnchor && !item.addonResourceState) return;
      rechargeResourceAddon(item, cfg);
    },
  };
}

export function buildRoseRug(api) {
  return buildResourceAddon(api, RESOURCE_ADDON_CONFIG['rose-rug']);
}

export function buildSkullRug(api) {
  return buildResourceAddon(api, RESOURCE_ADDON_CONFIG['skull-rug']);
}

export function buildFirePainting(api) {
  return buildResourceAddon(api, RESOURCE_ADDON_CONFIG['fire-painting']);
}

export function buildShipPainting(api) {
  return buildResourceAddon(api, RESOURCE_ADDON_CONFIG['ship-painting']);
}

const MINING_CART_RECHARGE_MS = 24 * 60 * 60 * 1000;
const MINING_CART_INGOTS = Object.freeze([
  { servuoClass: 'IronIngot', name: 'Iron Ingots', tagId: 'ingot-iron', hue: 0 },
  { servuoClass: 'DullCopperIngot', name: 'Dull Copper Ingots', tagId: 'ingot-dullcopper', hue: 0x0973 },
  { servuoClass: 'ShadowIronIngot', name: 'Shadow Iron Ingots', tagId: 'ingot-shadow', hue: 0x0966 },
  { servuoClass: 'CopperIngot', name: 'Copper Ingots', tagId: 'ingot-copper', hue: 0x096D },
  { servuoClass: 'BronzeIngot', name: 'Bronze Ingots', tagId: 'ingot-bronze', hue: 0x0972 },
  { servuoClass: 'GoldIngot', name: 'Gold Ingots', tagId: 'ingot-gold', hue: 0x08A5 },
  { servuoClass: 'AgapiteIngot', name: 'Agapite Ingots', tagId: 'ingot-agapite', hue: 0x0979 },
  { servuoClass: 'VeriteIngot', name: 'Verite Ingots', tagId: 'ingot-verite', hue: 0x089F },
  { servuoClass: 'ValoriteIngot', name: 'Valorite Ingots', tagId: 'ingot-valorite', hue: 0x08AB },
]);
const MINING_CART_GEMS = Object.freeze([
  { servuoClass: 'Amber', name: 'Amber', itemId: 0x0F25 },
  { servuoClass: 'Amethyst', name: 'Amethyst', itemId: 0x0F16 },
  { servuoClass: 'Citrine', name: 'Citrine', itemId: 0x0F15 },
  { servuoClass: 'Diamond', name: 'Diamond', itemId: 0x0F26 },
  { servuoClass: 'Emerald', name: 'Emerald', itemId: 0x0F10 },
  { servuoClass: 'Ruby', name: 'Ruby', itemId: 0x0F13 },
  { servuoClass: 'Sapphire', name: 'Sapphire', itemId: 0x0F19 },
  { servuoClass: 'StarSapphire', name: 'Star Sapphire', itemId: 0x0F21 },
  { servuoClass: 'Tourmaline', name: 'Tourmaline', itemId: 0x0F2D },
  { servuoClass: 'PerfectEmerald', name: 'Perfect Emerald', itemId: 0x3194 },
  { servuoClass: 'DarkSapphire', name: 'Dark Sapphire', itemId: 0x3192 },
  { servuoClass: 'Turquoise', name: 'Turquoise', itemId: 0x3193 },
  { servuoClass: 'EcruCitrine', name: 'Ecru Citrine', itemId: 0x3195 },
  { servuoClass: 'FireRuby', name: 'Fire Ruby', itemId: 0x3197 },
  { servuoClass: 'BlueDiamond', name: 'Blue Diamond', itemId: 0x3198 },
]);

function normalizeMiningCartType(value, itemId = 0) {
  if (typeof value === 'string' && value) return value;
  const id = itemId | 0;
  if (id === 0x1A88 || id === 0x1A87 || id === 0x1A8B) return 'OreEast';
  if (id === 0x0F2E || id === 0x0F12 || id === 0x0F24) return 'GemEast';
  return 'OreSouth';
}

function isMiningCartGem(type) {
  return /^Gem/i.test(String(type ?? ''));
}

function ensureMiningCartState(item, now = Date.now()) {
  const type = normalizeMiningCartType(item.miningCartType, item.itemId);
  item.miningCartType = type;
  item.movable = false;
  item.labelNumber ??= isMiningCartGem(type) ? 1080388 : 1026786;
  item.miningCartNextResourceAt ??= now + MINING_CART_RECHARGE_MS;
  if (isMiningCartGem(type)) item.miningCartGems = Math.max(0, Math.min(50, item.miningCartGems ?? 0));
  else item.miningCartOre = Math.max(0, Math.min(100, item.miningCartOre ?? 0));
  item.servuoClass ??= 'MiningCart';
  addServuoClasses(item, [
    'MiningCart',
    'MiningCartType',
    'MiningCartDeed',
    'InternalAddonComponent',
    'IRewardItem',
    'IRewardOption',
  ]);
}

function miningCartStateItem(world, item) {
  const anchor = item?._addonAnchor;
  if (!anchor) return item;
  let fallback = item;
  for (const piece of allItems({ world })) {
    const a = piece._addonAnchor;
    if (!a || a.x !== anchor.x || a.y !== anchor.y || a.z !== anchor.z) continue;
    if (piece._addon !== item._addon) continue;
    if (piece.miningCartState) return piece;
    if (!fallback || (piece.serial >>> 0) < (fallback.serial >>> 0)) fallback = piece;
  }
  return fallback ?? item;
}

function canUseHouseFriendResource(api, item, user) {
  if (!api.houses?.houseAt) return true;
  const house = houseAt(api, item.x, item.y, item.map);
  if (!house) return false;
  const role = houseRole(api, house, user);
  return role === 'owner' || role === 'coowner' || role === 'friend' || role === 'tenant';
}

function rechargeMiningCart(item, now = Date.now()) {
  ensureMiningCartState(item, now);
  if ((item.miningCartNextResourceAt ?? 0) > now) return false;
  if (isMiningCartGem(item.miningCartType)) item.miningCartGems = Math.min(50, (item.miningCartGems | 0) + 5);
  else item.miningCartOre = Math.min(100, (item.miningCartOre | 0) + 10);
  item.miningCartNextResourceAt = now + MINING_CART_RECHARGE_MS;
  return true;
}

export function buildMiningCart(api) {
  return {
    name: 'mining-cart',
    hasTick: true,
    onCreate(_world, item) {
      ensureMiningCartState(item);
    },
    onUse(world, item, user) {
      if (!user) return false;
      const state = miningCartStateItem(world, item);
      ensureMiningCartState(state);
      rechargeMiningCart(state);
      if (!inRange(item, user, 2)) {
        user.client?.sendSystemMessage?.("I can't reach that.");
        return true;
      }
      if (!canUseHouseFriendResource(api, item, user)) {
        user.client?.sendSystemMessage?.('You are not allowed to access this.');
        return true;
      }
      const pack = findBackpack({ ...api, world }, user);
      if (!pack) {
        user.client?.sendSystemMessage?.('Your backpack is full! Please make room and try again.');
        return true;
      }
      if (isMiningCartGem(state.miningCartType)) {
        if ((state.miningCartGems | 0) <= 0) {
          user.client?.sendSystemMessage?.('There are no more resources available at this time.');
          return true;
        }
        const amount = Math.min(5, state.miningCartGems | 0);
        const gem = MINING_CART_GEMS[(Math.random() * MINING_CART_GEMS.length) | 0];
        createItem(api, world, {
          itemId: gem.itemId,
          name: gem.name,
          tagId: `gem-${gem.name.toLowerCase().replace(/\s+/g, '-')}`,
          amount,
          stackable: true,
          parent: pack.serial,
          x: 44,
          y: 44,
          z: 0,
          map: 0,
          kind: 'resource',
          resource: 'gem',
          servuoClass: gem.servuoClass,
          servuoClasses: [gem.servuoClass],
        });
        state.miningCartGems = Math.max(0, (state.miningCartGems | 0) - amount);
        user.client?.sendSystemMessage?.(`Gems: ${amount}`);
        return true;
      }
      if ((state.miningCartOre | 0) <= 0) {
        user.client?.sendSystemMessage?.('There are no more resources available at this time.');
        return true;
      }
      const amount = Math.min(10, state.miningCartOre | 0);
      const ingot = MINING_CART_INGOTS[(Math.random() * MINING_CART_INGOTS.length) | 0];
      createItem(api, world, {
        itemId: 0x1BF2,
        name: ingot.name,
        tagId: ingot.tagId,
        hue: ingot.hue,
        amount,
        stackable: true,
        parent: pack.serial,
        x: 44,
        y: 44,
        z: 0,
        map: 0,
        kind: 'resource',
        resource: 'ingot',
        servuoClass: ingot.servuoClass,
        servuoClasses: [ingot.servuoClass],
      });
      state.miningCartOre = Math.max(0, (state.miningCartOre | 0) - amount);
      user.client?.sendSystemMessage?.(`Ore: ${amount}`);
      return true;
    },
    onTick(_world, item) {
      if (item._addonAnchor && !item.miningCartState) return;
      rechargeMiningCart(item);
    },
  };
}

const SHEEP_STATUE_RECHARGE_MS = 24 * 60 * 60 * 1000;
const SHEEP_STATUE_RESOURCES = Object.freeze([
  { itemId: 0x0EE3, name: 'Wool', tagId: 'wool', servuoClass: 'Wool' },
  { itemId: 0x1078, name: 'Leather', tagId: 'leather', servuoClass: 'Leather' },
  { itemId: 0x1078, name: 'Spined Leather', tagId: 'leather-spined', servuoClass: 'SpinedLeather', hue: 0x08AC },
  { itemId: 0x1078, name: 'Horned Leather', tagId: 'leather-horned', servuoClass: 'HornedLeather', hue: 0x0845 },
  { itemId: 0x1078, name: 'Barbed Leather', tagId: 'leather-barbed', servuoClass: 'BarbedLeather', hue: 0x0851 },
]);

function ensureSheepStatueState(item, now = Date.now()) {
  item.sheepResourceCount = Math.max(0, Math.min(100, item.sheepResourceCount ?? 0));
  item.sheepNextResourceAt ??= now + SHEEP_STATUE_RECHARGE_MS;
  item.itemId = item.sheepResourceCount > 0 ? 0x4A94 : 0x4A95;
  item.movable = false;
  item.forceShowProperties = true;
  item.servuoClass ??= 'SheepStatue';
  addServuoClasses(item, ['SheepStatue', 'SheepStatueDeed', 'InternalAddonComponent', 'IRewardItem']);
}

function rechargeSheepStatue(item, now = Date.now()) {
  ensureSheepStatueState(item, now);
  if ((item.sheepNextResourceAt ?? 0) > now) return false;
  item.sheepResourceCount = Math.min(100, (item.sheepResourceCount | 0) + 10);
  item.sheepNextResourceAt = now + SHEEP_STATUE_RECHARGE_MS;
  item.itemId = item.sheepResourceCount > 0 ? 0x4A94 : 0x4A95;
  return true;
}

export function buildSheepStatue(api) {
  return {
    name: 'sheep-statue',
    hasTick: true,
    onCreate(_world, item) {
      ensureSheepStatueState(item);
    },
    onUse(world, item, user) {
      if (!user) return false;
      ensureSheepStatueState(item);
      rechargeSheepStatue(item);
      if (!inRange(item, user, 2)) {
        user.client?.sendSystemMessage?.("I can't reach that.");
        return true;
      }
      if (!canUseHouseFriendResource(api, item, user)) {
        user.client?.sendSystemMessage?.('You are not allowed to access this.');
        return true;
      }
      if ((item.sheepResourceCount | 0) <= 0) {
        user.client?.sendSystemMessage?.('There are no more resources available at this time.');
        return true;
      }
      const pack = findBackpack({ ...api, world }, user);
      if (!pack) {
        user.client?.sendSystemMessage?.('Your backpack is full! Please make room and try again.');
        return true;
      }
      const amount = Math.min(10, item.sheepResourceCount | 0);
      const res = SHEEP_STATUE_RESOURCES[(Math.random() * SHEEP_STATUE_RESOURCES.length) | 0];
      createItem(api, world, {
        itemId: res.itemId,
        name: res.name,
        tagId: res.tagId,
        hue: res.hue ?? 0,
        amount,
        stackable: true,
        parent: pack.serial,
        x: 44,
        y: 44,
        z: 0,
        map: 0,
        kind: 'resource',
        servuoClass: res.servuoClass,
        servuoClasses: [res.servuoClass],
      });
      item.sheepResourceCount = Math.max(0, (item.sheepResourceCount | 0) - amount);
      item.itemId = item.sheepResourceCount > 0 ? 0x4A94 : 0x4A95;
      user.client?.sendSystemMessage?.(`Resources: ${item.sheepResourceCount | 0}`);
      return true;
    },
    onTick(_world, item) {
      rechargeSheepStatue(item);
    },
  };
}

function ensureHarpsichordState(item) {
  item.harpsichordSongs = [...new Set((item.harpsichordSongs ?? item.musicTracks ?? [])
    .map((id) => id | 0)
    .filter((id) => id > 0))];
  item.movable = false;
  item.servuoClass ??= 'HarpsichordAddon';
  addServuoClasses(item, [
    'HarpsichordAddon',
    'HarpsichordAddonDeed',
    'HarpsichordSongGump',
    'HarpsichordColor',
    'DirectionType',
    'AddonOptionGump',
    'IRewardOption',
  ]);
}

function harpsichordStateItem(world, item) {
  const anchor = item?._addonAnchor;
  if (!anchor) return item;
  let fallback = item;
  for (const piece of allItems({ world })) {
    const a = piece._addonAnchor;
    if (!a || a.x !== anchor.x || a.y !== anchor.y || a.z !== anchor.z) continue;
    if (piece._addon !== item._addon) continue;
    if (piece.harpsichordState) return piece;
    if (!fallback || (piece.serial >>> 0) < (fallback.serial >>> 0)) fallback = piece;
  }
  return fallback ?? item;
}

function sendMusic(api, client, musicId) {
  try {
    const pkt = api.protocol?.playMusic?.(musicId | 0);
    if (pkt) client?.send?.(pkt);
  } catch { /* optional protocol */ }
}

function openHarpsichordGump(api, world, item, user) {
  const state = user?.client;
  if (!state) return;
  const songs = [...new Set((item.harpsichordSongs ?? []).map((id) => id | 0).filter((id) => id > 0))];
  if (!api.gumps?.send) {
    state.sendSystemMessage?.(songs.length ? `Harpsichord songs: ${songs.join(', ')}` : 'The harpsichord has no song rolls installed.');
    return;
  }
  const rows = songs.slice(0, 14);
  const layout = [
    '{ resizepic 0 0 5054 270 370 }',
    '{ text 16 12 1153 0 }',
  ];
  const texts = ['Harpsichord'];
  rows.forEach((song, i) => {
    const y = 42 + i * 20;
    layout.push(`{ button 16 ${y} 4005 4007 1 0 ${100 + song} }`);
    texts.push(`Song ${song}`);
    layout.push(`{ text 50 ${y - 2} 1149 ${texts.length - 1} }`);
  });
  layout.push('{ button 16 340 4017 4018 1 0 1 }');
  texts.push('Stop Song');
  layout.push(`{ text 50 340 1153 ${texts.length - 1} }`);
  api.gumps.send(state, { gumpId: 0x4BA10, x: 100, y: 100, layout: layout.join(' '), texts }, (resp) => {
    const button = resp?.buttonId | 0;
    if (button === 1) {
      sendMusic(api, state, 0x1FFF);
      state.sendSystemMessage?.('The song stops.');
    } else if (button >= 100) {
      const song = button - 100;
      sendMusic(api, state, song);
      state.sendSystemMessage?.(`The harpsichord plays song ${song}.`);
    }
  });
}

export function buildHarpsichord(api) {
  return {
    name: 'harpsichord',
    onCreate(_world, item) {
      ensureHarpsichordState(item);
    },
    onUse(world, item, user) {
      if (!user) return false;
      const state = harpsichordStateItem(world, item);
      ensureHarpsichordState(state);
      if (!inRange(item, user, 3)) {
        user.client?.sendSystemMessage?.("I can't reach that.");
        return true;
      }
      if (!canUseHouseFriendResource(api, item, user)) {
        user.client?.sendSystemMessage?.('You must be in your house to do this.');
        return true;
      }
      openHarpsichordGump(api, world, state, user);
      return true;
    },
  };
}

export function buildHarpsichordRoll(api) {
  return {
    name: 'harpsichord-roll',
    onCreate(_world, item) {
      item.itemId ||= 0x4BA1;
      item.labelNumber ??= 1098233;
      item.harpsichordRollMusic ??= 88 + ((Math.random() * 15) | 0);
      item.servuoClass ??= 'HarpsichordRoll';
      addServuoClasses(item, ['HarpsichordRoll', 'InternalTarget']);
    },
    onUse(world, item, user) {
      if (!user?.client) return true;
      if (!isInPack({ ...api, world }, item, user)) {
        user.client.sendSystemMessage?.('This item must be in your backpack.');
        return true;
      }
      if (!api.targeting?.request) {
        user.client.sendSystemMessage?.('Targeting unavailable.');
        return true;
      }
      user.client.sendSystemMessage?.('Which Harpsichord do you wish to use this on?');
      api.targeting.request(user.client, (picked) => {
        const target = targetItem(api, world, picked);
        const classes = [target?.servuoClass, ...(target?.servuoClasses ?? [])].filter(Boolean);
        if (!target || (target.script !== 'harpsichord' && !classes.includes('HarpsichordAddon'))) {
          user.client?.sendSystemMessage?.('Use this on an Harpsichord.');
          return;
        }
        const harp = harpsichordStateItem(world, target);
        ensureHarpsichordState(harp);
        const song = item.harpsichordRollMusic | 0;
        if (harp.harpsichordSongs.includes(song)) {
          user.client?.sendSystemMessage?.('The Harpsichord already has this song.');
          return;
        }
        harp.harpsichordSongs.push(song);
        destroyItemBySerial({ ...api, world }, item.serial);
        user.client?.sendSystemMessage?.('You carefully feed the roll into the Harpsichord.');
      }, { range: 2 });
      return true;
    },
  };
}

function consumeWheat(world, backpack) {
  if (!backpack) return false;
  for (const item of allItems({ world })) {
    if ((item.parent >>> 0) !== (backpack.serial >>> 0)) continue;
    if ((item.itemId | 0) !== 0x1EBD && item.tagId !== 'crop-wheat' && item.name !== 'Wheat') continue;
    if ((item.amount ?? 1) > 1) item.amount = (item.amount | 0) - 1;
    else destroyItemBySerial({ world }, item.serial);
    return true;
  }
  return false;
}

export function buildFlourMill(api) {
  return {
    name: 'flour-mill',
    onUse(world, item, user) {
      if (!user) return false;
      const anchor = item._addonAnchor;
      if (!anchor) return true;
      if (item._flourMillBusy) {
        user.client?.sendSystemMessage?.('The mill is already grinding.');
        return true;
      }
      const pack = backpackOf(world, user);
      if (!consumeWheat(world, pack)) {
        user.client?.sendSystemMessage?.('You need wheat to make a sack of flour.');
        return true;
      }
      item._flourMillBusy = true;
      setFlourMillStage(api, world, anchor, 2);
      user.client?.sendSystemMessage?.('You start grinding the wheat.');
      const finish = () => {
        item._flourMillBusy = false;
        setFlourMillStage(api, world, anchor, 0);
        const targetPack = backpackOf(world, user);
        createItem(api, world, {
          itemId: 0x1EF0,
          name: 'Sack of Flour',
          parent: targetPack?.serial,
          x: targetPack ? 0 : user.x,
          y: targetPack ? 0 : user.y,
          z: targetPack ? 0 : user.z,
          map: user.map ?? 1,
          weight: 1,
        });
        user.client?.sendSystemMessage?.('You grind the wheat into a sack of flour.');
      };
      const timer = api.lifecycle?.setTimeout?.(finish, 5000) ?? setTimeout(finish, 5000);
      timer?.unref?.();
      return true;
    },
  };
}

export function buildWoodStove(api) {
  return {
    name: 'wood-stove',
    onUse(world, item, user) {
      if (!user) return false;
      const anchor = item._addonAnchor;
      const pieces = anchor
        ? [...allItems({ world })].filter((piece) => {
            const a = piece._addonAnchor;
            return a && a.x === anchor.x && a.y === anchor.y && a.z === anchor.z && piece._addon === item._addon;
          })
        : [item];
      for (const piece of pieces) {
        if (piece.itemId === 0xA2A4 || piece.itemId === 0xA2A8) piece.itemId++;
        else if (piece.itemId === 0xA2A5 || piece.itemId === 0xA2A9) piece.itemId--;
        else continue;
        broadcastItemUpdate(api, world, piece);
      }
      const pkt = api.protocol?.playSound?.({ soundId: 958, x: item.x, y: item.y, z: item.z });
      if (pkt) user.client?.send?.(pkt);
      user.client?.sendSystemMessage?.('You adjust the wood stove.');
      return true;
    },
  };
}

export function buildHauntedMirror(api) {
  function open(world, item) {
    if (item.itemId === 0x2A7B || item.itemId === 0x2A7D) {
      item.itemId++;
      broadcastItemUpdate(api, world, item);
    }
  }
  function close(world, item) {
    if (item.itemId === 0x2A7C || item.itemId === 0x2A7E) {
      item.itemId--;
      broadcastItemUpdate(api, world, item);
    }
  }
  return {
    name: 'haunted-mirror',
    onWalkOn(world, item, mob) {
      if (!mob?.hidden) open(world, item);
      return true;
    },
    onWalkOff(world, item) {
      close(world, item);
      return true;
    },
    onUse(world, item) {
      open(world, item);
      return true;
    },
  };
}

export function buildTreeStump(api) {
  return {
    name: 'tree-stump',
    onCreate(_world, item) {
      item._logs ??= 100;
      item._nextResourceCount ??= Date.now() + 24 * 60 * 60 * 1000;
    },
    onUse(world, item, user) {
      if (!user) return false;
      const now = Date.now();
      if ((item._nextResourceCount ?? 0) <= now) {
        item._logs = Math.min(100, (item._logs | 0) + 10);
        item._nextResourceCount = now + 24 * 60 * 60 * 1000;
      }
      if ((item._logs | 0) <= 0) {
        user.client?.sendSystemMessage?.('There are no more logs available.');
        return true;
      }
      const amount = Math.min(10, item._logs | 0);
      const pack = backpackOf(world, user);
      createItem(api, world, {
        itemId: 0x1BDD,
        name: 'Logs',
        amount,
        parent: pack?.serial,
        x: pack ? 0 : user.x,
        y: pack ? 0 : user.y,
        z: pack ? 0 : user.z,
        map: user.map ?? 1,
        weight: amount,
      });
      item._logs = (item._logs | 0) - amount;
      user.client?.sendSystemMessage?.(`Logs: ${item._logs | 0}`);
      return true;
    },
  };
}

export function buildHagStew(api) {
  return {
    name: 'hag-stew',
    onCreate(_world, item) {
      item.visible = item.visible ?? true;
    },
    onUse(world, item, user) {
      if (!user) return false;
      const now = Date.now();
      if ((item._stewHiddenUntil ?? 0) > now) {
        user.client?.sendSystemMessage?.('The stew pot is empty for the moment.');
        return true;
      }
      item.visible = false;
      item._stewHiddenUntil = now + 30_000;
      user.stam = Math.min(user.stamMax ?? 50, (user.stam ?? 0) + 10);
      api.statusEffects?.apply?.(user, { name: 'sated', durationMs: 60_000 });
      user.client?.sendSystemMessage?.('You eat from the hag stew.');
      broadcastItemUpdate(api, world, item);
      const restore = () => {
        item.visible = true;
        item._stewHiddenUntil = 0;
        broadcastItemUpdate(api, world, item);
      };
      const timer = api.lifecycle?.setTimeout?.(restore, 30_000) ?? setTimeout(restore, 30_000);
      timer?.unref?.();
      return true;
    },
  };
}

export function buildSolenAntHole(api) {
  return {
    name: 'solen-ant-hole',
    onUse(world, item, user) {
      if (!user) return false;
      const dx = Math.abs((user.x ?? 0) - (item.x ?? 0));
      const dy = Math.abs((user.y ?? 0) - (item.y ?? 0));
      if (Math.max(dx, dy) > 2) {
        user.client?.sendSystemMessage?.('I cannot reach that.');
        return true;
      }
      user.x = 5922;
      user.y = 2024;
      user.z = 0;
      user.map = item.map ?? user.map ?? 1;
      user.client?.sendSystemMessage?.('You dive into the hole and disappear.');
      try { api.protocol?.teleport?.(user.client, user); } catch { /* optional */ }
      return true;
    },
    onWalkOn(world, item, mob) {
      if (!mob?.client || mob.hidden) return false;
      if ((item._nextSolenSpawnAt ?? 0) > Date.now()) return false;
      item._nextSolenSpawnAt = Date.now() + 30_000;
      const kind = item.map === 0 ? 'red-solen-worker' : 'black-solen-worker';
      try {
        createMobile(api, world, {
          name: kind.replace(/-/g, ' '),
          kind,
          body: 0x30D,
          x: item.x + 1,
          y: item.y,
          z: item.z,
          map: item.map ?? 1,
          aiBehavior: 'aggressive',
          homeX: item.x,
          homeY: item.y,
          homeZ: item.z,
          homeRange: 10,
        });
      } catch { /* optional */ }
      return true;
    },
  };
}
