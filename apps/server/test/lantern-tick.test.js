import { expect, it } from 'vitest';
import buildLanternScript from '../../scripts/src/items/scripts/lights/lantern.js';

it('consumes ten minutes of lantern fuel from second-based script ticks', () => {
  const script = buildLanternScript({});
  const item = { serial: 1, itemId: 0x0A25, _lit: true };
  script.onCreate({}, item);
  script.onTick({}, item, 1);
  expect(item._burnRemainingMs).toBe(599_000);
  script.onTick({}, item, 598);
  expect(item._burnRemainingMs).toBe(1_000);
  script.onTick({}, item, 1);
  expect(item._lit).toBe(false);
  expect(item.itemId).toBe(0x0A22);
});
