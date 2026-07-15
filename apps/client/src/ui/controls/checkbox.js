// Checkbox / RadioButton — a toggle that can also be a one-of-many
// (radio) when grouped via `groupId`. Mirrors ClassicUO's
// Game/UI/Controls/Checkbox.cs and RadioButton.cs.

import { Graphics } from 'pixi.js';
import { Control } from '../control.js';
import { GumpPic } from './gump-pic.js';

export class Checkbox extends Control {
  /** @param {object} p
   *  @param {number}  [p.uncheckedGump]  gump.mul id (placeholder until FAZA 2)
   *  @param {number}  [p.checkedGump]
   *  @param {number}  [p.switchId]       server response switch id
   *  @param {boolean} [p.checked]
   *  @param {string}  [p.kind]           'checkbox' | 'radio'
   *  @param {string}  [p.groupId]        only for radio — controls in same group exclude each other
   */
  constructor({
    uncheckedGump = 0x00D2, checkedGump = 0x00D3,
    switchId = 0, checked = false, kind = 'checkbox', groupId = null,
    size = 18,
  } = {}) {
    super();
    this.keyboardFocusable = true;
    this.uncheckedGump = uncheckedGump | 0;
    this.checkedGump   = checkedGump   | 0;
    this.switchId = switchId | 0;
    this.kind = kind;
    this.groupId = groupId;
    this.width = this.height = size;
    this._checked = !!checked;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    // Server gump layouts supply the canonical unchecked/checked art ids.
    // Keep the vector face underneath as a robust fallback, then mount the
    // native UO faces above it when available.
    this._uncheckedPic = new GumpPic(this.uncheckedGump, { width: size, height: size });
    this._checkedPic = new GumpPic(this.checkedGump, { width: size, height: size });
    this._uncheckedPic.acceptMouseInput = false;
    this._checkedPic.acceptMouseInput = false;
    this.add(this._uncheckedPic);
    this.add(this._checkedPic);
    this._draw();
  }

  get checked() { return this._checked; }

  setChecked(v, { silent = false } = {}) {
    const next = !!v;
    if (this._checked === next) return;
    this._checked = next;
    this._draw();
    if (!silent && this.kind === 'radio' && next) this._exclusiveGroup();
  }

  onClick() {
    if (this.kind === 'radio') {
      if (!this._checked) { this._checked = true; this._draw(); this._exclusiveGroup(); }
    } else {
      this._checked = !this._checked;
      this._draw();
    }
    try { this.onToggle?.(this._checked); } catch (e) {
      console.error('[checkbox] onToggle failed', e);
    }
  }

  _exclusiveGroup() {
    // Walk siblings under the same parent; uncheck any radio sharing groupId.
    if (!this.parent || !this.groupId) return;
    for (const c of this.parent.children) {
      if (c === this) continue;
      if (c instanceof Checkbox && c.kind === 'radio' && c.groupId === this.groupId) {
        c.setChecked(false, { silent: true });
      }
    }
  }

  /** Read-only accessor used by Gump.respond() to collect switch state. */
  serializeSwitch() {
    return this._checked ? this.switchId : -1;
  }

  _draw() {
    if (this._uncheckedPic?.node) this._uncheckedPic.node.visible = !this._checked;
    if (this._checkedPic?.node) this._checkedPic.node.visible = this._checked;
    const g = this._gfx;
    g.clear();
    if (this.kind === 'radio') {
      g.circle(this.width / 2, this.height / 2, this.width / 2 - 1)
       .fill({ color: 0x070806, alpha: 0.85 })
       .stroke({ width: 1.5, color: 0x6e5520 });
      if (this._checked) {
        g.circle(this.width / 2, this.height / 2, this.width / 2 - 5)
         .fill({ color: 0xd8c890 });
      }
    } else {
      g.rect(0, 0, this.width, this.height)
       .fill({ color: 0x070806, alpha: 0.85 })
       .stroke({ width: 1.5, color: 0x6e5520 });
      if (this._checked) {
        // X mark
        g.moveTo(4, 4).lineTo(this.width - 4, this.height - 4)
         .moveTo(this.width - 4, 4).lineTo(4, this.height - 4)
         .stroke({ width: 2, color: 0xd8c890 });
      }
    }
  }
}
