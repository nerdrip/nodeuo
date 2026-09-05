import { describe, expect, it } from 'vitest';
import { killMobile } from '../src/corpse.js';
import { World } from '../src/world/world.js';

describe('summoned mobile death', () => {
  it('returns the summon to the ether without creating a corpse', () => {
    const world = new World();
    const packets = [];
    const messages = [];
    const master = world.createMobile({
      name: 'Mage', body: 0x0190, x: 100, y: 100, z: 0, map: 1,
      followers: 2,
    });
    master.client = {
      send: (packet) => packets.push(packet),
      sendSystemMessage: (message) => messages.push(message),
    };
    const vortex = world.createMobile({
      name: 'an energy vortex', body: 164, x: 101, y: 100, z: 0, map: 1,
      hp: 90, hpMax: 90,
    });
    Object.assign(vortex, {
      summoned: true, summonedBy: master.serial, controlMaster: master.serial,
      summonedUntil: Date.now() + 120_000, _followerCost: 2,
    });
    world._summons = new Set([vortex.serial]);

    expect(killMobile(world, vortex, master)).toBeNull();

    expect(world.mobiles.has(vortex.serial)).toBe(false);
    expect(world.items.size).toBe(0);
    expect(world._summons.has(vortex.serial)).toBe(false);
    expect(master.followers).toBe(0);
    expect(packets.some((packet) => packet?.[0] === 0x1D)).toBe(true);
    expect(messages.join(' ')).toContain('returns to the ether');
  });

  it('releases follower slots on direct world destruction as a safety net', () => {
    const world = new World();
    const master = world.createMobile({ name: 'Mage', body: 0x0190, x: 1, y: 1, map: 1 });
    master.followers = 2;
    const summon = world.createMobile({ name: 'vortex', body: 164, x: 2, y: 1, map: 1 });
    Object.assign(summon, {
      summoned: true, summonedBy: master.serial, controlMaster: master.serial,
      _followerCost: 2,
    });

    expect(world.destroyMobile(summon.serial)).toBe(true);
    expect(master.followers).toBe(0);
    expect(summon._followerCost).toBe(0);
  });
});
