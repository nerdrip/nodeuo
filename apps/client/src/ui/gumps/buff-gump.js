// BuffGump — small floating bar of active buff/debuff icons. Mirrors
// ClassicUO `Game/UI/Gumps/BuffGump.cs` (the "BuffControl" variant).
//
// Source of truth: 0xDF BuffDebuff. handlers.js fans out:
//   - buff:add    { serial, icon, duration, titleCliloc, secondaryCliloc, title, secondary }
//   - buff:remove { serial, icon }
//
// Layout: a compact 4-column grid of 30×30 icons. Each icon shows the
// remaining duration as a small subscript label and tooltips on hover.
// The gump is draggable (WindowGump chrome) and persists to the per-
// character profile by `_toggleKey = 'buffs'` so it reopens to the same
// position next session.

import { WindowGump } from './window-gump.js';
import { Control } from '../control.js';
import { TimerControl } from '../controls/timer-control.js';
import { ItemPic } from '../controls/item-pic.js';
import { bus } from '../../core/event-bus.js';
import { profile } from '../../managers/profile-manager.js';
import { tooltips } from '../../managers/tooltip-manager.js';
import { Graphics } from 'pixi.js';

const ICON = 30;
const COLS = 4;
const PAD  = 6;
const HEADER_H = 24;

class BuffIcon extends Control {
  constructor(buff) {
    super();
    this.buff = buff;
    this.width = ICON;
    this.height = ICON;
    this.acceptMouseInput = true;
    this._frame = new Graphics();
    this.node.addChild(this._frame);
    this._draw(false);
    // Buff icons are gump.mul graphics in CUO; we render them through
    // ItemPic which falls back to a coloured rect if the graphic id is
    // out of our atlas. Adequate for MVP.
    this._pic = new ItemPic(buff.icon, { hue: 0 });
    this._pic.setPosition(2, 2);
    this._pic.acceptMouseInput = false;
    this.add(this._pic);
    this._setTimer(buff.duration);
  }
  _draw(hover) {
    this._frame.clear();
    this._frame.rect(0, 0, ICON, ICON)
      .fill({ color: 0x0d1320, alpha: 0.85 })
      .stroke({ width: 1, color: hover ? 0xfff0a0 : 0x6a4a18, alpha: 1 });
  }
  onMouseEnter(e) {
    this._draw(true);
    const text = this.buff.title
      ? (this.buff.secondary ? `${this.buff.title}\n${this.buff.secondary}` : this.buff.title)
      : 'Buff';
    tooltips.showText(e.global.x, e.global.y, text);
  }
  onMouseLeave() { this._draw(false); tooltips.hide(); }
  updateBuff(buff) {
    this.buff = buff;
    this._setTimer(buff.duration);
  }
  _setTimer(duration) {
    const seconds = duration | 0;
    const showTimer = profile.get?.('combat.buffBarTime') !== false;
    this._endsAt = seconds > 0 ? performance.now() + seconds * 1000 : 0;
    if (seconds <= 0 || !showTimer) {
      if (this._timer) {
        try { this.remove(this._timer); } catch { /* already detached */ }
        this._timer.dispose?.();
        this._timer = null;
      }
      return;
    }
    if (!this._timer) {
      this._timer = new TimerControl({ fontSize: 9, hue: 0xfff0c0 });
      this._timer.setPosition(2, ICON - 11);
      this.add(this._timer);
    }
    this._timer.setExpiresAt(this._endsAt);
  }
  tick(now) {
    if (this._timer) return this._timer.tick(now);
    return this._endsAt ? now <= this._endsAt : true;
  }
}

export class BuffGump extends WindowGump {
  constructor() {
    super({ title: 'Buffs', width: PAD * 2 + COLS * (ICON + 2), height: 90, x: 8, y: 200 });
    /** @type {Map<number, BuffIcon>} icon-id → control */
    this._icons = new Map();
    this._unsubs = [
      bus.on('buff:add',    (b) => this._add(b)),
      bus.on('buff:remove', (b) => this._remove(b.icon)),
      bus.on('frame:tick',  (now) => this._tickAll(now)),
    ];
  }
  get type() { return 'buffs'; }
  dispose() {
    for (const u of this._unsubs) u();
    this._unsubs.length = 0;
    super.dispose();
  }

  _add(buff) {
    if (this._icons.has(buff.icon)) {
      // refresh duration / title in place
      const existing = this._icons.get(buff.icon);
      existing.updateBuff(buff);
      return;
    }
    const icon = new BuffIcon(buff);
    this._icons.set(buff.icon, icon);
    this.add(icon);
    this._reflow();
  }

  _remove(iconId) {
    const ctrl = this._icons.get(iconId);
    if (!ctrl) return;
    this._icons.delete(iconId);
    try { this.remove(ctrl); } catch { /* sometimes already detached */ }
    ctrl.dispose?.();
    this._reflow();
  }

  _reflow() {
    let i = 0;
    for (const ctrl of this._icons.values()) {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      ctrl.setPosition(PAD + col * (ICON + 2), HEADER_H + row * (ICON + 2));
      i++;
    }
    const rows = Math.max(1, Math.ceil(this._icons.size / COLS));
    this._h = HEADER_H + rows * (ICON + 2) + PAD;
    this.setSize(this._w, this._h);
    if (this._bg?._refresh) this._bg._refresh(this._w, this._h);
    else this._bg?.setSize?.(this._w, this._h);
  }

  _tickAll(now) {
    for (const [id, ctrl] of this._icons) {
      if (ctrl.tick(now) === false) this._remove(id);
    }
  }
}
