import assert from 'node:assert/strict';
import { Texture } from 'pixi.js';

globalThis.CanvasRenderingContext2D = globalThis.CanvasRenderingContext2D ?? function CanvasRenderingContext2D() {};
globalThis.document = globalThis.document ?? {
  createElement: () => ({
    getContext: () => ({
      font: '',
      measureText: (text) => ({
        width: String(text ?? '').length * 6,
        actualBoundingBoxAscent: 9,
        actualBoundingBoxDescent: 3,
        fontBoundingBoxAscent: 9,
        fontBoundingBoxDescent: 3,
      }),
    }),
  }),
};
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame
  ?? ((fn) => setTimeout(() => fn(Date.now()), 16));
globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame
  ?? ((id) => clearTimeout(id));

const { assets } = await import('../src/assets/asset-manager.js');
const originalFrame = assets.mobileFrameTextureSync;
const originalResolve = assets.resolveEquipAnim;
const originalPrefetch = assets.prefetchMobileCycle;

assets.mobileFrameTextureSync = () => ({
  texture: Texture.WHITE,
  cx: 8,
  cy: 0,
  w: 16,
  h: 32,
  frameCount: 2,
});
assets.resolveEquipAnim = (_body, itemId, hue) => ({ animBody: itemId, hue });
assets.prefetchMobileCycle = async () => {};

const { AnimatedCharacterFrame } = await import('../src/ui/controls/animated-character-frame.js');
const { RaceChangeGump } = await import('../src/ui/gumps/race-change-gump.js');

const frame = new AnimatedCharacterFrame({
  body: 0x190,
  hue: 0x83EA,
  equipment: [{ layer: 11, itemId: 0x203B, hue: 0x44E }],
});
frame.tick(1 / 6);
assert.equal(frame.body, 0x190);
assert.equal(frame._bodySprite.visible, true);
assert.equal(frame._equipment.length, 1);
frame.dispose();

const gump = new RaceChangeGump({ allowed: ['human', 'gargoyle'] });
assert.equal(gump._preview instanceof AnimatedCharacterFrame, true);
assert.equal(gump._preview.body, 0x190);
const controlsAfterFirstBuild = gump._comboControls.length;

gump._sel.race = 'gargoyle';
gump._sel.sex = 'female';
gump._sel.hairId = 0x4258;
gump._sel.beardId = 0x4260;
gump._rebuildCombos();
gump._refreshPreview();

assert.equal(gump._preview.body, 0x29B);
assert.deepEqual(gump._preview._equipment.map((eq) => eq.layer), [11, 16]);
assert.ok(gump._comboControls.length <= controlsAfterFirstBuild + 2);

gump.dispose();
assets.mobileFrameTextureSync = originalFrame;
assets.resolveEquipAnim = originalResolve;
assets.prefetchMobileCycle = originalPrefetch;

console.log('[smoke:race-preview] ok');
