import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.fetch = async () => ({ ok: false });
globalThis.localStorage = globalThis.localStorage ?? {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const {
  lightPoints,
  measureLightGrid,
  mobileEquipmentLightSpec,
  sampleLightOcclusionForTests,
  staticLightSpec,
} = await import('../src/renderer/light-points.js');

const grid = Uint8Array.from([
  0, 0, 0, 0, 0,
  0, 8, 16, 8, 0,
  0, 16, 31, 16, 0,
  0, 8, 16, 8, 0,
  0, 0, 0, 0, 0,
]);
const measured = measureLightGrid({
  w: 5,
  h: 5,
  pixels: Buffer.from(grid).toString('base64'),
});

assert.equal(measured.peak, 31);
assert.equal(measured.radius, 1);

const torch = staticLightSpec(0x0A0C);
assert.equal(torch.radius, 4);
assert.equal(torch.color, 0xFFB060);
assert.equal(torch.peak, 31);
assert.equal(torch.lightIndex, 2);
assert.ok(torch.flicker > 0);

const heldTorch = mobileEquipmentLightSpec({
  equipment: new Map([[1, { itemId: 0x0A0C }]]),
});
assert.deepEqual(heldTorch, torch);

const moongate = staticLightSpec(0x0F6C);
assert.equal(moongate.radius, 7);
assert.equal(moongate.color, 0x70A4FF);
assert.ok(moongate.pulse > 0);

const fireField = staticLightSpec(0x398C);
assert.equal(fireField.color, 0xFF6038);
assert.ok(fireField.flicker > 0);

const packedTorch = mobileEquipmentLightSpec({
  equipment: new Map([[21, { itemId: 0x0A0C }]]),
});
assert.equal(packedTorch, null);

const nearId = lightPoints.add({ x: 100, y: 100, radius: 4 });
const farId = lightPoints.add({ x: 400, y: 400, radius: 4 });
const attachedId = lightPoints.add({ x: 0, y: 0, radius: 4, attachedSerial: 0x1234 });
const nearSlot = lightPoints._sourceSlots.get(nearId);
const farSlot = lightPoints._sourceSlots.get(farId);
assert.ok(lightPoints._sourceX instanceof Float32Array);
assert.ok(lightPoints._sourceColor instanceof Uint32Array);
assert.equal(lightPoints._sourceX[nearSlot], 100);
assert.equal(lightPoints._sourceY[farSlot], 400);
assert.equal(lightPoints._sourceAttachedSerial[lightPoints._sourceSlots.get(attachedId)], 0x1234);
let candidates = lightPoints._collectCandidateSources(100, 100, 18);
assert.ok(candidates.some((s) => s.x === 100 && s.y === 100));
assert.ok(candidates.some((s) => s.attachedSerial === 0x1234));
assert.equal(candidates.some((s) => s.x === 400 && s.y === 400), false);
lightPoints.update(farId, { x: 106, y: 106 });
assert.equal(lightPoints._sourceX[farSlot], 106);
assert.equal(lightPoints._sourceY[farSlot], 106);
candidates = lightPoints._collectCandidateSources(100, 100, 18);
assert.ok(candidates.some((s) => s.x === 106 && s.y === 106));
const stableSector = lightPoints._sourceSectorById.get(farId);
lightPoints.update(farId, { radius: 8, color: 0xffcc88, flicker: 0.1 });
assert.equal(lightPoints._sourceRadius[farSlot], 8);
assert.equal(lightPoints._sourceColor[farSlot], 0xffcc88);
assert.equal(
  lightPoints._sourceSectorById.get(farId),
  stableSector,
  'parameter-only light update should not dirty/reindex spatial sectors',
);
lightPoints.remove(nearId);
lightPoints.remove(farId);
lightPoints.remove(attachedId);
assert.equal(lightPoints.size(), 0);

const source = readFileSync(new URL('../src/renderer/light-points.js', import.meta.url), 'utf8');
for (const needle of [
  'const _lightTextures = new Map()',
  '_candidateSourceSlots',
  'new Float32Array(0)',
  'new Uint32Array(0)',
  '_collectCandidateSourceSlots',
  'this._sourceX[sourceSlot]',
  '_lightTextures.get(lightIndex)',
  'if (_lightTextures.has(idx)) continue',
  '_fallbackRadialTex',
]) {
  assert.ok(source.includes(needle), `LightPoints should reuse light textures: ${needle}`);
}

globalThis.__tileRenderer = {
  dynamicTallsAt: () => null,
  visuals: new Map(),
};
const occ = sampleLightOcclusionForTests(10, 10, 14, 14, 0, 0);
assert.equal(occ.first, 1);
assert.equal(occ.second, 1);
assert.equal(occ.calls, 2);
assert.equal(occ.misses, 1);
assert.equal(occ.hits, 1);
assert.ok(occ.capacity >= 256);

globalThis.__tileRenderer = {
  dynamicTallsAt: (x, y) => (x === 12 && y === 12
    ? [{ x, y, z: 0, height: 20, isWall: true, isTransparent: false }]
    : []),
  visuals: new Map(),
};
const wallOcc = sampleLightOcclusionForTests(10, 10, 14, 14, 0, 0);
assert.equal(wallOcc.first, 0, 'ground-level walls should fully block light');
delete globalThis.__tileRenderer;

console.log('[smoke:light-points] ok');
