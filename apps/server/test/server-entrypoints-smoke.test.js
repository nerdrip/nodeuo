import { describe, it, expect } from 'vitest';
import registerAdmin from '../../scripts/src/commands/admin/admin.js';
import registerMap from '../../scripts/src/commands/map.js';
import registerPvp from '../../scripts/src/commands/combat/pvp.js';
import registerHunt from '../../scripts/src/commands/economy/hunt.js';
import registerPlayerVendor from '../../scripts/src/commands/economy/playervendor.js';
import registerHouseTeleporter from '../../scripts/src/items/scripts/housing/house-teleporter.js';
import * as playerVendor from '../src/systems/economy/player-vendor.js';
import { createScriptGameApi } from '../src/script-game-api.js';
import { World } from '../src/world/world.js';
import { createItem, destroyItem, setItemParent } from '../src/world/items.js';
import { createWorldOpsApi } from '../src/world/ops-api.js';
import { createWorldQueryApi } from '../src/world/query-api.js';

function makeApi(extra = {}) {
  const world = extra.world ?? new World();
  const cmds = new Map();
  const itemsApi = { createItem, destroyItem, setItemParent };
  const protocol = {
    worldItemSA: () => new Uint8Array([0xF3]),
    mobileUpdate: () => new Uint8Array([0x77]),
    containerContentUpdate: () => new Uint8Array([0x25]),
  };
  const query = extra.query ?? createWorldQueryApi(world);
  const ops = extra.ops ?? createWorldOpsApi(world);
  const api = {
    world,
    commands: {
      register(cmd) { cmds.set(cmd.name, cmd); },
      unregister(name) { cmds.delete(name); },
    },
    items: itemsApi,
    protocol,
    query,
    ops,
    game: extra.game ?? createScriptGameApi({ world, query, ops, protocol, items: itemsApi }),
    log: () => {},
    _cmds: cmds,
    ...extra,
  };
  return api;
}

function makePlayer(world, data = {}) {
  const mob = world.createMobile({
    name: 'Tester',
    body: 0x190,
    x: 100,
    y: 100,
    z: 0,
    map: 1,
    ...data,
  });
  mob.accountName = data.accountName ?? 'tester';
  mob.accountId = data.accountId ?? `acc:${mob.serial}`;
  return mob;
}

function addBackpack(world, mob) {
  return createItem(world, {
    itemId: 0x0E75,
    parent: mob.serial,
    layer: 21,
    gumpId: 0x003C,
    x: mob.x,
    y: mob.y,
    z: mob.z,
    map: mob.map,
  });
}

function makeCtx(sender, args = []) {
  const messages = [];
  const packets = [];
  return {
    sender,
    args,
    state: {
      mobile: sender,
      account: { accessLevel: 'Admin' },
      send: (packet) => packets.push(packet),
      sendSystemMessage: (msg) => messages.push(String(msg)),
    },
    messages,
    packets,
  };
}

function run(api, name, sender, args = []) {
  const ctx = makeCtx(sender, args);
  const cmd = api._cmds.get(name);
  expect(cmd, `command ${name} registered`).toBeTruthy();
  cmd.run(ctx, args);
  return ctx;
}

describe('server entrypoint smoke tests', () => {
  it('[admin gump emits the AdminGump bridge sentinel', () => {
    const api = makeApi();
    const admin = makePlayer(api.world);
    registerAdmin(api);

    const ctx = run(api, 'admin', admin, ['gump']);

    expect(api._cmds.get('admin')?.access).toBe('Admin');
    expect(ctx.messages).toContain('@@OPEN_ADMIN_GUMP@@');
  });

  it('[map opens the pin editor, persists pins, and sanitizes bridge rows', () => {
    const api = makeApi();
    const player = makePlayer(api.world);
    const pack = addBackpack(api.world, player);
    registerMap(api);

    const opened = run(api, 'map', player);
    const firstPayload = opened.messages.find((m) => m.startsWith('@@OPEN_MAPPINS_GUMP@@'));
    expect(firstPayload).toMatch(/^@@OPEN_MAPPINS_GUMP@@[0-9a-f]+\|\|320\|\|320\|\|/);

    const blankMap = [...api.world.items.values()].find((it) => it.itemId === 0x14EB);
    expect(blankMap).toBeTruthy();
    expect(blankMap.parent).toBe(pack.serial);

    run(api, 'map', player, ['pin', 'add', '12', '34', 'Danger|Zone;A']);
    expect(blankMap._mapPins).toEqual([{ x: 12, y: 34, label: 'Danger|Zone;A' }]);

    const reopened = run(api, 'map', player, ['pins']);
    const payload = reopened.messages.find((m) => m.startsWith('@@OPEN_MAPPINS_GUMP@@'));
    expect(payload).toContain('12|34|Danger_Zone_A');

    run(api, 'map', player, ['pin', 'clear']);
    expect(blankMap._mapPins).toEqual([]);
  });

  it('[house-teleporter creates and links an owner-only pair inside one house', () => {
    const house = { id: 'villa-1' };
    const api = makeApi({
      houses: {
        houseAt: () => house,
        roleOf: (_house, serial) => (serial === 0xBAD ? 'visitor' : 'owner'),
      },
    });
    const owner = makePlayer(api.world, { serial: undefined, accountName: 'owner' });
    const script = registerHouseTeleporter(api);

    const first = run(api, 'house-teleporter', owner);
    expect(first.messages.at(-1)).toMatch(/First teleporter dropped/);
    const firstPad = [...api.world.items.values()].find((it) => it.script === 'house-teleporter');
    expect(firstPad).toMatchObject({ itemId: 0x181F, _houseId: 'villa-1' });

    owner.x += 4;
    const second = run(api, 'house-teleporter', owner);
    expect(second.messages.at(-1)).toMatch(/pair linked/);
    const pads = [...api.world.items.values()].filter((it) => it.script === 'house-teleporter');
    expect(pads).toHaveLength(2);
    expect(pads[0].pairSerial).toBe(pads[1].serial);
    expect(pads[1].pairSerial).toBe(pads[0].serial);
    expect(pads[0].teleportTo).toMatchObject({ x: pads[1].x, y: pads[1].y, map: pads[1].map });

    const sent = [];
    const walker = makePlayer(api.world, { x: pads[0].x, y: pads[0].y });
    walker.client = {
      send: (packet) => sent.push(packet),
      sendSystemMessage: (msg) => sent.push(String(msg)),
    };
    script.onWalkOn(api.world, pads[0], walker);
    expect(walker.x).toBe(pads[1].x);
    expect(walker.y).toBe(pads[1].y);
    expect(sent.some((packet) => packet instanceof Uint8Array && packet[0] === 0x77)).toBe(true);
  });

  it('[pv gump opens the player-vendor bridge and preloads browse rows', () => {
    const api = makeApi({ systems: { playerVendor } });
    const owner = makePlayer(api.world, { name: 'VendorOwner' });
    const vendor = playerVendor.placeVendor(api.world, owner, { shopName: 'Bright Goods' });
    const gem = createItem(api.world, {
      itemId: 0x0F21,
      name: 'star sapphire',
      amount: 2,
      parent: owner.serial,
      x: owner.x,
      y: owner.y,
      z: owner.z,
      map: owner.map,
    });
    playerVendor.addStock(vendor, gem, 125, '', api.world);
    registerPlayerVendor(api);

    const ctx = run(api, 'pv', owner, ['gump', vendor.serial.toString(16)]);

    expect(ctx.messages).toContain(`@@OPEN_PLAYERVENDOR_GUMP@@${vendor.serial.toString(16)}`);
    expect(ctx.messages.some((m) => m.includes('PV === Bright Goods'))).toBe(true);
    expect(ctx.messages.some((m) => m.includes(gem.serial.toString(16)) && m.includes('star sapphire'))).toBe(true);
  });

  it('[hunt gump and [pvp gump emit their client overlay payloads', () => {
    const api = makeApi();
    const player = makePlayer(api.world);
    registerHunt(api);
    registerPvp(api);

    const hunt = run(api, 'hunt', player, ['gump']);
    const huntMsg = hunt.messages.find((m) => m.startsWith('@@OPEN_HUNTMASTER_GUMP@@'));
    expect(huntMsg?.split('||')).toHaveLength(4);

    const pvp = run(api, 'pvp', player, ['gump', 'rewards']);
    expect(pvp.messages).toContain('@@OPEN_VVV_GUMP@@rewards|none|0|');
  });
});
