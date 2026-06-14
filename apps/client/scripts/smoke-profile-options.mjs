import assert from 'node:assert/strict';
import fs from 'node:fs';

const store = new Map([
  ['uo.profile', JSON.stringify({
    worldmap: {
      partyBlips: false,
      guildBlips: true,
      defaultZoom: 2.5,
    },
  })],
]);

globalThis.localStorage = globalThis.localStorage ?? {
  getItem: (key) => store.get(String(key)) ?? null,
  setItem: (key, value) => { store.set(String(key), String(value)); },
  removeItem: (key) => { store.delete(String(key)); },
};

const { profile } = await import('../src/managers/profile-manager.js');
assert.equal(profile.get('worldmap.showParty'), false, 'legacy partyBlips should migrate to showParty');
assert.equal(profile.get('worldmap.showGuild'), true, 'legacy guildBlips should migrate to showGuild');
assert.equal(profile.get('worldmap.zoom'), 2.5, 'legacy defaultZoom should migrate to zoom');

const src = fs.readFileSync(new URL('../src/ui/gumps/options-gump.js', import.meta.url), 'utf8');
const worldmapSrc = fs.readFileSync(new URL('../src/ui/gumps/worldmap-gump.js', import.meta.url), 'utf8');
const paths = new Set();
for (const re of [
  /profile\.get\('([^']+)'\)/g,
  /profile\.set\('([^']+)'/g,
  /_add(?:Checkbox|Slider|Picker)\([^\n]*?'([^']+\.[^']+)'/g,
]) {
  for (const m of src.matchAll(re)) paths.add(m[1]);
}

function hasProfilePath(path) {
  let node = profile.settings;
  for (const part of path.split('.')) {
    if (!node || !Object.prototype.hasOwnProperty.call(node, part)) return false;
    node = node[part];
  }
  return true;
}

const missing = [...paths].sort().filter((path) => !hasProfilePath(path));
assert.deepEqual(missing, []);

for (const stale of ['worldmap.partyBlips', 'worldmap.guildBlips', 'worldmap.defaultZoom', 'worldmap.lastZoom']) {
  assert.equal(worldmapSrc.includes(stale), false, `WorldmapGump should not read stale profile key ${stale}`);
}
for (const consumed of [
  'worldmap.showParty',
  'worldmap.showGuild',
  'worldmap.showCoordinates',
  'worldmap.showGridIfZoomed',
  'worldmap.markerSize',
  'ui.worldMapShowMobiles',
]) {
  assert.equal(worldmapSrc.includes(consumed), true, `WorldmapGump should consume profile key ${consumed}`);
}
assert.equal(worldmapSrc.includes('worldMapEntities.entities'), false, 'WorldmapGump should use WorldMapEntityManager.getPins()');
assert.equal(worldmapSrc.includes('worldMapEntities.getPins'), true, 'WorldmapGump should read party/guild pins through getPins()');
assert.equal(worldmapSrc.includes('worldmapSettings'), false, 'WorldmapGump should not reference stale worldmapSettings globals');
assert.ok(worldmapSrc.includes('_addOverlayCluster'), 'WorldmapGump should cluster overlay pins at low zoom');
assert.ok(worldmapSrc.includes('worldMapStats'), 'WorldmapGump should expose overlay clustering stats');

console.log('[smoke:profile-options] ok');
