// ImbuingGump — client UI for the Imbuing skill (id 57).
//
// ServUO `Scripts/Services/Craft/Imbuing/Gumps/ImbuingGump.cs` exposes a
// 3-step flow: pick the item slot, pick the property, dial the intensity.
// Our server-side mechanic is `[imbue <serial> <attr> <intensity>`;
// this gump just composes that string after collecting the inputs.
//
// Flow:
//   1. Player double-clicks an imbuable item (weapon/armor/jewelry) ->
//      server emits the sentinel `@@OPEN_IMBUING_GUMP@@ <serial>`.
//      game-scene catches it and instantiates this gump bound to the
//      serial. (Players can also open the gump empty via `[imbue` with
//      no args, which prompts a target — also routes here.)
//   2. The attribute list ships from the server as
//      `IMBUE_ATTR <id> <attribute> <maxIntensity>` lines (one per row)
//      — we accept the existing `[imbueattrs` output already parsable
//      by this format. The gump rebuilds rows as lines arrive.
//   3. Slider + input set the intensity (1..max). Hitting "Imbue"
//      sends `[imbue <serial> <attribute> <intensity>` which the
//      existing command path handles (essence cost + skill roll +
//      budget gate).

import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { Control } from '../control.js';
import { TextInput } from '../controls/text-input.js';
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

const ROW_H = 22;

class AttrRow extends Control {
  constructor({ attribute, maxIntensity, isSelected, onPick }) {
    super();
    this.width = 360; this.height = ROW_H;
    const bg = new Graphics();
    bg.rect(0, 0, this.width, this.height).fill({ color: isSelected ? 0x3a2818 : 0x1a1612 });
    this.node.addChild(bg);
    const lbl = new Label(
      `${attribute}  (max ${maxIntensity})`,
      { fontSize: 11, hue: isSelected ? 0xffe080 : 0xc0b090 },
    );
    lbl.setPosition(8, 5); this.add(lbl);
    this.acceptMouseInput = true;
    this.node.eventMode = 'static';
    this.node.on?.('pointerdown', () => onPick?.(attribute, maxIntensity));
  }
}

export class ImbuingGump extends WindowGump {
  /**
   * @param {object} opts
   * @param {number} [opts.serial] — item serial to imbue, 0 if not yet picked
   */
  constructor({ serial = 0 } = {}) {
    super({ title: 'Imbuing', width: 420, height: 380, x: 200, y: 100 });
    this._serial = serial >>> 0;
    this._picked = null;
    this._maxIntensity = 15;

    const hdr = new Label(
      this._serial
        ? `Item: 0x${this._serial.toString(16).toUpperCase()}`
        : 'No item bound — use [imbue <serial> directly.',
      { fontSize: 12, hue: 0xfff0c0, stroke: true },
    );
    hdr.setPosition(14, 28); this.add(hdr);

    this._scroll = new ScrollArea({ width: 392, height: 220 });
    this.addContent(this._scroll, 14, 50);
    this._rows = [];

    // Intensity input + "Imbue" button.
    const intensityLbl = new Label('Intensity (1..15):', { fontSize: 12, hue: 0xc0b090 });
    intensityLbl.setPosition(14, 280); this.add(intensityLbl);
    this._intensity = new TextInput({ width: 60, height: 22, text: '1', maxLength: 2 });
    this._intensity.setPosition(140, 278); this.add(this._intensity);

    const imbueBtn = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 90, height: 22, label: 'Imbue', action: ButtonAction.Activate,
    });
    imbueBtn.setPosition(220, 278); this.add(imbueBtn);
    imbueBtn.onClick = () => this._sendImbue();

    const refresh = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 90, height: 22, label: 'Refresh', action: ButtonAction.Activate,
    });
    refresh.setPosition(14, 330); this.add(refresh);
    refresh.onClick = () => this._refreshAttrs();

    const close = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 90, height: 22, label: 'Close', action: ButtonAction.Activate,
    });
    close.setPosition(310, 330); this.add(close);
    close.onClick = () => this.close();

    // Server emits attribute rows as system messages with a "IMBUE_ATTR"
    // prefix; we sniff for them and rebuild the list.
    this._unsub = bus.on('chat:system', (m) => this._consume(m?.text ?? String(m)));
    bus.on?.('message:journal', (m) => {
      if (m?.text) this._consume(m.text);
    });
    this._refreshAttrs();
  }

  get type() { return 'imbuing'; }
  dispose() { this._unsub?.(); super.dispose?.(); }

  _consume(text) {
    if (!text) return;
    const m = text.match(/^IMBUE_ATTR\s+(\S+)\s+(\d+)$/);
    if (!m) return;
    this._appendRow({ attribute: m[1], maxIntensity: parseInt(m[2], 10) });
  }

  _appendRow({ attribute, maxIntensity }) {
    const row = new AttrRow({
      attribute, maxIntensity,
      isSelected: attribute === this._picked,
      onPick: (attr, max) => {
        this._picked = attr;
        this._maxIntensity = max;
        this._intensity.setText?.(String(Math.min(parseInt(this._intensity._text?.text ?? '1', 10) || 1, max)));
        this._rebuildRows();
      },
    });
    row.setPosition(0, this._rows.length * (ROW_H + 2));
    this._scroll.add?.(row);
    this._rows.push({ control: row, attribute, maxIntensity });
    this._scroll.setContentHeight?.(this._rows.length * (ROW_H + 2));
  }

  _rebuildRows() {
    // Recolour rows so the selected one stays highlighted across picks.
    const buf = this._rows.slice();
    for (const r of buf) {
      try { this._scroll.remove?.(r.control); } catch { /* ignore */ }
    }
    this._rows = [];
    for (const r of buf) this._appendRow({ attribute: r.attribute, maxIntensity: r.maxIntensity });
  }

  _refreshAttrs() {
    // Clear current rows + ask the server to re-emit IMBUE_ATTR lines.
    for (const r of this._rows) {
      try { this._scroll.remove?.(r.control); } catch { /* ignore */ }
    }
    this._rows = [];
    this._issue('[imbueattrs gump');
  }

  _sendImbue() {
    if (!this._serial) {
      bus.emit?.('chat:system', { text: 'Bind the gump to an item first.' });
      return;
    }
    if (!this._picked) {
      bus.emit?.('chat:system', { text: 'Pick a property.' });
      return;
    }
    const raw = parseInt(this._intensity._text?.text ?? '1', 10);
    const clamped = Math.max(1, Math.min(this._maxIntensity, Number.isFinite(raw) ? raw : 1));
    this._issue(`[imbue 0x${this._serial.toString(16)} ${this._picked} ${clamped}`);
  }

  _issue(line) { try { net.send?.(buildSpeechCmd(line)); } catch { /* ignore */ } }
}
