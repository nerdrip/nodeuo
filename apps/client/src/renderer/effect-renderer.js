// Effect renderer — moving / fixed graphic effects (spell projectiles,
// explosions, lightning). Mirrors ClassicUO's
// Game/Managers/EffectManager.cs.
//
// Wave 6 additions:
//   - rotation: projectile sprites rotate to face their motion vector
//   - scale: per-effect base scale + pulse multiplier
//   - blendMode: 'add' | 'normal' (selectable per effect)
//   - lightning bolt: jagged path drawn with Pixi Graphics + flicker
//   - drag effect (custom type 5): line tether between source and target
//
// Each effect lives in `world.effects` for its `duration` then auto-removes.
// Type:
//   0 = moving from source → target
//   1 = lightning bolt (fixed at target)
//   2 = fixed effect (stays at target)
//   3 = animated effect attached to source serial
//   4 = screen fade (handled by net/handlers)
//   5 = drag effect — tether line from source to target

import { Graphics } from 'pixi.js';
import { worldToScreenX, worldToScreenY, depthKey, LAYER_EFFECT } from './iso.js';
import { assets } from '../assets/asset-manager.js';
import { applyHueTo } from './hue-filter.js';
import { bus } from '../core/event-bus.js';
import { world } from '../world/world.js';
import { acquireSprite, releaseSprite } from './sprite-pool.js';
import { effectLifetimeMs } from './effect-timing.js';
import { profile } from '../managers/profile-manager.js';
import { clientRuntimeProfile } from '../shared/runtime-governor.js';

class ActiveEffect {
  constructor(info) {
    this._token = 0;
    this.reset(info);
  }

  reset(info) {
    this.info = info;
    this.elapsed = 0;
    /** projectile interpolation 0..1 */
    this.t = 0;
    /** @type {Sprite | null} */
    this.sprite = null;
    /** ms total flight time / display time */
    this.lifetime = effectLifetimeMs(info);
    this.sprite = null;
    this._lightning = null;
    this._drag = null;
    this._burst = null;
    this._burstSeed = 0;
    this._lightningPts = null;
    this._lastLightningAt = -Infinity;
    this._renderedGraphic = -1;
    this._pendingGraphic = 0;
    this._sourceX = Number(info.sx) || 0;
    this._sourceY = Number(info.sy) || 0;
    this._sourceZ = Number(info.sz) || 0;
    this._exploded = false;
    this._disposed = false;
    this._token = (this._token + 1) >>> 0;
    return this;
  }
}

export class EffectRenderer {
  /** @param {import('pixi.js').Container} parent */
  constructor(parent) {
    this.parent = parent;
    /** @type {ActiveEffect[]} */
    this.effects = [];
    this._effectPool = [];
    this._graphicsPool = [];
    /** Active per-mobile target halos. Keyed by serial; each entry is
     *  `{ g: Graphics, until: ms, color: u32 }`. Mirrors CUO's
     *  `Game/Renderer/GameRenderer.cs::DrawTargetingHalo` — a soft 6-frame
     *  aura around the currently-cycled target so the player has visual
     *  feedback when TargetNext / TargetClosest fires. */
    this._halos = new Map();
    this._unsubs = [
      bus.on('fx:graphic', (info) => this._spawn(info)),
      bus.on('fx:particle', (info) => this._spawnParticleFallback(info)),
      bus.on('fx:hued-short', (info) => this._spawnHuedShortFallback(info)),
      bus.on('target:cycle-changed', ({ serial, kind }) => {
        if (!serial) return;
        // Friend = soft green, enemy = red, neutral = pale gold.
        const color = kind === 'friend' ? 0x66ff88
                    : kind === 'enemy'  ? 0xff5544
                                        : 0xffe080;
        this._addHalo(serial >>> 0, color, 1400);
      }),
      bus.on('combat:target', ({ serial }) => {
        if (!serial) return;
        this._addHalo(serial >>> 0, 0xff5544, 1400);
      }),
    ];
  }

  /** Spawn / refresh a target halo for `serial`. The graphics object
   *  is attached to the world layer and re-positioned each frame in
   *  `tick()` so it tracks moving mobiles. */
  _addHalo(serial, color, durationMs) {
    let h = this._halos.get(serial);
    if (!h) {
      const g = this._acquireGraphics();
      this.parent.addChild(g);
      h = { g, color, until: 0 };
      this._halos.set(serial, h);
    }
    h.color = color;
    h.until = performance.now() + durationMs;
  }

  destroy() {
    for (const u of this._unsubs) u();
    this._unsubs.length = 0;
    for (const e of this.effects) this._destroyEffect(e, false);
    this.effects.length = 0;
    for (const h of this._halos.values()) this._releaseGraphics(h.g, false);
    this._halos.clear();
    for (const g of this._graphicsPool) {
      try { g.destroy(); } catch { /* ignore */ }
    }
    this._graphicsPool.length = 0;
    this._effectPool.length = 0;
  }

  _acquireEffect(info) {
    const eff = this._effectPool.pop();
    return eff ? eff.reset(info) : new ActiveEffect(info);
  }

  _releaseEffect(e, recycle = true) {
    if (!e) return;
    e._disposed = true;
    e.info = null;
    e.elapsed = 0;
    e.t = 0;
    e.lifetime = 0;
    e.sprite = null;
    e._lightning = null;
    e._drag = null;
    e._burst = null;
    e._burstSeed = 0;
    e._lightningPts = null;
    e._lastLightningAt = -Infinity;
    e._renderedGraphic = -1;
    e._pendingGraphic = 0;
    e._sourceX = e._sourceY = e._sourceZ = 0;
    e._exploded = false;
    if (recycle && this._effectPool.length < EffectRenderer.MAX_EFFECT_POOL) {
      this._effectPool.push(e);
    }
  }

  _acquireGraphics() {
    const g = this._graphicsPool.pop() || new Graphics();
    g.clear();
    g.alpha = 1;
    g.visible = true;
    g.renderable = true;
    g.rotation = 0;
    g.scale.set(1, 1);
    g.position.set(0, 0);
    g.zIndex = 0;
    return g;
  }

  _releaseGraphics(g, recycle = true) {
    if (!g) return;
    try { g.parent?.removeChild(g); } catch { /* ignore */ }
    try { g.clear(); } catch { /* ignore */ }
    g.alpha = 1;
    g.visible = false;
    g.renderable = false;
    if (recycle && this._graphicsPool.length < EffectRenderer.MAX_GRAPHICS_POOL) {
      this._graphicsPool.push(g);
      return;
    }
    try { g.destroy(); } catch { /* ignore */ }
  }

  _removeQueuedEffect(e) {
    const idx = this.effects.indexOf(e);
    if (idx >= 0) {
      const last = this.effects.pop();
      if (last && last !== e) this.effects[idx] = last;
    }
    this._destroyEffect(e);
  }

  _destroyEffect(e, recycle = true) {
    if (!e) return;
    if (e.sprite) releaseSprite(e.sprite);
    e.sprite = null;
    this._releaseGraphics(e._lightning, recycle);
    this._releaseGraphics(e._drag, recycle);
    this._releaseGraphics(e._burst, recycle);
    this._releaseEffect(e, recycle);
  }

  _dropOldestEffect() {
    if (!this.effects.length) return;
    const oldest = this.effects[0];
    const last = this.effects.pop();
    if (last && last !== oldest) this.effects[0] = last;
    this._destroyEffect(oldest);
  }

  _quality() {
    const selected = profile.get('graphics.effectsQuality');
    return selected === 'low' || selected === 'high' ? selected
      : clientRuntimeProfile.tier === 'low' ? 'low' : 'high';
  }

  _effectLimit() { return this._quality() === 'low' ? 80 : EffectRenderer.MAX_EFFECTS; }

  _effectAnchor(info = {}) {
    const p = world.player;
    const x = Number.isFinite(info.tx) ? info.tx
      : Number.isFinite(info.sx) ? info.sx
      : p?.x ?? 0;
    const y = Number.isFinite(info.ty) ? info.ty
      : Number.isFinite(info.sy) ? info.sy
      : p?.y ?? 0;
    const z = Number.isFinite(info.tz) ? info.tz
      : Number.isFinite(info.sz) ? info.sz
      : p?.z ?? 0;
    return { x, y, z };
  }

  _spawnBurst(info) {
    if (this.effects.length >= this._effectLimit()) {
      this._dropOldestEffect();
    }
    const eff = this._acquireEffect(info);
    const g = this._acquireGraphics();
    eff._burst = g;
    eff._burstSeed = Math.random() * Math.PI * 2;
    eff.lifetime = info.lifetime ?? 650;
    this.parent.addChild(g);
    this.effects.push(eff);
  }

  _spawnParticleFallback(info = {}) {
    this._spawnBurst({
      ...info,
      kind: 'particle-fallback',
      color: info.color ?? 0x7fcfff,
      lifetime: info.lifetime ?? 700,
    });
  }

  _spawnHuedShortFallback(info = {}) {
    this._spawnBurst({
      ...info,
      kind: 'hued-short-fallback',
      color: info.color ?? 0xffd17a,
      lifetime: info.lifetime ?? 520,
    });
  }

  /** Hard cap on simultaneous live effects to keep memory + render cost
   *  bounded during overlapping spell impacts. CUO `EffectManager` caps
   *  at ~512; we use 200 (older effects retire first). */
  static MAX_EFFECTS = 200;
  static MAX_EFFECT_POOL = 96;
  static MAX_GRAPHICS_POOL = 64;

  async _spawn(info) {
    // Drop the oldest effect when we're at the cap so a spell-fest
    // doesn't accumulate hundreds of sprites in `this.effects`.
    if (this.effects.length >= this._effectLimit()) {
      this._dropOldestEffect();
    }
    const eff = this._acquireEffect(info);
    const source = world.mobiles.get((info.sourceSerial ?? 0) >>> 0);
    if (source) {
      eff._sourceX = source.x;
      eff._sourceY = source.y;
      eff._sourceZ = source.z;
    }
    const target = world.mobiles.get((info.targetSerial ?? 0) >>> 0);
    eff.lifetime = effectLifetimeMs({
      ...info,
      sx: eff._sourceX,
      sy: eff._sourceY,
      sz: eff._sourceZ,
      tx: target?.x ?? info.tx,
      ty: target?.y ?? info.ty,
      tz: target?.z ?? info.tz,
    });
    this.effects.push(eff);
    const token = eff._token;

    // Lightning bolt: no static graphic, draw jagged Graphics polyline.
    if (info.type === 1 || info.kind === 'lightning') {
      const g = this._acquireGraphics();
      eff._lightning = g;
      this.parent.addChild(g);
      eff.lifetime = info.lifetime ?? 350;   // shorter than projectile
      return;
    }
    // Drag tether: draw a Graphics line, no sprite.
    if (info.type === 5 || info.kind === 'drag') {
      const g = this._acquireGraphics();
      eff._drag = g;
      this.parent.addChild(g);
      eff.lifetime = info.lifetime ?? 800;
      return;
    }
    if (!info.graphic) {
      this._removeQueuedEffect(eff);
      return;
    }
    // Effect art is animated through animdata even when tiledata does not
    // carry the Static.Animation flag. Start at the effect's first frame,
    // matching GameEffect.AnimIndex = 0 in ClassicUO.
    const firstGraphic = assets.currentAnimatedGraphic?.(info.graphic, 0) ?? info.graphic;
    const tex = assets.staticTextureSync?.(firstGraphic) ?? await assets.staticTexture(firstGraphic);
    if (eff._disposed || eff._token !== token || !this.effects.includes(eff)) return;
    if (!tex) {
      this._removeQueuedEffect(eff);
      return;
    }
    const sp = acquireSprite(tex);
    sp.anchor.set(0.5, 0.5);
    if (info.hue && assets.huesTexture && assets.huesMeta) {
      // Audit #34 P2 #9 — mask to u16; the wire field is u32 (ARGB-style)
      // but only the low 16 bits are the cliloc-hue index.
      applyHueTo(sp, info.hue & 0xFFFF, 1, assets.huesTexture, assets.huesMeta.count);
    }
    if (info.blend === 'add') sp.blendMode = 'add';
    // Audit #34 P2 #9 — CUO `PacketHandlers.cs:2482` reads renderMode as
    // `(GraphicEffectBlendMode)(p.ReadUInt32BE() % 7)`. Mapping:
    //   0 Normal, 1 Multiply, 2 Screen, 3 ScreenMore, 4 ScreenLess,
    //   5 NormalHalfTransparent, 6 ShadowBlue.
    // Was: only `info.blend === 'add'` string honoured — every numeric
    // renderMode (energy field glow / shadow mist) rendered flat normal.
    else if (Number.isFinite(info.renderMode)) {
      // Audit #46 P3 — distinct ScreenMore (3) vs ScreenLess (4) blend.
      // Pixi v8 lacks a dedicated hybrid; we approximate via alpha
      // (3 = bright bloom, 4 = subtle glow).
      const MODE = ['normal', 'multiply', 'screen', 'screen', 'screen', 'normal', 'normal'];
      sp.blendMode = MODE[(info.renderMode | 0) % 7] || 'normal';
      if ((info.renderMode | 0) === 3) sp.alpha = 1.0;
      if ((info.renderMode | 0) === 4) sp.alpha = 0.45;
      if ((info.renderMode | 0) === 5) sp.alpha = 0.5;
      if ((info.renderMode | 0) === 6) {
        sp.blendMode = 'multiply';
        sp.tint = 0x6688cc;
        sp.alpha = 0.65;
      }
    }
    if (info.scale) sp.scale.set(info.scale);
    eff.sprite = sp;
    eff._renderedGraphic = firstGraphic;
    this.parent.addChild(sp);
  }

  _updateAnimatedGraphic(eff) {
    const baseGraphic = eff.info?.graphic | 0;
    if (!baseGraphic || !eff.sprite) return;
    const graphic = assets.currentAnimatedGraphic?.(baseGraphic, eff.elapsed) ?? baseGraphic;
    if (graphic === eff._renderedGraphic) return;
    const cached = assets.staticTextureSync?.(graphic);
    if (cached) {
      eff.sprite.texture = cached;
      eff._renderedGraphic = graphic;
      eff._pendingGraphic = 0;
      return;
    }
    if (eff._pendingGraphic === graphic) return;
    eff._pendingGraphic = graphic;
    const token = eff._token;
    assets.staticTexture(graphic).then((texture) => {
      if (!texture || eff._disposed || eff._token !== token || !eff.sprite) return;
      eff.sprite.texture = texture;
      eff._renderedGraphic = graphic;
    }).finally(() => {
      if (eff._token === token && eff._pendingGraphic === graphic) eff._pendingGraphic = 0;
    }).catch(() => {});
  }

  _queueExplosion(info) {
    const graphic = (info.explodeEffect | 0) || 0x36CB;
    const target = world.mobiles.get((info.targetSerial ?? 0) >>> 0);
    const x = target?.x ?? info.tx ?? info.sx;
    const y = target?.y ?? info.ty ?? info.sy;
    const z = target?.z ?? info.tz ?? info.sz;
    if (info.explodeSound) {
      queueMicrotask(() => bus.emit('audio:sfx', {
        sound: info.explodeSound, x, y, z,
      }));
    }
    queueMicrotask(() => bus.emit('fx:graphic', {
      type: 2,
      graphic,
      hue: info.hue ?? 0,
      renderMode: info.renderMode ?? 0,
      sx: x, sy: y, sz: z,
      tx: x, ty: y, tz: z,
      duration: 8,
      speed: 0,
      explode: 0,
    }));
  }

  /** Per-frame tick: advance projectiles + cull expired effects. */
  tick(dt, now = performance.now()) {
    // Target halos — render a soft pulsing ring under each currently
    // targeted mobile. Independent of the effect queue so they outlive
    // a single combat:target event.
    if (this._halos.size) {
      for (const [serial, h] of this._halos) {
        if (now >= h.until) { this._releaseGraphics(h.g); this._halos.delete(serial); continue; }
        const m = world.mobiles.get(serial);
        if (!m) { h.g.clear(); continue; }
        const centerX = worldToScreenX(m.x, m.y);
        const centerY = worldToScreenY(m.x, m.y, m.z);
        const phase = (h.until - now) / 1400;
        const pulse = 0.6 + 0.4 * Math.sin(now / 120);
        h.g.clear();
        h.g.ellipse(centerX, centerY + 8, 22, 9)
          .stroke({ width: 2, color: h.color, alpha: phase * pulse });
        h.g.ellipse(centerX, centerY + 8, 16, 6)
          .stroke({ width: 1, color: h.color, alpha: phase * pulse * 0.6 });
        h.g.zIndex = depthKey(m.x, m.y, m.z, LAYER_EFFECT);
      }
    }
    if (!this.effects.length) return;
    let write = 0;
    for (let read = 0; read < this.effects.length; read++) {
      const eff = this.effects[read];
      eff.elapsed += dt * 1000;
      // Attached-to-mobile (type 3) effects must despawn the moment
      // their host mobile is gone — otherwise the sprite floats in
      // limbo at the last known position. CUO `EffectManager` checks
      // `world.GetOrCreateMobile(source) == null` per tick.
      const info = eff.info;
      if (info.type === 3 && (info.attachedSerial || info.source || info.sourceSerial || info.targetSerial)) {
        const hostSerial = info.attachedSerial || info.sourceSerial || info.targetSerial || info.source;
        const host = world.mobiles.get(hostSerial >>> 0);
        if (!host) eff.elapsed = eff.lifetime;
      }
      if (eff.elapsed >= eff.lifetime) {
        if (info.type === 0 && !eff._exploded
            && (info.explode || info.explodes || info.explodeEffect || info.explodeSound)) {
          eff._exploded = true;
          this._queueExplosion(info);
        }
        this._destroyEffect(eff);
        continue;
      }
      // Lightning bolt: redraw jagged polyline + flicker. ~350ms life.
      if (eff._lightning) {
        if (eff._lightningPts && eff.elapsed - (eff._lastLightningAt ?? -Infinity) < 45) {
          const flicker = profile.get('graphics.noFlicker') === true ? 1 : (Math.sin(eff.elapsed / 30) > 0 ? 1 : 0.4);
          eff._lightning.alpha = flicker;
          this.effects[write++] = eff;
          continue;
        }
        eff._lastLightningAt = eff.elapsed;
        const wx = info.sx ?? info.tx ?? 0;
        const wy = info.sy ?? info.ty ?? 0;
        const wz = info.sz ?? info.tz ?? 0;
        const projX = worldToScreenX(wx, wy);
        const projY = worldToScreenY(wx, wy, wz);
        const topX = projX + (Math.random() - 0.5) * 42;
        const topY = projY - 260;
        const botX = projX;
        const botY = projY;
        const SEGMENTS = this._quality() === 'low' ? 5 : 8;
        const pts = eff._lightningPts || (eff._lightningPts = new Array((SEGMENTS + 1) * 2));
        let pi = 0;
        pts[pi++] = topX;
        pts[pi++] = topY;
        for (let s = 1; s < SEGMENTS; s++) {
          const t = s / SEGMENTS;
          pts[pi++] = topX + (botX - topX) * t + (Math.random() - 0.5) * 24;
          pts[pi++] = topY + (botY - topY) * t;
        }
        pts[pi++] = botX;
        pts[pi++] = botY;
        eff._lightning.clear();
        const flicker = profile.get('graphics.noFlicker') === true ? 1 : (Math.sin(eff.elapsed / 30) > 0 ? 1 : 0.4);
        eff._lightning.alpha = flicker;
        eff._lightning.poly(pts, false)
          .stroke({ width: 6, color: 0x609cff, alpha: 0.48 })
          .stroke({ width: 3, color: 0xC0E0FF, alpha: 1 })
          .stroke({ width: 1, color: 0xFFFFFF, alpha: 1 });
        eff._lightning.zIndex = depthKey(wx | 0, wy | 0, (wz | 0) + 30, LAYER_EFFECT);
        this.effects[write++] = eff;
        continue;
      }
      // Drag tether: line from source mobile to target mobile.
      // Audit #34 P2 #8 — `decodeGraphicEffect` produces `sourceSerial`/
      // `targetSerial`; the legacy `attached*` field names this branch
      // read never existed on the decoded shape, so drag tethers + type-3
      // attached effects never rendered. Use the canonical field names.
      if (eff._drag) {
        const a = info.sourceSerial ? world.mobiles.get(info.sourceSerial) : null;
        const b = info.targetSerial ? world.mobiles.get(info.targetSerial) : null;
        if (a && b) {
          const ax = worldToScreenX(a.x, a.y);
          const ay = worldToScreenY(a.x, a.y, a.z);
          const bx = worldToScreenX(b.x, b.y);
          const by = worldToScreenY(b.x, b.y, b.z);
          const t = eff.elapsed / eff.lifetime;
          eff._drag.clear();
          eff._drag.moveTo(ax, ay - 30).lineTo(bx, by - 30)
            .stroke({ width: 2, color: info.color ?? 0xFFA060, alpha: 1 - t });
        }
        this.effects[write++] = eff;
        continue;
      }
      if (eff._burst) {
        const { x, y, z } = this._effectAnchor(info);
        const cx = worldToScreenX(x, y);
        const cy = worldToScreenY(x, y, z) - 18;
        const t = Math.max(0, Math.min(1, eff.elapsed / eff.lifetime));
        const alpha = Math.max(0, 1 - t);
        const radius = (info.kind === 'hued-short-fallback' ? 10 : 14) + t * 28;
        const color = info.color ?? 0x7fcfff;
        eff._burst.clear();
        eff._burst.circle(cx, cy, radius)
          .stroke({ width: 2, color, alpha: alpha * 0.75 });
        eff._burst.circle(cx, cy, radius * 0.45)
          .stroke({ width: 1, color: 0xffffff, alpha: alpha * 0.5 });
        const sparks = this._quality() === 'low' ? 4 : (info.kind === 'hued-short-fallback' ? 6 : 9);
        for (let i = 0; i < sparks; i++) {
          const a = eff._burstSeed + (i / sparks) * Math.PI * 2 + t * 1.2;
          const inner = radius * 0.35;
          const outer = radius * (0.85 + 0.25 * Math.sin((i + 1) * 1.7));
          const x0 = cx + Math.cos(a) * inner;
          const y0 = cy + Math.sin(a) * inner * 0.55;
          const x1 = cx + Math.cos(a) * outer;
          const y1 = cy + Math.sin(a) * outer * 0.55;
          eff._burst.moveTo(x0, y0).lineTo(x1, y1)
            .stroke({ width: 1, color, alpha: alpha * 0.65 });
        }
        eff._burst.zIndex = depthKey(x | 0, y | 0, (z | 0) + 30, LAYER_EFFECT);
        this.effects[write++] = eff;
        continue;
      }
      if (!eff.sprite) {
        this.effects[write++] = eff;
        continue;
      }
      this._updateAnimatedGraphic(eff);
      let wx, wy, wz;
      if (info.type === 0 && (Number.isFinite(info.tx) || Number.isFinite(info.ty) || info.targetSerial)) {
        // Moving projectile.
        const t = Math.min(1, eff.elapsed / eff.lifetime);
        eff.t = t;
        const target = world.mobiles.get((info.targetSerial ?? 0) >>> 0);
        const tx = target?.x ?? info.tx;
        const ty = target?.y ?? info.ty;
        const tz = target?.z ?? info.tz;
        wx = eff._sourceX + (tx - eff._sourceX) * t;
        wy = eff._sourceY + (ty - eff._sourceY) * t;
        wz = eff._sourceZ + (tz - eff._sourceZ) * t;
        // Rotate sprite to face the motion vector. Optional — caller
        // can disable with `info.fixedRotation = true`.
        if (!(info.fixedRotation || info.fixedDirection || info.fixed)) {
          const screenDx = worldToScreenX(tx, ty) - worldToScreenX(eff._sourceX, eff._sourceY);
          const screenDy = worldToScreenY(tx, ty, tz)
            - worldToScreenY(eff._sourceX, eff._sourceY, eff._sourceZ);
          eff.sprite.rotation = Math.atan2(screenDy, screenDx);
        }
      } else if (info.type === 3 && (info.attachedSerial || info.sourceSerial || info.targetSerial)) {
        // Animation attached to a mobile serial — track its position.
        // Audit #34 P2 #8: was reading dead `info.attachedSerial`.
        const serial = info.attachedSerial || info.targetSerial || info.sourceSerial;
        const m = world.mobiles.get(serial);
        wx = m?.x ?? info.tx; wy = m?.y ?? info.ty; wz = m?.z ?? info.tz;
      } else {
        // FixedXYZ / FixedFrom use the protocol's source coordinates.
        // Target coordinates belong to Moving effects and can legitimately
        // contain unrelated/non-zero values on custom shards.
        wx = Number.isFinite(info.sx) ? info.sx : info.tx;
        wy = Number.isFinite(info.sy) ? info.sy : info.ty;
        wz = Number.isFinite(info.sz) ? info.sz : info.tz;
      }
      const projX = worldToScreenX(wx, wy);
      const projY = worldToScreenY(wx, wy, wz);
      eff.sprite.position.set(projX, projY);
      eff.sprite.zIndex = depthKey(wx | 0, wy | 0, wz | 0, LAYER_EFFECT);
      // Pulse scale slightly on explosions for visual feedback.
      const baseScale = info.scale ?? 1;
      if (info.explode) {
        const phase = (eff.elapsed % 200) / 200;
        eff.sprite.scale.set(baseScale * (1 + phase * 0.3));
      }
      // Fade-out at the tail end so projectiles don't pop off-screen.
      const tailFrac = (eff.elapsed - (eff.lifetime - 150)) / 150;
      if (tailFrac > 0) eff.sprite.alpha = Math.max(0, 1 - tailFrac);
      this.effects[write++] = eff;
    }
    this.effects.length = write;
  }
}
