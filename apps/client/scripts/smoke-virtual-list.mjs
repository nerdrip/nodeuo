import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { calculateVirtualWindow } from '../src/shared/virtual-list.js';

const first = calculateVirtualWindow({
  scrollY: 0,
  viewportSize: 100,
  itemSize: 20,
  itemCount: 50,
  overscan: 2,
});
assert.deepEqual(first, { start: 0, end: 7, before: 0, after: 860, total: 1000 });

const mid = calculateVirtualWindow({
  scrollY: 240,
  viewportSize: 100,
  itemSize: 20,
  itemCount: 50,
  overscan: 2,
});
assert.deepEqual(mid, { start: 10, end: 19, before: 200, after: 620, total: 1000 });

const clamped = calculateVirtualWindow({
  scrollY: 5000,
  viewportSize: 100,
  itemSize: 20,
  itemCount: 50,
  overscan: 2,
});
assert.equal(clamped.end, 50);
assert.equal(clamped.after, 0);

assert.deepEqual(calculateVirtualWindow({ itemCount: 0 }), {
  start: 0,
  end: 0,
  before: 0,
  after: 0,
  total: 0,
});

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const commandPanel = read('../src/managers/command-panel.js');
const advancedSkills = read('../src/ui/gumps/skill-gump-advanced.js');

for (const needle of [
  'calculateVirtualWindow',
  '_renderVirtualList',
  'uo-cmd-spacer',
  'COMMAND_OVERSCAN',
]) {
  assert.ok(commandPanel.includes(needle), `CommandPanel should use virtual command rows: ${needle}`);
}

assert.ok(advancedSkills.includes('calculateVirtualWindow'), 'SkillGumpAdvanced should use the shared virtual range helper');

console.log('[smoke:virtual-list] ok');
