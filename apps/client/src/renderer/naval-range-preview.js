import { Graphics } from 'pixi.js';
import { TILE_HALF_H, TILE_HALF_W, worldToScreenX, worldToScreenY } from './iso.js';
import { world } from '../world/world.js';

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

export class NavalRangePreview {
  constructor(parent) {
    this.graphics = new Graphics();
    this.graphics.zIndex = 899_100_000;
    this.graphics.eventMode = 'none';
    parent.addChild(this.graphics);
    this.spec = null;
    this._lastKey = '';
  }

  get active() { return !!this.spec; }

  setSpec(spec) {
    this.spec = spec?.active === false ? null : spec;
    this._lastKey = '';
    if (!this.spec) this.graphics.clear();
  }

  clear() { this.setSpec(null); }

  update() {
    if (!this.spec) return;
    if (this.spec.expiresAt && Date.now() >= this.spec.expiresAt) {
      this.clear();
      return;
    }
    const boat = world.items.get(this.spec.boatSerial >>> 0);
    const bx = boat?.x ?? this.spec.x;
    const by = boat?.y ?? this.spec.y;
    const bz = boat?.z ?? this.spec.z ?? 0;
    if (!Number.isFinite(bx) || !Number.isFinite(by)) return;
    const key = `${bx}|${by}|${bz}|${boat?.facing ?? ''}|${this.spec.revision ?? 0}`;
    if (key === this._lastKey) return;
    this._lastKey = key;
    this.graphics.clear();

    for (const cannon of this.spec.cannons ?? []) {
      const cx = bx + (cannon.dx | 0);
      const cy = by + (cannon.dy | 0);
      const facing = (cannon.facing | 0) & 3;
      const [dx, dy] = DIRS[facing];
      const range = Math.max(1, Math.min(48, cannon.range | 0));
      const color = cannon.ready ? 0x66e39a : 0xffb45b;
      for (let step = 1; step <= range; step++) {
        const alpha = step === range ? 0.30 : 0.045;
        this._diamond(cx + dx * step, cy + dy * step, bz, color, alpha, step === range ? 0.85 : 0.18);
      }
      this._diamond(cx, cy, bz, 0xffdc73, 0.18, 0.95);
    }
  }

  _diamond(x, y, z, color, alpha, strokeAlpha) {
    const cx = worldToScreenX(x, y);
    const cy = worldToScreenY(x, y, z);
    this.graphics.poly([
      cx, cy - TILE_HALF_H,
      cx + TILE_HALF_W, cy,
      cx, cy + TILE_HALF_H,
      cx - TILE_HALF_W, cy,
    ], true).fill({ color, alpha })
      .stroke({ width: 1, color, alpha: strokeAlpha });
  }

  destroy() { this.graphics.destroy(); }
}
