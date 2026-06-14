// MapPinEditorGump — blank-map pin editor. ServUO `Items/MapItem.cs`
// + classic UO `MapGump`. Lets the player drop up to 50 named pins on
// a blank canvas-sized representation of a map item, then dispatch
// `[map pins save` to persist them on the item.
//
// Triggered by `@@OPEN_MAPPINS_GUMP@@<itemHex>||<width>||<height>||<pinsCsv>`
// where pinsCsv is `x|y|label` joined by `;`. Server `[map pins`
// command emits this; gump submits its mutations as `[map pin add <x> <y> <label>`
// and `[map pin del <i>` chat verbs.

import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { Control } from '../control.js';
import { bus } from '../../core/event-bus.js';
import { buildMapMessage, buildUnicodeSpeech } from '../../net/outgoing.js';

const MAX_PINS = 50;

class CanvasPin extends Control {
  constructor({ x, y, label: _label, idx, onClick }) {
    super();
    this.width = 12; this.height = 12;
    this.setPosition(x - 6, y - 6);
    const g = new Graphics();
    g.circle(6, 6, 5).fill({ color: 0xff4040 }).stroke({ width: 1, color: 0x202020 });
    this.node.addChild(g);
    this._idx = idx;
    this._onClick = onClick;
    this.acceptMouseInput = true;
    // Tiny label tag (1-indexed) next to the pin.
    const tag = new Label(String(idx + 1), { fontSize: 9, hue: 0xfff0c0, stroke: true });
    tag.setPosition(13, -2);
    this.add(tag);
  }
  onMouseDown() { this._onClick?.(this._idx); }
}

export class MapPinEditorGump extends WindowGump {
  /** @param {{ net?: any, itemSerial?: number, width?: number, height?: number, x1?: number, y1?: number, x2?: number, y2?: number, pins?: Array<{x,y,label}> }} opts */
  constructor(opts = {}) {
    const w = opts.width  ?? 320;
    const h = opts.height ?? 320;
    const serial = opts.itemSerial >>> 0;
    super({ title: `Map${serial ? ` 0x${serial.toString(16)}` : ''} (${(opts.pins ?? []).length}/${MAX_PINS} pins)`,
            width: w + 32, height: h + 96, x: 220, y: 100 });
    this._net = opts.net;
    this._itemSerial = serial;
    this._pins = (opts.pins ?? []).slice(0, MAX_PINS);
    this._canvasW = w; this._canvasH = h;
    this._x1 = opts.x1 | 0; this._y1 = opts.y1 | 0;
    this._x2 = opts.x2 | 0; this._y2 = opts.y2 | 0;
    this._unsubs = [
      bus.on('mapgump:pin', (info) => this._handleMapPinPacket(info)),
      bus.on('map:pin-update', (info) => this.updateMapInfo(info)),
    ];

    // Parchment canvas.
    const bg = new Graphics();
    bg.rect(16, 30, w, h).fill({ color: 0x2a2014 }).stroke({ width: 2, color: 0x806030 });
    this.node.addChild(bg);
    this._canvasBg = bg;
    this._canvasOriginX = 16;
    this._canvasOriginY = 30;

    this._renderPins();

    // Click-to-add: track raw mouse on the canvas.
    bg.eventMode = 'static';
    bg.cursor = 'pointer';
    bg.on('pointerdown', (e) => {
      if (this._pins.length >= MAX_PINS) return;
      const lx = e.global.x - this.node.x - this._canvasOriginX;
      const ly = e.global.y - this.node.y - this._canvasOriginY;
      if (lx < 0 || ly < 0 || lx > w || ly > h) return;
      const idx = this._pins.length + 1;
      const label = `Pin ${idx}`;
      const mapPoint = this._canvasToMapPoint(lx | 0, ly | 0);
      this._pins.push({ x: mapPoint.x, y: mapPoint.y, label });
      this._renderPins();
      if (!this._sendMap(1, idx - 1, mapPoint.x, mapPoint.y)) {
        this._sendCmd(`map pin add ${mapPoint.x} ${mapPoint.y} ${label}`);
      }
    });

    const close = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 100, height: 22,
      label: 'Close', action: ButtonAction.Activate,
    });
    close.setPosition(16, h + 50);
    close.onClick = () => this.close();
    this.add(close);

    const clear = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 100, height: 22,
      label: 'Clear All', action: ButtonAction.Activate,
    });
    clear.setPosition(130, h + 50);
    clear.onClick = () => {
      this._pins = [];
      this._renderPins();
      if (!this._sendMap(5, 0, 0, 0)) this._sendCmd('map pin clear');
    };
    this.add(clear);

    this.addContent(new Label('Click on the parchment to drop a pin. Click a pin to remove it.',
      { fontSize: 10, hue: 0xa0a0a0 }), 16, h + 78);
  }

  _renderPins() {
    for (const p of (this._renderedPins ?? [])) p.dispose?.();
    this._renderedPins = [];
    this.setTitle(`Map${this._itemSerial ? ` 0x${this._itemSerial.toString(16)}` : ''} (${this._pins.length}/${MAX_PINS} pins)`);
    this._pins.forEach((p, i) => {
      const pt = this._pinCanvasPoint(p.x, p.y);
      const pin = new CanvasPin({
        x: this._canvasOriginX + pt.x, y: this._canvasOriginY + pt.y,
        label: p.label, idx: i,
        onClick: (idx) => {
          const old = this._pins[idx];
          this._pins.splice(idx, 1);
          this._renderPins();
          if (!this._sendMap(4, idx, old?.x ?? 0, old?.y ?? 0)) this._sendCmd(`map pin del ${idx}`);
        },
      });
      this.add(pin);
      this._renderedPins.push(pin);
    });
  }

  updateMapInfo(info = {}) {
    if ((info.serial >>> 0) !== this._itemSerial) return;
    if (Number.isFinite(info.x1)) this._x1 = info.x1 | 0;
    if (Number.isFinite(info.y1)) this._y1 = info.y1 | 0;
    if (Number.isFinite(info.x2)) this._x2 = info.x2 | 0;
    if (Number.isFinite(info.y2)) this._y2 = info.y2 | 0;
    this._renderPins();
  }

  _handleMapPinPacket(info = {}) {
    if ((info.serial >>> 0) !== this._itemSerial) return;
    const cmd = info.cmd | 0;
    const pinNum = Math.max(0, info.pinNum | 0);
    const pin = { x: info.x | 0, y: info.y | 0, label: `Pin ${pinNum + 1}` };
    if (cmd === 1) {
      if (this._pins.length < MAX_PINS) this._pins.push(pin);
    } else if (cmd === 2) {
      if (this._pins.length < MAX_PINS) this._pins.splice(Math.min(pinNum, this._pins.length), 0, pin);
    } else if (cmd === 3 || cmd === 6 || cmd === 7) {
      if (this._pins[pinNum]) this._pins[pinNum] = { ...this._pins[pinNum], x: pin.x, y: pin.y };
    } else if (cmd === 4) {
      if (this._pins[pinNum]) this._pins.splice(pinNum, 1);
    } else if (cmd === 5) {
      this._pins = [];
    }
    this._renderPins();
  }

  _pinCanvasPoint(x, y) {
    const rx = x | 0;
    const ry = y | 0;
    const bw = (this._x2 | 0) - (this._x1 | 0);
    const bh = (this._y2 | 0) - (this._y1 | 0);
    if (bw > 0 && bh > 0 && rx >= this._x1 && rx <= this._x2 && ry >= this._y1 && ry <= this._y2) {
      const sx = Math.max(0, Math.min(1, (rx - this._x1) / bw));
      const sy = Math.max(0, Math.min(1, (ry - this._y1) / bh));
      return { x: Math.round(sx * this._canvasW), y: Math.round(sy * this._canvasH) };
    }
    if (rx >= 0 && ry >= 0 && rx <= this._canvasW && ry <= this._canvasH) return { x: rx, y: ry };
    return {
      x: Math.max(0, Math.min(this._canvasW, rx)),
      y: Math.max(0, Math.min(this._canvasH, ry)),
    };
  }

  _canvasToMapPoint(x, y) {
    const bw = (this._x2 | 0) - (this._x1 | 0);
    const bh = (this._y2 | 0) - (this._y1 | 0);
    if (bw > 0 && bh > 0) {
      return {
        x: this._x1 + Math.round((Math.max(0, Math.min(this._canvasW, x | 0)) / Math.max(1, this._canvasW)) * bw),
        y: this._y1 + Math.round((Math.max(0, Math.min(this._canvasH, y | 0)) / Math.max(1, this._canvasH)) * bh),
      };
    }
    return { x: x | 0, y: y | 0 };
  }

  _sendMap(action, pin, x, y) {
    if (!this._itemSerial || typeof this._net?.send !== 'function') return false;
    try {
      this._net.send(buildMapMessage(this._itemSerial, action, pin, x, y));
      return true;
    } catch {
      return false;
    }
  }

  _sendCmd(cmd) {
    if (this._net?.sendCommand) {
      try { this._net.sendCommand(cmd); } catch { /* */ }
    } else if (typeof this._net?.send === 'function') {
      try {
        const text = cmd.startsWith('[') ? cmd : `[${cmd}`;
        this._net.send(buildUnicodeSpeech(text, { type: 0x00, hue: 0x03B2 }));
      } catch { /* */ }
    }
  }

  dispose() {
    for (const off of this._unsubs ?? []) {
      try { off(); } catch { /* ignore */ }
    }
    this._unsubs = [];
    super.dispose();
  }

  get type() { return 'map-pins'; }
}

export function parseMapPinsPayload(raw) {
  if (!raw || typeof raw !== 'string') return { itemSerial: 0, width: 320, height: 320, pins: [] };
  const [hex, w, h, pinsCsv] = raw.split('||');
  const pins = (pinsCsv ?? '').split(';').filter(Boolean).map((row) => {
    const [x, y, ...labelParts] = row.split('|');
    return { x: x | 0, y: y | 0, label: labelParts.join('|') };
  });
  return {
    itemSerial: parseInt(hex, 16) >>> 0,
    width: w | 0, height: h | 0, pins,
  };
}
