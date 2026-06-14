// MLQuests Gump — Mondain's Legacy quest board UI. Mirrors ServUO
// `Mobiles/AI/MondainQuester.cs` + `MondainQuestGump`. Lists active
// quest chains for the player, their objective progress, and offers
// abandon / complete-turnin actions.
//
// Server feed: `[quest list-gump` emits MLQ-prefixed system messages:
//   "MLQ active <chainId> <stageIdx> <stageTitle>"
//   "MLQ obj <chainId> <objIdx> <progress>/<count> <label>"
//   "MLQ available <chainId> <title>"
//   "MLQ end"
// The gump consumes them between the `start` and `end` markers and
// rebuilds its row list.

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

const ROW_H = 22;

class QuestRow extends Control {
  constructor({ chainId, stageTitle, progressLine, active, onAbandon }) {
    super();
    this.width = 480; this.height = ROW_H;
    const bg = new Graphics();
    bg.rect(0, 0, this.width, this.height).fill({ color: active ? 0x2a2014 : 0x1a1612 });
    this.node.addChild(bg);
    const lbl = new Label(
      `${active ? '◆' : '○'} ${chainId}  —  ${stageTitle}${progressLine ? '  [' + progressLine + ']' : ''}`,
      { fontSize: 11, hue: active ? 0xfff0c0 : 0xa8a890 },
    );
    lbl.setPosition(8, 5); this.add(lbl);
    if (active && onAbandon) {
      const btn = new Button({
        normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
        width: 70, height: 16, label: 'Abandon', action: ButtonAction.None,
      });
      btn.setPosition(this.width - 76, 3); this.add(btn);
      btn.onClick = () => onAbandon(chainId);
    }
  }
}

export class MLQuestsGump extends WindowGump {
  constructor() {
    super({ title: 'Mondain\'s Legacy Quest Board', width: 520, height: 420, x: 180, y: 100 });
    this._rows = [];
    this._byChain = new Map();
    this._scroll = new ScrollArea({ width: 492, height: 320 });
    this.addContent(this._scroll, 14, 50);

    const refresh = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 90, height: 22, label: 'Refresh', action: ButtonAction.Activate,
    });
    refresh.setPosition(14, 380); this.add(refresh);
    refresh.onClick = () => this._refresh();

    const close = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 90, height: 22, label: 'Close', action: ButtonAction.Activate,
    });
    close.setPosition(410, 380); this.add(close);
    close.onClick = () => this.close();

    this._unsub = bus.on('chat:system', (m) => this._consume(m?.text ?? String(m)));
    bus.on?.('message:journal', (m) => { if (m?.text) this._consume(m.text); });
    this._refresh();
  }

  get type() { return 'mlquests'; }
  dispose() { this._unsub?.(); super.dispose?.(); }

  _consume(text) {
    if (!text || !text.startsWith('MLQ ')) return;
    const m = text.match(/^MLQ (\S+) (.+)$/);
    if (!m) return;
    const cmd = m[1];
    const rest = m[2];
    if (cmd === 'end') { this._rebuild(); return; }
    if (cmd === 'active') {
      const [chainId, stageIdx, ...title] = rest.split(' ');
      this._byChain.set(chainId, {
        chainId, stageIdx, stageTitle: title.join(' '), active: true, objs: [],
      });
      return;
    }
    if (cmd === 'available') {
      const [chainId, ...title] = rest.split(' ');
      if (!this._byChain.has(chainId)) {
        this._byChain.set(chainId, {
          chainId, stageIdx: 0, stageTitle: title.join(' '), active: false, objs: [],
        });
      }
      return;
    }
    if (cmd === 'obj') {
      const [chainId, , progress, ...rest2] = rest.split(' ');
      const label = rest2.join(' ');
      const entry = this._byChain.get(chainId);
      if (entry) entry.objs.push({ progress, label });
    }
  }

  _rebuild() {
    for (const r of this._rows) {
      try { this._scroll.remove?.(r); } catch { /* */ }
    }
    this._rows = [];
    let y = 0;
    for (const entry of this._byChain.values()) {
      const progressLine = entry.objs
        .map((o) => `${o.progress} ${o.label}`).join(' · ').slice(0, 80);
      const row = new QuestRow({
        chainId: entry.chainId,
        stageTitle: entry.stageTitle,
        progressLine,
        active: entry.active,
        onAbandon: entry.active ? (id) => this._issue(`[quest abandon ${id}`) : null,
      });
      row.setPosition(0, y);
      this._scroll.add?.(row);
      this._rows.push(row);
      y += ROW_H + 2;
    }
    this._scroll.setContentHeight?.(y);
  }

  _refresh() {
    this._byChain.clear();
    for (const r of this._rows) {
      try { this._scroll.remove?.(r); } catch { /* */ }
    }
    this._rows = [];
    this._issue('[quest list-gump');
  }

  _issue(line) { try { net.send?.(buildSpeechCmd(line)); } catch { /* */ } }
}
