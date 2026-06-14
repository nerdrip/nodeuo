import assert from 'node:assert/strict';

const { ColorBox, approxHueRgb } = await import('../src/ui/controls/color-box.js');
const { ClickableColorBox } = await import('../src/ui/controls/clickable-color-box.js');

const box = new ColorBox({ width: 24, height: 12, color: 0x112233 });
assert.equal(box.width, 24);
assert.equal(box.height, 12);
assert.equal(box.color, 0x112233);
assert.equal(box.hue, null);
assert.equal(box.hitTest(23, 11), true);
assert.equal(box.hitTest(24, 11), false);

box.setHue(0x44);
assert.equal(box.hue, 0x44);
assert.equal(typeof approxHueRgb(0x44), 'number');

box.setSelected(true);
assert.equal(box.selected, true);
box.setColor(0xaabbcc);
assert.equal(box.color, 0xaabbcc);
assert.equal(box.hue, null);

let changed = 0;
const clickable = new ClickableColorBox({ width: 18, height: 18, hue: 0x21 });
clickable.onChange = (hue) => { changed = hue; };
clickable.setHue(0x35);
assert.equal(clickable.hue, 0x35);
assert.equal(changed, 0x35);
assert.equal(clickable.children.length, 1);
assert.equal(clickable.children[0] instanceof ColorBox, true);

console.log('[smoke:color-box] ok');
