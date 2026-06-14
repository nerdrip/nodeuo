// RunebookGump — 16-rune (or 24-rune for Atlas) panel. Mirrors
// ServUO RunebookGump (`Items/Books/Runebook.cs`).
//
// Open with `runebookGump.show(snapshot)` where snapshot has the
// shape returned by `systems/runebook.js::snapshot(item)`:
//   { slots, defaultIndex, chargesLeft, chargesMax, atlas, name }
// Each slot button issues a `[runebook recall N` chat command.

import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button } from '../controls/button.js';
import { Control } from '../control.js';
import { net } from '../../net/net-client.js';

const ROW_H = 22;

class RuneRow extends Control {
  constructor({ index, slot, isDefault, onRecall, onGate, onMark, onDrop, onDefault }) {
    super();
    this.width = 350;
    this.height = ROW_H;

    this._bg = new Graphics();
    this.node.addChild(this._bg);

    this._lbl = new Label('', { fontSize: 11, hue: 0x808080 });
    this._lbl.setPosition(8, 5);
    this._lbl.acceptMouseInput = false;
    this.add(this._lbl);

    this._recall = new Button({ label: 'R',  width: 18, height: 16 });
    this._gate   = new Button({ label: 'G',  width: 18, height: 16 });
    this._def    = new Button({ label: '*',  width: 18, height: 16 });
    this._drop   = new Button({ label: 'X',  width: 18, height: 16 });
    this._mark   = new Button({ label: 'Mark', width: 38, height: 16 });
    this._recall.setPosition(this.width - 100, 3);
    this._gate.setPosition(this.width - 80, 3);
    this._def.setPosition(this.width - 60, 3);
    this._drop.setPosition(this.width - 40, 3);
    this._mark.setPosition(this.width - 60, 3);
    this.add(this._recall);
    this.add(this._gate);
    this.add(this._def);
    this.add(this._drop);
    this.add(this._mark);
    this.update({ index, slot, isDefault, onRecall, onGate, onMark, onDrop, onDefault });
  }

  update({ index, slot, isDefault, onRecall, onGate, onMark, onDrop, onDefault }) {
    this._bg.clear();
    this._bg.rect(0, 0, this.width, this.height).fill({ color: isDefault ? 0x3a2818 : 0x1a1612 });
    const label = slot
      ? `${(index + 1).toString().padStart(2)}. ${slot.name}  (${slot.x},${slot.y})`
      : `${(index + 1).toString().padStart(2)}. (empty)`;
    this._lbl.setText(label);
    this._lbl.setHue?.(slot ? 0xfff0c0 : 0x808080);
    this._recall.onClick = () => onRecall?.(index);
    this._gate.onClick = () => onGate?.(index);
    this._def.onClick = () => onDefault?.(index);
    this._drop.onClick = () => onDrop?.(index);
    this._mark.onClick = () => onMark?.(index);
    for (const btn of [this._recall, this._gate, this._def, this._drop]) {
      btn.visible = !!slot;
      btn.node.visible = !!slot;
    }
    this._mark.visible = !slot;
    this._mark.node.visible = !slot;
    this.visible = true;
    this.node.visible = true;
  }
}

export class RunebookGump extends WindowGump {
  constructor() {
    super({ title: 'Runebook', width: 380, height: 480, x: 220, y: 80 });
    this._snap = null;

    this._chargeLbl = new Label('charges 0/0', { fontSize: 11, hue: 0xc0b890 });
    this._chargeLbl.setPosition(14, 28);
    this.add(this._chargeLbl);

    this._rowsHost = { x: 14, y: 50 };
    this._rows = [];

    const recharge = new Button({ label: 'Recharge', width: 70, height: 18 });
    recharge.setPosition(280, 28);
    recharge.onClick = () => this._cmd('recharge');
    this.add(recharge);

    const close = new Button({ label: 'Close', width: 60, height: 18 });
    close.setPosition(300, 450);
    close.onClick = () => this.close?.();
    this.add(close);
  }

  show(snap) {
    this._snap = snap ?? null;
    if (!snap) return;
    this._chargeLbl.setText?.(`${snap.atlas ? 'Atlas' : 'Book'} — charges ${snap.chargesLeft}/${snap.chargesMax}`);
    let y = this._rowsHost.y;
    for (let i = 0; i < snap.slots.length; i++) {
      let row = this._rows[i];
      const info = {
        index: i,
        slot: snap.slots[i],
        isDefault: i === snap.defaultIndex,
        onRecall:  (idx) => this._cmd(`recall ${idx + 1}`),
        onGate:    (idx) => this._cmd(`gate ${idx + 1}`),
        onMark:    (idx) => this._cmd(`mark ${idx + 1}`),
        onDrop:    (idx) => this._cmd(`drop ${idx + 1}`),
        onDefault: (idx) => this._cmd(`default ${idx + 1}`),
      };
      if (!row) {
        row = new RuneRow(info);
        this._rows[i] = row;
        this.add(row);
      } else {
        row.update(info);
      }
      row.setPosition(this._rowsHost.x, y);
      y += ROW_H + 2;
    }
    for (let i = snap.slots.length; i < this._rows.length; i++) {
      this._rows[i].visible = false;
      this._rows[i].node.visible = false;
    }
  }

  _cmd(line) {
    try { net.send?.(buildSpeechCmd(`[runebook ${line}`)); } catch { /* ignore */ }
  }

  get type() { return 'runebook'; }
}

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

export const runebookGump = new RunebookGump();
