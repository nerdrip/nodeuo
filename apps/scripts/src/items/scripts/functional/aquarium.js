import { createItem, destroyItemBySerial } from '../../../_items.js';
import { childrenOf, findBackpack, findInPack, isInPack } from '../../../_inventory.js';
import { moveItem } from '../../../_movement.js';
import { allItems } from '../../../_spatial.js';
import { normalizeSkillValue } from '../../../_rules.js';
// Aquarium — ServUO `Items/Addons/Aquarium/`.
//
// Placeable house addon. The state tracks:
//   • `fish`: array of { kind, name, hue, addedAt }
//   • `food` (0..6 charges) and `water` (0..6 charges)
//   • `decoration` (0..6 — coral, stones, etc.)
//   • `state`: 'empty'|'healthy'|'overdue'|'dead'
//   • `lastTickedAt`
//
// Daily tick (driven externally via spawner sweep — see aquarium.tick
// helper) consumes 1 food + 1 water per fish. If either runs out the
// state flips to overdue; after a second daily tick of neglect the fish
// die and the state becomes 'dead' until cleaned by double-click while
// holding decorative stones.
//
// Double-click without supplies → status report. Drop fish food onto
// the tank → +1 food/water charge. Drop a "fish" item (we register a
// `decorative-fish` kind for now) → adds it to the school (cap 8).
//
// The aquarium is house-bound: only owner / co-owners can refill / harvest.

const MAX_CHARGES = 6;
const MAX_FISH = 30;
const SKILL_FISHING = 19;

const FISH_BREEDS = [
  'minoc-blue', 'albino-courtesan', 'nujhelm-honey', 'serpents-tail',
  'cu-sidhe-sphynx', 'corgul-clown', 'royal-flounder', 'arctic-mackerel',
];

const NET_FISH = [
  { tagId: 'minoc-blue-fish', name: 'Minoc Blue Fish', itemId: 0x3AFE, servuoClass: 'MinocBlueFish' },
  { tagId: 'shrimp', name: 'Shrimp', itemId: 0x3B14, servuoClass: 'Shrimp' },
  { tagId: 'fandancer-fish', name: 'Fandancer Fish', itemId: 0x3B02, servuoClass: 'FandancerFish' },
  { tagId: 'golden-broadtail', name: 'Golden Broadtail', itemId: 0x3B03, servuoClass: 'GoldenBroadtail' },
  { tagId: 'red-dart-fish', name: 'Red Dart Fish', itemId: 0x3B00, servuoClass: 'RedDartFish' },
  { tagId: 'albino-courtesan-fish', name: 'Albino Courtesan Fish', itemId: 0x3B04, servuoClass: 'AlbinoCourtesanFish' },
  { tagId: 'nujelm-honey-fish', name: 'Nujelm Honey Fish', itemId: 0x3B06, servuoClass: 'NujelmHoneyFish' },
  { tagId: 'jellyfish', name: 'Jellyfish', itemId: 0x3B0E, servuoClass: 'Jellyfish' },
  { tagId: 'speckled-crab', name: 'Speckled Crab', itemId: 0x3AFC, servuoClass: 'SpeckledCrab' },
  { tagId: 'long-claw-crab', name: 'Long Claw Crab', itemId: 0x3AFC, servuoClass: 'LongClawCrab' },
  { tagId: 'albino-frog', name: 'Albino Frog', itemId: 0x3B0D, servuoClass: 'AlbinoFrog' },
  { tagId: 'killer-frog', name: 'Killer Frog', itemId: 0x3B0D, servuoClass: 'KillerFrog' },
  { tagId: 'vesper-reef-tiger', name: 'Vesper Reef Tiger', itemId: 0x3B08, servuoClass: 'VesperReefTiger' },
  { tagId: 'purple-frog', name: 'Purple Frog', itemId: 0x3B0D, servuoClass: 'PurpleFrog' },
  { tagId: 'britain-crown-fish', name: 'Britain Crown Fish', itemId: 0x3AFF, servuoClass: 'BritainCrownFish' },
  { tagId: 'yellow-fin-bluebelly', name: 'Yellow Fin Bluebelly', itemId: 0x3B07, servuoClass: 'YellowFinBluebelly' },
  { tagId: 'spotted-buccaneer', name: 'Spotted Buccaneer', itemId: 0x3B09, servuoClass: 'SpottedBuccaneer' },
  { tagId: 'spined-scratcher-fish', name: 'Spined Scratcher Fish', itemId: 0x3B05, servuoClass: 'SpinedScratcherFish' },
  { tagId: 'small-mouth-sucker-fin', name: 'Small Mouth Sucker Fin', itemId: 0x3B01, servuoClass: 'SmallMouthSuckerFin' },
];

const AQUARIUM_BIRTH_FISH = [
  { tagId: 'brine-shrimp', name: 'Brine Shrimp', itemId: 0x3B11, servuoClass: 'BrineShrimp', event: 'Brine shrimp have hatched overnight in the tank.' },
  { tagId: 'coral', name: 'Coral', itemId: 0x3AF9, itemIds: [0x3AF9, 0x3AFA, 0x3AFB], servuoClass: 'Coral', event: 'A new creature has hatched overnight in the tank.' },
  { tagId: 'full-moon-fish', name: 'Full Moon Fish', itemId: 0x3B15, servuoClass: 'FullMoonFish', event: 'A new creature has hatched overnight in the tank.' },
  { tagId: 'sea-horse-fish', name: 'Sea Horse', itemId: 0x3B10, servuoClass: 'SeaHorseFish', event: 'A sea horse has hatched overnight in the tank.' },
  { tagId: 'stripped-flake-fish', name: 'Stripped Flake Fish', itemId: 0x3B0A, servuoClass: 'StrippedFlakeFish', event: 'A new creature has hatched overnight in the tank.' },
  { tagId: 'stripped-sosarian-swill', name: 'Stripped Sosarian Swill', itemId: 0x3B0A, servuoClass: 'StrippedSosarianSwill', event: 'A new creature has hatched overnight in the tank.' },
];

const AQUARIUM_REWARDS = [
  { tagId: 'aquarium-fish-bones', name: 'Fish Bones', itemId: 0x3B0C, servuoClass: 'FishBones' },
  { tagId: 'aquarium-waterlogged-boots', name: 'Waterlogged Boots', itemId: 0x1711, servuoClass: 'WaterloggedBoots', clothing: true, equipLayer: 3, slot: 'shoes' },
  { tagId: 'captain-blackhearts-fishing-pole', name: "Captain Blackheart's Fishing Pole", itemId: 0x0DC0, servuoClass: 'CaptainBlackheartsFishingPole', labelNumber: 1074571, kind: 'tool', script: 'fishing-pole' },
  { tagId: 'craftys-fishing-hat', name: "Crafty's Fishing Hat", itemId: 0x1713, servuoClass: 'CraftysFishingHat', clothing: true, equipLayer: 6, slot: 'hat' },
  { tagId: 'aquarium-fishing-net', name: 'Aquarium Fishing Net', itemId: 0x0DC8, servuoClass: 'AquariumFishNet', servuoClasses: ['AquariumFishNet', 'AquariumFishingNet', 'SpecialFishingNet'], labelNumber: 1074463, script: 'aquarium-fishing-net', kind: 'fishing-net' },
  { tagId: 'aquarium-message', name: 'Message in a Bottle', itemId: 0x099F, servuoClass: 'AquariumMessage', labelNumber: 1073894 },
  { tagId: 'aquarium-island-statue', name: 'Island Statue', itemId: 0x3B0F, servuoClass: 'IslandStatue' },
  { tagId: 'aquarium-shell', name: 'A Shell', itemId: 0x3B12, itemIds: [0x3B12, 0x3B13], servuoClass: 'Shell', labelNumber: 1074598 },
  { tagId: 'aquarium-toy-boat', name: 'Toy Boat', itemId: 0x14F4, servuoClass: 'ToyBoat' },
];

const AQUARIUM_ACTION_CLASSES = [
  'AquariumState',
  'AquariumGump',
  'ExamineEntry',
  'CollectRewardEntry',
  'ViewEventEntry',
  'CancelVacationMode',
  'GMAddFood',
  'GMAddWater',
  'GMForceEvaluate',
  'GMOpen',
  'GMFill',
];

function aquariumState(item) {
  item.aquarium ??= {
    fish: [], food: 0, water: 0, decoration: 0,
    state: 'empty', lastTickedAt: Date.now(),
    servuoClass: 'AquariumState',
  };
  const aq = item.aquarium;
  aq.fish ??= [];
  aq.food ??= 0;
  aq.water ??= 0;
  aq.decoration ??= 0;
  aq.state ??= aq.fish.length ? 'healthy' : 'empty';
  aq.lastTickedAt ??= Date.now();
  aq.events ??= [];
  aq.rewardAvailable ??= false;
  aq.evaluateDay ??= false;
  aq.vacationLeft ??= 0;
  aq.servuoClass ??= 'AquariumState';
  item.servuoClass ??= 'Aquarium';
  item.servuoClasses = [...new Set([
    ...(item.servuoClasses ?? []),
    'Aquarium',
    ...AQUARIUM_ACTION_CLASSES,
  ])];
  return item.aquarium;
}

function isAquariumFish(item) {
  return item?.kind === 'decorative-fish'
      || item?.kind === 'aquarium-fish'
      || item?.servuoBaseClass === 'BaseFish'
      || item?.aquariumFish === true;
}

function isAquariumDecoration(item) {
  const cls = item?.servuoClass;
  return item?.kind === 'aquarium-decoration'
      || item?.aquariumDecoration === true
      || AQUARIUM_REWARDS.some((def) => def.servuoClass === cls || def.tagId === item?.tagId);
}

function randomFrom(values) {
  return values[(Math.random() * values.length) | 0] ?? values[0];
}

function packDrop() {
  return {
    x: 44 + ((Math.random() * 72) | 0),
    y: 44 + ((Math.random() * 72) | 0),
    z: 0,
    map: 0,
  };
}

function fishSummary(item) {
  const breed = item?.breed
    ?? item?.fishKind
    ?? item?.tagId
    ?? FISH_BREEDS[Math.floor(Math.random() * FISH_BREEDS.length)];
  return {
    kind: breed,
    name: item?.label ?? item?.name ?? breed,
    hue: item?.hue ?? 0,
    itemId: item?.itemId ?? 0,
    addedAt: Date.now(),
  };
}

function fishingSkill(user) {
  return normalizeSkillValue(user?.skills?.[SKILL_FISHING] ?? user?.skills?.[String(SKILL_FISHING)] ?? 0);
}

function pickNetFish(user) {
  const skill = fishingSkill(user);
  if (skill <= 0) return NET_FISH[0];
  const max = Math.min(NET_FISH.length, Math.max(1, Math.floor(skill / 5)));
  if ((skill / 100) < Math.random()) return NET_FISH[0];
  return NET_FISH[(Math.random() * max) | 0] ?? NET_FISH[0];
}

function addFishToAquarium(aq, fish) {
  if (aq.fish.length >= MAX_FISH) return false;
  aq.fish.push(fishSummary(fish));
  if (aq.state === 'empty') aq.state = aq.food > 0 ? 'healthy' : 'overdue';
  return true;
}

function createAquariumFish(api, world, def, where = {}) {
  return createItem(api, world, {
    itemId: def.itemIds ? randomFrom(def.itemIds) : def.itemId,
    tagId: def.tagId,
    name: def.name,
    kind: 'aquarium-fish',
    aquariumFish: true,
    fishKind: def.tagId,
    servuoClass: def.servuoClass,
    servuoBaseClass: 'BaseFish',
    ...where,
  });
}

function createAquariumReward(api, world, def, where = {}) {
  return createItem(api, world, {
    itemId: def.itemIds ? randomFrom(def.itemIds) : def.itemId,
    tagId: def.tagId,
    name: def.name,
    kind: def.kind ?? 'aquarium-decoration',
    aquariumDecoration: true,
    weight: 1,
    movable: true,
    servuoClass: def.servuoClass,
    servuoClasses: [...new Set([def.servuoClass, ...(def.servuoClasses ?? [])].filter(Boolean))],
    labelNumber: def.labelNumber,
    clothing: def.clothing,
    equipLayer: def.equipLayer,
    slot: def.slot,
    script: def.script,
    ...where,
  });
}

function firstFishInBowl(api, bowl) {
  for (const it of childrenOf(api, bowl)) {
    if (isAquariumFish(it)) return it;
  }
  return null;
}

function emptyFishBowl(api, user) {
  return findInPack(api, user, (it) => (
    (it?.script === 'fish-bowl' || it?.servuoClass === 'FishBowl')
    && !firstFishInBowl(api, it)
  ));
}

function returnHeldToPack(api, item, user) {
  if (!item || !user) return;
  const pack = findBackpack(api, user);
  if (pack) {
    moveItem(api, item, {
      parent: pack.serial,
      x: 44 + ((Math.random() * 72) | 0),
      y: 44 + ((Math.random() * 72) | 0),
      z: 0,
      map: 0,
    });
  } else {
    moveItem(api, item, {
      parent: null,
      x: user.x, y: user.y, z: user.z, map: user.map ?? 1,
    });
  }
}

function removeFishToPack(api, world, source, user, index = 0) {
  const pack = findBackpack(api, user);
  if (!pack) {
    user?.client?.sendSystemMessage?.('There is no room in your pack for the creature.');
    return false;
  }
  if (source?.script === 'fish-bowl') {
    const fish = firstFishInBowl(api, source);
    if (!fish) {
      user?.client?.sendSystemMessage?.('The fish bowl is empty.');
      return false;
    }
    moveItem(api, fish, {
      parent: pack.serial,
      x: 44 + ((Math.random() * 72) | 0),
      y: 44 + ((Math.random() * 72) | 0),
      z: 0,
      map: 0,
    });
    user?.client?.sendSystemMessage?.('The creature has been removed from the fish bowl.');
    return true;
  }
  const aq = aquariumState(source);
  const rec = aq.fish[index | 0];
  if (!rec) return false;
  aq.fish.splice(index | 0, 1);
  if (aq.fish.length === 0) aq.state = 'empty';
  const bowl = emptyFishBowl(api, user);
  createItem(api, world, {
    itemId: rec.itemId || 0x3B0A,
    name: rec.name ?? 'aquarium fish',
    kind: 'aquarium-fish',
    aquariumFish: true,
    breed: rec.kind,
    fishKind: rec.kind,
    hue: rec.hue ?? 0,
    parent: bowl?.serial ?? pack.serial,
    ...(bowl ? { x: 44, y: 44, z: 0, map: 0 } : packDrop()),
  });
  user?.client?.sendSystemMessage?.(bowl
    ? 'You put the creature into a fish bowl.'
    : 'You put the gasping creature into your pack.');
  return true;
}

function fmtStatus(aq) {
  return `Aquarium — ${aq.fish.length}/${MAX_FISH} fish, ${aq.food}/${MAX_CHARGES} food, ${aq.water}/${MAX_CHARGES} water (${aq.state}).`;
}

function addAquariumEvent(aq, text) {
  aq.events ??= [];
  aq.events.push(text);
  if (aq.events.length > 12) aq.events.splice(0, aq.events.length - 12);
}

function effectiveAquariumState(aq) {
  if (aq.fish.length === 0) return 'empty';
  if (aq.food >= Math.min(aq.fish.length, MAX_CHARGES) && aq.water >= Math.min(aq.fish.length, MAX_CHARGES)) return 'healthy';
  if (aq.food > 0 && aq.water > 0) return 'healthy';
  return aq.state === 'dead' ? 'dead' : 'overdue';
}

function evaluateAquarium(api, world, item, forced = false) {
  const aq = aquariumState(item);
  if ((aq.vacationLeft | 0) > 0 && !forced) {
    aq.vacationLeft = Math.max(0, (aq.vacationLeft | 0) - 1);
    return { evaluated: false, vacation: true };
  }
  aq.events = [];
  const previous = aq.state;
  const need = Math.max(1, Math.min(MAX_CHARGES, Math.ceil(aq.fish.length / 5)));
  if (aq.fish.length === 0) {
    aq.state = 'empty';
    aq.food = Math.max(0, aq.food - 1);
    aq.water = Math.max(0, aq.water - 1);
  } else if (aq.food >= need && aq.water >= need) {
    aq.food = Math.max(0, aq.food - need);
    aq.water = Math.max(0, aq.water - need);
    aq.state = 'healthy';
    if (previous !== 'healthy') addAquariumEvent(aq, 'The tank looks healthier today.');
    if (aq.fish.length < MAX_FISH && Math.random() < Math.max(0.005 * aq.fish.length, forced ? 0.2 : 0)) {
      const born = randomFrom(AQUARIUM_BIRTH_FISH);
      const fish = createAquariumFish(api, world, born, { x: item.x, y: item.y, z: item.z, map: item.map ?? 1 });
      if (fish && addFishToAquarium(aq, fish)) {
        destroyItemBySerial(api, fish.serial);
        addAquariumEvent(aq, born.event);
      }
    }
  } else if (previous === 'overdue') {
    const losses = Math.min(aq.fish.length, 1 + ((Math.random() * 2) | 0));
    aq.fish.splice(0, losses);
    aq.state = aq.fish.length ? 'overdue' : 'dead';
    addAquariumEvent(aq, 'An unfortunate accident has left a creature floating upside-down. It is starting to smell.');
  } else {
    aq.state = 'overdue';
    addAquariumEvent(aq, aq.food < need ? 'The tank looks worse than it did yesterday.' : 'This tank can use more water.');
  }
  if (aq.fish.length > 0) aq.rewardAvailable = true;
  aq.lastTickedAt = Date.now();
  aq.evaluateDay = !aq.evaluateDay;
  return { evaluated: true, state: aq.state };
}

function giveAquariumReward(api, world, item, user) {
  const aq = aquariumState(item);
  if (!aq.rewardAvailable) {
    user?.client?.sendSystemMessage?.('No aquarium reward is available.');
    return false;
  }
  const pack = findBackpack(api, user);
  if (!pack) {
    user?.client?.sendSystemMessage?.('The reward could not be given. Make sure you have room in your pack.');
    return false;
  }
  const max = Math.max(1, Math.ceil((aq.fish.length / MAX_FISH) * AQUARIUM_REWARDS.length));
  const def = AQUARIUM_REWARDS[Math.min(AQUARIUM_REWARDS.length - 1, (Math.random() * max) | 0)] ?? AQUARIUM_REWARDS[0];
  const reward = createAquariumReward(api, world, def, { parent: pack.serial, ...packDrop() });
  if (!reward) {
    user?.client?.sendSystemMessage?.('The reward could not be given. Make sure you have room in your pack.');
    return false;
  }
  aq.rewardAvailable = false;
  user?.client?.sendSystemMessage?.(`You receive a reward: ${def.name}.`);
  return true;
}

function viewAquariumEvents(item, user) {
  const aq = aquariumState(item);
  if (!aq.events?.length) {
    user?.client?.sendSystemMessage?.('There are no aquarium events to view.');
    return false;
  }
  for (const evt of aq.events) user?.client?.sendSystemMessage?.(evt);
  return true;
}

function cancelVacationMode(item, user) {
  const aq = aquariumState(item);
  if ((aq.vacationLeft | 0) <= 0) {
    user?.client?.sendSystemMessage?.('The aquarium is not in vacation mode.');
    return false;
  }
  aq.vacationLeft = 0;
  user?.client?.sendSystemMessage?.('Vacation mode has been cancelled.');
  return true;
}

function openAquariumGump(api, world, item, user, edit = false) {
  const state = user?.client;
  if (!state || !api.gumps?.send) {
    const aq = aquariumState(item);
    state?.sendSystemMessage?.(fmtStatus(aq));
    return;
  }
  const aq = aquariumState(item);
  const rows = Math.max(1, Math.min(12, aq.fish.length));
  const h = 194 + rows * 24 + (edit ? 102 : 0);
  const layout = [
    `{ resizepic 0 0 5054 430 ${h} }`,
    `{ text 20 14 1153 0 }`,
    `{ text 20 40 1149 1 }`,
    `{ text 20 62 1149 2 }`,
    `{ button 22 84 4017 4018 1 0 2 }`,
    `{ text 58 86 1153 3 }`,
    `{ button 176 84 4017 4018 1 0 3 }`,
    `{ text 212 86 1153 4 }`,
  ];
  const texts = [
    'Aquarium',
    `${aq.fish.length}/${MAX_FISH} creatures, food ${aq.food}/${MAX_CHARGES}, water ${aq.water}/${MAX_CHARGES}`,
    `State: ${effectiveAquariumState(aq)}${aq.vacationLeft ? `, vacation ${aq.vacationLeft} day(s)` : ''}`,
    'Collect reward',
    'View events',
  ];
  let y = 118;
  if (aq.fish.length === 0) {
    texts.push('(empty)');
    layout.push(`{ text 32 ${y} 1149 ${texts.length - 1} }`);
    y += 24;
  } else {
    aq.fish.slice(0, 12).forEach((fish, i) => {
      if (edit) layout.push(`{ button 22 ${y} 4017 4018 1 0 ${100 + i} }`);
      texts.push(fish.name ?? fish.kind ?? 'creature');
      layout.push(`{ text ${edit ? 58 : 32} ${y + 2} 1149 ${texts.length - 1} }`);
      y += 24;
    });
  }
  if (aq.vacationLeft > 0) {
    layout.push(`{ button 22 ${y + 4} 4023 4024 1 0 4 }`);
    texts.push('Cancel vacation mode');
    layout.push(`{ text 58 ${y + 6} 1153 ${texts.length - 1} }`);
    y += 34;
  }
  if (edit) {
    const gmRows = [
      [1, 'GM fill food/water'],
      [5, 'GM add food'],
      [6, 'GM add water'],
      [7, 'GM force evaluate'],
    ];
    for (const [button, text] of gmRows) {
      layout.push(`{ button 22 ${y + 4} 4023 4024 1 0 ${button} }`);
      texts.push(text);
      layout.push(`{ text 58 ${y + 6} 1153 ${texts.length - 1} }`);
      y += 24;
    }
  }
  api.gumps.send(state, { gumpId: 0xA9000101, x: 100, y: 100, layout: layout.join(''), texts }, (resp) => {
    const b = resp?.buttonId | 0;
    if (b === 1 && edit) {
      aq.food = MAX_CHARGES;
      aq.water = MAX_CHARGES;
      if (aq.fish.length > 0) aq.state = 'healthy';
      state.sendSystemMessage?.('Aquarium food and water have been filled.');
      openAquariumGump(api, world, item, user, edit);
      return;
    }
    if (b === 2) {
      giveAquariumReward(api, world, item, user);
      openAquariumGump(api, world, item, user, edit);
      return;
    }
    if (b === 3) {
      viewAquariumEvents(item, user);
      return;
    }
    if (b === 4) {
      cancelVacationMode(item, user);
      openAquariumGump(api, world, item, user, edit);
      return;
    }
    if (b === 5 && edit) {
      aq.food = Math.min(MAX_CHARGES, aq.food + 1);
      state.sendSystemMessage?.('Aquarium food has been increased.');
      openAquariumGump(api, world, item, user, edit);
      return;
    }
    if (b === 6 && edit) {
      aq.water = Math.min(MAX_CHARGES, aq.water + 1);
      state.sendSystemMessage?.('Aquarium water has been increased.');
      openAquariumGump(api, world, item, user, edit);
      return;
    }
    if (b === 7 && edit) {
      evaluateAquarium(api, world, item, true);
      state.sendSystemMessage?.('Aquarium has been evaluated.');
      openAquariumGump(api, world, item, user, edit);
      return;
    }
    if (b >= 100 && edit) {
      removeFishToPack(api, world, item, user, b - 100);
      openAquariumGump(api, world, item, user, edit);
    }
  });
}

export default function buildAquarium(api) {
  return {
    name: 'aquarium',
    onCreate(_world, item) {
      aquariumState(item);
      item.movable = false;
      item._aquarium = true;
    },
    onUse(world, item, user) {
      if (!user?.client) return true;
      const aq = aquariumState(item);
      const edit = (user.accessLevel | 0) > 0 || user.isAdmin === true;
      if (api.gumps?.send) {
        openAquariumGump(api, world, item, user, edit);
        return true;
      }
      user.client.sendSystemMessage?.(fmtStatus(aq));
      if (aq.fish.length > 0) {
        user.client.sendSystemMessage?.('Fish in the tank:');
        for (const f of aq.fish) {
          user.client.sendSystemMessage?.(`  - ${f.name ?? f.kind}`);
        }
      }
      user.client.sendSystemMessage?.('Drop fish food on the tank to feed; drop a fish to add it.');
      if (aq.rewardAvailable) user.client.sendSystemMessage?.('An aquarium reward is available.');
      if (aq.events?.length) viewAquariumEvents(item, user);
      return true;
    },
    // Drop handler — accepts fish-food items (`kind === 'aquarium-food'`)
    // and decorative fish items (`kind === 'decorative-fish'`).
    onDrop(world, tank, dropped, dropper) {
      if (!dropped) return false;
      const aq = aquariumState(tank);
      if (dropped.script === 'fish-bowl' || dropped.servuoClass === 'FishBowl') {
        const fish = firstFishInBowl(api, dropped);
        if (!fish) {
          dropper?.client?.sendSystemMessage?.('The fish bowl is empty.');
          return { handled: true, consumeHeld: false };
        }
        if (!addFishToAquarium(aq, fish)) {
          dropper?.client?.sendSystemMessage?.('The tank is full.');
          return { handled: true, consumeHeld: false };
        }
        try { destroyItemBySerial(api, fish.serial); } catch { /* */ }
        returnHeldToPack(api, dropped, dropper);
        dropper?.client?.sendSystemMessage?.(`You put the creature into the aquarium (${aq.fish.length}/${MAX_FISH}).`);
        return { handled: true, consumeHeld: false };
      }
      if (dropped.kind === 'aquarium-food') {
        aq.food = Math.min(MAX_CHARGES, aq.food + (dropped.amount ?? 1));
        try { destroyItemBySerial(api, dropped.serial); } catch { /* */ }
        dropper?.client?.sendSystemMessage?.(`Aquarium fed (food ${aq.food}).`);
        if (aq.state === 'overdue' && aq.food > 0 && aq.water > 0) aq.state = 'healthy';
        return true;
      }
      if (dropped.kind === 'water' || dropped.content === 'water' || dropped.beverageType === 'water') {
        aq.water = Math.min(MAX_CHARGES, aq.water + 1);
        dropper?.client?.sendSystemMessage?.(`Aquarium water increased (${aq.water}).`);
        if (aq.state === 'overdue' && aq.food > 0 && aq.water > 0) aq.state = 'healthy';
        return true;
      }
      if (dropped.kind === 'aquarium-vacation-wafer') {
        aq.vacationLeft = Math.max(aq.vacationLeft | 0, 7);
        try { destroyItemBySerial(api, dropped.serial); } catch { /* */ }
        dropper?.client?.sendSystemMessage?.(`The aquarium will be in vacation mode for ${aq.vacationLeft} day(s).`);
        return true;
      }
      if (isAquariumFish(dropped)) {
        if (aq.fish.length >= MAX_FISH) {
          dropper?.client?.sendSystemMessage?.('The tank is full.');
          return false;
        }
        const breed = dropped.breed ?? dropped.fishKind
          ?? FISH_BREEDS[Math.floor(Math.random() * FISH_BREEDS.length)];
        addFishToAquarium(aq, dropped);
        try { destroyItemBySerial(api, dropped.serial); } catch { /* */ }
        dropper?.client?.sendSystemMessage?.(`Added a ${breed} (${aq.fish.length}/${MAX_FISH}).`);
        return true;
      }
      if (isAquariumDecoration(dropped)) {
        if (aq.decoration >= MAX_CHARGES) {
          dropper?.client?.sendSystemMessage?.('The aquarium cannot hold more decoration.');
          return false;
        }
        aq.decoration++;
        try { destroyItemBySerial(api, dropped.serial); } catch { /* */ }
        dropper?.client?.sendSystemMessage?.('You add the decoration to the aquarium.');
        return true;
      }
      return false;
    },
  };
}

export function buildFishBowl(api) {
  return {
    name: 'fish-bowl',
    onCreate(_world, item) {
      item.container = true;
      item.gumpId ||= 0x003D;
      item.capacity = 1;
      item.maxWeight = 10;
      item.hue ||= 0x47E;
      item.labelNumber ??= 1074499;
      item.servuoClass ??= 'FishBowl';
      item.servuoClasses = [...new Set([...(item.servuoClasses ?? []), 'FishBowl', 'RemoveCreature'])];
    },
    onUse(world, item, user) {
      if (!user?.client) return true;
      const fish = firstFishInBowl(api, item);
      if (!fish) {
        user.client.sendSystemMessage?.('The fish bowl is empty.');
        return true;
      }
      if (!api.gumps?.send) {
        user.client.sendSystemMessage?.(`Fish bowl contains: ${fish.name ?? 'a creature'}.`);
        user.client.sendSystemMessage?.('Use [fishbowl remove after targeting the bowl.');
        return true;
      }
      const layout = [
        '{ resizepic 0 0 5054 300 140 }',
        '{ text 20 14 1153 0 }',
        '{ text 20 46 1149 1 }',
        '{ button 24 92 4023 4024 1 0 1 }',
        '{ text 62 94 1153 2 }',
      ].join('');
      const texts = ['Fish Bowl', `Contains: ${fish.name ?? 'a creature'}`, 'Remove creature'];
      api.gumps.send(user.client, { gumpId: 0xA9000102, x: 120, y: 110, layout, texts }, (resp) => {
        if ((resp?.buttonId | 0) === 1) removeFishToPack(api, world, item, user, 0);
      });
      return true;
    },
    onDrop(_world, bowl, dropped, dropper) {
      if (!dropped) return false;
      if (!isAquariumFish(dropped)) {
        dropper?.client?.sendSystemMessage?.('The container can not hold that type of object.');
        return { handled: true, consumeHeld: false };
      }
      if (firstFishInBowl(api, bowl)) {
        dropper?.client?.sendSystemMessage?.('The fish bowl already contains a creature.');
        return { handled: true, consumeHeld: false };
      }
      moveItem(api, dropped, { parent: bowl.serial, x: 44, y: 44, z: 0, map: 0 });
      dropper?.client?.sendSystemMessage?.('You put the creature into the fish bowl.');
      return true;
    },
  };
}

export function buildAquariumFishingNet(api) {
  return {
    name: 'aquarium-fishing-net',
    onCreate(_world, item) {
      item.itemId ||= 0x0DC8;
      item.labelNumber ??= 1074463;
      item.servuoClass ??= 'AquariumFishingNet';
      item.servuoClasses ??= ['AquariumFishingNet', 'AquariumFishNet', 'SpecialFishingNet'];
    },
    onUse(world, item, user) {
      if (!user?.client) return false;
      if (!isInPack(api, item, user)) {
        user.client.sendSystemMessage?.('That must be in your pack for you to use it.');
        return true;
      }
      if (fishingSkill(user) < 10) {
        user.client.sendSystemMessage?.('The creatures are too quick for you!');
        return true;
      }
      const pack = findBackpack(api, user);
      if (!pack) {
        user.client.sendSystemMessage?.("You don't have enough room in your backpack!");
        return true;
      }
      const def = pickNetFish(user);
      const fish = createAquariumFish(api, world, def, {
        parent: pack.serial,
        ...packDrop(),
      });
      if (!fish) {
        user.client.sendSystemMessage?.('You could not hold the creature.');
        return true;
      }
      const bowl = emptyFishBowl(api, user);
      if (bowl) {
        moveItem(api, fish, { parent: bowl.serial, x: 44, y: 44, z: 0, map: 0 });
        user.client.sendSystemMessage?.('A live creature jumps into the fish bowl in your pack!');
      } else {
        fish.aquariumDead = true;
        fish.name = `${def.name} (out of water)`;
        user.client.sendSystemMessage?.('A live creature flops around in your pack before running out of air.');
      }
      api.skillGain?.tryGain?.(user, SKILL_FISHING, 10, 100);
      if ((item.amount ?? 1) > 1) item.amount = (item.amount | 0) - 1;
      else destroyItemBySerial(api, item.serial);
      return true;
    },
  };
}

/**
 * Daily-tick helper. Walks every aquarium-tagged item in the world and
 * runs the consume/decay loop. Returns the counts updated.
 *
 * Wire this from a hourly setInterval in main.js (or from the regen
 * sweep) once per real-day. Until then aquariums act as static decor.
 */
export function tickAquariums(world, now = Date.now()) {
  let ticked = 0, died = 0;
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  for (const item of allItems({ world })) {
    if (!item._aquarium) continue;
    const aq = item.aquarium;
    if (!aq) continue;
    if ((now - (aq.lastTickedAt ?? 0)) < ONE_DAY_MS) continue;
    ticked++;
    const before = aq.fish.length;
    evaluateAquarium({ world, items: { createItem } }, world, item);
    died += Math.max(0, before - aq.fish.length);
    aq.lastTickedAt = now;
  }
  return { ticked, died };
}
