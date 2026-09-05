import { Graphics } from 'pixi.js';
import {
  TILE_HALF_H, TILE_HALF_W, worldToScreenX, worldToScreenY,
} from './iso.js';
import { bus } from '../core/event-bus.js';

function tileKey(x, y) { return `${x}|${y}`; }

/** Pure AoE footprint generator, exported for smoke/regression tests. */
export function spellAreaTiles(origin, target, area = {}) {
  if (!origin || !target) return [];
  const shape = area.shape ?? 'single';
  const radius = Math.max(0, Math.min(12, area.radius | 0));
  if (shape === 'single' || radius === 0) return [{ x: target.x | 0, y: target.y | 0 }];
  const result = [];
  const seen = new Set();
  const add = (x, y) => {
    const key = tileKey(x, y);
    if (seen.has(key)) return;
    seen.add(key); result.push({ x, y });
  };
  if (shape === 'circle') {
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) add(target.x + dx, target.y + dy);
    }
    return result;
  }

  const aimX = target.x - origin.x;
  const aimY = target.y - origin.y;
  const aimLength = Math.hypot(aimX, aimY) || 1;
  const ux = aimX / aimLength, uy = aimY / aimLength;
  if (shape === 'line') {
    for (let step = 1; step <= radius; step++) {
      add(Math.round(origin.x + ux * step), Math.round(origin.y + uy * step));
    }
    return result;
  }
  if (shape === 'cone') {
    const halfAngle = Math.max(15, Math.min(180, area.angle | 0 || 90)) * Math.PI / 360;
    const cosLimit = Math.cos(halfAngle);
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const distance = Math.hypot(dx, dy);
      if (distance < 0.5 || distance > radius) continue;
      if ((dx * ux + dy * uy) / distance >= cosLimit) add(origin.x + dx, origin.y + dy);
    }
    return result;
  }
  return [{ x: target.x | 0, y: target.y | 0 }];
}

export function spellRangeRing(origin, range) {
  const radius = Math.max(0, Math.min(18, range | 0));
  if (!origin || radius === 0) return [];
  const tiles = [];
  for (let d = -radius; d <= radius; d++) {
    tiles.push({ x: origin.x + d, y: origin.y - radius });
    tiles.push({ x: origin.x + d, y: origin.y + radius });
    if (Math.abs(d) !== radius) {
      tiles.push({ x: origin.x - radius, y: origin.y + d });
      tiles.push({ x: origin.x + radius, y: origin.y + d });
    }
  }
  return tiles;
}

export class SpellRangePreview {
  constructor(parent, { landAt = null } = {}) {
    this.graphics = new Graphics();
    this.graphics.zIndex = 899_000_000;
    this.graphics.eventMode = 'none';
    parent.addChild(this.graphics);
    this.landAt = landAt;
    this.spec = null;
    this._lastKey = '';
    // Composer ranges are only meaningful while editing. A server/admin
    // target prompt (e.g. [kill]) supersedes that context; clear the old ring
    // so its blue diamonds cannot masquerade as terrain corruption.
    this._offTarget = bus.on('target:active', () => this.clear());
  }

  get active() { return !!this.spec; }

  setSpec(spec) {
    this.spec = spec?.active === false ? null : spec;
    this._lastKey = '';
    if (!this.spec) this.graphics.clear();
  }

  clear() { this.setSpec(null); }

  update(origin, hovered) {
    if (!this.spec || !origin) return;
    const range = Math.max(0, Math.min(18, this.spec.range | 0));
    const rawTarget = hovered ?? origin;
    const dx = rawTarget.x - origin.x, dy = rawTarget.y - origin.y;
    const distance = Math.max(Math.abs(dx), Math.abs(dy));
    const inRange = distance <= range;
    const scale = distance > range && distance > 0 ? range / distance : 1;
    const target = {
      x: Math.round(origin.x + dx * scale),
      y: Math.round(origin.y + dy * scale),
      z: rawTarget.z ?? origin.z,
    };
    const area = this.spec.area ?? { shape: 'single', radius: 0 };
    const key = `${origin.x}|${origin.y}|${origin.z}|${target.x}|${target.y}|${range}|${area.shape}|${area.radius}|${area.angle}|${inRange}`;
    if (key === this._lastKey) return;
    this._lastKey = key;
    this.graphics.clear();

    for (const tile of spellRangeRing(origin, range)) {
      this._diamond(tile.x, tile.y, origin.z, 0x55b7ff, 0.08, 0x78c9ff, 0.55);
    }
    const fill = inRange ? 0xffb347 : 0xff4f55;
    for (const tile of spellAreaTiles(origin, target, area)) {
      const z = this.landAt?.(tile.x, tile.y)?.z ?? target.z ?? origin.z;
      this._diamond(tile.x, tile.y, z, fill, 0.20, fill, 0.82);
    }
    this._diamond(target.x, target.y, target.z, fill, 0.13, 0xffffff, 0.95);
  }

  _diamond(x, y, z, fill, fillAlpha, stroke, strokeAlpha) {
    const cx = worldToScreenX(x, y);
    const cy = worldToScreenY(x, y, z);
    this.graphics.poly([
      cx, cy - TILE_HALF_H,
      cx + TILE_HALF_W, cy,
      cx, cy + TILE_HALF_H,
      cx - TILE_HALF_W, cy,
    ], true).fill({ color: fill, alpha: fillAlpha })
      .stroke({ width: 1, color: stroke, alpha: strokeAlpha });
  }

  destroy() {
    this._offTarget?.();
    this._offTarget = null;
    this.graphics.destroy();
  }
}
