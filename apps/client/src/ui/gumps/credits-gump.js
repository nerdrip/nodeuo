// CreditsGump — port of ClassicUO `Game/UI/Gumps/CreditsGump.cs`. End
// credits roll. Click anywhere closes it.

import { Gump } from '../gump.js';
import { Control } from '../control.js';
import { Graphics } from 'pixi.js';
import { Label } from '../controls/label.js';

const CREDITS = [
  '— Ultima Online (Web Pixi port) —',
  '',
  'Original game:  Origin Systems / EA',
  'ClassicUO:      bittiez, kvic, mjustin, andreakarasho',
  'ServUO:         the ServUO team',
  '',
  'Web port:       Marcin Boberek',
  'Built with:     Pixi.js v8, Vite, ESM',
  '',
  'Press any key or click to close.',
];

export class CreditsGump extends Gump {
  constructor() {
    super();
    this.setSize(420, 320);
    this.setPosition((window.innerWidth - 420) / 2, (window.innerHeight - 320) / 2);
    const bg = new Control();
    bg.width = 420; bg.height = 320;
    bg.acceptMouseInput = true;
    bg.onClick = () => this._close();
    const g = new Graphics();
    g.rect(0, 0, 420, 320)
     .fill({ color: 0x070806, alpha: 0.92 })
     .stroke({ width: 2, color: 0x6e5520 });
    bg.node.addChild(g);
    this.add(bg);
    let y = 28;
    for (const line of CREDITS) {
      const lbl = new Label(line, {
        fontSize: line.startsWith('—') ? 16 : 12,
        hue: line.startsWith('—') ? 0xFFE060 : 0xfff0c0,
      });
      lbl.setPosition(20, y);
      this.add(lbl);
      y += 22;
    }
    // ESC also closes.
    this._kbd = (e) => { if (e.key === 'Escape' || e.key === 'Enter') this._close(); };
    window.addEventListener('keydown', this._kbd);
  }
  get type() { return 'credits'; }
  _close() {
    window.removeEventListener('keydown', this._kbd);
    this.parent?.removeGump?.(this);
  }
  destroy() {
    window.removeEventListener('keydown', this._kbd);
    super.destroy?.();
  }
}
