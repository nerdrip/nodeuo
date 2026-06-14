import assert from 'node:assert/strict';

const { ScrollFlag } = await import('../src/ui/controls/scroll-flag.js');

const flag = new ScrollFlag({ height: 116, min: 0, max: 100, value: 25 });
assert.equal(flag.value, 25);
assert.equal(flag.sliderY(), 25);

let changed = null;
flag.onChange = (value) => { changed = value; };
flag.setValue(200);
assert.equal(flag.value, 100);
assert.equal(changed, 100);
assert.equal(flag.sliderY(), 100);

flag.setRange(10, 10);
assert.equal(flag.scrollable, false);
assert.equal(flag.sliderY(), 0);

console.log('[smoke:scroll-flag] ok');
