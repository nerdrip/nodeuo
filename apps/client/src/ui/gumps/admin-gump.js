// AdminGump — central GM control panel. Mirrors ServUO `Gumps/AdminGump.cs`
// at MVP scope. Four tabs: Accounts, Characters, World, Items.
//
// Each tab dispatches the matching `[admin <tab> <sub>` command via the
// 0xAD speech packet so it shares the server-side surface with the
// chat command. Selecting a row sets `_selected` and renders sub-buttons.

import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { Control } from '../control.js';
import { net } from '../../net/net-client.js';
import { bus } from '../../core/event-bus.js';

const TABS = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'chars',    label: 'Chars' },
  { id: 'world',    label: 'World' },
  { id: 'items',    label: 'Items' },
];

class TabButton extends Control {
  constructor({ label, active, onClick }) {
    super();
    this.width = 92; this.height = 24;
    this._label = label; this._active = active; this._onClick = onClick;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._txt = new Label(label, { fontSize: 12, hue: 0xfff0c0, stroke: true });
    this._txt.setPosition(10, 6);
    this.add(this._txt);
    this.acceptMouseInput = true;
    this._draw();
  }
  setActive(v) { this._active = v; this._draw(); }
  onMouseDown() { this._onClick?.(); }
  _draw() {
    this._gfx.clear();
    this._gfx.rect(0, 0, this.width, this.height)
      .fill({ color: this._active ? 0x6a4a18 : 0x1c1612 })
      .stroke({ width: 1, color: 0x4a3818 });
  }
}

export class AdminGump extends WindowGump {
  constructor() {
    super({ title: 'Admin Panel', width: 540, height: 460, x: 90, y: 80 });

    this._tab = 'accounts';
    this._tabButtons = [];

    let tx = 12;
    for (const t of TABS) {
      const btn = new TabButton({
        label: t.label, active: t.id === this._tab,
        onClick: () => this.setTab(t.id),
      });
      btn.setPosition(tx, 28);
      this.add(btn);
      this._tabButtons.push({ id: t.id, ctrl: btn });
      tx += 100;
    }

    // Output / list pane.
    this._scroll = new ScrollArea({ width: 516, height: 320 });
    this.addContent(this._scroll, 12, 60);
    this._lines = [];

    // Action buttons row at the bottom.
    this._actions = new Control();
    this._actions.width = 540; this._actions.height = 30;
    this.addContent(this._actions, 0, 392);
    this._actionControls = [];

    // Capture system-message responses (the chat command writes them
    // back via `state.sendSystemMessage`). We intercept to populate the
    // scroll list — a future server-side gump packet would replace this.
    this._unsub = bus.on('chat:system', (m) => this._appendLine(m?.text ?? String(m)));

    this._renderActions();
    this._issue('list');
  }

  get type() { return 'admin'; }

  dispose() { this._unsub?.(); super.dispose?.(); }

  setTab(id) {
    if (this._tab === id) return;
    this._tab = id;
    for (const tb of this._tabButtons) tb.ctrl.setActive(tb.id === id);
    this._clearLines();
    this._renderActions();
    this._issue(id === 'world' ? 'counts' : 'list');
  }

  _renderActions() {
    while (this._actionControls.length) {
      this._actionControls.pop()?.dispose?.();
    }
    const buttons = ACTIONS[this._tab] ?? [];
    let x = 12;
    for (const b of buttons) {
      const btn = new Button({
        normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
        width: 80, height: 22, label: b.label, action: ButtonAction.Activate,
      });
      btn.setPosition(x, 4);
      btn.onClick = () => this._issue(b.cmd, b.prompt);
      this._actions.add(btn);
      this._actionControls.push(btn);
      x += 86;
    }
  }

  _appendLine(text) {
    if (!text) return;
    const lbl = new Label(String(text), { fontSize: 11, hue: 0xfff0c0 });
    lbl.setPosition(0, this._lines.length * 14);
    this._scroll.add?.(lbl);
    this._lines.push(lbl);
    this._scroll.setContentHeight?.(this._lines.length * 14);
  }

  _clearLines() {
    while (this._lines.length) this._lines.pop()?.dispose?.();
    this._scroll.setContentHeight?.(0);
  }

  _issue(sub, promptForArg) {
    let line = `[admin ${this._tab} ${sub}`;
    if (promptForArg) {
      // Lazy: blocking-prompt via window.prompt isn't ideal but it
      // matches the chat command's <name> requirement without forcing
      // a custom modal. The future client gump replaces this with an
      // inline TextInput.

      const arg = (typeof window !== 'undefined' ? window.prompt(`${promptForArg}:`) : '');
      if (!arg) return;
      line += ` ${arg}`;
    }
    try { net.send?.(buildSpeechCmd(line)); } catch { /* ignore */ }
  }
}

const ACTIONS = {
  accounts: [
    { label: 'List',   cmd: 'list' },
    { label: 'Kick',   cmd: 'kick',   prompt: 'Account name' },
    { label: 'Ban',    cmd: 'ban',    prompt: 'Account name' },
    { label: 'Unban',  cmd: 'unban',  prompt: 'Account name' },
    { label: 'Promote',cmd: 'promote',prompt: 'Name + level (Player|GM|Admin)' },
  ],
  chars: [
    { label: 'List',   cmd: 'list' },
    { label: 'Find',   cmd: 'find',   prompt: 'Name fragment' },
    { label: 'Tele',   cmd: 'teleto', prompt: 'Name' },
    { label: 'Kill',   cmd: 'kill',   prompt: 'Name' },
    { label: 'Res',    cmd: 'res',    prompt: 'Name' },
  ],
  world: [
    { label: 'Counts', cmd: 'counts' },
    { label: 'Save',   cmd: 'save' },
    { label: 'Bcast',  cmd: 'broadcast', prompt: 'Message' },
  ],
  items: [
    { label: 'Counts', cmd: 'counts' },
    { label: 'Prune',  cmd: 'prune' },
    { label: 'Freeze', cmd: 'freeze',  prompt: 'Radius' },
  ],
};

function buildSpeechCmd(text) {
  const enc = new TextEncoder();
  const body = enc.encode(text + '\0');
  const buf = new Uint8Array(12 + body.length);
  let o = 0;
  buf[o++] = 0xAD;
  buf[o++] = 0x00; buf[o++] = (12 + body.length) & 0xff;
  buf[o++] = 0;
  buf[o++] = 0; buf[o++] = 0;
  buf[o++] = 0; buf[o++] = 0;
  buf[o++] = 0x45; buf[o++] = 0x4E; buf[o++] = 0x55; buf[o++] = 0;
  buf.set(body, o);
  return buf;
}

export const adminGump = new AdminGump();
