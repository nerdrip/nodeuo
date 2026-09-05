import assert from 'node:assert/strict';

globalThis.requestAnimationFrame = globalThis.requestAnimationFrame
  ?? ((fn) => setTimeout(() => fn(Date.now()), 16));
globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame
  ?? ((id) => clearTimeout(id));

const { PaperDollInteractable } = await import('../src/ui/controls/paper-doll-interactable.js');
const { resolveEquipGumpId } = await import('../src/ui/gumps/paperdoll-gump.js');

const customWearable = {
  itemId: 0x0ff1, paperdollGumpId: 0xc351,
  paperdollMaleGumpId: 0xc352, paperdollFemaleGumpId: 0xea62,
};
assert.equal(resolveEquipGumpId(0x190, customWearable), 0xc352,
  'male paperdoll override is independent of ground item art');
assert.equal(resolveEquipGumpId(0x191, customWearable), 0xea62,
  'female paperdoll override is independent of ground item art');
assert.equal(resolveEquipGumpId(0x190, { itemId: 0x0ff1, paperdollGumpId: 0xc351 }), 0xc351,
  'unisex paperdoll override remains available for arbitrary custom clothing');

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
assert.equal(ctrl._shimmer, null, 'paperdoll equipment never paints a 32x32 loading artifact');
assert.equal(ctrl._showFallback, false, 'missing wearable art stays invisible instead of becoming a tiny square');
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
