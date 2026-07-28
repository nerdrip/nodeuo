import { afterEach, describe, expect, it } from 'vitest';
import { World } from '../src/world/world.js';
import { useItem } from '../src/world/templates.js';
import {
  registerItemScript,
  unregisterItemScript,
} from '../src/world/item-scripts.js';
import buildPowerHourScript from '../../scripts/src/items/scripts/consumables/power-hour-scroll.js';

afterEach(() => unregisterItemScript('power-hour-scroll'));

describe('Power Hour scroll', () => {
  it('migrates and consumes the scriptless reward found in old saves', () => {
    const world = new World();
    const user = world.createMobile({ name: 'Scholar', x: 100, y: 100, z: 0, map: 1 });
    const messages = [];
    user.client = { sendSystemMessage: (message) => messages.push(message) };
    const scroll = world.createItem({
      itemId: 0x14F0,
      name: 'a Power Hour scroll',
      amount: 1,
      parent: user.serial,
      map: 1,
    });
    registerItemScript(buildPowerHourScript({}));

    const before = Date.now();
    expect(useItem(world, scroll, user)).toBe(true);
    expect(scroll.script).toBe('power-hour-scroll');
    expect(user._powerHourUntil).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
    expect(world.items.has(scroll.serial)).toBe(false);
    expect(messages.join('\n')).toMatch(/skill gains accelerated for 1 hour/i);
  });

  it('does not consume a second scroll while the effect is active', () => {
    const world = new World();
    const user = world.createMobile({ name: 'Scholar', x: 100, y: 100, z: 0, map: 1 });
    const messages = [];
    user.client = { sendSystemMessage: (message) => messages.push(message) };
    user._powerHourUntil = Date.now() + 30_000;
    const scroll = world.createItem({
      itemId: 0x14F0,
      name: 'a Power Hour scroll',
      script: 'power-hour-scroll',
      amount: 1,
      parent: user.serial,
      map: 1,
    });
    registerItemScript(buildPowerHourScript({}));

    expect(useItem(world, scroll, user)).toBe(true);
    expect(world.items.has(scroll.serial)).toBe(true);
    expect(messages).toContain('A power hour is already in effect.');
  });
});
