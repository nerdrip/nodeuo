// MacroButtonGump — port of ClassicUO `Game/UI/Gumps/MacroButtonGump.cs`.
// A floating one-button hotbar tile that fires a saved macro on click.
// Drag a macro out of the MacroGump editor → this spawns under the
// cursor. Mirrors the spell / ability hotbar pattern.

import { Gump } from '../gump.js';
import { Control } from '../control.js';
import { Graphics } from 'pixi.js';
import { Label } from '../controls/label.js';
import { tooltips } from '../../managers/tooltip-manager.js';
import { macroManager } from '../../managers/macro-manager.js';

const ICON = 44;

class MacroIcon extends Control {
  constructor(macro) {
    super();
    this.macro = macro;
    this.width = ICON; this.height = ICON;
    this.acceptMouseInput = true;
    this._frame = new Graphics();
    this.node.addChild(this._frame);
    this._draw(false);
    const lbl = new Label((macro?.name ?? 'M').slice(0, 3), {
      fontSize: 14, hue: 0xFFE060,
    });
    lbl.setPosition((ICON - 16) / 2, (ICON - 18) / 2);
    lbl.acceptMouseInput = false;
    this.add(lbl);
  }
  _draw(hover) {
    this._frame.clear();
    this._frame.rect(0, 0, ICON, ICON)
      .fill({ color: hover ? 0x3a4660 : 0x14263e, alpha: 0.9 })
      .stroke({ width: 2, color: hover ? 0xfff0a0 : 0x6a4a18 });
  }
  onMouseEnter(e) {
    this._draw(true);
    tooltips.showText(e.global.x, e.global.y,
      `${this.macro?.name ?? '(unnamed)'}\n${(this.macro?.actions ?? []).map((a) => a.kind ?? a).join(' → ')}`);
  }
  onMouseLeave() { this._draw(false); tooltips.hide(); }
  onClick() {
    if (!this.macro) return;
    // Audit #41 client P1 #7 — `MacroManager.run(actions)` iterates
    // the array. Passing the whole macro object iterated nothing.
    try { macroManager.run?.(this.macro.actions ?? []); }
    catch { /* runtime error in user macro — silent */ }
  }
}

export class MacroButtonGump extends Gump {
  constructor(macro, x = 240, y = 240) {
    super();
    this.setPosition(x, y);
    this.setSize(ICON, ICON);
    this.macro = macro;
    const icon = new MacroIcon(macro);
    icon.isDragHandle = true;
    this.add(icon);
  }
  get type() { return `macro-button:${this.macro?.id ?? this.macro?.name ?? '?'}`; }
}
