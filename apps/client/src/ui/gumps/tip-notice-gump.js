// TipNoticeGump — daily tip / system notice popup. Mirrors ClassicUO
// `Game/UI/Gumps/TipNoticeGump.cs`.
//
// Server pushes 0x99 (newcomer tip) or a `tip:show` bus event on login
// or when the player triggers a help interaction. The gump shows:
//   - title strip
//   - body text (multi-line)
//   - optional [<] / [>] arrows when there are multiple tips queued
//   - [Don't show this again] checkbox (writes to ProfileManager)
//
// Tips are pulled from a local list. Server-pushed tips override.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { Control } from '../control.js';
import { bus } from '../../core/event-bus.js';
import { profile } from '../../managers/profile-manager.js';

const DEFAULT_TIPS = Object.freeze([
  { id: 'movement',  title: 'Tip: Movement',
    body: 'Click and hold the right mouse button to walk. Hold Shift to run.' },
  { id: 'targeting', title: 'Tip: Targeting',
    body: 'When the cursor turns into a crosshair, click on a target.\nPress Escape to cancel.' },
  { id: 'paperdoll', title: 'Tip: Paperdoll',
    body: 'Double-click yourself to open your paperdoll.\nDrag items to/from equipment slots.' },
  { id: 'macros',    title: 'Tip: Macros',
    body: 'Press [m] to open the macro list.\nHotkey common actions for combat efficiency.' },
  { id: 'skills',    title: 'Tip: Skills',
    body: 'Use [skills] or click the Skills button on your status bar.\nLock skills you don\'t want to gain to focus on chosen ones.' },
]);

const SUPPRESS_KEY = 'ui.suppressedTips';

function isSuppressed(tipId) {
  const list = profile.get(SUPPRESS_KEY) ?? [];
  return list.includes(tipId);
}
function suppressTip(tipId) {
  const list = profile.get(SUPPRESS_KEY) ?? [];
  if (list.includes(tipId)) return;
  list.push(tipId);
  profile.set(SUPPRESS_KEY, list);
}

class WrappedText extends Control {
  constructor(text, width, opts = {}) {
    super();
    this.width = width;
    const lines = String(text).split(/\r?\n/);
    let y = 0;
    for (const line of lines) {
      const lbl = new Label(line, { fontSize: opts.fontSize ?? 12, hue: opts.hue ?? 0xe0e0c0 });
      lbl.setPosition(0, y);
      this.add(lbl);
      y += (opts.fontSize ?? 12) + 4;
    }
    this.height = y;
  }
}

export class TipNoticeGump extends WindowGump {
  constructor(tips = DEFAULT_TIPS) {
    super({ title: 'Notice', width: 360, height: 220, x: 240, y: 120 });
    this._tips = tips.filter((t) => !isSuppressed(t.id));
    this._idx = 0;
    if (this._tips.length === 0) {
      this.close();
      return;
    }
    this._renderCurrent();
  }

  _renderCurrent() {
    // Clear previous children except chrome.
    if (this._content) {
      try { this._content.dispose?.(); } catch {}
    }
    const tip = this._tips[this._idx];
    if (!tip) return;
    this.setTitle?.(tip.title ?? 'Notice');

    this._content = new Control();
    this._content.setPosition(15, 30);
    this.add(this._content);

    const body = new WrappedText(tip.body, 320);
    this._content.add(body);

    // Suppress checkbox.
    const sup = new Button({
      normalGumpId: 0x0FA2, pressedGumpId: 0x0FA3, buttonId: 0,
      action: ButtonAction.Activate, width: 16, height: 16,
      label: '[ ]',
    });
    sup.setPosition(0, body.height + 12);
    sup.onClick = () => {
      suppressTip(tip.id);
      sup._label?.setText?.('[X]');
    };
    this._content.add(sup);
    const supLbl = new Label("Don't show this tip again",
                              { fontSize: 11, hue: 0xa0a0a0 });
    supLbl.setPosition(20, body.height + 14);
    this._content.add(supLbl);

    // Prev / Next arrows.
    if (this._tips.length > 1) {
      const prev = new Button({
        normalGumpId: 0x0FAE, pressedGumpId: 0x0FAF, buttonId: 0,
        action: ButtonAction.Activate, width: 18, height: 18,
        label: '<',
      });
      prev.setPosition(0, body.height + 40);
      prev.onClick = () => {
        this._idx = (this._idx - 1 + this._tips.length) % this._tips.length;
        this._renderCurrent();
      };
      this._content.add(prev);

      const next = new Button({
        normalGumpId: 0x0FA8, pressedGumpId: 0x0FA9, buttonId: 0,
        action: ButtonAction.Activate, width: 18, height: 18,
        label: '>',
      });
      next.setPosition(40, body.height + 40);
      next.onClick = () => {
        this._idx = (this._idx + 1) % this._tips.length;
        this._renderCurrent();
      };
      this._content.add(next);
    }
  }
}

export function installTipNoticeListener(uiManager) {
  bus.on('tip:show', (info) => {
    if (info?.tipId && isSuppressed(info.tipId)) return;
    const tips = info?.tips ?? (info?.tipId
      ? DEFAULT_TIPS.filter((t) => t.id === info.tipId)
      : DEFAULT_TIPS);
    const g = new TipNoticeGump(tips);
    uiManager.add(g);
  });
}
