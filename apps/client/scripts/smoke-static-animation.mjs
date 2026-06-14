import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isAnimdataStaticGraphic } from '../src/renderer/static-animation.js';

const assetUrl = (name) => new URL(`../public/assets/${name}`, import.meta.url);
const tiledata = JSON.parse(readFileSync(assetUrl('tiledata.json'), 'utf8'));
const animdata = JSON.parse(readFileSync(assetUrl('animdata.json'), 'utf8'));

const shouldAnimate = [
  0x0475, // fireplace
  0x0DDA, // red moongate
  0x0DE3, // campfire
  0x0F6C, // blue moongate
  0x1FD4, // Tokuno moongate
  0x29FD, // fire pit
  0x346E, // water
  0x398C, // field of fire
];

for (const id of shouldAnimate) {
  assert.equal(
    isAnimdataStaticGraphic(tiledata, animdata, id),
    true,
    `0x${id.toString(16)} should use animdata`,
  );
}

const shouldStayStatic = [
  0x154D, // water barrel has animdata junk but no Animation flag
  0x1BC3, // teleporter floor plate has no animdata entry
];

for (const id of shouldStayStatic) {
  assert.equal(
    isAnimdataStaticGraphic(tiledata, animdata, id),
    false,
    `0x${id.toString(16)} should not use animdata`,
  );
}

console.log('[smoke:static-anim] ok');
