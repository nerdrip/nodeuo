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
export const ACTION_BAR_PAGE_COUNT = 5;
const ACTION_BAR_KEY_BASE = 'uo.spell-actionbar';

function actionBarBaseKey() {
  const serial = world?.player?.serial;
  return serial ? `${ACTION_BAR_KEY_BASE}:${serial.toString(16)}` : ACTION_BAR_KEY_BASE;
}

function actionBarKey(page = readActionBarPage()) {
  return page > 0 ? `${actionBarBaseKey()}:page:${page}` : actionBarBaseKey();
}

export function readActionBarPage() {
  try {
    const page = Number(localStorage.getItem(`${actionBarBaseKey()}:active-page`)) | 0;
    return Math.max(0, Math.min(ACTION_BAR_PAGE_COUNT - 1, page));
  } catch { return 0; }
}

export function setActionBarPage(page) {
  const next = Math.max(0, Math.min(ACTION_BAR_PAGE_COUNT - 1, page | 0));
  try { localStorage.setItem(`${actionBarBaseKey()}:active-page`, String(next)); } catch {}
  bus.emit('actionbar:changed', { page: next });
  return next;
}

export function readActionBarSlots() {
  return readActionBarActions().map((action) => action?.type === 'spell' ? action.id : null);
}

function normalizeAction(value) {
  if (Number.isInteger(Number(value)) && Number(value) > 0) {
    return { type: 'spell', id: Number(value) | 0 };
  }
  if (!value || typeof value !== 'object') return null;
  const type = value.type === 'skill' ? 'skill' : value.type === 'spell' ? 'spell' : null;
  const id = Number(value.id) | 0;
  if (!type || id <= 0) return null;
  return { type, id, name: String(value.name ?? '').slice(0, 80) };
}

export function readActionBarActions(page = readActionBarPage()) {
  try {
    const raw = localStorage.getItem(actionBarKey(page));
    const parsed = raw ? JSON.parse(raw) : [];
    const slots = new Array(ACTION_BAR_SLOT_COUNT).fill(null);
    if (!Array.isArray(parsed)) return slots;
    for (let i = 0; i < slots.length; i++) {
      slots[i] = normalizeAction(parsed[i]);
    }
    return slots;
  } catch {
    return new Array(ACTION_BAR_SLOT_COUNT).fill(null);
  }
}

function writeActionBarSlots(slots, page = readActionBarPage()) {
  return writeActionBarActions(slots?.map((id) => normalizeAction(id)), page);
}

function writeActionBarActions(slots, page = readActionBarPage()) {
  const normalized = new Array(ACTION_BAR_SLOT_COUNT).fill(null);
  for (let i = 0; i < normalized.length; i++) {
    normalized[i] = normalizeAction(slots?.[i]);
  }
  try { localStorage.setItem(actionBarKey(page), JSON.stringify(normalized)); }
  catch { /* private mode / quota */ }
  bus.emit('actionbar:changed', { slots: normalized });
  return normalized;
}

export function clearActionBarSlot(index, page = readActionBarPage()) {
  const i = index | 0;
  if (i < 0 || i >= ACTION_BAR_SLOT_COUNT) return false;
  const slots = readActionBarActions(page);
  if (slots[i] == null) return false;
  slots[i] = null;
  writeActionBarSlots(slots, page);
  return true;
}

export function exportActionBarProfile() {
  return JSON.stringify({
    version: 2,
    activePage: readActionBarPage(),
    pages: Array.from({ length: ACTION_BAR_PAGE_COUNT }, (_, page) => readActionBarActions(page)),
  }, null, 2);
}

export function importActionBarProfile(payload) {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (!parsed || parsed.version !== 2 || !Array.isArray(parsed.pages)) throw new Error('Unsupported action bar profile');
  for (let page = 0; page < ACTION_BAR_PAGE_COUNT; page++) writeActionBarActions(parsed.pages[page] ?? [], page);
  setActionBarPage(parsed.activePage ?? 0);
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

function makePreview(action) {
  if (typeof document === 'undefined' || !document.body) return;
  preview = document.createElement('div');
  preview.className = 'uo-spell-drag-preview';
  preview.textContent = action?.name ?? (action?.type === 'skill' ? 'Skill' : 'Spell');
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
    action: { type: 'spell', id: spell.id | 0, name: spell.name ?? '' },
    data: spell,
    sourceIndex: Number.isInteger(sourceIndex) ? sourceIndex : null,
    sourcePage: readActionBarPage(),
  };
  makePreview(activeDrag.action);
  return true;
}

export function beginSkillShortcutDrag(skill, sourceIndex = null) {
  if (!skill?.id || !skill?.name) return false;
  removePreview();
  activeDrag = {
    action: { type: 'skill', id: skill.id | 0, name: String(skill.name) },
    data: skill,
    sourceIndex: Number.isInteger(sourceIndex) ? sourceIndex : null,
    sourcePage: readActionBarPage(),
  };
  makePreview(activeDrag.action);
  return true;
}

export function hasSpellShortcutDrag() { return activeDrag != null; }

export function dropSpellShortcutOnActionBar(index) {
  const target = index | 0;
  if (!activeDrag || target < 0 || target >= ACTION_BAR_SLOT_COUNT) return false;
  const { action, sourceIndex, sourcePage } = activeDrag;
  activeDrag = null;
  removePreview();

  const targetPage = readActionBarPage();
  const slots = readActionBarActions(targetPage);
  const source = Number.isInteger(sourceIndex) ? sourceIndex : -1;
  if (source >= 0 && source < ACTION_BAR_SLOT_COUNT) {
    if (sourcePage === targetPage && source !== target) {
      slots[source] = slots[target];
    } else if (sourcePage !== targetPage) {
      const sourceSlots = readActionBarActions(sourcePage);
      sourceSlots[source] = slots[target];
      writeActionBarActions(sourceSlots, sourcePage);
    }
  }
  // A spell has one canonical action-bar position. Dragging it in from the
  // book moves the existing assignment instead of creating duplicates.
  for (let i = 0; i < slots.length; i++) {
    if (i !== target && i !== source && slots[i]?.type === action.type && slots[i]?.id === action.id) slots[i] = null;
  }
  slots[target] = action;
  writeActionBarActions(slots, targetPage);
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
  const { action, data, sourceIndex, sourcePage } = activeDrag;
  activeDrag = null;
  removePreview();

  // Dragging away from the fixed bar removes that assignment. A drop on the
  // world also creates an independent, freely movable ClassicUO-style tile.
  if (Number.isInteger(sourceIndex)) clearActionBarSlot(sourceIndex, sourcePage);
  if (claimed) return;

  if (!ui) return;
  const logical = ui._logicalPoint?.(x, y) ?? {
    x: x / (ui.scale || 1), y: y / (ui.scale || 1),
  };
  if (action.type === 'skill') {
    import('./skill-button-gump.js').then(({ SkillButtonGump }) => {
      ui.addGump(new SkillButtonGump(data ?? action, logical.x - 22, logical.y - 22));
    }).catch(() => {});
  } else {
    ui.addGump(new UseSpellButtonGump(data ?? action, logical.x - 22, logical.y - 22));
  }
}

// UIManager emits this after target-control drop dispatch. ActionSlot consumes
// the drag first; anything still active here was dropped off the action bar.
bus.on('ui:physical-drag-finished', finishSpellShortcutDrag);
