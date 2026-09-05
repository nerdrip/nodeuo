// HelpGump — in-game help menu (ServUO `Gumps/HelpGump.cs`).
// Phase G #4.
//
// Triggered by `[help` or pressing the F1/Help key. Lets the player
// queue a PageQueue request, browse common topics, or open the
// staff-facing report panel. Submissions route through the existing
// `apps/server/src/help-queue.js` PageQueue.
//
// Wire format: each option sends a chat command via `net.sendCommand`.
// The server-side `help-queue.js` already handles `[page <reason>` and
// `[help-topic <id>` — this gump just builds the UI on top.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';

const TOPICS = [
  { id: 'stuck',          label: 'I am stuck and cannot move',      cmd: 'stuck' },
  { id: 'griefer',        label: 'Report a harassing player',       cmd: 'page harassment' },
  { id: 'bug',            label: 'Report a bug',                     cmd: 'page bug' },
  { id: 'gm-question',    label: 'Question for a Game Master',      cmd: 'page question' },
  { id: 'lost-item',      label: 'Lost item / dupe report',         cmd: 'page item-loss' },
  { id: 'account',        label: 'Account / login problems',        cmd: 'page account' },
  { id: 'shard',          label: 'Server problems / crash report',  cmd: 'page crash' },
];

export class HelpGump extends WindowGump {
  /** @param {{ net?: any }} opts */
  constructor(opts = {}) {
    super({ title: 'Help Menu', width: 380, height: 280, x: 220, y: 140 });
    this._net = opts.net;

    this.addContent(new Label(
      'Choose the topic that best describes your problem.',
      { fontSize: 11, hue: 0xffe0a0 },
    ), 12, 30);
    this.addContent(new Label(
      'A Game Master will review your page when one becomes available.',
      { fontSize: 10, hue: 0xc0c0c0 },
    ), 12, 48);

    let y = 78;
    for (const t of TOPICS) {
      const b = new Button({
        normalGumpId: 0x0481, pressedGumpId: 0x0482,
        width: 340, height: 22,
        label: t.label, action: ButtonAction.Activate,
      });
      b.setPosition(20, y);
      b.onClick = () => { this._submit(t.cmd); this.close(); };
      this.add(b);
      y += 26;
    }

    const close = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 80, height: 20,
      label: 'Close', action: ButtonAction.Cancel,
    });
    close.setPosition(280, y + 6);
    close.onClick = () => this.close();
    this.add(close);
  }

  _submit(cmd) {
    if (this._net?.sendCommand) {
      try { this._net.sendCommand(cmd); } catch { /* */ }
    }
  }

  get type() { return 'help'; }
}
