import assert from 'node:assert/strict';

const { camera, MIN_VIEW_W, MIN_VIEW_H } = await import('../src/renderer/camera.js');

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

camera.setZoom(2);
camera.userSizedW = MIN_VIEW_W;
camera.userSizedH = MIN_VIEW_H;
camera.setViewport(1280, 900);
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
