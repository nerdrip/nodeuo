// Shared spell-shortcut drag state.
//
// Floating spell buttons and the fixed action bar deliberately use separate
// persistence. The old implementation treated every floating shortcut as an
// action-bar entry, so dragging one spell out of the book created two buttons.

import { bus } from '../../core/event-bus.js';
import { world } from '../../world/world.js';
import { uiManagerInstance } from '../ui-manager-singleton.js';
import { UseSpellButtonGump } from './use-spell-button-gump.js';

export const ACTION_BAR_SLOT_COUNT = 10;
const ACTION_BAR_KEY_BASE = 'uo.spell-actionbar';

function actionBarKey() {
  const serial = world?.player?.serial;
  return serial ? `${ACTION_BAR_KEY_BASE}:${serial.toString(16)}` : ACTION_BAR_KEY_BASE;
}

export function readActionBarSlots() {
  try {
    const raw = localStorage.getItem(actionBarKey());
    const parsed = raw ? JSON.parse(raw) : [];
    const slots = new Array(ACTION_BAR_SLOT_COUNT).fill(null);
    if (!Array.isArray(parsed)) return slots;
    for (let i = 0; i < slots.length; i++) {
      const id = Number(parsed[i]);
      slots[i] = Number.isInteger(id) && id > 0 ? id : null;
    }
    return slots;
  } catch {
    return new Array(ACTION_BAR_SLOT_COUNT).fill(null);
  }
}

function writeActionBarSlots(slots) {
  const normalized = new Array(ACTION_BAR_SLOT_COUNT).fill(null);
  for (let i = 0; i < normalized.length; i++) {
    const id = Number(slots?.[i]);
    normalized[i] = Number.isInteger(id) && id > 0 ? id : null;
  }
  try { localStorage.setItem(actionBarKey(), JSON.stringify(normalized)); }
  catch { /* private mode / quota */ }
  bus.emit('actionbar:changed', { slots: normalized });
  return normalized;
}

export function clearActionBarSlot(index) {
  const i = index | 0;
  if (i < 0 || i >= ACTION_BAR_SLOT_COUNT) return false;
  const slots = readActionBarSlots();
  if (slots[i] == null) return false;
  slots[i] = null;
  writeActionBarSlots(slots);
  return true;
}

let activeDrag = null;
let preview = null;

function movePreview(e) {
  if (!preview) return;
  preview.style.left = `${(e?.clientX ?? 0) + 14}px`;
  preview.style.top = `${(e?.clientY ?? 0) + 14}px`;
}

function removePreview() {
  if (typeof window !== 'undefined') window.removeEventListener('mousemove', movePreview, true);
  preview?.remove?.();
  preview = null;
}

function makePreview(spell) {
  if (typeof document === 'undefined' || !document.body) return;
  preview = document.createElement('div');
  preview.className = 'uo-spell-drag-preview';
  preview.textContent = spell?.name ?? 'Spell';
  Object.assign(preview.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: '2147483647',
    maxWidth: '180px', padding: '7px 10px', borderRadius: '5px',
    color: '#fff0b0', background: 'rgba(16,23,34,.94)',
    border: '1px solid #d6a84f', boxShadow: '0 4px 16px rgba(0,0,0,.55)',
    font: '600 12px/1.2 system-ui, sans-serif', whiteSpace: 'nowrap',
  });
  document.body.appendChild(preview);
  const ui = uiManagerInstance.get();
  movePreview({ clientX: ui?.lastMouseX ?? 200, clientY: ui?.lastMouseY ?? 200 });
  window.addEventListener('mousemove', movePreview, true);
}

export function beginSpellShortcutDrag(spell, sourceIndex = null) {
  if (!spell?.id) return false;
  removePreview();
  activeDrag = {
    spell,
    sourceIndex: Number.isInteger(sourceIndex) ? sourceIndex : null,
  };
  makePreview(spell);
  return true;
}

export function hasSpellShortcutDrag() { return activeDrag != null; }

export function dropSpellShortcutOnActionBar(index) {
  const target = index | 0;
  if (!activeDrag || target < 0 || target >= ACTION_BAR_SLOT_COUNT) return false;
  const { spell, sourceIndex } = activeDrag;
  activeDrag = null;
  removePreview();

  const slots = readActionBarSlots();
  const source = Number.isInteger(sourceIndex) ? sourceIndex : -1;
  if (source >= 0 && source < ACTION_BAR_SLOT_COUNT && source !== target) {
    // Reordering swaps instead of silently deleting the target shortcut.
    slots[source] = slots[target];
  }
  // A spell has one canonical action-bar position. Dragging it in from the
  // book moves the existing assignment instead of creating duplicates.
  for (let i = 0; i < slots.length; i++) {
    if (i !== target && i !== source && slots[i] === spell.id) slots[i] = null;
  }
  slots[target] = spell.id;
  writeActionBarSlots(slots);
  return true;
}

function finishSpellShortcutDrag({ claimed, x, y }) {
  if (!activeDrag) return;
  const ui = uiManagerInstance.get();
  // UIManager intentionally skips onDrop when press and release hit the
  // exact same control. For action slots that should be a no-op, not a
  // remove-and-create-floating-button operation. Resolve the slot (including
  // its icon/label descendants) before treating the release as a world drop.
  if (!claimed && ui) {
    let control = ui.pickAtScreen?.(x, y)?.control;
    while (control) {
      if (Number.isInteger(control.actionBarSlotIndex)) {
        dropSpellShortcutOnActionBar(control.actionBarSlotIndex);
        return;
      }
      control = control.parent;
    }
  }
  const { spell, sourceIndex } = activeDrag;
  activeDrag = null;
  removePreview();

  // Dragging away from the fixed bar removes that assignment. A drop on the
  // world also creates an independent, freely movable ClassicUO-style tile.
  if (Number.isInteger(sourceIndex)) clearActionBarSlot(sourceIndex);
  if (claimed) return;

  if (!ui) return;
  const logical = ui._logicalPoint?.(x, y) ?? {
    x: x / (ui.scale || 1), y: y / (ui.scale || 1),
  };
  ui.addGump(new UseSpellButtonGump(spell, logical.x - 22, logical.y - 22));
}

// UIManager emits this after target-control drop dispatch. ActionSlot consumes
// the drag first; anything still active here was dropped off the action bar.
bus.on('ui:physical-drag-finished', finishSpellShortcutDrag);
