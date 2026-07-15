import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateAnimationManifest } from '../anim.js';
import { GROUP, groupBaseIndex, loadBodyConfig, pickAnimFile, resolveIdxIndex } from '../body-config.js';

test('parses retail Bodyconv rows and CUO grouped body/corpse definitions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nodeuo-body-config-'));
  try {
    writeFileSync(join(dir, 'Bodyconv.def'), [
      '# index anim2 anim3 anim4 anim5',
      '794 100 200 -1 300',
      '791 -1 161 -1 -1',
    ].join('\n'));
    writeFileSync(join(dir, 'Body.def'), [
      '794 { 11 22 219 } 102',
      '52 { 51 } 0',
      '52 { 9 } 999',
    ].join('\n'));
    writeFileSync(join(dir, 'Corpse.def'), '794 { 31 32 33 } 44\n');
    writeFileSync(join(dir, 'Equipconv.def'), [
      '400 1000 500 0 -1',
      '401 1001 501 -1 20',
    ].join('\n'));
    writeFileSync(join(dir, 'mobtypes.txt'), '794 MONSTER 0\n');

    const cfg = loadBodyConfig(dir);
    assert.deepEqual(cfg.bodyConv.get(794), { fileIndex: 4, indexInFile: 300 });
    assert.deepEqual(cfg.bodyConv.get(791), { fileIndex: 2, indexInFile: 161 });
    assert.deepEqual(cfg.bodyAlias.get(794), { trueBody: 219, hue: 102 });
    assert.deepEqual(cfg.bodyAlias.get(52), { trueBody: 51, hue: 0 });
    assert.deepEqual(cfg.corpseConv.get(794), { corpseBody: 33, corpseHue: 44 });
    assert.deepEqual(cfg.equipConv.get(400).get(1000), {
      animBody: 500, gump: 1000, hue: 0xFFFF,
    });
    assert.deepEqual(cfg.equipConv.get(401).get(1001), {
      animBody: 501, gump: 501, hue: 20,
    });
    assert.equal(pickAnimFile(794, cfg.bodyConv), 4);
    assert.equal(
      resolveIdxIndex(794, 4, 1, 2, cfg.bodyConv, cfg.mobTypes),
      groupBaseIndex(300, GROUP.High) + 7,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validates schema-v3 animation manifests before publishing atlas pages', () => {
  const manifest = {
    schemaVersion: 3,
    pageCount: 1,
    atlasW: 64,
    atlasH: 64,
    bodyConv: { 794: { fileIndex: 1, indexInFile: 205 } },
    bodies: {
      794: { actions: { 0: { dirs: { 0: [{ page: 0, u: 2, v: 3, w: 20, h: 30, cx: 10, cy: 20 }] } } } },
    },
  };
  assert.deepEqual(validateAnimationManifest(manifest, { expectedBodyConv: 1 }), {
    pages: 1, bodies: 1, frames: 1, bodyConv: 1,
  });
  manifest.bodies[794].actions[0].dirs[0][0].w = 100;
  assert.throws(() => validateAnimationManifest(manifest), /out-of-bounds frame/);
});
