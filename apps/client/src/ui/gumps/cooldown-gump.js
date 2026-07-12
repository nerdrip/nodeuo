import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';

const WIDTH = 220;
const ROW_H = 28;

export class CooldownGump extends WindowGump {
  constructor(initial = null) {
    super({ title: 'Cooldowns', width: WIDTH, height: 62, x: 735, y: 530 });
    this._toggleKey = 'cooldowns';
    this._cooldowns = new Map();
    if (initial) this.updateCooldown(initial);
  }

  get type() { return 'cooldowns'; }

  updateCooldown(data) {
    if (!data?.id) return;
    const durationMs = Math.max(1, data.durationMs | 0);
    this._cooldowns.set(String(data.id), {
      ...data,
      durationMs,
      startedAt: performance.now(),
      endsAt: performance.now() + durationMs,
    });
    this._rebuild();
  }

  removeCooldown(id) {
    if (this._cooldowns.delete(String(id))) this._rebuild();
  }

  _rebuild() {
    for (const child of this._rows ?? []) {
      try { this.remove(child); } catch { /* already detached */ }
      child.dispose?.();
    }
    this._rows = [];
    let index = 0;
    for (const cooldown of [...this._cooldowns.values()].slice(0, 6)) {
      const y = 26 + index * ROW_H;
      const bar = new Graphics();
      this.node.addChild(bar);
      const label = new Label(cooldown.label ?? cooldown.id, { fontSize: 10, hue: 0xffefca });
      label.setPosition(8, y + 3); this.add(label);
      const timer = new Label('', { fontSize: 9, hue: 0xffd36a });
      timer.setPosition(179, y + 3); this.add(timer);
      this._rows.push({ bar, label, timer, cooldown, y });
      index++;
    }
    const height = Math.max(62, 30 + Math.max(1, index) * ROW_H);
    this._h = height; this.setSize(WIDTH, height);
    this._bg?.setSize?.(WIDTH, height);
    this.tick(performance.now());
  }

  tick(now) {
    let expired = false;
    for (const row of this._rows ?? []) {
      const remaining = Math.max(0, row.cooldown.endsAt - now);
      const ratio = Math.max(0, Math.min(1, remaining / row.cooldown.durationMs));
      row.bar.clear();
      row.bar.roundRect(6, row.y, WIDTH - 12, 22, 3).fill({ color: 0x101722, alpha: 0.92 });
      row.bar.roundRect(6, row.y, (WIDTH - 12) * ratio, 22, 3)
        .fill({ color: row.cooldown.category === 'spell' ? 0x425bb5 : 0x8d6831, alpha: 0.75 });
      row.timer.setText(`${(remaining / 1000).toFixed(1)}s`);
      if (remaining <= 0) {
        this._cooldowns.delete(String(row.cooldown.id));
        expired = true;
      }
    }
    if (expired) this._rebuild();
  }
}
