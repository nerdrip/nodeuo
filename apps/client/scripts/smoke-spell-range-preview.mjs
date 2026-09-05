import assert from 'node:assert/strict';
import { Container } from 'pixi.js';
import { bus } from '../src/core/event-bus.js';
import { SpellRangePreview, spellAreaTiles, spellRangeRing } from '../src/renderer/spell-range-preview.js';

const origin = { x: 100, y: 100 };
const target = { x: 104, y: 100 };

const circle = spellAreaTiles(origin, target, { shape: 'circle', radius: 2 });
assert.equal(circle.length, 13, 'radius-2 circle footprint');
assert(circle.some((tile) => tile.x === 104 && tile.y === 100));
assert(circle.every((tile) => (tile.x - 104) ** 2 + (tile.y - 100) ** 2 <= 4));

const line = spellAreaTiles(origin, target, { shape: 'line', radius: 4 });
assert.deepEqual(line, [
  { x: 101, y: 100 }, { x: 102, y: 100 },
  { x: 103, y: 100 }, { x: 104, y: 100 },
]);

const cone = spellAreaTiles(origin, target, { shape: 'cone', radius: 4, angle: 90 });
assert(cone.length > 4);
assert(cone.every((tile) => tile.x >= origin.x), 'cone must not spill behind caster');

assert.equal(spellRangeRing(origin, 10).length, 80, 'Chebyshev range perimeter');
assert.equal(spellRangeRing(origin, 99).length, 18 * 8, 'range is clamped');

const preview = new SpellRangePreview(new Container());
preview.setSpec({ range: 10, area: { shape: 'single', radius: 0 } });
assert.equal(preview.active, true);
bus.emit('target:active', { cursorType: 0, cursorId: 123, flag: 1 });
assert.equal(preview.active, false, 'a generic target prompt clears stale composer diamonds');
preview.destroy();

console.log('[smoke:spell-range-preview] ok');
