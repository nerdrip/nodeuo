// MessageBoxGump — modal dialog with OK/Cancel + multi-line text wrap.
// Mirrors ClassicUO's Game/UI/Gumps/MessageBoxGump.cs.
//
// Usage:
//   import { showMessageBox } from './message-box-gump.js';
//   showMessageBox('Are you sure?', { ok: 'Yes', cancel: 'No' })
//     .then((accepted) => { if (accepted) … });
//
// The promise resolves to true on OK, false on Cancel/X. Only one
// message box can be open at a time — call collapses to the most
// recent prompt.

import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Control } from '../control.js';
import { uiManager } from '../ui-manager.js';

class TextButton extends Control {
  constructor({ label, width = 80, height = 22, onClick }) {
    super();
    this.width = width; this.height = height;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._txt = new Label(label, { fontSize: 11, hue: 0xfff0c0, stroke: true });
    this._txt.acceptMouseInput = false;
    this.add(this._txt);
    this._txt.setPosition(Math.max(2, (width - label.length * 6) / 2), 4);
    this.acceptMouseInput = true;
    this._onClick = onClick;
    this._gfx.rect(0, 0, width, height).fill({ color: 0x1c1612 }).stroke({ width: 1, color: 0x4a3818 });
  }
  onMouseDown() { this._onClick?.(); }
}

function wrapText(text, maxCharsPerLine = 50) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).length > maxCharsPerLine && cur) { lines.push(cur); cur = w; }
    else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

export class MessageBoxGump extends WindowGump {
  constructor({ text, ok = 'OK', cancel = null, onResolve }) {
    const lines = wrapText(text, 50);
    const h = 60 + lines.length * 16 + 32;
    super({ title: 'Message', width: 360, height: h, x: window.innerWidth/2 - 180, y: window.innerHeight/2 - h/2 });
    this._onResolve = onResolve;

    let y = 32;
    for (const ln of lines) {
      const lbl = new Label(ln, { fontSize: 12, hue: 0xfff0c0, stroke: true });
      lbl.setPosition(16, y);
      this.add(lbl);
      y += 16;
    }
    y += 12;

    const btnW = cancel ? 90 : 100;
    const total = cancel ? btnW * 2 + 12 : btnW;
    let bx = (360 - total) / 2;

    const okBtn = new TextButton({
      label: ok, width: btnW,
      onClick: () => { this._resolve(true); this.close?.(); },
    });
    okBtn.setPosition(bx, y);
    this.add(okBtn);
    bx += btnW + 12;

    if (cancel) {
      const cancelBtn = new TextButton({
        label: cancel, width: btnW,
        onClick: () => { this._resolve(false); this.close?.(); },
      });
      cancelBtn.setPosition(bx, y);
      this.add(cancelBtn);
    }

    this._resolved = false;
  }

  _resolve(v) {
    if (this._resolved) return;
    this._resolved = true;
    this._onResolve?.(v);
  }

  close(...args) {
    this._resolve(false);
    return super.close?.(...args);
  }

  get type() { return 'message-box'; }
}

let _activeBox = null;
export function showMessageBox(text, { ok = 'OK', cancel = null } = {}) {
  if (_activeBox) {
    try { _activeBox.close?.(); } catch { /* ignored */ }
    _activeBox = null;
  }
  return new Promise((resolve) => {
    const box = new MessageBoxGump({
      text, ok, cancel,
      onResolve: (v) => {
        try { uiManager.clearModal?.(box); } catch { /* ignore */ }
        _activeBox = null; resolve(v);
      },
    });
    _activeBox = box;
    uiManager.show?.(box);
    try { uiManager.setModal?.(box); } catch { /* ignore */ }
  });
}
