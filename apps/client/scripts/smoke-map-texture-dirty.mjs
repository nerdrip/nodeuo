import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const minimap = read('../src/ui/gumps/minimap-gump.js');
const worldmap = read('../src/ui/gumps/worldmap-gump.js');

for (const needle of [
  '_lastFrameCx',
  '_lastFrameMobileRev',
  '_basePixels',
  '_scrollTerrain',
  'this._texture.source.update()',
]) {
  assert.ok(minimap.includes(needle), `Minimap should keep dirty texture path: ${needle}`);
}

for (const needle of [
  '_lastTerrainZoom',
  '_lastTerrainX0',
  '_lastTerrainY0',
  'return false',
  'this._tex.source.update()',
]) {
  assert.ok(worldmap.includes(needle), `Worldmap should keep dirty texture path: ${needle}`);
}

assert.ok(worldmap.includes('_addOverlayCluster'), 'Worldmap marker overlay should stay clustered at low zoom');
for (const needle of [
  'this._visibleSerials = new Uint32Array(32)',
  '_visibleSerialCount',
  '_addVisibleSerial',
  '_hasVisibleSerial',
  '_ensureVisibleSerialCapacity',
]) {
  assert.ok(worldmap.includes(needle), `Worldmap should keep stable typed visible serial list: ${needle}`);
}
assert.ok(!worldmap.includes('this._visibleSerials = new Set()'), 'Worldmap should not use Set for visible serial overlay scratch');

console.log('[smoke:map-texture-dirty] ok');
