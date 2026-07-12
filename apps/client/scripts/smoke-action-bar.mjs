import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

const {
  beginSpellShortcutDrag,
  clearActionBarSlot,
  dropSpellShortcutOnActionBar,
  readActionBarSlots,
} = await import('../src/ui/gumps/spell-shortcut-drag.js');

const heal = { id: 4, name: 'Heal' };
const fireball = { id: 18, name: 'Fireball' };

assert.equal(readActionBarSlots().every((slot) => slot == null), true);
beginSpellShortcutDrag(heal);
assert.equal(dropSpellShortcutOnActionBar(3), true);
assert.equal(readActionBarSlots()[3], heal.id, 'book drag lands only in the chosen slot');

beginSpellShortcutDrag(fireball);
dropSpellShortcutOnActionBar(7);
beginSpellShortcutDrag(heal, 3);
dropSpellShortcutOnActionBar(7);
let slots = readActionBarSlots();
assert.equal(slots[7], heal.id, 'dragged spell moves to target slot');
assert.equal(slots[3], fireball.id, 'occupied slots swap without losing a shortcut');

assert.equal(clearActionBarSlot(7), true);
slots = readActionBarSlots();
assert.equal(slots[7], null, 'slot can be removed from the action bar');

console.log('[smoke:action-bar] ok');
