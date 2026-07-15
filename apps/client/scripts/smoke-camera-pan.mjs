import assert from 'node:assert/strict';

const {
  camera, MIN_VIEW_W, MIN_VIEW_H, GAME_VIEW_ASPECT, calculateResponsiveViewport,
} = await import('../src/renderer/camera.js');
const { assets } = await import('../src/assets/asset-manager.js');

function makeWorldContainer() {
  return {
    scale: {
      value: 1,
      set(v) { this.value = v; },
    },
    position: {
      x: 0,
      y: 0,
      set(x, y) { this.x = x; this.y = y; },
    },
  };
}

const worldContainer = makeWorldContainer();

const wideLayout = calculateResponsiveViewport(2048, 732);
assert.ok(wideLayout.x >= 300 && wideLayout.x + wideLayout.w <= 2048 - 300,
  'wide layout must reserve useful left/right rails');
assert.ok(Math.abs(wideLayout.w / wideLayout.h - GAME_VIEW_ASPECT) < 0.01,
  'responsive viewport must preserve the 16:10 world aspect');
const compactLayout = calculateResponsiveViewport(1024, 768);
assert.ok(compactLayout.w >= 900 && compactLayout.x >= 0,
  'compact layout must collapse rails and prioritize the world');
const normalDesktop = calculateResponsiveViewport(2048, 1200);
const compactDesktop = calculateResponsiveViewport(2048, 1200, { compactSidePanels: true });
assert.ok(compactDesktop.w > normalDesktop.w && compactDesktop.x < normalDesktop.x,
  'compact side-panel mode must reclaim horizontal space for the world');

camera.setZoom(2);
camera.userSizedW = MIN_VIEW_W;
camera.userSizedH = MIN_VIEW_H;
camera.setUserPosition(31, 27);
camera.setViewport(1280, 900);
assert.deepEqual([camera.viewX, camera.viewY], [31, 27], 'browser resize preserves a user-positioned viewport');
const savedMapMeta = assets.mapMeta;
assets.mapMeta = { width: 100, height: 80 };
camera.follow(999, 999, 0);
assert.deepEqual([camera.worldX, camera.worldY], [99, 79], 'camera clamps to the active facet dimensions');
assets.mapMeta = savedMapMeta;
camera.follow(100, 100, 0);
camera.resetPan();
camera.apply(worldContainer);

const base = { x: worldContainer.position.x, y: worldContainer.position.y };

camera.panBy(24, -12);
camera.apply(worldContainer);
assert.equal(worldContainer.position.x - base.x, 24, 'panBy should preserve viewport-pixel X distance at zoom 2');
assert.equal(worldContainer.position.y - base.y, -12, 'panBy should preserve viewport-pixel Y distance at zoom 2');

camera.resetPan();
camera.apply(worldContainer);
assert.deepEqual(
  { x: worldContainer.position.x, y: worldContainer.position.y },
  base,
  'resetPan should restore strict player-follow camera position',
);

console.log('[smoke:camera-pan] ok');
