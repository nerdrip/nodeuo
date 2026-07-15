import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

const {
  beginSkillShortcutDrag,
  beginSpellShortcutDrag,
  clearActionBarSlot,
  dropSpellShortcutOnActionBar,
  exportActionBarProfile,
  importActionBarProfile,
  readActionBarActions,
  readActionBarPage,
  readActionBarSlots,
  setActionBarPage,
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

beginSkillShortcutDrag({ id: 21, name: 'Hiding' });
assert.equal(dropSpellShortcutOnActionBar(1), true);
const actions = readActionBarActions();
assert.deepEqual(actions[1], { type: 'skill', id: 21, name: 'Hiding' },
  'active skills use the same deterministic slot model as spells');
assert.equal(readActionBarSlots()[1], null,
  'legacy spell-only readers do not mistake a skill for a spell id');

setActionBarPage(2);
assert.equal(readActionBarPage(), 2);
beginSpellShortcutDrag(fireball);
dropSpellShortcutOnActionBar(5);
assert.equal(readActionBarSlots()[5], fireball.id, 'each page has an independent slot set');
setActionBarPage(0);
assert.equal(readActionBarSlots()[5], null);
const profile = exportActionBarProfile();
storage.clear();
importActionBarProfile(profile);
assert.equal(readActionBarPage(), 0, 'profile restores the active page');
setActionBarPage(2);
assert.equal(readActionBarSlots()[5], fireball.id, 'profile exports and imports every page');

console.log('[smoke:action-bar] ok');
