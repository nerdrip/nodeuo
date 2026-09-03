import { describe, expect, it, vi } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem, destroyItem } from '../src/world/items.js';
import { setItemParent } from '../src/world/items.js';
import {
  buildGenderChangeToken, buildRaceChangeToken,
} from '../../scripts/src/items/scripts/consumables/promotional-tokens.js';

function fixture() {
  const world = new World();
  const user = world.createMobile({ name: 'Tester', body: 0x190, x: 1, y: 1, z: 0, map: 1, race: 'human', female: false });
  const pack = createItem(world, { itemId: 0x0E75, parent: user.serial, layer: 21 });
  user.equipment = new Map([[21, pack]]);
  let response;
  user.client = { sendSystemMessage: vi.fn(), send: vi.fn() };
  user.client.mobile = user;
  const api = {
    world, items: { createItem, destroyItem },
    gumps: { send: vi.fn((_state, _def, callback) => { response = callback; }) },
  };
  return { world, user, pack, api, respond: (buttonId) => response({ buttonId }) };
}

describe('store-bought appearance tokens', () => {
  it('confirms and consumes a gender token exactly once', () => {
    const f = fixture();
    const token = createItem(f.world, { itemId: 0x2AAA });
    setItemParent(f.world, token, f.pack.serial);
    buildGenderChangeToken(f.api).onUse(f.world, token, f.user);
    f.respond(1);
    expect(f.user).toMatchObject({ female: true, sex: 1, body: 0x191 });
    expect(f.world.items.has(token.serial)).toBe(false);
  });

  it('uses the shared race selector and consumes only after selection', () => {
    const f = fixture();
    const token = createItem(f.world, { itemId: 0x2AAA });
    setItemParent(f.world, token, f.pack.serial);
    buildRaceChangeToken(f.api).onUse(f.world, token, f.user);
    expect(f.world.items.has(token.serial)).toBe(true);
    f.respond(2); // elf
    expect(f.user).toMatchObject({ race: 'elf', body: 0x25D });
    expect(f.world.items.has(token.serial)).toBe(false);
  });
});
