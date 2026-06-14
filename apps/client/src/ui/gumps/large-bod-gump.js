// LargeBodGump — Large Bulk Order Deed progress UI (ServUO
// `Gumps/LargeBODGump.cs`). Faza G #9.
//
// Receives a payload of:
//   { label: string, skill: number, material: string, exceptional: bool,
//     slots: Array<{ itemId, label, done }>, reward: string }
// and renders one row per slot with a check / cross indicator.
//
// Actions:
//   • "Combine"  — opens a target prompt for selecting a small deed
//                  (server-side via `[bod combine <small> <this>`).
//   • "Claim"    — sends `[bod-claim` when every slot is done.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';

const SKILL_NAMES = {
  8: 'Blacksmithy', 10: 'Inscription', 22: 'Tailoring',
  35: 'Carpentry', 45: 'Fletching',
};

export class LargeBodGump extends WindowGump {
  /**
   * @param {{
   *   net?: any,
   *   bod?: { label: string, skill: number, material: string,
   *           exceptional: boolean, reward: string,
   *           slots: Array<{ itemId: number, label: string, done: boolean }> },
   *   serial?: number,
   * }} opts
   */
  constructor(opts = {}) {
    const bod = opts.bod ?? { slots: [] };
    super({
      title: bod.label ?? 'Large Bulk Order',
      width: 380, height: 320, x: 220, y: 130,
    });
    this._net = opts.net;
    this._serial = opts.serial >>> 0;
    this._bod = bod;

    const skillLabel = SKILL_NAMES[bod.skill] ?? `Skill #${bod.skill}`;
    this.addContent(new Label(`${skillLabel}  •  Material: ${bod.material}${bod.exceptional ? '  •  Exceptional' : ''}`,
      { fontSize: 11, hue: 0xffe0a0 }), 14, 30);

    const slots = bod.slots ?? [];
    const doneCount = slots.filter((s) => s.done).length;
    this.addContent(new Label(`Progress: ${doneCount}/${slots.length}`,
      { fontSize: 11, hue: doneCount === slots.length ? 0x44ff44 : 0xffffff }), 14, 50);

    let y = 78;
    for (const slot of slots) {
      const mark = slot.done ? '✓' : '☐';
      const hue = slot.done ? 0x44ff44 : 0xc0c0c0;
      this.addContent(new Label(`${mark}  ${slot.label}`, { fontSize: 11, hue }), 26, y);
      y += 18;
    }

    this.addContent(new Label(`Reward: ${bod.reward ?? '(unknown)'}`,
      { fontSize: 10, hue: 0xffe0a0 }), 14, y + 16);

    // Bottom action row.
    const combine = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 100, height: 22, label: 'Combine', action: ButtonAction.Activate,
    });
    combine.setPosition(14, 270);
    combine.onClick = () => this._sendCmd('bod combine');     // server prompts for target
    this.add(combine);

    const claim = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 100, height: 22, label: 'Claim Reward', action: ButtonAction.Activate,
    });
    claim.setPosition(130, 270);
    claim.onClick = () => { this._sendCmd('bod-claim'); this.close(); };
    this.add(claim);

    const close = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 80, height: 22, label: 'Close', action: ButtonAction.Cancel,
    });
    close.setPosition(260, 270);
    close.onClick = () => this.close();
    this.add(close);
  }

  _sendCmd(cmd) {
    if (this._net?.sendCommand) {
      try { this._net.sendCommand(cmd); } catch { /* */ }
    }
  }

  get type() { return 'large-bod'; }
}
