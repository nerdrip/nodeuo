// AchievementProgressGump — graphical progress bars for the player's
// achievement counters (kills / crafts / exceptionals / imbues /
// tames / tmaps). Driven by `[achievements progress` system messages
// (one line per counter). Each bar shows the raw count next to a
// sliding threshold display.

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

// Counter → next-tier threshold(s) — mirror what's in
// `systems/achievements.js`. Each bar resets to 0 after the highest
// threshold, marked "MAX".
const NEXT_THRESHOLD = {
  kills:        [1, 100, 1000],
  crafts:       [1, 1000],
  exceptionals: [100],
  imbues:       [50],
  tmaps:        [1, 50],
  tames:        [10, 100],
};

const ROW_H = 30;

class CounterRow extends Control {
  constructor({ key, value }) {
    super();
    this.width = 380; this.height = ROW_H;
    const tiers = NEXT_THRESHOLD[key] ?? [];
    const next = tiers.find((t) => value < t);
    const target = next ?? tiers[tiers.length - 1] ?? 1;
    const isMax = !next;
    const pct = isMax ? 1 : Math.max(0, Math.min(1, value / target));

    const bg = new Graphics();
    bg.rect(0, 0, this.width, this.height).fill({ color: 0x1a1612 });
    this.node.addChild(bg);

    const lbl = new Label(`${key}`, { fontSize: 11, hue: 0xfff0c0 });
    lbl.setPosition(8, 4); this.add(lbl);

    const right = new Label(
      isMax ? `${value} (MAX)` : `${value} / ${target}`,
      { fontSize: 11, hue: isMax ? 0x80ff80 : 0xc0b890 },
    );
    right.setPosition(this.width - 110, 4); this.add(right);

    const bar = new Graphics();
    bar.rect(8, 18, this.width - 16, 8).fill({ color: 0x222222, alpha: 0.85 })
       .stroke({ width: 1, color: 0x000000, alpha: 0.9 });
    if (pct > 0) {
      const fillColor = isMax ? 0x80ff80 : 0xffd06a;
      bar.rect(9, 19, (this.width - 18) * pct, 6).fill({ color: fillColor });
    }
    this.node.addChild(bar);
  }
}

export class AchievementProgressGump extends WindowGump {
  constructor() {
    super({ title: 'Achievement Progress', width: 420, height: 380, x: 220, y: 130 });
    this._rows = [];
    this._scroll = new ScrollArea({ width: 392, height: 280 });
    this.addContent(this._scroll, 14, 30);

    const refresh = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 80, height: 22, label: 'Refresh', action: ButtonAction.Activate,
    });
    refresh.setPosition(14, 330); this.add(refresh);
    refresh.onClick = () => this._refresh();

    const close = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 60, height: 22, label: 'Close', action: ButtonAction.Activate,
    });
    close.setPosition(340, 330); this.add(close);
    close.onClick = () => this.close();

    this._unsub = bus.on('chat:system', (m) => this._consume(m?.text ?? String(m)));
    this._refresh();
  }
  get type() { return 'achievement-progress'; }
  dispose() { this._unsub?.(); super.dispose?.(); }

  _refresh() {
    for (const r of this._rows) r.dispose?.();
    this._rows = [];
    this._scroll.clear?.();
    try { net.send?.(buildSpeechCmd('[achievements progress')); }
    catch { /* ignore */ }
  }

  _consume(text) {
    if (!text) return;
    // Server format: "  <key>            <value>"
    const m = text.match(/^\s+(\S+)\s+(\d+)$/);
    if (!m) return;
    const key = m[1];
    const value = parseInt(m[2], 10) || 0;
    const row = new CounterRow({ key, value });
    row.setPosition(0, this._rows.length * (ROW_H + 2));
    this._scroll.add?.(row);
    this._rows.push(row);
    this._scroll.setContentHeight?.(this._rows.length * (ROW_H + 2));
  }
}

export const achievementProgressGump = new AchievementProgressGump();
