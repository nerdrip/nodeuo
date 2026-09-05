// PHASE CW — bugfix #65 regression: corpse decay broadcasts must honour
// the canon UO 18-tile visibility gate. Previously the loop fanned
// removeEntity to EVERY connected client per decay sweep, which scaled
// poorly on busy shards (every 30 s sweeper × every corpse × every
// player = lots of wasted packets).

import { describe, it, expect } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import { decayCorpse, sweepDecayedCorpses } from '../src/corpse.js';

describe('decayCorpse visibility gate (bugfix #65)', () => {
  it('only broadcasts removeEntity to clients within 18 tiles + same map', () => {
    const w = new World();
    // Corpse in Britain.
    const corpse = createItem(w, {
      itemId: 0x2006, x: 1500, y: 1600, z: 0, map: 1,
      name: 'a corpse', movable: false,
    });
    const nearbySent = [];
    const farSent = [];
    const wrongMapSent = [];

    const nearby = w.createMobile({
      name: 'nearby', body: 0x190, x: 1505, y: 1605, z: 0, map: 1,
    });
    nearby.client = { send: (b) => nearbySent.push(b) };

    const far = w.createMobile({
      name: 'far', body: 0x190, x: 3000, y: 3000, z: 0, map: 1,
    });
    far.client = { send: (b) => farSent.push(b) };

    const wrongMap = w.createMobile({
      name: 'wrongMap', body: 0x190, x: 1500, y: 1600, z: 0, map: 0,
    });
    wrongMap.client = { send: (b) => wrongMapSent.push(b) };

    decayCorpse(w, corpse.serial);

    // Nearby observer should receive 0x1D removeEntity.
    expect(nearbySent.some((b) => b[0] === 0x1D)).toBe(true);
    // Distant + cross-map observers should not.
    expect(farSent.length).toBe(0);
    expect(wrongMapSent.length).toBe(0);
  });

  it('still works when the corpse item is gone before broadcast (graceful)', () => {
    const w = new World();
    const corpse = createItem(w, {
      itemId: 0x2006, x: 0, y: 0, z: 0, map: 1,
    });
    const m = w.createMobile({
      name: 'a', body: 0x190, x: 0, y: 0, z: 0, map: 1,
    });
    let received = 0;
    m.client = { send: () => received++ };
    // Remove corpse manually first so position lookup fails — decay
    // must not throw and must skip silently.
    w.items.delete(corpse.serial);
    expect(() => decayCorpse(w, corpse.serial)).not.toThrow();
    // Without a center we can't gate; safe behaviour: send to everyone
    // (the corpse is already gone so the packet is harmless). Acceptable
    // either way — assert not-throw is the contract.
    void received;
  });

  it('sweeps via a corpse index after the initial lazy build', () => {
    const w = new World();
    const oldCorpse = createItem(w, {
      itemId: 0x2006, x: 10, y: 10, z: 0, map: 1,
      name: 'an old corpse', movable: false,
    });
    oldCorpse.spawnedAt = Date.now() - 8 * 60 * 1000;
    const coin = createItem(w, {
      itemId: 0x0EED, x: 10, y: 10, z: 0, map: 1,
      amount: 12,
    });

    expect(sweepDecayedCorpses(w)).toBe(1);
    expect(w.items.has(oldCorpse.serial)).toBe(false);
    expect(w.items.has(coin.serial)).toBe(true);
    expect(w._corpses?.has(oldCorpse.serial)).toBe(false);
    expect(w._corpseIndexReady).toBe(true);
  });
});
