import { describe, expect, it, vi } from 'vitest';
import { PacketWriter } from '@uo/protocol';
import { handleHouseCustomization } from '../src/net/handlers/client-extensions.js';
import { Stage } from '../src/net/net-state.js';
import { HouseRegistry } from '../src/systems/housing/houses.js';
import { World } from '../src/world/world.js';

function addPacket(playerSerial, graphic, x, y) {
  const writer = new PacketWriter(25);
  writer.writeU8(0xD7);
  writer.writeU16(25);
  writer.writeU32(playerSerial >>> 0);
  writer.writeU16(0x06);
  writer.writeU8(0); writer.writeU32(graphic >>> 0);
  writer.writeU8(0); writer.writeU32(x >>> 0);
  writer.writeU8(0); writer.writeU32(y >>> 0);
  writer.writeU8(0x0A);
  return writer.bytes();
}

function setup() {
  const world = new World();
  const owner = { serial: 0x1234, name: 'Owner', x: 100, y: 200, z: 10, map: 1 };
  const foundation = world.createItem({
    itemId: 0x13EC, multiId: 0x13EC, x: 100, y: 200, z: 10, map: 1,
    movable: false, _multiAnchor: true,
  });
  const houses = new HouseRegistry().attachWorld(world);
  const house = houses.place(owner, {
    x1: 98, y1: 195, x2: 105, y2: 205, z: 10, map: 1,
    multiSerial: foundation.serial, customizable: true,
  });
  const state = {
    stage: Stage.InWorld,
    mobile: owner,
    ctx: { world, houses, protocol: {} },
    sendSystemMessage: vi.fn(),
  };
  return { house, houses, owner, state };
}

describe('0xD7 classic house-customization input', () => {
  it('converts standard foundation-relative coordinates to world coordinates', () => {
    const { house, owner, state } = setup();
    handleHouseCustomization(state, addPacket(owner.serial, 0x06A5, 2, -1));
    expect(house.editing?.tiles).toContainEqual({
      kind: 'item', g: 0x06A5, x: 102, y: 199, z: 17,
    });
  });

  it('rejects malformed lengths and encoded separators before mutating a design', () => {
    const { house, owner, state } = setup();
    const badLength = addPacket(owner.serial, 0x06A5, 2, -1);
    badLength[2]--;
    handleHouseCustomization(state, badLength);
    expect(house.editing).toBeFalsy();

    const badSeparator = addPacket(owner.serial, 0x06A5, 2, -1);
    badSeparator[9] = 1;
    handleHouseCustomization(state, badSeparator);
    expect(house.editing).toBeFalsy();
  });

  it('rejects remote authoring even when the player owns the foundation', () => {
    const { house, owner, state } = setup();
    owner.x = 500;
    owner.y = 500;
    handleHouseCustomization(state, addPacket(owner.serial, 0x06A5, 2, -1));
    expect(house.editing).toBeFalsy();
    expect(state.sendSystemMessage).toHaveBeenCalledWith(
      'You must remain at the house to customize it.',
    );
  });
});
