import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAllItemScripts } from '../../scripts/src/items/scripts/index.js';
import buildDisguiseKit from '../../scripts/src/items/scripts/tools/disguise-kit.js';
import buildRecallRune from '../../scripts/src/items/scripts/tools/recall-rune.js';
import {
  buildMessageInBottle,
  buildSosScript,
} from '../../scripts/src/items/scripts/tools/sos.js';
import { buildSpyglassScript, tideDirection } from '../../scripts/src/items/scripts/tools/misc-tools.js';
import { RESOURCE_GEMS, STEALABLE_POOL } from '../../scripts/src/items/definitions/stealable-pool.js';
import {
  findBlankRune,
  findMarkedRune,
  markRune,
  spawnGatePair,
} from '../../scripts/src/spells/rune-helpers.js';
import {
  allItemScripts,
  registerItemScript,
  unregisterItemScript,
} from '../src/world/item-scripts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const itemsPath = path.resolve(here, '..', '..', 'scripts', 'src', 'data', 'config', 'items.json');

function readItems() {
  return JSON.parse(fs.readFileSync(itemsPath, 'utf8'));
}

describe('audited item gaps', () => {
  it('registers the completed item scripts through the manifest', () => {
    const previous = allItemScripts();
    try {
      const names = registerAllItemScripts({
        log: () => {},
        commands: { register() {}, unregister() {} },
      });
      expect(names).toContain('dye-tub');
      expect(names).toContain('disguise-kit');
      expect(names).toContain('recall-rune');
      expect(names).toContain('message-in-bottle');
      expect(names).toContain('sos');
      expect(names).toContain('treasure-map-sea');
    } finally {
      for (const script of allItemScripts()) unregisterItemScript(script.name);
      for (const script of previous) registerItemScript(script);
    }
  });

  it('has spawnable recall rune and disguise-kit item templates', () => {
    const byName = new Map(readItems().map((item) => [item.name, item]));
    expect(byName.get('recall-rune')).toMatchObject({ itemId: 0x1F14, script: 'recall-rune' });
    expect(byName.get('marked-rune')).toMatchObject({ itemId: 0x1F14, hue: 0x47, script: 'recall-rune' });
    expect(byName.get('disguise-kit')).toMatchObject({ itemId: 0x0E05, script: 'disguise-kit' });
    expect(byName.get('message-in-bottle')).toMatchObject({ itemId: 0x099F, script: 'message-in-bottle' });
    expect(byName.get('waterstained-sos')).toMatchObject({ itemId: 0x14EE, script: 'sos' });
    expect(byName.get('ancient-sos')).toMatchObject({ itemId: 0x14EE, hue: 0x0481, script: 'sos' });
  });

  it('spyglass reports moon phases and tide direction', () => {
    const messages = [];
    const script = buildSpyglassScript({ now: () => 0 });
    script.onUse(null, null, { client: { sendSystemMessage: (msg) => messages.push(msg) } });
    expect(messages).toContain('  Trammel:  new moon');
    expect(messages).toContain('  Felucca:  new moon');
    expect(messages).toContain(`  Tide:     flowing ${tideDirection(0)}`);
  });

  it('resource gems are available in the monster stealable pools', () => {
    const stealableNames = new Set(
      Object.values(STEALABLE_POOL).flat().map((entry) => entry.name),
    );
    for (const gem of RESOURCE_GEMS) {
      expect(stealableNames.has(gem.name)).toBe(true);
    }
  });

  it('disguise kit double-click applies the shared disguise effect', () => {
    const messages = [];
    const effects = [];
    const api = { statusEffects: { apply: (_mob, effect) => effects.push(effect) } };
    const script = buildDisguiseKit(api);
    const user = {
      serial: 1,
      name: 'Player',
      npcGuild: 'thieves',
      client: { sendSystemMessage: (msg) => messages.push(msg) },
    };
    const pack = { serial: 2, parent: user.serial };
    const kit = { serial: 3, parent: pack.serial, itemId: 0x0E05 };
    const world = { items: new Map([[pack.serial, pack], [kit.serial, kit]]) };

    expect(script.onUse(world, kit, user)).toBe(true);
    expect(user._origDisplayName).toBe('Player');
    expect(user.name).not.toBe('Player');
    expect(messages).toContain('Your features blur — you are disguised.');
    expect(effects[0]).toMatchObject({ name: 'disguised' });
  });

  it('recall rune double-click reveals blank and marked state', () => {
    const script = buildRecallRune();
    const messages = [];
    const user = { client: { sendSystemMessage: (msg) => messages.push(msg) } };

    script.onUse(null, {}, user);
    expect(messages).toContain('This recall rune is blank.');

    messages.length = 0;
    script.onUse(null, {
      runeDest: { x: 100, y: 200, z: 0, map: 1, label: 'Britain bank' },
    }, user);
    expect(messages).toContain('This rune is marked for Britain bank.');
    expect(messages).toContain('Map 1: 100, 200, 0.');
  });

  it('rune helpers find runes inside backpack containers', () => {
    const caster = { serial: 1, x: 10, y: 20, z: 0, map: 1 };
    const pack = { serial: 2, parent: caster.serial };
    const rune = { serial: 3, parent: pack.serial, itemId: 0x1F14 };
    const api = { world: { items: new Map([[pack.serial, pack], [rune.serial, rune]]) } };

    expect(findBlankRune(api, caster)).toBe(rune);
    markRune(rune, caster);
    expect(findMarkedRune(api, caster)).toBe(rune);
    expect(rune.runeDest).toMatchObject({ x: 10, y: 20, map: 1 });
  });

  it('gate travel creates a visible temporary moongate pair', () => {
    const packets = [];
    const destroyed = [];
    const world = { items: new Map(), mobiles: new Map() };
    const caster = {
      serial: 1,
      x: 10,
      y: 20,
      z: 0,
      map: 1,
      client: { send: (packet) => packets.push(packet) },
    };
    const observer = {
      serial: 2,
      x: 100,
      y: 200,
      z: 0,
      map: 1,
      client: { send: (packet) => packets.push(packet) },
    };
    world.mobiles.set(caster.serial, caster);
    world.mobiles.set(observer.serial, observer);
    let nextSerial = 0x4000_2000;
    const api = {
      world,
      items: {
        createItem(worldArg, data) {
          expect(worldArg).toBe(world);
          const item = { serial: nextSerial++, amount: 1, hue: 0, ...data };
          world.items.set(item.serial, item);
          return item;
        },
        destroyItem(worldArg, serial) {
          expect(worldArg).toBe(world);
          destroyed.push(serial);
          world.items.delete(serial);
        },
      },
      protocol: {
        worldItemSA: (entry) => ({ op: 'worldItemSA', ...entry }),
        removeEntity: (serial) => ({ op: 'removeEntity', serial }),
      },
    };

    expect(spawnGatePair(api, caster, { x: 100, y: 200, z: 5, map: 1 })).toBe(true);
    const gates = [...world.items.values()];
    expect(gates).toHaveLength(2);
    expect(gates[0]).toMatchObject({ script: 'teleporter', teleportTo: { x: 100, y: 200, z: 5, map: 1 } });
    expect(gates[1]).toMatchObject({ script: 'teleporter', teleportTo: { x: 10, y: 20, z: 0, map: 1 } });
    expect(packets.filter((packet) => packet.op === 'worldItemSA')).toHaveLength(2);
    expect(destroyed).toEqual([]);
  });

  it('message-in-bottle opens into a decoded SOS treasure map', () => {
    const messages = [];
    const packets = [];
    const api = {
      rng: () => 0,
      protocol: { containerContentUpdate: (item, parent) => ({ item, parent }) },
    };
    const script = buildMessageInBottle(api);
    const user = {
      serial: 1,
      map: 1,
      client: {
        sendSystemMessage: (msg) => messages.push(msg),
        send: (packet) => packets.push(packet),
      },
    };
    const pack = { serial: 2, parent: user.serial };
    const bottle = {
      serial: 3,
      parent: pack.serial,
      itemId: 0x099F,
      script: 'message-in-bottle',
      mib: { x: 1234, y: 2345, map: 1, level: 4 },
    };
    const world = { items: new Map([[pack.serial, pack], [bottle.serial, bottle]]) };

    expect(script.onUse(world, bottle, user)).toBe(true);
    expect(messages).toContain('You extract the message from the bottle.');
    expect(bottle).toMatchObject({
      itemId: 0x14EE,
      hue: 0x0481,
      script: 'sos',
      name: 'an ancient SOS',
      treasureMap: { level: 4, x: 1234, y: 2345, map: 1, decoded: true, sos: true },
    });
    expect(packets[0]).toMatchObject({ item: { itemId: 0x14EE, hue: 0x0481 }, parent: pack.serial });
  });

  it('SOS double-click shows the wreck coordinates', () => {
    const messages = [];
    const script = buildSosScript();
    const user = { serial: 1, client: { sendSystemMessage: (msg) => messages.push(msg) } };
    const pack = { serial: 2, parent: user.serial };
    const sos = {
      serial: 3,
      parent: pack.serial,
      itemId: 0x14EE,
      script: 'sos',
      sos: { x: 111, y: 222, z: 0, map: 1, level: 2, messageIndex: 0, ancient: false },
    };
    const world = { items: new Map([[pack.serial, pack], [sos.serial, sos]]) };

    expect(script.onUse(world, sos, user)).toBe(true);
    expect(messages).toContain('SOS: map 1, 111, 222.');
    expect(messages).toContain('Use [dig at the marked coordinates to recover the wreckage.');
  });
});
