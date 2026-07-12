// UseSpellButtonGump — floating hotbar shortcut for one spell. Mirrors
// ClassicUO `Game/UI/Gumps/UseSpellButtonGump.cs`. Player drags a spell
// out of the SpellbookGump into the world; we spawn one of these gumps
// at the drop point. Click the icon → cast the spell.
//
// Persistence: the set of active hotbar shortcuts (spell id + position)
// is mirrored to `localStorage` under HOTBAR_KEY so a relog re-spawns
// them in the same place. Mirrors CUO's profile-bound macro/hotbar bar.

import { Gump } from '../gump.js';
import { Control } from '../control.js';
import { Graphics } from 'pixi.js';
import { GumpPic } from '../controls/gump-pic.js';
import { net } from '../../net/net-client.js';
import { buildTextCommand } from '../../net/outgoing.js';
import { tooltips } from '../../managers/tooltip-manager.js';
import { bus } from '../../core/event-bus.js';
import { spellIconId, spellById } from './spell-data.js';
import { world } from '../../world/world.js';

// Per-character key. The previous single-bucket `uo.spell-hotbar` was
// stomped between alts on the same account — character A's bar saved
// over character B's the next time A logged in. Use the player's
// serial when available (each character has a unique stable serial),
// fall back to the legacy bucket for first-boot compatibility.
const HOTBAR_KEY_BASE = 'uo.spell-hotbar';
function hotbarKey() {
  const s = world?.player?.serial;
  return s ? `${HOTBAR_KEY_BASE}:${s.toString(16)}` : HOTBAR_KEY_BASE;
}

/** Read the saved hotbar entries: [{ spellId, x, y }, ...]. */
export function readHotbarEntries() {
  try {
    const raw = localStorage.getItem(hotbarKey()) ?? localStorage.getItem(HOTBAR_KEY_BASE);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((e) => e && Number.isFinite(e.spellId)
      && Number.isFinite(e.x) && Number.isFinite(e.y));
  } catch { return []; }
}

function writeHotbarEntries(entries) {
  try { localStorage.setItem(hotbarKey(), JSON.stringify(entries)); }
  catch { /* quota / disabled — silent */ }
  bus.emit('hotbar:changed', { entries });
}

/** Add or update a single shortcut entry, keyed by spellId. */
export function persistHotbarEntry(spellId, x, y) {
  const all = readHotbarEntries().filter((e) => e.spellId !== spellId);
  all.push({ spellId, x: x | 0, y: y | 0 });
  writeHotbarEntries(all);
}

/** Drop a saved shortcut by spellId (called when the player closes one). */
export function forgetHotbarEntry(spellId) {
  writeHotbarEntries(readHotbarEntries().filter((e) => e.spellId !== spellId));
}

const ICON = 44;

class HotbarIcon extends Control {
  constructor(spell) {
    super();
    this.spell = spell;
    this.width = ICON;
    this.height = ICON;
    this.acceptMouseInput = true;
    // Frame behind the icon so the cell still reads as "a button" while
    // the gump texture is in flight or for spells outside the icon range.
    this._frame = new Graphics();
    this.node.addChild(this._frame);
    this._active = false;
    this._draw(false);
    // Real spell icon — same gumppic the spellbook gump uses, so the
    // shortcut visually matches its source. Falls back to GumpPic
    // placeholder while atlas loads.
    const iconId = spellIconId(spell);
    this._pic = new GumpPic(iconId || 0x08C0, { width: ICON, height: ICON });
    this._pic.acceptMouseInput = false;
    this.add(this._pic);
    // Audit #37 client P3 #10 — cooldown / active-spell overlay. CUO
    // tints the icon Hue=38 when its spell is in the
    // `world.ActiveSpellIcons` set, then darkens during `_castTimer`.
    // We mirror via the existing `spell:toggle` bus event (already
    // emitted by the 0xBF 0x25 handler).
    this._unsubToggle = bus.on?.('spell:toggle', ({ spellId, active }) => {
      if (spellId !== this.spell.id) return;
      this._active = !!active;
      this._draw(false);
    });
  }
  _draw(hover) {
    this._frame.clear();
    let bg = hover ? 0x3a4660 : 0x14263e;
    let stroke = hover ? 0xfff0a0 : 0x6a4a18;
    // Audit #37 client P3 #10 — active = amber glow ring.
    if (this._active) {
      bg = 0x4a3010;
      stroke = 0xffc060;
    }
    this._frame.rect(0, 0, ICON, ICON)
      .fill({ color: bg, alpha: 0.9 })
      .stroke({ width: 2, color: stroke });
  }
  dispose() { this._unsubToggle?.(); super.dispose?.(); }
  onMouseEnter(e) {
    this._draw(true);
    tooltips.showText(e.global.x, e.global.y,
      `${this.spell.name}\nMana ${this.spell.mana}${this.spell.reagents ? '\n' + this.spell.reagents : ''}`);
  }
  onMouseLeave() { this._draw(false); tooltips.hide(); }
  onClick() {
    try { net.send(buildTextCommand(0x56, String(this.spell.id))); }
    catch { /* socket transient */ }
  }
}

export class UseSpellButtonGump extends Gump {
  constructor(spell, x = 200, y = 200) {
    super();
    this.setPosition(x, y);
    this.setSize(ICON, ICON);
    this.spell = spell;
    const icon = new HotbarIcon(spell);
    icon.isDragHandle = true;     // entire icon doubles as drag handle
    this.add(icon);
    // Persist on creation. Drag-end (UIManager.persistPosition) will
    // re-write with the final coords; closing the gump (RMB / X)
    // calls dispose() below which clears the entry.
    if (spell?.id != null) persistHotbarEntry(spell.id, x, y);
  }
  get type() { return 'use-spell'; }
  /** Stable key per-spell so reopening the same shortcut doesn't
   *  spawn a duplicate at the default position. */
  get positionKey() { return `use-spell:${this.spell?.id}`; }
  /** Override to ALSO mirror to the dedicated hotbar list — the base
   *  positionKey memo only stores per-key x/y, but the hotbar restore
   *  needs the full list so it knows WHICH spells to re-spawn. */
  persistPosition() {
    super.persistPosition();
    if (this.spell?.id != null) persistHotbarEntry(this.spell.id, this.x, this.y);
  }
  dispose() {
    if (this.spell?.id != null) forgetHotbarEntry(this.spell.id);
    super.dispose();
  }
}

/** Spawn every saved hotbar shortcut. Called once after world login
 *  (game-scene.js) so the player sees their previous bar without
 *  re-dragging from the spellbook. */
export function restoreSavedHotbar(uiManager) {
  if (!uiManager) return;
  for (const e of readHotbarEntries()) {
    const spell = spellById(e.spellId);
    if (!spell) continue;
    uiManager.addGump(new UseSpellButtonGump(spell, e.x, e.y));
  }
}
