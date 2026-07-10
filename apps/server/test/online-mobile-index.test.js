import { describe, expect, it } from 'vitest';
import { World } from '../src/world/world.js';

describe('online mobile index', () => {
  it('keeps the scan fallback until the index is explicitly enabled', () => {
    const world = new World();
    const a = world.createMobile({ name: 'online A', body: 0x190, x: 0, y: 0, z: 0, map: 1 });
    const b = world.createMobile({ name: 'online B', body: 0x190, x: 1, y: 0, z: 0, map: 1 });
    a.client = {};
    b.client = {};

    world.removeMobile(a.serial);

    expect([...world.onlineMobiles()].map((m) => m.serial)).toEqual([b.serial]);
  });

  it('uses the explicit index once enabled', () => {
    const world = new World();
    const player = world.createMobile({ name: 'online', body: 0x190, x: 0, y: 0, z: 0, map: 1 });
    player.client = {};

    world.enableOnlineMobileIndex();
    expect([...world.onlineMobiles()].map((m) => m.serial)).toEqual([player.serial]);
    expect(world.hasOnlineMobiles()).toBe(true);

    player.client = null;
    world.markMobileOffline(player);

    expect([...world.onlineMobiles()]).toEqual([]);
    expect(world.hasOnlineMobiles()).toBe(false);
  });
});
