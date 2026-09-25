import { expect, it } from 'vitest';
import {
  registerItemScript, unregisterItemScript, tickAllItemScripts,
} from '../src/world/item-scripts.js';

it('starts ticking when hot reload replaces a same-name item script with hasTick', () => {
  const name = '__tick-cache-replacement';
  const item = { serial: 1, script: name };
  const world = { items: new Map([[item.serial, item]]) };
  const seen = [];
  try {
    registerItemScript({ name, hasTick: false });
    tickAllItemScripts(world, 1);
    registerItemScript({ name, hasTick: true, onTick: () => seen.push('tick') });
    tickAllItemScripts(world, 1);
    expect(seen).toEqual(['tick']);
    registerItemScript({ name, hasTick: false });
    tickAllItemScripts(world, 1);
    expect(seen).toEqual(['tick']);
  } finally {
    unregisterItemScript(name);
  }
});
