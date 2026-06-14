// Particle pool — short-lived particles for visual flourishes that the
// existing effect-renderer (server-driven 0x70/0xC0/0xC7 graphics) doesn't
// cover: explosion sparks, heal sparkles, teleport rings, level-up burst,
// damage-floater puff.
//
// IMPLEMENTATION (2026-05-08): migrated from pooled Sprites to Pixi v8
// `ParticleContainer` + `Particle`. ParticleContainer batches all
// children into a single GPU draw call regardless of count (vs ~N
// drawcalls for a Container of Sprites). The trade-off is reduced API:
// no children, no filters, no events. We don't need any of those for
// VFX so the migration is a pure win.
//
// Architecture:
//   - One ParticleContainer holds every active sprite particle. Dynamic
//     properties = position+rotation+color (we animate alpha/scale/move).
//   - Damage-floaters stay in a sibling Container because Text isn't
//     compatible with ParticleContainer (Pixi v8 limitation: only the
//     IParticle interface, not full DisplayObjects).
//   - Sprite-pool is no longer used for particles — Particle objects are
//     cheap (no transform matrices, no event mode), pooled in `_free[]`.
//
// Usage:
//   import { particles } from './particle-pool.js';
//   particles.burst({ x:200, y:300, count:12, texId:0x36B0, hue:0x21,
//                     spread:32, lifetime:600, fade:true });

import { Container, Text, TextStyle, ParticleContainer, Particle as PixiParticle } from 'pixi.js';
import { worldToScreenX, worldToScreenY, depthKey, LAYER_EFFECT } from './iso.js';
import { assets } from '../assets/asset-manager.js';

const ACTIVE_CAP = 256;
const TICK_MS = 16;

const _damageTextStyleCache = new Map();
function damageTextStyle(color) {
  const key = color | 0;
  let style = _damageTextStyleCache.get(key);
  if (style) return style;
  style = new TextStyle({
    fill: key,
    fontSize: 14,
    fontWeight: 'bold',
    stroke: { color: 0x000000, width: 3, join: 'round' },
    align: 'center',
  });
  _damageTextStyleCache.set(key, style);
  return style;
}

// Internal animation record — wraps a PixiParticle (sprite path) OR a
// Text (damage-floater path) with motion + lifetime data. We don't use
// instanceof tests in the hot path; `isText` flag carries the discriminator.
class ParticleAnim {
  constructor() {
    /** @type {PixiParticle | Text | null} */
    this.node = null;
    this.elapsed = 0;
    this.lifetime = 0;
    this.vx = 0; this.vy = 0; this.gravity = 0;
    this.fadeOut = false;
    this.scaleStart = 1; this.scaleEnd = 1;
    this.alphaStart = 1; this.alphaEnd = 0;
    this.isText = false;
  }
}

class ParticlePool {
  constructor() {
    /** @type {Container | null} world-aligned parent (effect layer) */
    this.parent = null;
    /** @type {ParticleContainer | null} */
    this._sprites = null;
    /** @type {Container | null} sibling for Text (damage floaters) */
    this._texts = null;
    /** @type {ParticleAnim[]} */
    this._active = [];
    /** @type {ParticleAnim[]} */
    this._free = [];
    /** @type {PixiParticle[]} */
    this._freeParticles = [];
    /** @type {Text[]} */
    this._freeTexts = [];
    this._lastTick = 0;
  }

  /** Attach the pool to a Pixi container — game-scene calls this once. */
  bind(parent) {
    this.parent = parent;
    if (this._sprites) return;
    // Dynamic position+color (alpha/tint via color), keep rotation off.
    // ParticleContainer with `position+color` dynamic = particles can
    // be moved + faded each frame; vertices/uvs cached on first add.
    this._sprites = new ParticleContainer({
      dynamicProperties: { position: true, color: true, scale: true },
      // No interaction or sorting — VFX render in spawn order.
    });
    this._sprites.zIndex = depthKey(0, 0, 0, LAYER_EFFECT);
    this._texts = new Container();
    this._texts.zIndex = depthKey(0, 0, 0, LAYER_EFFECT) + 1;
    parent.addChild(this._sprites, this._texts);
  }

  _take() { return this._free.pop() ?? new ParticleAnim(); }

  _takeParticle(tex, x, y, opts, tint) {
    const particle = this._freeParticles.pop() ?? new PixiParticle({
      texture: tex,
      x,
      y,
      anchorX: 0.5,
      anchorY: 0.5,
      scaleX: opts.scaleStart ?? 1.0,
      scaleY: opts.scaleStart ?? 1.0,
      tint,
      alpha: 1,
    });
    particle.texture = tex;
    particle.x = x;
    particle.y = y;
    particle.anchorX = 0.5;
    particle.anchorY = 0.5;
    particle.scaleX = opts.scaleStart ?? 1.0;
    particle.scaleY = opts.scaleStart ?? 1.0;
    particle.tint = tint;
    particle.alpha = 1;
    return particle;
  }

  _takeText(label, color) {
    const txt = this._freeTexts.pop() ?? new Text({
      text: '',
      style: damageTextStyle(color),
    });
    txt.text = String(label);
    txt.style = damageTextStyle(color);
    txt.anchor.set(0.5, 1);
    txt.scale.set(1);
    txt.alpha = 1;
    txt.visible = true;
    return txt;
  }

  _retireOldest() {
    if (!this._active.length) return;
    const oldest = this._active[0];
    const last = this._active.pop();
    if (last && last !== oldest) this._active[0] = last;
    this._retire(oldest);
  }

  _spawnSprite(particle, opts) {
    if (this._active.length >= ACTIVE_CAP) this._retireOldest();
    const p = this._take();
    p.node = particle;
    p.elapsed = 0;
    p.lifetime = opts.lifetime ?? 600;
    p.vx = opts.vx ?? 0;
    p.vy = opts.vy ?? 0;
    p.gravity = opts.gravity ?? 0;
    p.fadeOut = !!opts.fadeOut;
    p.scaleStart = opts.scaleStart ?? 1;
    p.scaleEnd = opts.scaleEnd ?? 1;
    p.alphaStart = opts.alphaStart ?? 1;
    p.alphaEnd = opts.alphaEnd ?? 0;
    p.isText = false;
    particle.alpha = p.alphaStart;
    particle.scaleX = p.scaleStart;
    particle.scaleY = p.scaleStart;
    this._active.push(p);
    this._sprites?.addParticle(particle);
  }

  _spawnText(text, opts) {
    if (this._active.length >= ACTIVE_CAP) this._retireOldest();
    const p = this._take();
    p.node = text;
    p.elapsed = 0;
    p.lifetime = opts.lifetime ?? 600;
    p.vx = opts.vx ?? 0; p.vy = opts.vy ?? 0; p.gravity = opts.gravity ?? 0;
    p.fadeOut = !!opts.fadeOut;
    p.scaleStart = 1; p.scaleEnd = 1;
    p.alphaStart = 1; p.alphaEnd = 0;
    p.isText = true;
    text.alpha = 1;
    this._active.push(p);
    this._texts?.addChild(text);
  }

  _retire(p) {
    if (!p) return;
    if (p.node) {
      try {
        if (p.isText) {
          p.node.parent?.removeChild?.(p.node);
          p.node.visible = false;
          p.node.text = '';
          if (this._freeTexts.length < 32) this._freeTexts.push(p.node);
          else p.node.destroy();
        } else {
          this._sprites?.removeParticle(p.node);
          if (this._freeParticles.length < 256) this._freeParticles.push(p.node);
        }
      } catch { /* ignore */ }
    }
    p.node = null;
    if (this._free.length < 64) this._free.push(p);
  }

  /** Per-frame tick — game-scene calls this from its rAF loop. */
  tick(nowMs) {
    if (!this._lastTick) this._lastTick = nowMs;
    const dt = nowMs - this._lastTick;
    this._lastTick = nowMs;
    let write = 0;
    for (let read = 0; read < this._active.length; read++) {
      const p = this._active[read];
      p.elapsed += dt;
      const t = Math.min(1, p.elapsed / p.lifetime);
      if (t >= 1) {
        this._retire(p);
        continue;
      }
      const node = p.node;
      if (!node) {
        this._retire(p);
        continue;
      }
      node.x += p.vx * (dt / TICK_MS);
      node.y += p.vy * (dt / TICK_MS);
      p.vy += p.gravity * (dt / TICK_MS);
      const s = p.scaleStart + (p.scaleEnd - p.scaleStart) * t;
      if (p.isText) {
        // Text uses .scale.set; particle uses scaleX/scaleY scalars.
      } else {
        node.scaleX = s; node.scaleY = s;
      }
      const a = p.fadeOut
        ? p.alphaStart + (p.alphaEnd - p.alphaStart) * t
        : p.alphaStart;
      node.alpha = a;
      this._active[write++] = p;
    }
    this._active.length = write;
  }

  /**
   * Generic burst — N particles scattered around (cx, cy) with random
   * velocities. Each particle uses the given static texture id (item
   * graphic from art.mul). Hue is applied via Particle's `tint` field
   * (single-multiplier RGB, sufficient for spark / pulse effects;
   * complex paletted hues from hue-filter shader were Sprite-only).
   */
  async burst(opts = {}) {
    if (!this._sprites) return;
    const cx = opts.x ?? 0, cy = opts.y ?? 0;
    const count = Math.max(1, Math.min(64, opts.count ?? 12));
    const texId = opts.texId ?? 0x36B0;     // small magic spark
    const tex = assets.staticTextureSync?.(texId) ?? await assets.staticTexture(texId);
    if (!tex) return;
    const spread = opts.spread ?? 24;
    const tint = opts.tint ?? 0xffffff;
    for (let i = 0; i < count; i++) {
      const particle = this._takeParticle(
        tex,
        cx + (Math.random() - 0.5) * spread,
        cy + (Math.random() - 0.5) * spread,
        opts,
        tint,
      );
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.5 + Math.random() * 1.5;
      this._spawnSprite(particle, {
        lifetime: opts.lifetime ?? (400 + Math.random() * 400),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        gravity: opts.gravity ?? 0,
        fadeOut: opts.fade !== false,
        scaleStart: opts.scaleStart ?? 1.0,
        scaleEnd:   opts.scaleEnd   ?? 0.4,
        alphaStart: 1, alphaEnd: 0,
      });
    }
  }

  /** Heal pulse — green tint sparkles around a target sprite. */
  heal(target) {
    if (!target) return;
    return this.burst({
      x: target.x ?? 0, y: target.y ?? 0,
      count: 8, texId: 0x376A, tint: 0x44ff66, spread: 20,
      lifetime: 600, fade: true,
      scaleStart: 0.6, scaleEnd: 1.2,
    });
  }

  /** Teleport sparkle ring at a world (x,y,z). */
  teleportIn(wx, wy, wz) {
    const sx = worldToScreenX(wx, wy);
    const sy = worldToScreenY(wx, wy, wz);
    return this.burst({
      x: sx, y: sy, count: 16, texId: 0x376A, tint: 0x80c0ff,
      spread: 32, lifetime: 800, fade: true,
      scaleStart: 0.4, scaleEnd: 1.6,
    });
  }

  /** Floating damage number. Uses Pixi Text in the sibling Text container
   *  (ParticleContainer can't host Text). Cheap enough at combat tempo. */
  damageFloat(screenX, screenY, label, color = 0xff4040) {
    if (!this._texts) return;
    const txt = this._takeText(label, color);
    txt.x = screenX;
    txt.y = screenY;
    this._spawnText(txt, {
      lifetime: 900, vy: -1.2, gravity: 0.02, fadeOut: true,
    });
  }

  /** Drop everything (test teardown / scene change). */
  clear() {
    for (const p of this._active) this._retire(p);
    this._active.length = 0;
    this._freeParticles.length = 0;
  }
}

export const particles = new ParticlePool();
export { ParticlePool };
