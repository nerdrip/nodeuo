import { describe, expect, it } from 'vitest';
import * as protocol from '@uo/protocol';
import registerMount from '../../scripts/src/commands/economy/mount.js';
import { World } from '../src/world/world.js';
import * as itemOps from '../src/world/items.js';
import { nearbyMobiles } from '../src/world/visibility.js';

describe('mount command equipment model', () => {
  it('migrates legacy saved mount bodies without touching unrelated mobiles', () => {
    const world = new World();
    const dragon = world.createMobile({ body: 0x0033, x: 10, y: 10, z: 0, map: 1 });
    dragon.kind = 'swamp-dragon';
    const unrelated = world.createMobile({ body: 0x0033, x: 12, y: 10, z: 0, map: 1 });
    unrelated.kind = 'unrelated-monster';
    const commands = new Map();
    const api = {
      world,
      commands: {
        register: (def) => commands.set(def.name, def),
        unregister: (name) => commands.delete(name),
      },
      protocol,
    };

    registerMount(api);

    expect(dragon.body).toBe(0x031A);
    expect(unrelated.body).toBe(0x0033);
  });

  it('keeps the rider body/clothes and equips a real Layer.Mount item', () => {
    const world = new World();
    const packets = [];
    const rider = world.createMobile({
      name: 'Rider', body: 0x0190, x: 100, y: 100, z: 0, map: 1,
    });
    rider.client = { send: (pkt) => packets.push(pkt), sendSystemMessage() {} };
    const horse = world.createMobile({
      name: 'a horse', body: 0x00C8, x: 101, y: 100, z: 0, map: 1,
    });
    horse.kind = 'horse';
    horse.controlMaster = rider.serial;
    const commands = new Map();
    const api = {
      world,
      commands: {
        register: (def) => commands.set(def.name, def),
        unregister: (name) => commands.delete(name),
      },
      protocol,
      monsters: { get: (kind) => kind === 'horse' ? { tameable: true, name: 'a horse' } : null },
      items: itemOps,
    };
    registerMount(api);
    const ctx = { sender: rider, state: rider.client };

    commands.get('mount').run(ctx);

    expect(rider.body).toBe(0x0190);
    expect(rider.mountedFrom).toBe(horse.serial);
    const mountItem = [...world.items.values()].find((it) => it.parent === rider.serial && it.layer === 25);
    expect(mountItem).toMatchObject({ itemId: 0x3E9F, movable: false, weight: 0 });
    expect(packets.some((pkt) => pkt[0] === 0x2E)).toBe(true);
    expect([...nearbyMobiles(world, rider, rider)]).not.toContain(horse);

    commands.get('mount').run(ctx);
    expect(rider.body).toBe(0x0190);
    expect(rider.mountedFrom).toBeUndefined();
    expect(world.items.has(mountItem.serial)).toBe(false);
    expect(horse.mounted).toBeUndefined();
  });
});
