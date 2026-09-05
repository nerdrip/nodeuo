import { describe, expect, it } from 'vitest';
import { nearbyClients, nearbyItems, nearbyMobiles } from '../src/world/visibility.js';

describe('server-authoritative world layers', () => {
  it('protects enhanced and classic clients through the shared visibility path', () => {
    const observer = { serial: 1, x: 100, y: 100, map: 0, nodeUOWorldLayer: 'base', client: {} };
    const base = { serial: 2, x: 101, y: 100, map: 0, client: {} };
    const event = { serial: 3, x: 101, y: 101, map: 0, nodeUOWorldLayer: 'event:one', client: {} };
    const shared = { serial: 4, x: 102, y: 101, map: 0, nodeUOWorldLayer: '*', client: {} };
    const baseItem = { serial: 10, x: 100, y: 101, map: 0, parent: 0 };
    const eventItem = { serial: 11, x: 100, y: 102, map: 0, parent: 0, nodeUOWorldLayer: 'event:one' };
    const world = { mobiles: new Map([[1, observer], [2, base], [3, event], [4, shared]]),
      items: new Map([[10, baseItem], [11, eventItem]]) };
    expect([...nearbyClients(world, observer, observer)]).toEqual([base, shared]);
    expect([...nearbyMobiles(world, observer, observer)]).toEqual([base, shared]);
    expect([...nearbyItems(world, observer)]).toEqual([baseItem]);
  });
});
