import assert from 'node:assert/strict';

globalThis.requestAnimationFrame = globalThis.requestAnimationFrame
  ?? ((fn) => setTimeout(() => fn(Date.now()), 16));
globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame
  ?? ((id) => clearTimeout(id));

const { PaperDollInteractable } = await import('../src/ui/controls/paper-doll-interactable.js');

const calls = [];
const ctrl = new PaperDollInteractable({
  gumpId: 0x1234,
  layer: 5,
  equipment: { serial: 0x40000001, itemId: 0x1517, hue: 0 },
  onTarget: () => false,
  onDropHeld: (c) => calls.push(`drop:${c.layer}`),
  onLift: (c) => calls.push(`lift:${c.equipment.itemId}`),
  onUse: (c) => calls.push(`use:${c.equipment.serial}`),
  onPreviewEnter: () => calls.push('enter'),
  onPreviewLeave: () => calls.push('leave'),
});

assert.equal(ctrl.layer, 5);
assert.equal(ctrl.isBackpackSlot, false);
ctrl.onClick();
ctrl.onDragStart();
ctrl.onDoubleClick();
ctrl.onMouseEnter();
ctrl.onMouseLeave();
assert.deepEqual(calls, ['drop:5', 'lift:5399', 'use:1073741825', 'enter', 'leave']);

const backpack = new PaperDollInteractable({ gumpId: 0x0E75, layer: 21, isBackpackSlot: true, onLift: () => calls.push('bad') });
backpack.onDragStart();
assert.equal(calls.includes('bad'), false);

ctrl.dispose();
backpack.dispose();

console.log('[smoke:paper-doll-interactable] ok');
