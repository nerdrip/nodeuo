#!/usr/bin/env node
// Audit and mechanically enrich item definitions with the extracted UO
// equipment layer and paperdoll gumps. Gameplay identity is never inferred
// from artwork: definitionId remains authoritative and any number of records
// may intentionally share artId and gump IDs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILES = [
  path.join(ROOT, 'apps/scripts/src/data/config/items.json'),
  path.join(ROOT, 'apps/scripts/src/data/config/item-types.json'),
];
const ASSETS = path.join(ROOT, 'apps/client/public/assets');
const tiledata = JSON.parse(fs.readFileSync(path.join(ASSETS, 'tiledata.json'), 'utf8'));
const gumps = JSON.parse(fs.readFileSync(path.join(ASSETS, 'gump-atlas.json'), 'utf8')).tiles ?? {};
const itemTypes = JSON.parse(fs.readFileSync(FILES[1], 'utf8'));
const write = process.argv.includes('--write');
const normalize = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const typesByIdentity = new Map(Object.values(itemTypes).map((entry) => [normalize(entry.definitionId), entry]));

function derivedGumps(artId) {
  const tile = tiledata.statics?.[artId];
  const animationId = Number(tile?.animId ?? 0) | 0;
  if (!animationId) return { tile, animationId, male: 0, female: 0 };
  const male = gumps[animationId + 50000] ? animationId + 50000 : 0;
  const femaleSpecific = gumps[animationId + 60000] ? animationId + 60000 : 0;
  return { tile, animationId, male, female: femaleSpecific || male, femaleSpecific };
}

function enrich(record) {
  const artId = Number(record.artId);
  const resolved = derivedGumps(artId);
  // The supplied client has the Fur Boots wearable animation but omits its
  // otherwise conventional gump slot. Use the visually compatible boots
  // paperdoll pair explicitly; leaving it implicit makes the item disappear.
  if (!resolved.male && artId === 0x2307) {
    record.clothing = true;
    record.equipLayer = Number(resolved.tile?.layer ?? 3) | 0;
    record.paperdollGumpId = 50477;
    record.paperdollMaleGumpId = 50477;
    record.paperdollFemaleGumpId = 60477;
    return true;
  }
  if (!resolved.male) return false;
  const layer = Number(resolved.tile?.layer ?? record.equipLayer ?? 0) | 0;
  if (layer <= 0 && !record.clothing) return false;
  record.clothing = true;
  if (layer > 0) record.equipLayer = layer;
  record.paperdollGumpId = resolved.male;
  record.paperdollMaleGumpId = resolved.male;
  record.paperdollFemaleGumpId = resolved.female;
  return true;
}

const canonical = JSON.parse(fs.readFileSync(FILES[0], 'utf8'));
let correctedArt = 0;
for (const record of canonical) {
  if (!(record.clothing || Number(record.equipLayer) > 0)) continue;
  const extracted = typesByIdentity.get(normalize(record.definitionId));
  const candidate = Number(extracted?.artId);
  const candidateTile = tiledata.statics?.[candidate];
  // Only use a strongly typed ServUO equipment constructor. Some generated
  // item-types entries contain constructor parameters unrelated to graphics
  // (often 1); those are intentionally rejected here.
  if (candidate > 1 && candidate !== record.artId
      && String(extracted?.base ?? '').startsWith('Base')
      && Number(candidateTile?.animId) > 0 && String(candidateTile?.name ?? '').trim()) {
    record.artId = candidate;
    correctedArt++;
  }
}

// These two hand-authored records have no unambiguous same-name entry in the
// extracted type catalogue.
const kiteShield = canonical.find((entry) => entry.definitionId === 'kite-shield');
if (kiteShield && kiteShield.artId !== 0x1B74) { kiteShield.artId = 0x1B74; correctedArt++; }
const shovel = canonical.find((entry) => entry.definitionId === 'shovel');
if (shovel) {
  delete shovel.clothing;
  delete shovel.equipLayer;
  delete shovel.slot;
  delete shovel.paperdollGumpId;
  delete shovel.paperdollMaleGumpId;
  delete shovel.paperdollFemaleGumpId;
}

let canonicalEnriched = 0;
const unresolved = [];
for (const record of canonical) {
  if (!(record.clothing || Number(record.equipLayer) > 0)) continue;
  if (enrich(record)) canonicalEnriched++;
  else unresolved.push({ definitionId: record.definitionId, artId: record.artId });
}

let libraryEnriched = 0;
for (const record of Object.values(itemTypes)) {
  const tile = tiledata.statics?.[Number(record.artId)];
  if ((Number(tile?.layer) | 0) <= 0) continue;
  if (enrich(record)) libraryEnriched++;
}

if (write) {
  fs.writeFileSync(FILES[0], JSON.stringify(canonical, null, 2) + '\n');
  fs.writeFileSync(FILES[1], JSON.stringify(itemTypes, null, 2) + '\n');
}

console.log(JSON.stringify({
  mode: write ? 'write' : 'audit', correctedArt, canonicalEnriched,
  libraryEnriched, unresolved, identityRule: 'definitionId (artId is presentation only)',
}, null, 2));
