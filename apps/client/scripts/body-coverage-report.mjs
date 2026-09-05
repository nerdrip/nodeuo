import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { BODY_FALLBACK } from '../src/assets/mobile-atlas.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const manifestUrl = new URL('../public/assets/mobiles-atlas.json', import.meta.url);
const indexUrl = new URL('../public/assets/mobiles-atlas-index.json', import.meta.url);

function bodyEntry(atlas, bodyId) {
  return atlas?.bodies?.[bodyId] ?? atlas?.bodies?.[String(bodyId)] ?? null;
}

function hasFrames(body) {
  return framesForBody(body).length > 0;
}

function aliasTarget(atlas, bodyId) {
  const alias = atlas?.aliases?.[bodyId] ?? atlas?.aliases?.[String(bodyId)];
  return alias?.body ?? alias?.trueBody ?? null;
}

function resolveBody(atlas, bodyId, fallback) {
  const chain = [bodyId];
  const exactSource = atlas?.bodyConv?.[bodyId]
    || (((atlas?.mobTypes?.[bodyId]?.flags | 0) & 0x10000) !== 0);
  if (exactSource && hasFrames(bodyEntry(atlas, bodyId))) {
    return { resolved: bodyId, via: 'exact-source', chain };
  }

  const alias = aliasTarget(atlas, bodyId);
  if (Number.isFinite(alias)) {
    chain.push(alias);
    if (hasFrames(bodyEntry(atlas, alias))) return { resolved: alias, via: 'alias', chain };
  }

  if (hasFrames(bodyEntry(atlas, bodyId))) return { resolved: bodyId, via: 'direct', chain };

  const sub = fallback.get(bodyId);
  if (Number.isFinite(sub)) {
    chain.push(sub);
    if (hasFrames(bodyEntry(atlas, sub))) return { resolved: sub, via: 'fallback', chain };
  }

  const generic = bodyId < 200 ? 9 : (bodyId < 400 ? 226 : null);
  if (generic != null) {
    chain.push(generic);
    if (hasFrames(bodyEntry(atlas, generic))) return { resolved: generic, via: 'generic', chain };
  }

  return { resolved: null, via: 'missing', chain };
}

function framesForBody(body) {
  const actions = body?.actions ?? body ?? {};
  const frames = [];
  for (const action of Object.values(actions)) {
    const dirs = action?.dirs ?? action?.directions ?? action ?? {};
    for (const dir of Object.values(dirs)) {
      const list = Array.isArray(dir) ? dir : (dir?.frames ?? []);
      for (const frame of list) {
        if (frame && Number.isFinite(frame.w) && Number.isFinite(frame.h)) frames.push(frame);
      }
    }
  }
  return frames;
}

if (!existsSync(manifestUrl) && !existsSync(indexUrl)) {
  console.log('[body-coverage] skipped: no mobile atlas manifest is present');
  process.exit(0);
}

const atlas = existsSync(indexUrl)
  ? JSON.parse(read('../public/assets/mobiles-atlas-index.json'))
  : JSON.parse(read('../public/assets/mobiles-atlas.json'));
if (atlas.shards) {
  atlas.bodies = {};
  for (const row of Object.values(atlas.shards)) {
    const shard = JSON.parse(read(`../public/assets/${row.file}`));
    Object.assign(atlas.bodies, shard.bodies ?? {});
  }
}
const fallback = new Map(Object.entries(BODY_FALLBACK).map(([body, target]) => [Number(body), target]));
const bodyIds = Object.keys(atlas.bodies ?? {}).map((id) => Number(id)).filter(Number.isFinite);
const aliasCount = Object.keys(atlas.aliases ?? {}).length;
const equipConvCount = Object.keys(atlas.equipConv ?? {}).length;
const corpseConvCount = Object.keys(atlas.corpseConv ?? {}).length;
const bodyConvCount = Object.keys(atlas.bodyConv ?? {}).length;
const modernUopSchema = (atlas.schemaVersion | 0) >= 2
  && atlas.mobTypes
  && atlas.uopActions;

let totalFrames = 0;
const emptyBodies = [];
const tinyBodies = [];
for (const bodyId of bodyIds) {
  const frames = framesForBody(bodyEntry(atlas, bodyId));
  totalFrames += frames.length;
  if (frames.length === 0) {
    emptyBodies.push(bodyId);
    continue;
  }
  let maxW = 0;
  let maxH = 0;
  for (const frame of frames) {
    maxW = Math.max(maxW, frame.w | 0);
    maxH = Math.max(maxH, frame.h | 0);
  }
  if (maxW < 16 && maxH < 16) tinyBodies.push(bodyId);
}

const raceBodies = [
  ['human male', 0x190],
  ['human female', 0x191],
  ['elf male', 0x25d],
  ['elf female', 0x25e],
  ['gargoyle male', 0x29a],
  ['gargoyle female', 0x29b],
];
const raceResults = raceBodies.map(([label, bodyId]) => [label, bodyId, resolveBody(atlas, bodyId, fallback)]);

assert.ok((atlas.pageCount | 0) > 0, 'mobiles atlas should expose pageCount');
assert.ok(bodyIds.length > 700, 'mobiles atlas should contain the extracted body set');
assert.ok(totalFrames > 10000, 'mobiles atlas should contain animation frames');
for (const [label, bodyId, result] of raceResults) {
  assert.notEqual(result.resolved, null, `${label} body 0x${bodyId.toString(16)} should resolve`);
}
const lavaSnake = resolveBody(atlas, 52, fallback);
assert.equal(lavaSnake.resolved, 51, 'empty lava-snake body must use giant-serpent art, not generic daemon');
assert.equal(lavaSnake.via, 'fallback', 'lava-snake substitution must be an explicit same-family fallback');

console.log(`[body-coverage] pages=${atlas.pageCount} bodies=${bodyIds.length} frames=${totalFrames}`);
console.log(`[body-coverage] aliases=${aliasCount} bodyConv=${bodyConvCount} fallback=${fallback.size} equipConv=${equipConvCount} corpseConv=${corpseConvCount}`);
console.log(`[body-coverage] emptyBodies=${emptyBodies.length} tinyBodies=${tinyBodies.length}`);
if (!modernUopSchema) {
  console.warn('[body-coverage] WARNING: generated atlas predates AnimationSequence/UOP schema v2; re-run the extractor from a legal UO install.');
}
for (const [label, , result] of raceResults) {
  const chain = result.chain.map((id) => `0x${id.toString(16)}`).join(' -> ');
  console.log(`[body-coverage] ${label}: ${chain} (${result.via})`);
}
console.log('[smoke:body-coverage] ok');
