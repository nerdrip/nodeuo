import { describe, expect, it, vi } from 'vitest';

import registerTrainer from '../../scripts/src/npcs/vendors/trainer.js';
import { World } from '../src/world/world.js';

describe('trainer AI transactions', () => {
  it('charges an aggregate of gold piles atomically before teaching', () => {
    const world = new World();
    let behavior;
    const api = {
      world,
      commands: { register: vi.fn(), unregister: vi.fn() },
      ai: { registerBehavior: (value) => { behavior = value; }, unregisterBehavior: vi.fn() },
      protocol: {
        removeEntity: () => new Uint8Array([0x1D]),
        containerContentUpdate: () => new Uint8Array([0x25]),
      },
      skills: { byId: new Map([[2, { name: 'Anatomy' }]]) },
    };
    registerTrainer(api);
    const trainer = world.createMobile({ name: 'Trainer', x: 100, y: 100, map: 1 });
    trainer.teaches = [2];
    const student = world.createMobile({ name: 'Student', x: 101, y: 100, map: 1 });
    student.skills = { 2: 0 };
    student.client = { send: vi.fn(), sendSystemMessage: vi.fn() };
    const pack = world.createItem({ itemId: 0x0E75, parent: student.serial, layer: 21 });
    const first = world.createItem({ itemId: 0x0EED, amount: 10, parent: pack.serial });
    const second = world.createItem({ itemId: 0x0EED, amount: 15, parent: pack.serial });
    trainer._heardSpeech = [{ speaker: student, text: 'anatomy' }];

    behavior.tick({ now: 5_000, broadcastSpeech: vi.fn() }, trainer, behavior.initState());

    expect(world.items.has(first.serial)).toBe(false);
    expect(world.items.has(second.serial)).toBe(false);
    expect(student.skills[2]).toBe(30);
  });
});
