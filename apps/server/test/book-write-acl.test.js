// BUGFIX #40 (FAZA BX): book write packets used to apply page/title
// edits using only the book serial — anyone with the serial could
// scribble in someone else's tome. The new `bookWriteAllowed` gate
// requires the writer to either carry the book, stand within 3 tiles
// of it on the ground, or have its container open.

import { describe, it, expect } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import { _bookWriteAllowedForTest as bookWriteAllowed } from '../src/net/handlers.js';

import { Stage } from '../src/net/net-state.js';

function makeState(world, mob) {
  return {
    stage: Stage.InWorld,
    mobile: mob,
    ctx: { world },
    openContainers: new Set(),
  };
}

describe('bookWriteAllowed (FAZA BX bugfix #40)', () => {
  it('rejects unknown serials', () => {
    const w = new World();
    const mob = w.createMobile({ name: 'a', body: 0x190, x: 0, y: 0, z: 0, map: 1 });
    expect(bookWriteAllowed(makeState(w, mob), 0x99999)).toBe(false);
  });

  it('rejects when writer is not in the world', () => {
    const w = new World();
    const item = createItem(w, { itemId: 0x0FF1, x: 0, y: 0, z: 0, map: 1 });
    const state = { stage: Stage.CharacterList, ctx: { world: w }, openContainers: new Set() };
    expect(bookWriteAllowed(state, item.serial)).toBe(false);
  });

  it('allows writes when book is carried by the writer', () => {
    const w = new World();
    const mob = w.createMobile({ name: 'a', body: 0x190, x: 10, y: 10, z: 0, map: 1 });
    const pack = createItem(w, { itemId: 0x0E75, x: 0, y: 0, z: 0,
      parent: mob.serial, layer: 21 });
    const book = createItem(w, { itemId: 0x0FF1, x: 0, y: 0, z: 0,
      parent: mob.serial });
    expect(bookWriteAllowed(makeState(w, mob), book.serial)).toBe(true);
    void pack;
  });

  it('allows ground writes when book is within 3 tiles', () => {
    const w = new World();
    const mob = w.createMobile({ name: 'a', body: 0x190, x: 10, y: 10, z: 0, map: 1 });
    const book = createItem(w, { itemId: 0x0FF1, x: 12, y: 11, z: 0, map: 1 });
    expect(bookWriteAllowed(makeState(w, mob), book.serial)).toBe(true);
  });

  it('rejects ground writes when book is more than 3 tiles away', () => {
    const w = new World();
    const mob = w.createMobile({ name: 'a', body: 0x190, x: 10, y: 10, z: 0, map: 1 });
    const book = createItem(w, { itemId: 0x0FF1, x: 99, y: 99, z: 0, map: 1 });
    expect(bookWriteAllowed(makeState(w, mob), book.serial)).toBe(false);
  });

  it('rejects ground writes across maps', () => {
    const w = new World();
    const mob = w.createMobile({ name: 'a', body: 0x190, x: 10, y: 10, z: 0, map: 1 });
    const book = createItem(w, { itemId: 0x0FF1, x: 10, y: 10, z: 0, map: 2 });
    expect(bookWriteAllowed(makeState(w, mob), book.serial)).toBe(false);
  });

  it('allows writes when the parent container is open', () => {
    const w = new World();
    const mob = w.createMobile({ name: 'a', body: 0x190, x: 10, y: 10, z: 0, map: 1 });
    const chest = createItem(w, { itemId: 0x0E40, x: 99, y: 99, z: 0, map: 1, gumpId: 0x49 });
    const book = createItem(w, { itemId: 0x0FF1, x: 0, y: 0, z: 0, parent: chest.serial });
    const state = makeState(w, mob);
    state.openContainers.add(chest.serial);
    expect(bookWriteAllowed(state, book.serial)).toBe(true);
  });

  it('rejects writes when container is NOT open (cross-account write attempt)', () => {
    const w = new World();
    const mob = w.createMobile({ name: 'a', body: 0x190, x: 10, y: 10, z: 0, map: 1 });
    const otherChest = createItem(w, { itemId: 0x0E40, x: 99, y: 99, z: 0, map: 1, gumpId: 0x49 });
    const book = createItem(w, { itemId: 0x0FF1, x: 0, y: 0, z: 0, parent: otherChest.serial });
    expect(bookWriteAllowed(makeState(w, mob), book.serial)).toBe(false);
  });
});
