// WorldTextManager — short-lived floating text in the world layer.
// Mirrors ClassicUO Game/Managers/WorldTextManager.cs.
//
// Used for:
//   - damage numbers (red, large) on hit
//   - heal numbers (green, large) on heal
//   - misc system text "*you fail*" near a mobile
//   - server "world text" (0x1C ASCII / 0xAE Unicode) in the world space
//
// Each entry is a Pixi Text that:
//   - lives `lifetime` ms (default 2000)
//   - rises by `dy` px over its lifetime (CUO drifts +20 px)
//   - fades to alpha 0 at end
//
// Pruned by tick(); call from main render loop.

import { Text, TextStyle } from 'pixi.js';
import { worldToScreenX, worldToScreenY } from '../renderer/iso.js';
import { world } from '../world/world.js';
import { UI_FONT_FAMILY, UI_TEXT_RESOLUTION } from '../ui/text-quality.js';

// Client perf round 2 #11: damage / heal numbers and floating world
// text used to allocate a fresh `TextStyle` per popup (object literal
// →  Pixi v8 compiles + canvas glyph cache). In a busy fight 8 mobs ×
// multiple hits/s → dozens of style builds/sec. Cache by signature
// (color/size/bold) so each unique flavour is built once.
const _styleCache = new Map();
function getWorldTextStyle({ color, fontSize, bold }) {
  const key = `${color | 0}:${fontSize | 0}:${bold ? 1 : 0}`;
  let s = _styleCache.get(key);
  if (s) return s;
  s = new TextStyle({
    fill: color, fontSize,
    fontFamily: UI_FONT_FAMILY,
    stroke: { color: 0x000000, width: 2, join: 'round' },
    fontWeight: bold ? '700' : '400',
  });
  _styleCache.set(key, s);
  return s;
}

const DAMAGE_COLORS = Object.freeze({
  phys:   0xFFFFFF,
  fire:   0xFF4040,
  cold:   0x80B0FF,
  poison: 0x60E060,
  energy: 0xFFC080,
  heal:   0x80FF80,
});

const TEXT_POOL_CAP = 128;
const _textPool = [];

export const worldTextStats = {
  created: 0,
  reused: 0,
  released: 0,
  destroyed: 0,
  active: 0,
  peakActive: 0,
  poolSize: 0,
  styleCount: 0,
};

function acquireTextNode(text, style) {
  const node = _textPool.pop();
  const out = node ?? new Text({
    text: '', style, resolution: UI_TEXT_RESOLUTION, roundPixels: true,
  });
  if (node) worldTextStats.reused++;
  else worldTextStats.created++;
  worldTextStats.active++;
  if (worldTextStats.active > worldTextStats.peakActive) {
    worldTextStats.peakActive = worldTextStats.active;
  }
  worldTextStats.poolSize = _textPool.length;
  worldTextStats.styleCount = _styleCache.size;
  out.text = text;
  out.style = style;
  out.visible = true;
  out.alpha = 1;
  out.anchor.set(0.5, 1);
  return out;
}

function releaseTextNode(node) {
  if (!node || node.destroyed) return;
  worldTextStats.released++;
  if (worldTextStats.active > 0) worldTextStats.active--;
  node.parent?.removeChild(node);
  node.visible = false;
  node.text = '';
  node.alpha = 1;
  if (_textPool.length >= TEXT_POOL_CAP) {
    worldTextStats.destroyed++;
    worldTextStats.poolSize = _textPool.length;
    node.destroy();
    return;
  }
  _textPool.push(node);
  worldTextStats.poolSize = _textPool.length;
}

export function dominantDamageType(type = 'phys') {
  if (!type) return 'phys';
  if (typeof type === 'string') return type.toLowerCase();
  if (typeof type !== 'object') return 'phys';
  let best = 'phys';
  let bestVal = 0;
  for (const key in type) {
    const n = Number(type[key]) || 0;
    if (n > bestVal) {
      bestVal = n;
      best = String(key).toLowerCase();
    }
  }
  return best;
}

export function damageColor(type = 'phys') {
  return DAMAGE_COLORS[dominantDamageType(type)] ?? DAMAGE_COLORS.phys;
}

class WorldTextEntry {
  constructor(parent, x, y, z, text, opts = {}) {
    this._parent = parent;
    this.x = x; this.y = y; this.z = z;
    this.bornAt = opts.now ?? performance.now();
    this.lifetime = opts.lifetime ?? 2000;
    this.dy = opts.dy ?? 22;
    this._dxRand = (Math.random() - 0.5) * 8;     // mild horizontal jitter
    this._serial = opts.serial ?? 0;
    // Audit rev.4 P2 — vertical stacking. CUO `WorldTextManager` lays
    // multiple overhead messages above the same mobile on a vertical
    // stack so they don't visually merge. Index supplied by the
    // manager (count of live entries on this serial at spawn).
    this._stackIndex = opts.stackIndex | 0;
    // Audit rev.4 P3 — damage / heal flourish. Caller (`damage()`) sets
    // this so combat numbers get the parabolic bounce; plain world
    // text leaves it false for a straight drift.
    this._bounce = !!opts.bounce;
    this.text = acquireTextNode(text, getWorldTextStyle({
      color: opts.color ?? 0xffffff,
      fontSize: opts.fontSize ?? 14,
      bold: !!opts.bold,
    }));
    parent.addChild(this.text);
  }

  /** Returns true while still alive. */
  tick(now) {
    const t = (now - this.bornAt) / this.lifetime;
    if (t >= 1) {
      releaseTextNode(this.text);
      this.text = null;
      return false;
    }
    // If the entry is anchored to a moving mobile, follow it.
    if (this._serial) {
      const m = world.mobiles.get(this._serial);
      if (m) { this.x = m.x; this.y = m.y; this.z = m.z; }
    }
    const spX = worldToScreenX(this.x, this.y);
    const spY = worldToScreenY(this.x, this.y, this.z);
    // Stack offset — older entries above newer; each row 16 px so the
    // two-line stack stays inside the head-overhead band without
    // clipping the cursor.
    const stackY = this._stackIndex * 16;
    // Audit rev.4 P3 — damage popup bounce. CUO renders damage
    // numbers with a small parabolic up-then-down arc; we add a
    // single bounce on the rising edge.
    let bounceY = 0;
    if (this._bounce && t < 0.5) {
      // Parabola peaking at t=0.25, amp 4 px.
      const u = t / 0.5;
      bounceY = -4 * (1 - (2 * u - 1) * (2 * u - 1));
    }
    this.text.position.set(
      (spX + this._dxRand + 0.5) | 0,
      (spY - 50 - stackY - t * this.dy + bounceY + 0.5) | 0,
    );
    this.text.alpha = Math.max(0, 1 - t * 1.05);
    return true;
  }

  destroy() {
    if (this.text) {
      releaseTextNode(this.text);
      this.text = null;
    }
  }
}

class WorldTextManager {
  constructor() {
    this._parent = null;
    /** @type {WorldTextEntry[]} */
    this._entries = [];
  }
  install(parent) { this._parent = parent; }

  /**
   * Spawn a damage number above a mobile. Color depends on damage type
   * (CUO: physical=white, fire=red, cold=blue, etc).
   *
   * @param {number} serial   target mobile serial
   * @param {number} amount   damage amount (positive = damage, negative = heal)
   * @param {string} [type]   'fire'|'cold'|'poison'|'energy'|'phys'|'heal'
   */
  damage(serial, amount, type = 'phys') {
    const m = world.mobiles.get(serial);
    if (!m || !this._parent) return;
    const now = performance.now();
    const text = amount < 0 ? `+${-amount}` : `-${amount}`;
    const stackIndex = this._countOnSerial(serial);
    const e = new WorldTextEntry(this._parent, m.x, m.y, m.z, text, {
      color: damageColor(amount < 0 ? 'heal' : type), fontSize: 14, bold: true, serial, stackIndex,
      bounce: true, now,
    });
    this._entries.push(e);
  }

  /** Spawn arbitrary world text (e.g. server overhead "*Hi*"). */
  text(x, y, z, text, opts = {}) {
    if (!this._parent) return;
    const stackIndex = opts.serial ? this._countOnSerial(opts.serial) : 0;
    this._entries.push(new WorldTextEntry(this._parent, x, y, z, text, {
      ...opts,
      stackIndex,
      now: opts.now ?? performance.now(),
    }));
  }

  /** Audit rev.4 P2 — count live entries anchored to a given serial.
   *  Returns the next stack index so each new overhead message lands
   *  on a fresh row instead of overlapping. */
  _countOnSerial(serial) {
    let n = 0;
    for (const e of this._entries) if (e._serial === serial) n++;
    return n;
  }

  tick(now = performance.now()) {
    if (this._entries.length === 0) return;
    let write = 0;
    for (let read = 0; read < this._entries.length; read++) {
      const entry = this._entries[read];
      if (entry.tick(now)) this._entries[write++] = entry;
    }
    this._entries.length = write;
  }

  /** Drop everything — called on scene unload to free GPU text textures. */
  clear() {
    for (const e of this._entries) e.destroy();
    this._entries.length = 0;
  }

  hasActive() { return this._entries.length > 0; }
}

export const worldTextManager = new WorldTextManager();
