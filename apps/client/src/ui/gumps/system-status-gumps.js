// VeteranRewardsGump / HuntmasterGump / FactionSigilsGump — three
// thin Pixi panels that listen to system-message responses from the
// matching `[claimreward` / `[hunt` / `[sigils` chat commands. Each
// gump simply re-issues the chat command + scrolls the response.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { Control } from '../control.js';
import { net } from '../../net/net-client.js';
import { bus } from '../../core/event-bus.js';

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

/** Generic helper: gump with a scrollable read-out + a row of buttons
 *  that dispatch `[<cmd> <arg>` chat lines. Subclasses override the
 *  `_buttons()` factory and the chat prefix. */
class CommandPanel extends WindowGump {
  constructor({ title, width = 460, height = 380, prefix }) {
    super({ title, width, height, x: 120, y: 120 });
    this._prefix = prefix;
    this._scroll = new ScrollArea({ width: width - 24, height: height - 110 });
    this.addContent(this._scroll, 12, 30);
    this._lines = [];

    this._actions = new Control();
    this._actions.width = width; this._actions.height = 30;
    this.addContent(this._actions, 0, height - 64);

    this._unsub = bus.on('chat:system', (m) => this._appendLine(m?.text ?? String(m)));
    this._buildButtons();
  }
  dispose() { this._unsub?.(); super.dispose?.(); }

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
  _issue(line) {
    try { net.send?.(buildSpeechCmd(line)); } catch { /* ignore */ }
  }
  _buildButtons() { /* override */ }
}

// --------------------------------------------------------------------
//  Veteran Rewards
// --------------------------------------------------------------------
export class VeteranRewardsGump extends CommandPanel {
  constructor() { super({ title: 'Veteran Rewards', prefix: 'claimreward' }); }
  get type() { return 'veteran-rewards'; }
  _buildButtons() {
    const refresh = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 80, height: 22, label: 'Refresh', action: ButtonAction.Activate,
    });
    refresh.setPosition(12, 4);
    refresh.onClick = () => { this._clearLines(); this._issue('[claimreward'); };
    this._actions.add(refresh);

    const claim = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 80, height: 22, label: 'Claim', action: ButtonAction.Activate,
    });
    claim.setPosition(98, 4);
    claim.onClick = () => {

      const name = (typeof window !== 'undefined' ? window.prompt('Reward name:') : '');
      if (!name) return;
      this._issue(`[claimreward ${name.trim()}`);
    };
    this._actions.add(claim);

    // Initial fetch
    this._issue('[claimreward');
  }
}

// --------------------------------------------------------------------
//  Huntmaster Challenge leaderboard
// --------------------------------------------------------------------
export class HuntmasterGump extends CommandPanel {
  constructor() { super({ title: 'Huntmaster Challenge', prefix: 'hunt' }); }
  get type() { return 'huntmaster'; }
  _buildButtons() {
    const top = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 80, height: 22, label: 'Top 10', action: ButtonAction.Activate,
    });
    top.setPosition(12, 4);
    top.onClick = () => { this._clearLines(); this._issue('[hunt top'); };
    this._actions.add(top);

    const mine = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 80, height: 22, label: 'Mine', action: ButtonAction.Activate,
    });
    mine.setPosition(98, 4);
    mine.onClick = () => { this._clearLines(); this._issue('[hunt mine'); };
    this._actions.add(mine);

    const target = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 80, height: 22, label: 'Target', action: ButtonAction.Activate,
    });
    target.setPosition(184, 4);
    target.onClick = () => { this._clearLines(); this._issue('[hunt'); };
    this._actions.add(target);

    this._issue('[hunt');
  }
}

// --------------------------------------------------------------------
//  Faction Sigils
// --------------------------------------------------------------------
export class FactionSigilsGump extends CommandPanel {
  constructor() { super({ title: 'Faction Sigils', prefix: 'sigils' }); }
  get type() { return 'faction-sigils'; }
  _buildButtons() {
    const list = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 80, height: 22, label: 'Sigils', action: ButtonAction.Activate,
    });
    list.setPosition(12, 4);
    list.onClick = () => { this._clearLines(); this._issue('[sigils'); };
    this._actions.add(list);

    const towns = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 80, height: 22, label: 'Towns', action: ButtonAction.Activate,
    });
    towns.setPosition(98, 4);
    towns.onClick = () => { this._clearLines(); this._issue('[sigils towns'); };
    this._actions.add(towns);

    const pickup = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 80, height: 22, label: 'Pickup', action: ButtonAction.Activate,
    });
    pickup.setPosition(184, 4);
    pickup.onClick = () => {

      const town = (typeof window !== 'undefined' ? window.prompt('Town (britain|magincia|minoc|trinsic|yew):') : '');
      if (!town) return;
      this._issue(`[sigils pickup ${town}`);
    };
    this._actions.add(pickup);

    const drop = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 80, height: 22, label: 'Drop', action: ButtonAction.Activate,
    });
    drop.setPosition(270, 4);
    drop.onClick = () => {

      const town = (typeof window !== 'undefined' ? window.prompt('Town:') : '');
      if (!town) return;
      this._issue(`[sigils drop ${town}`);
    };
    this._actions.add(drop);

    this._issue('[sigils');
  }
}

export const veteranRewardsGump = new VeteranRewardsGump();
export const huntmasterGump = new HuntmasterGump();
export const factionSigilsGump = new FactionSigilsGump();
