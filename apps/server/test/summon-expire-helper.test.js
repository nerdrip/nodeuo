import { afterEach, describe, expect, it, vi } from 'vitest';
import { expireSummonedMobile } from '../../scripts/src/spells/_helpers.js';

describe('summon expiry helper', () => {
  afterEach(() => vi.useRealTimers());

  it('broadcasts removal and uses destroyMobile instead of raw map delete', () => {
    vi.useFakeTimers();
    const packets = [];
    const summoned = { serial: 0x2001, x: 10, y: 10, z: 0, map: 1 };
    const near = {
      serial: 0x1001,
      x: 12,
      y: 10,
      z: 0,
      map: 1,
      client: { send: (packet) => packets.push(packet) },
    };
    const far = {
      serial: 0x1002,
      x: 100,
      y: 100,
      z: 0,
      map: 1,
      client: { send: (packet) => packets.push(packet) },
    };
    const destroyed = [];
    const world = {
      mobiles: new Map([[summoned.serial, summoned], [near.serial, near], [far.serial, far]]),
      destroyMobile(serial) {
        destroyed.push(serial);
        this.mobiles.delete(serial);
      },
    };
    const api = {
      world,
      protocol: { removeEntity: (serial) => ({ op: 'removeEntity', serial }) },
    };

    expireSummonedMobile(api, summoned, 1000);
    vi.advanceTimersByTime(1000);

    expect(destroyed).toEqual([summoned.serial]);
    expect(world.mobiles.has(summoned.serial)).toBe(false);
    expect(packets).toEqual([{ op: 'removeEntity', serial: summoned.serial }]);
  });
});
