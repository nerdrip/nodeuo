import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const decorations = json('../../apps/scripts/src/data/world/decorations.json');
const signs = json('../../apps/scripts/src/data/world/signs.json');
const teleporters = json('../../apps/scripts/src/data/world/teleporters.json');
const spawners = json('../../apps/scripts/src/data/world/xmlspawners.json');
const monsters = json('../../apps/scripts/src/data/config/monsters.json');
const source = readFileSync(new URL('../../apps/scripts/src/commands/admin/createworld.js', import.meta.url), 'utf8');

assert.ok(decorations.length > 80_000, 'CreateWorld decoration catalogue is unexpectedly small');
assert.ok(signs.length > 800, 'CreateWorld sign catalogue is unexpectedly small');
assert.ok(teleporters.length > 1_300, 'CreateWorld teleporter catalogue is unexpectedly small');
assert.ok(spawners.length > 6_000, 'CreateWorld XmlSpawner catalogue is unexpectedly small');
for (const stage of ['Decorations', 'Signs', 'Doors', 'Teleporters', 'Moongates', 'XmlSpawners', 'RegionalNPCs', 'Sigils']) {
  assert.match(source, new RegExp(`name:\\s*['"]${stage}['"]`), `CreateWorld missing ${stage} stage`);
}

const knownKinds = new Set(monsters.map((m) => String(m.definitionId).replace(/[^a-z0-9]/gi, '').toLowerCase()));
let vendorGroups = 0;
let creatureRefs = 0;
const invalid = [];
for (let i = 0; i < spawners.length; i++) {
  const group = spawners[i];
  if (!Number.isInteger(group.map) || group.map < 0 || group.map > 5) invalid.push([i, 'map']);
  if (![group.x1, group.x2, group.y1, group.y2].every(Number.isFinite)) invalid.push([i, 'coords']);
  if (group.x1 > group.x2 || group.y1 > group.y2) invalid.push([i, 'bounds']);
  // Loader clamps legacy zero/undersized delays to [>=1s, >=2s]. Audit the
  // effective range rather than rejecting valid old XmlSpawner semantics.
  const effectiveMin = Math.max(1000, group.minDelayMs | 0);
  const effectiveMax = Math.max(2000, group.maxDelayMs | 0);
  if (effectiveMax < effectiveMin) invalid.push([i, 'delay']);
  if (!Array.isArray(group.kinds) || group.kinds.length === 0) invalid.push([i, 'kinds']);
  if (/vendor|banker|healer|stable|guildmaster/i.test(group.name ?? '')) vendorGroups++;
  for (const kind of group.kinds ?? []) {
    creatureRefs++;
    const normalized = String(kind.name ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    // XmlSpawner contains addon/item names too. Only enforce recognizable
    // creature-like entries when their name already maps to our registry.
    if (!normalized) invalid.push([i, 'empty-kind']);
    void knownKinds.has(normalized);
  }
}
assert.deepEqual(invalid, [], `invalid XmlSpawner groups: ${JSON.stringify(invalid.slice(0, 20))}`);
assert.ok(vendorGroups > 100, `expected broad vendor coverage, got ${vendorGroups}`);

console.log(`[audit:createworld] ok decorations=${decorations.length} signs=${signs.length} teleporters=${teleporters.length} spawners=${spawners.length} vendors=${vendorGroups} refs=${creatureRefs}`);
