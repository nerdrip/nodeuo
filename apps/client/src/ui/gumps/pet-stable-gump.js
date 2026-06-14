// PetStableGump — list stabled pets + claim. Mirrors ServUO
// `Mobiles/AI/AnimalTrainer.cs` stable browse gump. Driven through
// the `[stable` chat command which the server uses to surface +
// claim slots. Each row = one stabled pet (kind + name + HP).

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

const ROW_H = 24;

class StabledPetRow extends Control {
  constructor({ slot, pet, onClaim, onDeposit }) {
    super();
    this.width = 360; this.height = ROW_H;
    const bg = new Graphics();
    bg.rect(0, 0, this.width, this.height).fill({ color: 0x1a1612 });
    this.node.addChild(bg);

    const label = pet
      ? `[${slot}] ${pet.name ?? '(pet)'} (${pet.kind})  HP ${pet.hp}/${pet.hpMax}`
      : `[${slot}] (empty slot)`;
    const lbl = new Label(label, { fontSize: 11, hue: pet ? 0xfff0c0 : 0x808080 });
    lbl.setPosition(8, 6); this.add(lbl);

    if (pet) {
      const claim = new Button({
        normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
        width: 50, height: 16, label: 'Claim', action: ButtonAction.None,
      });
      claim.setPosition(this.width - 56, 4); this.add(claim);
      claim.onClick = () => onClaim?.(slot);
    } else {
      const dep = new Button({
        normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
        width: 60, height: 16, label: 'Deposit', action: ButtonAction.None,
      });
      dep.setPosition(this.width - 66, 4); this.add(dep);
      dep.onClick = () => onDeposit?.(slot);
    }
  }
}

export class PetStableGump extends WindowGump {
  constructor() {
    super({ title: 'Animal Trainer', width: 400, height: 320, x: 220, y: 120 });
    this._rows = [];
    this._slots = [];

    this._title = new Label('Stabled creatures:', { fontSize: 12, hue: 0xfff0c0, stroke: true });
    this._title.setPosition(14, 28); this.add(this._title);

    this._scroll = new ScrollArea({ width: 372, height: 200 });
    this.addContent(this._scroll, 14, 50);

    const refresh = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 80, height: 22, label: 'Refresh', action: ButtonAction.Activate,
    });
    refresh.setPosition(14, 270); this.add(refresh);
    refresh.onClick = () => this._issue('[stable list');

    const close = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 60, height: 22, label: 'Close', action: ButtonAction.Activate,
    });
    close.setPosition(320, 270); this.add(close);
    close.onClick = () => this.close();

    // Server `[stable list` echoes one line per slot:
    //   "STABLE <slot> <kind> <name> <hp>/<hpMax>"
    //   "STABLE <slot> empty"
    this._unsub = bus.on('chat:system', (m) => this._consume(m?.text ?? String(m)));
    this._issue('[stable list');
  }

  get type() { return 'pet-stable'; }
  dispose() { this._unsub?.(); super.dispose?.(); }

  _consume(text) {
    if (!text) return;
    const empty = text.match(/^STABLE\s+(\d+)\s+empty$/);
    if (empty) {
      this._appendRow({ slot: parseInt(empty[1], 10), pet: null });
      return;
    }
    const m = text.match(/^STABLE\s+(\d+)\s+(\S+)\s+(.+?)\s+(\d+)\/(\d+)$/);
    if (!m) return;
    this._appendRow({
      slot: parseInt(m[1], 10),
      pet: {
        kind: m[2], name: m[3],
        hp: parseInt(m[4], 10), hpMax: parseInt(m[5], 10),
      },
    });
  }

  _appendRow({ slot, pet }) {
    const row = new StabledPetRow({
      slot, pet,
      onClaim:   (n) => this._issue(`[stable claim ${n}`),
      onDeposit: (n) => this._issue(`[stable deposit ${n}`),
    });
    row.setPosition(0, this._rows.length * (ROW_H + 2));
    this._scroll.add?.(row);
    this._rows.push(row);
    this._scroll.setContentHeight?.(this._rows.length * (ROW_H + 2));
  }

  _issue(line) { try { net.send?.(buildSpeechCmd(line)); } catch { /* ignore */ } }
}

export const petStableGump = new PetStableGump();
