// NewsBoardGump — Town Cryer / shard-events board. Mirrors ServUO
// `Services/Town Cryer/TownCryerNewsGump.cs` + the `[events` chat
// surface. Lists the 30 most-recent shard events with timestamp +
// kind colouring; clicking on a row prints the full message + payload.

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

const ROW_H = 16;

const KIND_COLOR = {
  'champion-defeat':     0xff8030,
  'champion-tier':       0xffd06a,
  'world-boss-spawn':    0xff4040,
  'world-boss-defeat':   0xff8030,
  'artifact-discovered': 0xffd700,
  'achievement-unlocked':0x60c0ff,
  'house-built':         0x80ff80,
  'house-demolished':    0x808080,
  'faction-corruption':  0xff8030,
  'sigil-captured':      0xffd06a,
  'season-change':       0x80ffff,
  'weather':             0x80c0ff,
  'death':               0xff4040,
  'login':               0xc0ffc0,
  'logout':              0x808080,
  'system':              0xfff0c0,
};

class NewsRow extends Control {
  constructor({ ev, onClick }) {
    super();
    this.width = 540; this.height = ROW_H;
    this.acceptMouseInput = true;
    const ts = new Date(ev.ts).toISOString().slice(11, 19);
    const color = KIND_COLOR[ev.kind] ?? 0xfff0c0;
    const text = `[${ts}] ${ev.kind.padEnd(20)} ${ev.message.slice(0, 70)}`;
    this._lbl = new Label(text, { fontSize: 10, hue: color, fontFamily: 'Consolas, monospace' });
    this._lbl.setPosition(0, 1);
    this.add(this._lbl);
    this._onClick = onClick;
    this._ev = ev;
  }
  onMouseEnter() { this._lbl?.node?.alpha != null && (this._lbl.node.alpha = 0.7); }
  onMouseLeave() { this._lbl?.node?.alpha != null && (this._lbl.node.alpha = 1); }
  onClick()      { this._onClick?.(this._ev); }
}

export class NewsBoardGump extends WindowGump {
  constructor() {
    super({ title: 'Town Cryer — Recent Shard Events', width: 580, height: 420, x: 100, y: 90 });
    this._rows = [];
    this._events = [];

    this._scroll = new ScrollArea({ width: 552, height: 320 });
    this.addContent(this._scroll, 14, 30);

    // Filter buttons (5 most-useful kinds + All).
    const filters = [
      ['All',     null],
      ['Boss',    'champion-defeat'],
      ['World',   'world-boss-spawn'],
      ['Artifact','artifact-discovered'],
      ['House',   'house-built'],
      ['Faction', 'faction-corruption'],
    ];
    let bx = 14;
    for (const [label, kind] of filters) {
      const b = new Button({
        normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
        width: 70, height: 22, label, action: ButtonAction.Activate,
      });
      b.setPosition(bx, 360);
      b.onClick = () => { this._filter = kind; this._issue(`[events recent ${kind ?? ''}`.trim()); this._clearRows(); };
      this.add(b);
      bx += 76;
    }

    const close = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 60, height: 22, label: 'Close', action: ButtonAction.Activate,
    });
    close.setPosition(500, 360); this.add(close);
    close.onClick = () => this.close();

    this._filter = null;
    this._unsub = bus.on('chat:system', (m) => this._consume(m?.text ?? String(m)));
    this._issue('[events recent');
  }
  get type() { return 'news-board'; }
  dispose() { this._unsub?.(); super.dispose?.(); }

  _consume(text) {
    if (!text) return;
    // Server format: "  [HH:MM:SS] <kind padded> <message>"
    const m = text.match(/^\s+\[(\d\d:\d\d:\d\d)\]\s+(\S+)\s+(.+)$/);
    if (!m) return;
    const ev = { ts: Date.now(), kind: m[2], message: m[3] };
    this._events.push(ev);
    this._appendRow(ev);
  }

  _clearRows() {
    for (const r of this._rows) r.dispose?.();
    this._rows = [];
    this._events = [];
    this._scroll.clear?.();
  }
  _appendRow(ev) {
    const row = new NewsRow({
      ev, onClick: (e) => bus.emit('chat:system', { text: `> ${e.message}` }),
    });
    row.setPosition(0, this._rows.length * ROW_H);
    this._scroll.add?.(row);
    this._rows.push(row);
    this._scroll.setContentHeight?.(this._rows.length * ROW_H);
  }

  _issue(line) { try { net.send?.(buildSpeechCmd(line)); } catch { /* ignore */ } }
}

export const newsBoardGump = new NewsBoardGump();
