// ServUO P1 multis parity: classic boats, house deeds, contest houses,
// customization aliases, dynamic decay helpers, and small missing timers.
//
// The heavy lifting stays in the existing Node-native systems:
//   - systems/boats.js owns sailing, anchors, damage and dry dock state
//   - commands/housing/placemulti.js owns multi stamping and ACL
//   - systems/housing/houses.js owns registry-based customization/decay
//
// This module stitches the ServUO-facing classes into those systems with
// functional commands/templates instead of mirroring the C# inheritance tree.

import { createItem, destroyItemBySerial } from '../_items.js';
import { itemBySerial, mobileBySerial } from '../_entities.js';
import { allItems, allMobiles, sendToClientsNear } from '../_spatial.js';
import { spawnNPC } from '../npcs/vendors/_spawn.js';

export const SERVUO_P1_MULTI_CLASSES = Object.freeze([
  'FixColumnTimer',
  'SetSecureLevelEntry',
  'TurnTimer',
  'MoveBoatHS',
  'UpdateAllTimer',
  'BoatCourse',
  'DryDockEntry',
  'LargeBoat',
  'LargeBoatDeed',
  'LargeDockedBoat',
  'MediumBoat',
  'MediumBoatDeed',
  'MediumDockedBoat',
  'PlanksContext',
  'SmallBoat',
  'SmallBoatDeed',
  'SmallDockedBoat',
  'EmergencyRepairEntry',
  'ShipRepairEntry',
  'Spreadsheet',
  'DataRecord',
  'GothicRoseCastle',
  'ElsaCastle',
  'Spires',
  'CastleOfOceania',
  'FeudalCastle',
  'TraditionalKeep',
  'DarkthornKeep',
  'CasaMoga',
  'Camelot',
  'LacrimaeInCaelo',
  'OkinawaSweetDreamCastle',
  'TwoStoryWoodPlasterHouseDeed',
  'TwoStoryStonePlasterHouseDeed',
  'DynamicDecay',
  'DecayStageInfo',
  'HouseFoundation',
  'BeginHouseCustomization',
  'EndHouseCustomization',
  'SendQueueEntry',
  'SmallOldHouse',
  'TwoStoryHouse',
  'LargePatioHouse',
  'LargeMarbleHouse',
  'TwoStoryVilla',
  'SmallShop',
  'NoHousingDelayTimer',
  'PreviewHouse',
]);

const BOAT_DEEDS = [
  {
    name: 'small-boat-deed',
    label: 'small ship deed',
    hullKind: 'small',
    classes: ['SmallBoatDeed', 'SmallBoat', 'SmallDockedBoat'],
  },
  {
    name: 'medium-boat-deed',
    label: 'medium ship deed',
    hullKind: 'medium',
    classes: ['MediumBoatDeed', 'MediumBoat', 'MediumDockedBoat'],
  },
  {
    name: 'large-boat-deed',
    label: 'large ship deed',
    hullKind: 'large',
    classes: ['LargeBoatDeed', 'LargeBoat', 'LargeDockedBoat'],
  },
];

const HOUSE_DEEDS = [
  {
    name: 'small-old-house-deed',
    label: 'deed to a small old house',
    multiId: 0x64,
    offset: { x: 0, y: 4, z: 0 },
    classes: ['SmallOldHouse'],
  },
  {
    name: 'two-story-wood-plaster-house-deed',
    label: 'deed to a two story wood and plaster house',
    multiId: 0x76,
    offset: { x: -3, y: 7, z: 0 },
    classes: ['TwoStoryWoodPlasterHouseDeed', 'TwoStoryHouse'],
  },
  {
    name: 'two-story-stone-plaster-house-deed',
    label: 'deed to a two story stone and plaster house',
    multiId: 0x78,
    offset: { x: -3, y: 7, z: 0 },
    classes: ['TwoStoryStonePlasterHouseDeed', 'TwoStoryHouse'],
  },
  {
    name: 'large-patio-house-deed',
    label: 'deed to a large house with patio',
    multiId: 0x8C,
    offset: { x: -4, y: 7, z: 0 },
    classes: ['LargePatioHouse'],
  },
  {
    name: 'large-marble-house-deed',
    label: 'deed to a large marble house',
    multiId: 0x96,
    offset: { x: -4, y: 7, z: 0 },
    classes: ['LargeMarbleHouse'],
  },
  {
    name: 'two-story-villa-deed',
    label: 'deed to a two story villa',
    multiId: 0x9E,
    offset: { x: 3, y: 6, z: 0 },
    classes: ['TwoStoryVilla'],
  },
  {
    name: 'stone-workshop-deed',
    label: 'deed to a small stone workshop',
    multiId: 0xA0,
    offset: { x: -1, y: 4, z: 0 },
    classes: ['SmallShop'],
  },
  {
    name: 'marble-workshop-deed',
    label: 'deed to a small marble workshop',
    multiId: 0xA2,
    offset: { x: -1, y: 4, z: 0 },
    classes: ['SmallShop'],
  },
];

const CONTEST_HOUSES = [
  ['gothic-rose-castle-deed', 'Gothic Rose Castle deed', 0x147F, 'GothicRoseCastle', 'castle'],
  ['elsa-castle-deed', 'Elsa Castle deed', 0x1480, 'ElsaCastle', 'castle'],
  ['spires-deed', 'Spires deed', 0x1481, 'Spires', 'castle'],
  ['castle-of-oceania-deed', 'Castle of Oceania deed', 0x1482, 'CastleOfOceania', 'castle'],
  ['feudal-castle-deed', 'Feudal Castle deed', 0x1483, 'FeudalCastle', 'castle'],
  ['traditional-keep-deed', 'Traditional Keep deed', 0x1485, 'TraditionalKeep', 'keep'],
  ['darkthorn-keep-deed', 'Darkthorn Keep deed', 0x1487, 'DarkthornKeep', 'keep'],
  ['casa-moga-deed', 'Casa Moga deed', 0x1489, 'CasaMoga', 'keep'],
  ['camelot-deed', 'Camelot deed', 0x148B, 'Camelot', 'castle'],
  ['lacrimae-in-caelo-deed', 'Lacrimae In Caelo deed', 0x148C, 'LacrimaeInCaelo', 'castle'],
  ['okinawa-sweet-dream-castle-deed', 'Okinawa Sweet Dream Castle deed', 0x148D, 'OkinawaSweetDreamCastle', 'castle'],
];

const SECURE_LEVELS = new Set(['owner', 'coowner', 'friend', 'anyone']);

function upsertTemplate(disposers, api, tmpl) {
  const templates = api.templates;
  if (!templates?.registerTemplate) return;
  const prev = templates.getTemplate?.(tmpl.name) ?? templates.get?.(tmpl.name);
  templates.registerTemplate(tmpl);
  disposers.push(() => {
    if (prev) templates.registerTemplate(prev);
    else templates.unregisterTemplate?.(tmpl.name);
  });
}

function mergeClasses(entity, classes) {
  if (!entity || !classes?.length) return entity;
  entity.servuoClasses = [...new Set([entity.servuoClass, ...(entity.servuoClasses ?? []), ...classes].filter(Boolean))];
  entity.servuoClass ??= entity.servuoClasses[0];
  return entity;
}

function registerTemplates(api, disposers) {
  for (const def of BOAT_DEEDS) {
    upsertTemplate(disposers, api, {
      name: def.name,
      label: def.label,
      itemId: 0x14F0,
      hue: 0x0481,
      weight: 1,
      movable: true,
      script: 'servuo-boat-deed',
      boatDeed: { hullKind: def.hullKind, name: def.label },
      servuoClass: def.classes[0],
      servuoClasses: def.classes,
      servuoPath: `templates/ServUO/Scripts/Multis/Boats/${titleCase(def.hullKind)}Boat.cs`,
    });
  }

  for (const def of HOUSE_DEEDS) {
    upsertTemplate(disposers, api, houseDeedTemplate(def));
  }

  for (const [name, label, multiId, cls, type] of CONTEST_HOUSES) {
    upsertTemplate(disposers, api, houseDeedTemplate({
      name,
      label,
      multiId,
      offset: { x: 0, y: 0, z: 0 },
      classes: [cls],
      contestHouse: { type, servuoClass: cls },
    }));
  }

  upsertTemplate(disposers, api, {
    name: 'preview-house',
    label: 'preview house marker',
    itemId: 0x14F0,
    hue: 0x04F2,
    weight: 1,
    movable: true,
    _previewHouse: true,
    servuoClass: 'PreviewHouse',
    servuoClasses: ['PreviewHouse'],
  });
}

function houseDeedTemplate(def) {
  return {
    name: def.name,
    label: def.label,
    itemId: 0x14F0,
    hue: 0x0481,
    weight: 1,
    movable: true,
    script: 'house-deed',
    _deedMulti: def.multiId,
    _deedOffset: def.offset,
    _contestHouse: def.contestHouse,
    servuoClass: def.classes[0],
    servuoClasses: def.classes,
    servuoPath: 'templates/ServUO/Scripts/Multis',
  };
}

function titleCase(value) {
  const text = String(value ?? '');
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function parseSerial(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return 0;
  return /^0x/i.test(text) ? parseInt(text.slice(2), 16) >>> 0 : parseInt(text, 10) >>> 0;
}

function currentBoat(api, mob, serialArg = null) {
  const serial = serialArg ? parseSerial(serialArg) : (mob?._boardedBoat >>> 0);
  let boat = serial ? itemBySerial(api, serial) : null;
  if (boat?.boat) return boat;
  for (const it of allItems(api, (x) => !!x.boat)) {
    if ((it.map ?? 1) !== (mob.map ?? 1)) continue;
    if (Math.max(Math.abs((it.x | 0) - (mob.x | 0)), Math.abs((it.y | 0) - (mob.y | 0))) <= 2) {
      boat = it;
      break;
    }
  }
  return boat?.boat ? boat : null;
}

function sendItem(api, item) {
  if (!item || !api.protocol?.worldItemSA) return;
  const pkt = api.protocol.worldItemSA({
    serial: item.serial,
    itemId: item.itemId,
    hue: item.hue ?? 0,
    amount: item.amount ?? 1,
    x: item.x, y: item.y, z: item.z,
  });
  sendToClientsNear(api, item, pkt, null, 18);
}

function makePlanks(api, boat) {
  const b = boat?.boat;
  if (!b) return 0;
  b.planks ??= [];
  if (b.planks.length > 0) return 0;
  const small = (b.hullKind ?? b.hull) === 'small';
  const slots = small
    ? [[0, -1, 'N'], [0, 1, 'S']]
    : [[0, -1, 'N'], [1, 0, 'E'], [0, 1, 'S'], [-1, 0, 'W']];
  let made = 0;
  for (const [dx, dy, side] of slots) {
    const plank = createItem(api, api.world, {
      itemId: 0x3EAA,
      x: boat.x + dx,
      y: boat.y + dy,
      z: boat.z,
      map: boat.map,
      name: 'a plank',
      movable: false,
      boatPlank: { boatSerial: boat.serial, side },
      servuoClasses: ['PlanksContext'],
    });
    if (!plank) continue;
    plank.boatPlank = { boatSerial: boat.serial, side };
    mergeClasses(plank, ['PlanksContext']);
    b.planks.push(plank.serial >>> 0);
    sendItem(api, plank);
    made++;
  }
  return made;
}

function ensureTillerman(api, boat, owner) {
  if (!boat?.boat || boat.boat.tillermanSerial) return null;
  try {
    const helm = {
      x: boat.x,
      y: boat.y - (boat.boat.hullKind === 'large' ? 5 : 4),
      z: boat.z,
      map: boat.map,
      direction: owner?.direction ?? 0,
    };
    const tiller = spawnNPC(api, helm, {
      name: 'a tillerman',
      body: 0x190,
      hue: 0x0481,
      notoriety: 7,
      invulnerable: true,
      keywords: ['forward', 'backward', 'stop', 'left', 'right', 'turn', 'anchor', 'dock', 'repair'],
      fields: {
        _tillerman: true,
        servuoClasses: ['EmergencyRepairEntry', 'ShipRepairEntry'],
      },
    });
    api.boats?.setTillerman?.(boat, tiller);
    return tiller;
  } catch (e) {
    api.log?.(`[servuo-multis] tillerman spawn failed: ${e.message}`);
    return null;
  }
}

function registerBoatScripts(api, disposers) {
  api.itemScripts?.register?.({
    name: 'servuo-boat-deed',
    onUse(world, item, user) {
      if (!item?.boatDeed) return false;
      const hullKind = String(item.boatDeed.hullKind ?? 'small').toLowerCase();
      let boat = null;
      try {
        boat = api.boats?.placeGalleon?.(api, {
          kind: api.boats?._HULLS?.[hullKind] ? hullKind : 'small',
          x: user.x,
          y: user.y,
          z: user.z,
          map: user.map,
          ownerSerial: user.serial >>> 0,
          name: item.boatDeed.name,
        });
      } catch (e) {
        user.client?.sendSystemMessage?.(`The ship could not be launched: ${e.message}`);
        return true;
      }
      if (!boat?.boat) return true;
      boat.boat.anchored = false;
      boat.boat.hullKind = hullKind;
      mergeClasses(boat, boatClassesFor(hullKind));
      makePlanks(api, boat);
      ensureTillerman(api, boat, user);
      const key = api.game?.mobile?.giveItem?.(user, {
        itemId: 0x1010,
        name: 'a boat key',
        hue: 0x044E,
        boatKey: boat.serial >>> 0,
      }, { randomGrid: true, requireBackpack: false });
      if (key) {
        key.boatKey = boat.serial >>> 0;
        boat.boat.keys ??= [];
        boat.boat.keys.push(key.serial >>> 0);
      }
      sendItem(api, boat);
      destroyItemBySerial({ world, items: api.items, ops: api.ops, game: api.game }, item.serial);
      user.client?.sendSystemMessage?.(`You launch ${item.boatDeed.name ?? 'a ship'}.`);
      return true;
    },
  });
  disposers.push(() => api.itemScripts?.unregister?.('servuo-boat-deed'));
}

function boatClassesFor(hullKind) {
  if (hullKind === 'large') return ['LargeBoat', 'LargeBoatDeed', 'LargeDockedBoat'];
  if (hullKind === 'medium') return ['MediumBoat', 'MediumBoatDeed', 'MediumDockedBoat'];
  return ['SmallBoat', 'SmallBoatDeed', 'SmallDockedBoat'];
}

function repairBoat(boat, mode) {
  const b = boat?.boat;
  if (!b) return { ok: false, reason: 'not-a-boat' };
  b.boatHpMax ??= 1000;
  b.boatHp ??= b.boatHpMax;
  const now = Date.now();
  if (mode === 'emergency') {
    if (b.nextEmergencyRepairAt && now < b.nextEmergencyRepairAt) {
      return { ok: false, reason: 'emergency repair is cooling down' };
    }
    b.boatHp = Math.min(b.boatHpMax, b.boatHp + Math.max(50, Math.floor(b.boatHpMax * 0.15)));
    b.nextEmergencyRepairAt = now + 5 * 60 * 1000;
    mergeClasses(boat, ['EmergencyRepairEntry']);
    return { ok: true, hp: b.boatHp, max: b.boatHpMax };
  }
  b.boatHp = b.boatHpMax;
  b.wrecked = false;
  mergeClasses(boat, ['ShipRepairEntry']);
  return { ok: true, hp: b.boatHp, max: b.boatHpMax };
}

function tickBoatCourses(api) {
  for (const boat of allItems(api, (it) => !!it.boat?.course?.running)) {
    const b = boat.boat;
    const course = b.course;
    const points = course.waypoints ?? [];
    if (!points.length) {
      course.running = false;
      b.sailState = 'stop';
      continue;
    }
    const target = points[course.index % points.length];
    if (!target) continue;
    if (b.wrecked || (target.map != null && target.map !== boat.map)) {
      course.running = false;
      b.sailState = 'stop';
      continue;
    }
    const now = Date.now();
    if (course.lastX !== (boat.x | 0) || course.lastY !== (boat.y | 0)) {
      course.lastX = boat.x | 0;
      course.lastY = boat.y | 0;
      course.lastProgressAt = now;
    } else if (now - (course.lastProgressAt ?? now) > 6000) {
      course.running = false;
      course.blocked = true;
      b.sailState = 'stop';
      for (const serial of b.riders ?? []) {
        mobileBySerial(api, serial)?.client?.sendSystemMessage?.('Autopilot stopped: the course is blocked.');
      }
      continue;
    }
    const dx = (target.x | 0) - (boat.x | 0);
    const dy = (target.y | 0) - (boat.y | 0);
    if (Math.abs(dx) <= 0 && Math.abs(dy) <= 0) {
      course.index++;
      if (course.index >= points.length && !course.loop) {
        course.running = false;
        b.sailState = 'stop';
      }
      if (course.loop && course.index >= points.length) course.index = 0;
      continue;
    }
    const horizontal = dx >= 0 ? 'E' : 'W';
    const vertical = dy >= 0 ? 'S' : 'N';
    const choices = Math.abs(dx) >= Math.abs(dy) ? [horizontal, vertical] : [vertical, horizontal];
    const deltas = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
    const facing = choices.find((candidate) => {
      const [sx, sy] = deltas[candidate];
      return api.boats?.canSailTo?.(boat, boat.x + sx, boat.y + sy, boat.map) !== false;
    }) ?? choices[0];
    if (api.boats?.setFacing) api.boats.setFacing(boat, facing);
    else b.facing = facing;
    b.anchored = false;
    b.sailState = course.speed ?? 'medium';
    course.blocked = false;
    mergeClasses(boat, ['BoatCourse', 'MoveBoatHS', 'UpdateAllTimer']);
  }
}

function configureBoatCourse(api, ctx, boat, inputArgs = []) {
  if (!boat?.boat) {
    ctx.state.sendSystemMessage?.('Stand on/near a boat or pass its serial.');
    return false;
  }
  if (api.boats?.hasPilotRights && !api.boats.hasPilotRights(boat, ctx.sender)) {
    ctx.state.sendSystemMessage?.('You lack the right to program this boat.');
    return false;
  }
  const args = [...inputArgs];
  const sub = String(args[0] ?? 'status').toLowerCase();
  boat.boat.course ??= { waypoints: [], index: 0, running: false, loop: false, speed: 'medium' };
  const c = boat.boat.course;
  mergeClasses(boat, ['BoatCourse', 'MoveBoatHS']);
  if (sub === 'add') {
    const useHere = String(args[1] ?? '').toLowerCase() === 'here';
    const x = useHere ? ctx.sender.x : parseInt(args[1], 10);
    const y = useHere ? ctx.sender.y : parseInt(args[2], 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      ctx.state.sendSystemMessage?.('Usage: [boat autopilot add <x> <y> (or: add here)');
      return false;
    }
    if (api.boats?.canSailTo?.(boat, x, y, boat.map) === false) {
      ctx.state.sendSystemMessage?.('That waypoint is not on navigable water.');
      return false;
    }
    c.waypoints.push({ x, y, map: boat.map ?? 1 });
    ctx.state.sendSystemMessage?.(`Course point added (${x},${y}). Points: ${c.waypoints.length}.`);
    return true;
  }
  if (sub === 'clear') {
    c.waypoints = [];
    c.index = 0;
    c.running = false;
    boat.boat.sailState = 'stop';
    ctx.state.sendSystemMessage?.('Boat course cleared.');
    return true;
  }
  if (sub === 'start') {
    const speed = String(args[1] ?? c.speed ?? 'medium').toLowerCase();
    if (!['slow', 'medium', 'full'].includes(speed)) {
      ctx.state.sendSystemMessage?.('Autopilot speed must be slow, medium or full.');
      return false;
    }
    c.index = Math.min(Math.max(0, c.index | 0), Math.max(0, c.waypoints.length - 1));
    c.running = c.waypoints.length > 0;
    c.speed = speed;
    c.lastX = boat.x | 0;
    c.lastY = boat.y | 0;
    c.lastProgressAt = Date.now();
    c.blocked = false;
    ctx.state.sendSystemMessage?.(c.running ? `Autopilot started at ${speed} speed.` : 'Add waypoints first.');
    return c.running;
  }
  if (sub === 'stop') {
    c.running = false;
    boat.boat.sailState = 'stop';
    ctx.state.sendSystemMessage?.('Autopilot stopped.');
    return true;
  }
  if (sub === 'loop') {
    const explicit = String(args[1] ?? '').toLowerCase();
    c.loop = explicit === 'on' ? true : explicit === 'off' ? false : !c.loop;
    ctx.state.sendSystemMessage?.(`Boat course loop: ${c.loop ? 'on' : 'off'}.`);
    return true;
  }
  const next = c.waypoints[c.index] ?? c.waypoints[0];
  ctx.state.sendSystemMessage?.(
    `Autopilot: ${c.waypoints.length} point(s), next=${next ? `${next.x},${next.y}` : 'none'}, `
    + `running=${!!c.running}, loop=${!!c.loop}, speed=${c.speed ?? 'medium'}${c.blocked ? ', BLOCKED' : ''}.`,
  );
  return true;
}

function registerCommands(api, disposers) {
  api.commands?.register?.({
    name: 'boatcourse',
    hidden: true,
    help: '[boatcourse [serial] add <x> <y>|clear|start|stop|loop|status',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      let args = [...ctx.args];
      let boat = currentBoat(api, mob, args[0]);
      if (boat) args = args.slice(parseSerial(args[0]) ? 1 : 0);
      else boat = currentBoat(api, mob);
      if (!boat?.boat) {
        ctx.state.sendSystemMessage?.('Stand on/near a boat or pass its serial.');
        return;
      }
      configureBoatCourse(api, ctx, boat, args);
    },
  });

  api.commands?.register?.({
    name: 'boatrepair',
    hidden: true,
    help: '[boatrepair [serial] emergency|ship',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      let args = [...ctx.args];
      let boat = currentBoat(api, mob, args[0]);
      if (boat) args = args.slice(parseSerial(args[0]) ? 1 : 0);
      else boat = currentBoat(api, mob);
      const mode = String(args[0] ?? 'ship').toLowerCase();
      const result = repairBoat(boat, mode === 'emergency' ? 'emergency' : 'ship');
      if (!result.ok) {
        ctx.state.sendSystemMessage?.(`Cannot repair: ${result.reason}.`);
        return;
      }
      ctx.state.sendSystemMessage?.(`Boat repaired: ${result.hp}/${result.max} hp.`);
    },
  });

  api.commands?.register?.({
    name: 'boatturn',
    hidden: true,
    help: '[boatturn [serial] left|right|around — delayed ServUO-style turn.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      let args = [...ctx.args];
      let boat = currentBoat(api, mob, args[0]);
      if (boat) args = args.slice(parseSerial(args[0]) ? 1 : 0);
      else boat = currentBoat(api, mob);
      if (!boat?.boat) {
        ctx.state.sendSystemMessage?.('No boat selected.');
        return;
      }
      const dir = String(args[0] ?? 'right').toLowerCase();
      mergeClasses(boat, ['TurnTimer']);
      const table = {
        left: { N: 'W', W: 'S', S: 'E', E: 'N' },
        right: { N: 'E', E: 'S', S: 'W', W: 'N' },
        around: { N: 'S', S: 'N', E: 'W', W: 'E' },
      }[dir] ?? { N: 'E', E: 'S', S: 'W', W: 'N' };
      api.lifecycle?.setTimeout?.(() => {
        if (boat.boat) api.boats?.setFacing?.(boat, table[boat.boat.facing] ?? 'N');
      }, 500) ?? setTimeout(() => {
        if (boat.boat) api.boats?.setFacing?.(boat, table[boat.boat.facing] ?? 'N');
      }, 500);
      ctx.state.sendSystemMessage?.(`Turn queued: ${dir}.`);
    },
  });

  api.commands?.register?.({
    name: 'securelevel',
    help: '[securelevel <owner|coowner|friend|anyone> [serial] — set secure container access.',
    access: 'Player',
    run(ctx) {
      const level = String(ctx.args[0] ?? '').toLowerCase();
      if (!SECURE_LEVELS.has(level)) {
        ctx.state.sendSystemMessage?.('Usage: [securelevel <owner|coowner|friend|anyone> [serial]');
        return;
      }
      const apply = (serial) => {
        const item = itemBySerial(api, serial >>> 0);
        if (!item) {
          ctx.state.sendSystemMessage?.('No item at that serial.');
          return;
        }
        item.secureLevel = level;
        mergeClasses(item, ['SetSecureLevelEntry']);
        ctx.state.sendSystemMessage?.(`Secure level set to ${level}.`);
      };
      const serial = parseSerial(ctx.args[1]);
      if (serial) {
        apply(serial);
        return;
      }
      ctx.state.sendSystemMessage?.('Target a secure container/item.');
      api.targeting?.request?.(ctx.state, (picked) => {
        if (picked?.serial) apply(picked.serial);
      }, { kind: 0 });
    },
  });

  api.commands?.register?.({
    name: 'housecustom',
    hidden: true,
    help: '[housecustom start|commit|revert|backup|restore|floor <n>|status',
    access: 'Player',
    run(ctx) {
      const HR = api.houses;
      const mob = ctx.sender;
      const house = HR?.houseAt?.(mob.x, mob.y, mob.map);
      if (!house) {
        ctx.state.sendSystemMessage?.('You are not inside a registry house.');
        return;
      }
      if (HR.roleOf?.(house, mob.serial) !== 'owner') {
        ctx.state.sendSystemMessage?.('Only the owner can customize this house.');
        return;
      }
      const sub = String(ctx.args[0] ?? 'status').toLowerCase();
      house.servuoClasses = [...new Set([...(house.servuoClasses ?? []), 'BeginHouseCustomization', 'EndHouseCustomization', 'SendQueueEntry'])];
      const ok = {
        start: () => HR.beginEditing?.(house, mob),
        commit: () => HR.commitCustom?.(house),
        revert: () => HR.revertCustom?.(house),
        backup: () => HR.backupCustom?.(house),
        restore: () => HR.restoreCustom?.(house),
        floor: () => HR.setEditingFloor?.(house, parseInt(ctx.args[1] ?? '0', 10) | 0),
      }[sub]?.();
      if (sub === 'status') {
        ctx.state.sendSystemMessage?.(`House custom: editing=${!!house.editing}, tiles=${house.tiles?.length ?? 0}, revision=${house.revision ?? 0}.`);
        return;
      }
      ctx.state.sendSystemMessage?.(ok ? `House customization ${sub} ok.` : `House customization ${sub} failed.`);
    },
  });

  api.commands?.register?.({
    name: 'previewhouse',
    hidden: true,
    help: '[previewhouse <multiId|template> — send a client multi preview cursor.',
    access: 'Player',
    run(ctx) {
      const arg = String(ctx.args[0] ?? '').toLowerCase();
      const def = HOUSE_DEEDS.find((d) => d.name === arg)
        ?? CONTEST_HOUSES.map(([name, label, multiId, cls]) => ({ name, label, multiId, classes: [cls] })).find((d) => d.name === arg);
      const multiId = def?.multiId ?? parseSerial(arg);
      if (!multiId || !api.protocol?.multiPlacementRequest) {
        ctx.state.sendSystemMessage?.('Usage: [previewhouse <multiId|template>');
        return;
      }
      ctx.sender._previewHouse = { multiId, servuoClass: 'PreviewHouse', at: Date.now() };
      const cursorId = ((ctx.state._nextTargetId = (ctx.state._nextTargetId ?? 1) + 1) | 0);
      ctx.state.targetCallbacks ??= new Map();
      ctx.state.targetCallbacks.set(cursorId, () => {
        ctx.state.sendSystemMessage?.('Preview closed.');
      });
      ctx.state.send?.(api.protocol.multiPlacementRequest({
        id: cursorId,
        multiId,
        hue: 0,
        offsetX: 0,
        offsetY: 0,
        offsetZ: 0,
        allowGround: true,
      }));
      ctx.state.sendSystemMessage?.(`Previewing multi 0x${multiId.toString(16)}.`);
    },
  });

  api.commands?.register?.({
    name: 'servuomultis',
    hidden: true,
    help: '[servuomultis deeds|contest|fixcolumns|decay|nohousing <seconds>',
    access: 'GM',
    run(ctx) {
      const sub = String(ctx.args[0] ?? 'deeds').toLowerCase();
      if (sub === 'deeds') {
        for (const d of [...BOAT_DEEDS, ...HOUSE_DEEDS]) ctx.state.sendSystemMessage?.(`  ${d.name}`);
        return;
      }
      if (sub === 'contest') {
        for (const [name, label, multiId, cls] of CONTEST_HOUSES) {
          ctx.state.sendSystemMessage?.(`  ${name} 0x${multiId.toString(16)} ${cls} - ${label}`);
        }
        return;
      }
      if (sub === 'fixcolumns') {
        const fixed = fixColumns(api, ctx.sender);
        ctx.state.sendSystemMessage?.(`FixColumnTimer pass touched ${fixed} multi tile(s).`);
        return;
      }
      if (sub === 'decay') {
        const info = decayStatus(api, ctx.sender);
        ctx.state.sendSystemMessage?.(info);
        return;
      }
      if (sub === 'nohousing') {
        const seconds = Math.max(1, parseInt(ctx.args[1] ?? '60', 10) || 60);
        ctx.sender._noHousingUntil = Date.now() + seconds * 1000;
        ctx.sender.servuoClasses = [...new Set([...(ctx.sender.servuoClasses ?? []), 'NoHousingDelayTimer'])];
        ctx.state.sendSystemMessage?.(`No-housing delay set for ${seconds}s.`);
        return;
      }
      ctx.state.sendSystemMessage?.('Usage: [servuomultis deeds|contest|fixcolumns|decay|nohousing <seconds>');
    },
  });

  disposers.push(() => {
    for (const name of ['boatcourse', 'boatrepair', 'boatturn', 'securelevel', 'housecustom', 'previewhouse', 'servuomultis']) {
      try { api.commands?.unregister?.(name); } catch {}
    }
  });
}

function fixColumns(api, center) {
  let touched = 0;
  for (const it of allItems(api)) {
    if (it._multi == null) continue;
    if (center && (it.map ?? 1) === (center.map ?? 1)) {
      if (Math.abs((it.x | 0) - (center.x | 0)) > 32 || Math.abs((it.y | 0) - (center.y | 0)) > 32) continue;
    }
    const height = api.tileData?.staticHeight?.(it.itemId) ?? 0;
    if (height > 0) it.height = height;
    const role = api.housedata?.roleFor?.(it.itemId);
    if (role === 'wall' || role === 'roof' || role === 'door') it.solid = true;
    mergeClasses(it, ['FixColumnTimer', 'DataRecord']);
    touched++;
  }
  return touched;
}

function decayStatus(api, mob) {
  const HR = api.houses;
  const h = HR?.houseAt?.(mob.x, mob.y, mob.map);
  if (h) {
    const stage = HR.decayOf?.(h) ?? 'Unknown';
    h.servuoClasses = [...new Set([...(h.servuoClasses ?? []), 'DynamicDecay', 'DecayStageInfo'])];
    return `Registry house #${h.id}: ${stage}.`;
  }
  for (const it of allItems(api)) {
    if (it._multi == null || !it._multiAcl) continue;
    if ((it.map ?? 1) !== (mob.map ?? 1)) continue;
    if (Math.max(Math.abs((it.x | 0) - (mob.x | 0)), Math.abs((it.y | 0) - (mob.y | 0))) > 24) continue;
    const last = it._multiAcl.lastVisitAt ?? Date.now();
    const days = Math.max(0, 15 - ((Date.now() - last) / 86_400_000));
    mergeClasses(it, ['DynamicDecay', 'DecayStageInfo']);
    return `Placed multi 0x${(it._multi | 0).toString(16)}: ${days.toFixed(1)}d before collapse.`;
  }
  return 'No house/multi nearby.';
}

function sweepNoHousing(api) {
  const now = Date.now();
  for (const mob of allMobiles(api)) {
    if (mob._noHousingUntil && now >= mob._noHousingUntil) {
      delete mob._noHousingUntil;
    }
  }
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  const disposers = [];
  registerTemplates(api, disposers);
  registerBoatScripts(api, disposers);
  registerCommands(api, disposers);

  const courseTimer = api.lifecycle?.setInterval?.(() => tickBoatCourses(api), 1000)
    ?? setInterval(() => tickBoatCourses(api), 1000);
  courseTimer.unref?.();
  disposers.push(() => clearInterval(courseTimer));

  const housingTimer = api.lifecycle?.setInterval?.(() => sweepNoHousing(api), 5000)
    ?? setInterval(() => sweepNoHousing(api), 5000);
  housingTimer.unref?.();
  disposers.push(() => clearInterval(housingTimer));

  api.systems ??= {};
  const previous = api.systems.servuoMultis;
  api.systems.servuoMultis = {
    classes: SERVUO_P1_MULTI_CLASSES,
    makePlanks: (boat) => makePlanks(api, boat),
    repairBoat,
    configureBoatCourse: (ctx, boat, args) => configureBoatCourse(api, ctx, boat, args),
    tickBoatCourses: () => tickBoatCourses(api),
    fixColumns: (center) => fixColumns(api, center),
    decayStatus: (mob) => decayStatus(api, mob),
  };
  disposers.push(() => {
    if (previous) api.systems.servuoMultis = previous;
    else delete api.systems.servuoMultis;
  });

  api.log?.(`servuo-p1-multis: ${BOAT_DEEDS.length} boat deeds, ${HOUSE_DEEDS.length} house deeds, ${CONTEST_HOUSES.length} contest house deeds registered`);
  return () => {
    for (const d of disposers.reverse()) {
      try { d(); } catch {}
    }
  };
}
