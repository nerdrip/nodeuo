// BodRewardsGump — browse + claim Bulk Order Deed rewards. Mirrors
// ServUO `Engines/BulkOrders/Gumps/RewardChoiceGump.cs`. The bod
// system already computes per-deed reward tier (`rollBodReward`) and
// returns a list of `{ itemId, amount?, name?, material? }` entries;
// this gump renders a checkbox per option and dispatches the chosen
// one through the chat surface.

import { Graphics } from 'pixi.js';
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

const ROW_H = 26;

class RewardRow extends Control {
  constructor({ entry, onPick }) {
    super();
    this.width = 360; this.height = ROW_H;
    const bg = new Graphics();
    bg.rect(0, 0, this.width, this.height).fill({ color: 0x1a1612 });
    this.node.addChild(bg);

    const lbl = new Label(`${entry.name ?? '(reward)'} ×${entry.amount ?? 1}`,
      { fontSize: 11, hue: 0xfff0c0 });
    lbl.setPosition(10, 7); this.add(lbl);
    if (entry.material) {
      const mat = new Label(`(${entry.material})`, { fontSize: 10, hue: 0xc0b890 });
      mat.setPosition(220, 8); this.add(mat);
    }
    const claim = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 60, height: 18, label: 'Claim', action: ButtonAction.None,
    });
    claim.setPosition(this.width - 70, 4); this.add(claim);
    claim.onClick = () => onPick?.(entry);
  }
}

export class BodRewardsGump extends WindowGump {
  constructor() {
    super({ title: 'Bulk Order Rewards', width: 400, height: 380, x: 220, y: 110 });
    this._rows = [];

    this._title = new Label('Pending bulk orders:', { fontSize: 12, hue: 0xfff0c0, stroke: true });
    this._title.setPosition(14, 28); this.add(this._title);

    this._scroll = new ScrollArea({ width: 372, height: 280 });
    this.addContent(this._scroll, 14, 50);

    const refresh = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 80, height: 22, label: 'Refresh', action: ButtonAction.Activate,
    });
    refresh.setPosition(14, 340); this.add(refresh);
    refresh.onClick = () => this._issue('[bod rewards');

    const close = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 60, height: 22, label: 'Close', action: ButtonAction.Activate,
    });
    close.setPosition(320, 340); this.add(close);
    close.onClick = () => this.close();

    // Server `[bod rewards` command emits one system message per
    // available reward. Format expected:
    //   "REWARD <key> ×<amt> [<material>] :: <name>"
    this._unsub = bus.on('chat:system', (m) => this._consume(m?.text ?? String(m)));
    this._issue('[bod rewards');
  }

  get type() { return 'bod-rewards'; }
  dispose() { this._unsub?.(); super.dispose?.(); }

  _consume(text) {
    if (!text) return;
    const m = text.match(/^REWARD\s+(\S+)\s+×(\d+)(?:\s+\[(\w+)\])?\s+::\s+(.+)$/);
    if (!m) return;
    const entry = {
      key: m[1],
      amount: parseInt(m[2], 10) || 1,
      material: m[3] ?? null,
      name: m[4],
    };
    this._appendRow(entry);
  }

  _appendRow(entry) {
    const row = new RewardRow({
      entry,
      onPick: (e) => this._issue(`[bod claim ${e.key}`),
    });
    row.setPosition(0, this._rows.length * (ROW_H + 2));
    this._scroll.add?.(row);
    this._rows.push(row);
    this._scroll.setContentHeight?.(this._rows.length * (ROW_H + 2));
  }

  _issue(line) { try { net.send?.(buildSpeechCmd(line)); } catch { /* ignore */ } }
}

export const bodRewardsGump = new BodRewardsGump();
