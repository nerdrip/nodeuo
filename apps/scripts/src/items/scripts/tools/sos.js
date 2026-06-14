import { isInPack } from '../../../_inventory.js';

const SOS_ITEM_ID = 0x14EE;
const MIB_ITEM_ID = 0x099F;
const ANCIENT_HUE = 0x0481;

const SOS_MESSAGES = [
  'The ink has run, but the coordinates are still readable.',
  'A desperate sailor marked the spot before the sea took the ship.',
  'The parchment smells of salt and old cedar.',
  'The message points to wreckage hidden below the waves.',
];

function clampLevel(level) {
  return Math.max(1, Math.min(4, level | 0 || 1));
}

function rollCoordinate(map, rng) {
  const regions = map === 2
    ? [{ x: 1240, y: 1000, w: 312, h: 160 }, { x: 1472, y: 272, w: 304, h: 240 }]
    : map === 3
      ? [{ x: 1376, y: 1520, w: 464, h: 280 }]
      : map === 4
        ? [{ x: 10, y: 10, w: 1440, h: 1440 }]
        : [{ x: 0, y: 0, w: 5120, h: 4096 }];
  const r = regions[Math.floor(rng() * regions.length)] ?? regions[0];
  return {
    x: r.x + Math.floor(rng() * r.w),
    y: r.y + Math.floor(rng() * r.h),
  };
}

export function createSosPayload(source = {}, user = {}, rng = Math.random) {
  const src = source.sos ?? source.mib ?? source.treasureMap ?? source;
  const map = src.map ?? user.map ?? 1;
  const rolled = src.x != null && src.y != null ? src : rollCoordinate(map, rng);
  const level = clampLevel(src.level);
  return {
    x: rolled.x | 0,
    y: rolled.y | 0,
    z: rolled.z | 0,
    map: map | 0,
    level,
    messageIndex: src.messageIndex ?? Math.floor(rng() * SOS_MESSAGES.length),
    opened: true,
    ancient: level >= 4,
  };
}

export function applySosToItem(item, payload) {
  item.itemId = SOS_ITEM_ID;
  item.hue = payload.ancient ? ANCIENT_HUE : 0;
  item.name = payload.ancient ? 'an ancient SOS' : 'a waterstained SOS';
  item.script = 'sos';
  item.sos = payload;
  item.treasureMap = {
    level: payload.level,
    x: payload.x,
    y: payload.y,
    map: payload.map,
    decoded: true,
    completed: false,
    sos: true,
  };
  delete item.mib;
  return item;
}

function sendContainerUpdate(api, user, item) {
  if (!user?.client || item.parent == null || !api.protocol?.containerContentUpdate) return;
  user.client.send(api.protocol.containerContentUpdate({
    serial: item.serial,
    itemId: item.itemId,
    amount: item.amount ?? 1,
    hue: item.hue ?? 0,
    gridX: item.gridX ?? 0,
    gridY: item.gridY ?? 0,
    gridLocation: item.gridLocation ?? 0,
  }, item.parent));
}

function describeSos(item, user) {
  const sos = item.sos ?? createSosPayload(item.treasureMap ?? item, user, () => 0);
  item.sos = sos;
  item.treasureMap ??= {
    level: sos.level,
    x: sos.x,
    y: sos.y,
    map: sos.map,
    decoded: true,
    completed: false,
    sos: true,
  };
  const msg = SOS_MESSAGES[sos.messageIndex % SOS_MESSAGES.length] ?? SOS_MESSAGES[0];
  user.client.sendSystemMessage?.(msg);
  user.client.sendSystemMessage?.(
    `${sos.ancient ? 'Ancient SOS' : 'SOS'}: map ${sos.map}, ${sos.x}, ${sos.y}.`,
  );
  user.client.sendSystemMessage?.('Use [dig at the marked coordinates to recover the wreckage.');
}

export function buildMessageInBottle(api) {
  return {
    name: 'message-in-bottle',
    onUse(world, item, user) {
      const runtimeApi = api?.world ? api : { ...api, world };
      if (!user?.client) return true;
      if (!isInPack(runtimeApi, item, user)) {
        user.client.sendSystemMessage?.('That must be in your pack for you to use it.');
        return true;
      }
      const rng = api.rng ?? Math.random;
      const payload = createSosPayload(item, user, rng);
      applySosToItem(item, payload);
      user.client.sendSystemMessage?.('You extract the message from the bottle.');
      sendContainerUpdate(api, user, item);
      return true;
    },
  };
}

export function buildSosScript(api) {
  return {
    name: 'sos',
    onUse(world, item, user) {
      const runtimeApi = api?.world ? api : { ...api, world };
      if (!user?.client) return true;
      if (!isInPack(runtimeApi, item, user)) {
        user.client.sendSystemMessage?.('That must be in your pack for you to use it.');
        return true;
      }
      describeSos(item, user);
      return true;
    },
  };
}

export function buildSeaTreasureMapScript(api) {
  return {
    name: 'treasure-map-sea',
    onUse(world, item, user) {
      const runtimeApi = api?.world ? api : { ...api, world };
      if (!user?.client) return true;
      if (!isInPack(runtimeApi, item, user)) {
        user.client.sendSystemMessage?.('That must be in your pack for you to use it.');
        return true;
      }
      item.sos ??= createSosPayload(item, user, () => 0);
      item.treasureMap ??= {
        level: item.sos.level,
        x: item.sos.x,
        y: item.sos.y,
        map: item.sos.map,
        decoded: true,
        completed: false,
        sos: true,
      };
      describeSos(item, user);
      return true;
    },
  };
}

export const _SOS_CONST = Object.freeze({ SOS_ITEM_ID, MIB_ITEM_ID, ANCIENT_HUE, SOS_MESSAGES });
