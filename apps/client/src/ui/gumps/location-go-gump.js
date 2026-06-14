// LocationGoGump — small modal for "go to coordinates" or "go to
// landmark". Mirrors ClassicUO Game/UI/Gumps/LocationGoGump.cs (+ our
// existing `[go ...` text command).
//
// User types either "x y [z]" (3 ints) or a landmark name (e.g.
// "britain"). On submit we send `[go <input>` via the text command
// channel — server-side `[go` resolves landmarks and integer triples.

import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Control } from '../control.js';
import { TextInput } from '../controls/text-input.js';
import { net } from '../../net/net-client.js';
import { buildTextCommand } from '../../net/outgoing.js';
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

export class LocationGoGump extends WindowGump {
  constructor() {
    super({ title: 'Go to…', width: 280, height: 130, x: 100, y: 100 });

    const help = new Label('Coords "x y [z]" or landmark', {
      fontSize: 10, hue: 0xa08868, stroke: false });
    help.setPosition(12, 30);
    this.add(help);

    this._input = new TextInput({
      width: 240, height: 22,
      placeholder: 'e.g. 1496 1624  or  britain',
      text: '',
    });
    this._input.setPosition(12, 50);
    this.add(this._input);

    const go = new TextButton({
      label: 'Go', width: 80,
      onClick: () => this._submit(),
    });
    go.setPosition(12, 86);
    this.add(go);

    const cancel = new TextButton({
      label: 'Cancel', width: 80,
      onClick: () => this.close?.(),
    });
    cancel.setPosition(110, 86);
    this.add(cancel);
  }

  _submit() {
    const raw = (this._input?.value ?? '').trim();
    if (!raw) return;
    try { net.send(buildTextCommand(`go ${raw}`)); } catch { /* socket */ }
    this.close?.();
  }

  get type() { return 'location-go'; }
}

export function showLocationGo() {
  const g = new LocationGoGump();
  uiManager.show?.(g);
  return g;
}
