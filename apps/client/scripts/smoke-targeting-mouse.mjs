import assert from 'node:assert/strict';
import { GameWorldPicker } from '../src/scenes/game-world-picker.js';

globalThis.localStorage = globalThis.localStorage ?? {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};

const { walkNameFor, cursorHotspotFor } = await import('../src/managers/system-cursor.js');
const { resolveMouseRunState } = await import('../src/shared/mouse-walk.js');
const { targetManager } = await import('../src/managers/target-manager.js');
const { world } = await import('../src/world/world.js');
const { net } = await import('../src/net/net-client.js');
const { resolveSfxSourceMap } = await import('../src/managers/audio-manager.js');
const { isWeatherSheltered } = await import('../src/renderer/weather.js');

assert.equal(walkNameFor(100, 0), 'walk-e');
assert.equal(walkNameFor(0, -100), 'walk-n');
assert.equal(walkNameFor(-100, 0), 'walk-w');
assert.equal(walkNameFor(0, 100), 'walk-s');
assert.equal(walkNameFor(2, 2), null, 'cursor inside player dead-zone is not a walk arrow');
assert.deepEqual(cursorHotspotFor('target-harmful', 48, 36), { x: 24, y: 18 });

assert.deepEqual(resolveMouseRunState(110 ** 2, false, false), { autoRun: true, run: true });
assert.deepEqual(resolveMouseRunState(85 ** 2, true, false), { autoRun: true, run: true }, 'run hysteresis must not flap');
assert.deepEqual(resolveMouseRunState(50 ** 2, true, false), { autoRun: false, run: false });
assert.equal(resolveMouseRunState(20 ** 2, false, true).run, true, 'Shift forces running');
assert.equal(resolveSfxSourceMap(undefined, 1), 1, 'positional SFX falls back to player facet');
assert.equal(resolveSfxSourceMap(4, 1), 4);
assert.equal(isWeatherSheltered(true, null), true);
assert.equal(isWeatherSheltered(false, 'dungeon'), true);
assert.equal(isWeatherSheltered(false, null), false);

const pickerWorld = {
  player: { serial: 1, x: 10, y: 10, z: 0, map: 1 },
  items: new Map(),
  mobiles: new Map([[2, { serial: 2, x: 10, y: 10, z: 0 }]]),
};
const pickerCamera = { zoom: 1, cx: 0, cy: 0, viewX: 0, viewY: 0, viewW: 640, viewH: 480 };
const pickerAssets = { landAt: () => ({ z: 0 }), tiledata: null, staticsAt: () => [] };
const picker = new GameWorldPicker({
  world: pickerWorld,
  camera: pickerCamera,
  assets: pickerAssets,
  isMobileLayerReady: () => true,
});
const playerPoint = picker.playerScreenPoint();
assert.equal(picker.pickEntity(playerPoint.x, playerPoint.y - 20)?.serial, 2);
assert.equal(picker.pickStatic(playerPoint.x, playerPoint.y), null);

const sent = [];
const originalSend = net.send;
net.send = (packet) => sent.push(packet);
targetManager.active = false;
targetManager._queue.length = 0;
targetManager._queueHead = 0;
targetManager.setMultiPlacement({
  cursorId: 0x12345678,
  multiId: 0x2000,
  offsetX: 2,
  offsetY: 3,
  offsetZ: 4,
  hue: 0,
});
targetManager.pickPosition(100, 200, 20);
assert.equal(sent.length, 1);
const packet = sent[0];
const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
assert.equal(packet.length, 19);
assert.equal(packet[1], 2);
assert.equal(view.getUint16(11, false), 98);
assert.equal(view.getUint16(13, false), 197);
assert.equal(view.getInt16(15, false), 16);
assert.equal(view.getUint16(17, false), 0x2000);

const a = world.ensureMobile(0x11);
const b = world.ensureMobile(0x12);
sent.length = 0;
targetManager.setLastTarget(a.serial);
assert.equal(sent[0][0], 0x05);
assert.equal(new DataView(sent[0].buffer, sent[0].byteOffset, sent[0].byteLength).getUint32(1, false), a.serial);
targetManager.confirmAttack(a.serial);
assert.equal(a._isLastAttack, true);
targetManager.confirmAttack(b.serial);
assert.equal(a._isLastAttack, false);
assert.equal(b._isLastAttack, true);
targetManager.confirmAttack(0);
assert.equal(b._isLastAttack, false);
net.send = originalSend;

console.log('[smoke:targeting-mouse] ok');
