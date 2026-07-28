import { describe, expect, it } from 'vitest';
import { buildHandlers } from '../src/net/handlers.js';
import { Stage } from '../src/net/net-state.js';
import { isPaperdollBody } from '../src/systems/race.js';
import { createItem } from '../src/world/items.js';
import { World } from '../src/world/world.js';

function usePacket(serial) {
  return new Uint8Array([
    0x06,
    (serial >>> 24) & 0xff,
    (serial >>> 16) & 0xff,
    (serial >>> 8) & 0xff,
    serial & 0xff,
  ]);
}

describe('mobile paperdoll body gate', () => {
  it('matches humanoid/creature body families', () => {
    expect(isPaperdollBody(0x0190)).toBe(true);
    expect(isPaperdollBody(0x025e)).toBe(true);
    expect(isPaperdollBody(0x02b6)).toBe(true);
    expect(isPaperdollBody(0x0009)).toBe(false); // daemon
    expect(isPaperdollBody(0x0034)).toBe(false); // lava snake
  });

  it('refreshes a humanoid equipment snapshot immediately before opening 0x88', () => {
    const world = new World();
    const player = { serial: 0x1001, name: 'player', body: 0x0190 };
    const human = { serial: 0x2001, name: 'vendorless human', body: 0x0191 };
    const daemon = { serial: 0x2002, name: 'a daemon', body: 0x0009 };
    world.mobiles.set(player.serial, player);
    world.mobiles.set(human.serial, human);
    world.mobiles.set(daemon.serial, daemon);
    const backpack = createItem(world, {
      itemId: 0x0E75, parent: human.serial, layer: 21, hue: 0x0481,
    });
    const sent = [];
    const state = {
      id: 1, stage: Stage.InWorld, mobile: player,
      ctx: { world }, send: (packet) => sent.push(packet),
    };
    const use = buildHandlers()[0x06];

    use(state, usePacket(daemon.serial));
    expect(sent).toHaveLength(0);

    use(state, usePacket(human.serial));
    expect(sent).toHaveLength(2);
    expect(sent.map((packet) => packet[0])).toEqual([0x78, 0x88]);
    expect(new DataView(sent[0].buffer, sent[0].byteOffset).getUint32(19)).toBe(backpack.serial);
  });
});
