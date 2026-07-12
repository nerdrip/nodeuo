import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
globalThis.window ??= globalThis;
globalThis.window.addEventListener ??= () => {};
globalThis.window.removeEventListener ??= () => {};
globalThis.CanvasRenderingContext2D ??= class CanvasRenderingContext2D {
  constructor() {
    this.font = '';
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
  }

  measureText(text) {
    const width = String(text ?? '').length * 7;
    return {
      width,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: width,
      actualBoundingBoxAscent: 10,
      actualBoundingBoxDescent: 3,
      fontBoundingBoxAscent: 10,
      fontBoundingBoxDescent: 3,
    };
  }

  clearRect() {}
  drawImage() {}
  fillRect() {}
  fillText() {}
  getImageData() { return { data: new Uint8ClampedArray(4) }; }
  restore() {}
  save() {}
  scale() {}
  setTransform() {}
  strokeText() {}
};
globalThis.document ??= {
  body: {
    appendChild() {},
    removeChild() {},
  },
  createElement(tag) {
    if (tag !== 'canvas') {
      return {
        style: {},
        appendChild() {},
        remove() {},
        addEventListener() {},
        removeEventListener() {},
      };
    }
    return {
      width: 0,
      height: 0,
      style: {},
      addEventListener() {},
      removeEventListener() {},
      getContext() {
        return new globalThis.CanvasRenderingContext2D();
      },
    };
  },
};
globalThis.localStorage = globalThis.localStorage ?? {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const root = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const sourceFiles = walk(root).map((full) => ({
  rel: path.relative(root, full).replaceAll(path.sep, '/'),
  text: readFileSync(full, 'utf8'),
}));
const byRel = new Map(sourceFiles.map(({ rel, text }) => [rel, text]));

function consumersFor(key) {
  return sourceFiles
    .filter(({ rel }) => rel !== 'managers/profile-manager.js' && rel !== 'ui/gumps/options-gump.js')
    .filter(({ text }) => text.includes(key))
    .map(({ rel }) => rel);
}

const criticalProfileConsumers = new Map([
  ['ui.circleOfTransparencyType', ['renderer/tile-renderer.js']],
  ['ui.circleOfTransparencyRadius', ['renderer/tile-renderer.js']],
  ['debug.cotOverlay', ['renderer/tile-renderer.js']],
  ['debug.roofOverlay', ['renderer/tile-renderer.js']],
  ['ui.fieldsType', ['renderer/tile-renderer.js']],
  ['ui.treeToStumps', ['renderer/tile-renderer.js']],
  ['ui.hideVegetation', ['renderer/tile-renderer.js']],
  ['ui.enableCaveBorder', ['renderer/tile-renderer.js']],
  ['debug.skipAnimData', ['renderer/tile-renderer.js']],
  ['graphics.noColorObjectsOutOfRange', [
    'renderer/tile-renderer.js',
    'renderer/mobile-renderer.js',
    'scenes/game-scene.js',
  ]],
  ['graphics.hideUnderRoof', ['renderer/tile-renderer.js']],
]);

for (const [key, expectedFiles] of criticalProfileConsumers) {
  const consumers = consumersFor(key);
  assert.ok(consumers.length > 0, `${key} should have at least one non-UI consumer`);
  for (const expected of expectedFiles) {
    assert.ok(consumers.includes(expected), `${key} should be consumed by ${expected}; got ${consumers.join(', ')}`);
  }
}

const networkStats = byRel.get('ui/gumps/network-stats-gump.js') ?? '';
assert.ok(networkStats.includes('_exportMovementTrace'), 'NetworkStatsGump should expose movement trace export');
assert.ok(networkStats.includes("bus.emit('debug:movement-trace'"), 'movement trace export should emit a diagnostic event');

const mobileRenderer = byRel.get('renderer/mobile-renderer.js') ?? '';
for (const needle of [
  'const CHAIR_GRAPHICS = new Set',
  'function detectChairUnder',
  'const sitting = !isPlayer && canSit && detectChairUnder(mob)',
  'this._anim.frame = 0',
  'mob.sitPoseOffsetY',
]) {
  assert.ok(mobileRenderer.includes(needle), `chair sitting parity should include ${needle}`);
}

const boatManagerSource = byRel.get('managers/boat-moving-manager.js') ?? '';
for (const needle of [
  'const BOAT_FACING_MULTI = new Map',
  'function multiFootprint',
  'offsetX = offX',
  'offsetY = offY',
  'r.ent.x += ddx',
  'multiForFacing',
]) {
  assert.ok(boatManagerSource.includes(needle), `boat visual parity should include ${needle}`);
}

const gameSceneSource = byRel.get('scenes/game-scene.js') ?? '';
assert.ok(gameSceneSource.includes('houseCustomization.setPreviewTile'), 'house customization should update tile preview from mouse move');
assert.ok(gameSceneSource.includes('houseCustomization.place(tile.x, tile.y, tile.z)'), 'house customization should place brush on world click');
assert.ok(gameSceneSource.includes('houseCustomization.erase(0, tile.x, tile.y, tile.z)'), 'house customization should erase on world click');

const worldTextSource = byRel.get('managers/world-text-manager.js') ?? '';
for (const needle of ['TEXT_POOL_CAP', 'worldTextStats', 'acquireTextNode', 'releaseTextNode']) {
  assert.ok(worldTextSource.includes(needle), `world text lifecycle should include ${needle}`);
}

const tooltipSource = byRel.get('managers/tooltip-manager.js') ?? '';
for (const needle of ["bus.on('tooltip:revision'", '& ~0x40000000', "bus.on('cliloc:ready'", 'this._cache.delete(s)']) {
  assert.ok(tooltipSource.includes(needle), `tooltip invalidation should include ${needle}`);
}

const { MapPinEditorGump, parseMapPinsPayload } = await import('../src/ui/gumps/map-pin-editor-gump.js');

const parsed = parseMapPinsPayload('40001234||320||240||12|34|Bank;80|90|TMap|spot');
assert.equal(parsed.itemSerial, 0x40001234);
assert.equal(parsed.width, 320);
assert.equal(parsed.height, 240);
assert.deepEqual(parsed.pins, [
  { x: 12, y: 34, label: 'Bank' },
  { x: 80, y: 90, label: 'TMap|spot' },
]);

const mapGump = Object.create(MapPinEditorGump.prototype);
Object.assign(mapGump, {
  _itemSerial: 0x40001234,
  _pins: [],
  _canvasW: 320,
  _canvasH: 320,
  _x1: 100,
  _y1: 200,
  _x2: 420,
  _y2: 520,
  _renderPinsCalls: 0,
  _renderPins() { this._renderPinsCalls++; },
});

assert.deepEqual(mapGump._pinCanvasPoint(260, 360), { x: 160, y: 160 });
assert.deepEqual(mapGump._canvasToMapPoint(160, 160), { x: 260, y: 360 });

mapGump._handleMapPinPacket({ serial: 0x40001234, cmd: 1, pinNum: 0, x: 260, y: 360 });
assert.deepEqual(mapGump._pins, [{ x: 260, y: 360, label: 'Pin 1' }]);
mapGump._handleMapPinPacket({ serial: 0x40001234, cmd: 3, pinNum: 0, x: 300, y: 390 });
assert.deepEqual(mapGump._pins[0], { x: 300, y: 390, label: 'Pin 1' });
mapGump._handleMapPinPacket({ serial: 0x40001234, cmd: 4, pinNum: 0, x: 0, y: 0 });
assert.deepEqual(mapGump._pins, []);
assert.ok(mapGump._renderPinsCalls >= 3, 'map pin packet mutations should redraw pins');

let sent = null;
mapGump._net = { send(bytes) { sent = Buffer.from(bytes).toString('hex'); } };
assert.equal(mapGump._sendMap(1, 2, 16, 32), true);
assert.equal(sent, '5640001234010200100020');

const { bus } = await import('../src/core/event-bus.js');
const { world } = await import('../src/world/world.js');
const { assets } = await import('../src/assets/asset-manager.js');
const { boatMovingManager } = await import('../src/managers/boat-moving-manager.js');
const { houseCustomization, HouseCustomState } = await import('../src/managers/house-customization-manager.js');
const { net } = await import('../src/net/net-client.js');
const { worldTextManager, worldTextStats } = await import('../src/managers/world-text-manager.js');
const { tooltips } = await import('../src/managers/tooltip-manager.js');
const { walker, movementStats } = await import('../src/managers/walker.js');

function once(topic) {
  let value = null;
  const off = bus.on(topic, (payload) => { value = payload ?? true; });
  return {
    get value() { return value; },
    off,
  };
}

function packetSubop(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  return ((b[7] << 8) | b[8]) >>> 0;
}

function resetHouseCustomization() {
  houseCustomization.state = HouseCustomState.Idle;
  houseCustomization.targetSerial = 0;
  houseCustomization.currentFloor = 1;
  houseCustomization.brush = 0;
  houseCustomization.brushKind = 'item';
  houseCustomization.clearPreviewTile();
}

function makeDisplayParent() {
  return {
    children: [],
    addChild(node) {
      node.parent = this;
      this.children.push(node);
    },
    removeChild(node) {
      const idx = this.children.indexOf(node);
      if (idx >= 0) this.children.splice(idx, 1);
      if (node?.parent === this) node.parent = null;
    },
  };
}

function clearTooltipState() {
  if (tooltips._flushTimer) {
    clearTimeout(tooltips._flushTimer);
    tooltips._flushTimer = null;
  }
  tooltips._cache.clear();
  tooltips._pending.clear();
  tooltips._requestCooldown.clear();
  tooltips._revisions.clear();
  tooltips._renderedKey = '';
  tooltips._renderedSerial = 0;
}

world.reset?.();
world.mapId = 1;
const oldMultiTiles = assets.multiTiles;
assets.multiTiles = () => [{ x: 0, y: 0 }, { x: 1, y: 1 }];
try {
  const boat = world.ensureItem(0x40001000);
  Object.assign(boat, { serial: 0x40001000, x: 100, y: 100, z: 0, map: 1, parent: 0, multiId: 0x3E96 });
  const rider = world.ensureMobile(0x40002000);
  Object.assign(rider, { serial: 0x40002000, x: 100, y: 100, z: 0, map: 1 });
  boatMovingManager._lerps.clear();
  boatMovingManager._onMoving({
    serial: boat.serial,
    speed: 3,
    direction: 2,
    facing: 2,
    x: 101,
    y: 100,
    z: 0,
    fromX: 100,
    fromY: 100,
    passengers: [{ serial: rider.serial }],
  });
  const lerp = boatMovingManager._lerps.get(boat.serial);
  assert.ok(lerp, 'boat movement should create a visual lerp');
  boatMovingManager._tick(lerp.startedAt + lerp.durationMs / 2);
  assert.notEqual(boat.offsetX, 0, 'boat should have a visual offset mid-lerp');
  assert.equal(rider.offsetX, boat.offsetX, 'explicit boat passenger should share boat offset');
  boatMovingManager._tick(lerp.startedAt + lerp.durationMs + 1);
  assert.equal(boat.offsetX, 0, 'boat offset should clear after lerp');
  assert.equal(rider.offsetX, 0, 'passenger offset should clear after lerp');
  assert.equal(rider.x, 101, 'passenger logical x should move with boat');
  assert.equal(boat.multiId, 0x3E98, 'boat multi id should swap to east facing at lerp end');
} finally {
  assets.multiTiles = oldMultiTiles;
  boatMovingManager._lerps.clear();
  world.reset?.();
}

const sentHousePackets = [];
const oldNetSend = net.send;
net.send = (bytes) => { sentHousePackets.push(Uint8Array.from(bytes)); };
try {
  world.player = { serial: 0x01020304 };
  resetHouseCustomization();
  houseCustomization.beginEdit(0x4000);
  houseCustomization.setBrush(0x1234, 'item');
  houseCustomization.setPreviewTile(10, 20, 5);
  assert.equal(houseCustomization.isPreviewActive(), true, 'house customization preview should become active on tile hover');
  houseCustomization.place(10, 20, 5);
  houseCustomization.setBrush(0x1235, 'roof');
  houseCustomization.place(10, 20, 6);
  houseCustomization.setBrush(0x1236, 'stair');
  houseCustomization.place(11, 20, 5);
  houseCustomization.setBrush(0x1235, 'roof');
  houseCustomization.erase(0x1235, 10, 20, 6);
  houseCustomization.setBrush(0x1234, 'item');
  houseCustomization.erase(0x1234, 10, 20, 5);
  assert.deepEqual(sentHousePackets.map(packetSubop), [0x06, 0x13, 0x0D, 0x14, 0x05], 'house customization click flow should send CUO 0xD7 subops');
} finally {
  net.send = oldNetSend;
  resetHouseCustomization();
  world.reset?.();
}

clearTooltipState();
world.reset?.();
const tooltipSerial = 0x40003000;
world.ensureItem(tooltipSerial).itemId = 0x0F0E;
bus.emit('tooltip:lines', {
  serial: tooltipSerial,
  revision: 0x123,
  lines: [{ cliloc: 1042971, args: 'test' }],
});
assert.equal(tooltips._cache.has(tooltipSerial), true, 'tooltip lines should populate cache');
assert.equal(tooltips._revisions.get(tooltipSerial), 0x123, 'tooltip lines should store revision');
bus.emit('tooltip:revision', { serial: tooltipSerial, revision: 0x40000123 });
assert.equal(tooltips._cache.has(tooltipSerial), true, 'tooltip high-bit-only revision should keep cache');
bus.emit('tooltip:revision', { serial: tooltipSerial, revision: 0x124 });
assert.equal(tooltips._cache.has(tooltipSerial), false, 'tooltip changed revision should drop stale cache');
assert.equal(tooltips._revisions.has(tooltipSerial), false, 'tooltip changed revision should drop stale revision');
assert.equal(tooltips._pending.has(tooltipSerial), true, 'tooltip changed revision should enqueue a forced refresh');
clearTooltipState();
bus.emit('tooltip:lines', {
  serial: tooltipSerial,
  revision: 0x125,
  lines: [{ cliloc: 1042971, args: 'late cliloc' }],
});
bus.emit('cliloc:ready');
assert.equal(tooltips._cache.has(tooltipSerial), false, 'cliloc ready should invalidate cached tooltip text');
clearTooltipState();
world.reset?.();

for (const key of Object.keys(worldTextStats)) worldTextStats[key] = 0;
worldTextManager.clear();
world.reset?.();
const textParent = makeDisplayParent();
worldTextManager.install(textParent);
const damageTarget = world.ensureMobile(0x40004000);
Object.assign(damageTarget, { serial: 0x40004000, x: 100, y: 100, z: 0, map: 1 });
worldTextManager.damage(damageTarget.serial, 12, 'fire');
assert.equal(worldTextStats.active, 1, 'world text damage should acquire one active text node');
assert.equal(worldTextStats.created, 1, 'world text first spawn should create a text node');
assert.equal(worldTextManager.hasActive(), true, 'world text manager should report active entry');
const bornAt = worldTextManager._entries[0].bornAt;
worldTextManager.tick(bornAt + 2500);
assert.equal(worldTextStats.active, 0, 'expired world text should release active node');
assert.ok(worldTextStats.poolSize >= 1, 'expired world text should return node to pool');
worldTextManager.damage(damageTarget.serial, 7, 'cold');
assert.ok(worldTextStats.reused >= 1, 'world text second spawn should reuse pooled node');
worldTextManager.clear();
assert.equal(worldTextStats.active, 0, 'world text clear should release active nodes');
worldTextManager.install(null);
world.reset?.();

walker.reset();
const first = walker.reserve(false, false, 1000);
assert.ok(first, 'walker should reserve first movement step');
const staleStart = movementStats.staleResyncs | 0;
const resync = once('net:resync-request');
assert.equal(walker.canStep(4501), false, 'walker should block stale in-flight movement');
resync.off();
assert.equal(resync.value, true, 'stale movement should request network resync');
assert.equal(walker.resyncRequested, true, 'stale ack should latch resyncRequested');
assert.ok((movementStats.staleResyncs | 0) > staleStart, 'stale ack should increment staleResyncs');

walker.clearResync();
const second = walker.reserve(false, false, 5000);
assert.ok(second, 'walker should reserve after clearing resync');
const rewind = once('walker:rewind');
walker.onRej({ sequence: second.sequence, x: 55, y: 66, z: 7, direction: 5 });
rewind.off();
assert.deepEqual(rewind.value, { x: 55, y: 66, z: 7, direction: 5 });
assert.equal(walker.resyncRequested, true, 'movement reject should latch resyncRequested');
walker.clearResync();

// A newer ACK must release only its own reservation and must not refresh the
// age of an older missing ACK. Otherwise continuous walking can mask the lost
// request until the five-slot movement window stays full forever.
walker.reset();
const oldestMissing = walker.reserve(false, false, 1000);
const newerAcked = walker.reserve(false, false, 1400);
assert.ok(oldestMissing && newerAcked, 'walker should track multiple movement reservations');
walker.onAck(newerAcked.sequence);
assert.equal(movementStats.pending, 1, 'newer ACK should leave the older request pending');
const maskedAckResync = once('net:resync-request');
assert.equal(walker.canStep(4001), false, 'oldest missing ACK should still trigger the stall timeout');
maskedAckResync.off();
assert.equal(maskedAckResync.value, true, 'oldest missing ACK should request a network resync');
walker.clearResync();

walker.reset();
assert.equal(walker.reserve(false, false, 1000, false)?.delayMs, 400, 'unmounted walk should use CUO walk delay');
walker.reset();
assert.equal(walker.reserve(true, false, 1000, false)?.delayMs, 200, 'unmounted run should use CUO run delay');
walker.reset();
assert.equal(walker.reserve(false, false, 1000, true)?.delayMs, 200, 'mounted walk should use CUO mounted walk delay');
walker.reset();
assert.equal(walker.reserve(true, false, 1000, true)?.delayMs, 100, 'mounted run should use CUO mounted run delay');

console.log('[smoke:audit-parity] ok');
