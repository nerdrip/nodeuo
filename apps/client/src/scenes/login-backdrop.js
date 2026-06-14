// Login backdrop — animated Pixi layer for the LoginScene. Mirrors the
// CUO `LoginBackground` (animated stone-dragon banner + sweeping clouds
// over a parchment glow) without trying to be pixel-perfect.
//
// Components:
//   1. Dark stone gradient base (Graphics, fullscreen).
//   2. Slow-drifting cloud ribbons (alpha 0.06, sin-driven horizontal pan).
//   3. Pulsing parchment hotspot dead-centre (radial gradient, 6s cycle).
//   4. Banner: ULTIMA ONLINE word + UO-Node Shard subtext rendered with
//      a serif font in pure Pixi Text so the user gets a proper UO vibe
//      even if their DOM CSS is overridden.
//
// The DOM login panel sits on top via z-index — this layer is just for
// atmosphere. We mount on the gc.ui (un-transformed) container so it
// doesn't move when the world-camera changes.

import { Container, Graphics, Text } from 'pixi.js';

export class LoginBackdrop {
  /** @param {Container} parent */
  constructor(parent) {
    this.parent = parent;
    this.container = new Container();
    this.container.label = 'login-backdrop';
    this.container.eventMode = 'none';
    parent.addChildAt(this.container, 0);

    this._base = new Graphics();
    this._clouds = new Graphics();
    this._spot = new Graphics();
    this._banner = new Container();
    this.container.addChild(this._base, this._clouds, this._spot, this._banner);

    // Banner text — done once; we just rescale on resize.
    this._title = new Text({
      text: 'ULTIMA ONLINE',
      style: {
        fill: 0xfff0c0,
        fontSize: 56,
        letterSpacing: 12,
        fontFamily: 'Times New Roman, serif',
        fontWeight: '700',
        stroke: { color: 0x1a0a04, width: 4 },
        dropShadow: { color: 0xa86030, blur: 16, distance: 0, alpha: 0.6 },
      },
    });
    this._title.anchor.set(0.5, 0.5);
    this._sub = new Text({
      text: 'UO-Node Shard',
      style: {
        fill: 0xa89060,
        fontSize: 16,
        letterSpacing: 4,
        fontFamily: 'Times New Roman, serif',
      },
    });
    this._sub.anchor.set(0.5, 0.5);
    this._banner.addChild(this._title, this._sub);

    this._t0 = performance.now();
    this._raf = null;
    // Throttle to ~30 FPS — login backdrop has no fast-moving content
    // (sin-driven clouds drift at 0.06/0.4 Hz). 30 FPS halves CPU/GPU
    // cost vs 60 FPS RAF without any visible difference. The user can
    // still notice 60→30 on hard scrolls but this layer never scrolls.
    this._minFrameMs = 33;
    this._lastDrawAt = 0;
    this._loop = (now) => {
      const t = now ?? performance.now();
      if (t - this._lastDrawAt >= this._minFrameMs) {
        this._draw();
        this._lastDrawAt = t;
      }
      this._raf = requestAnimationFrame(this._loop);
    };
    this._raf = requestAnimationFrame(this._loop);
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._loop = null;
    try { this.container.destroy({ children: true }); } catch { /* noop */ }
  }

  _draw() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const t = (performance.now() - this._t0) / 1000;

    // Base gradient (fake — three layered rectangles top→bottom).
    this._base.clear();
    this._base.rect(0, 0, w, h).fill({ color: 0x05080d });
    // Bottom warm stone band.
    const bandH = Math.min(220, h * 0.35);
    this._base.rect(0, h - bandH, w, bandH).fill({ color: 0x1a1206, alpha: 0.65 });
    // Top vignette.
    this._base.rect(0, 0, w, 80).fill({ color: 0x000000, alpha: 0.6 });

    // Sweeping cloud ribbons (low-α horizontal bands moving sin(t)).
    this._clouds.clear();
    for (let i = 0; i < 5; i++) {
      const y = (h * 0.18) + i * 60 + Math.sin(t * 0.4 + i) * 14;
      const ox = (Math.sin(t * 0.06 + i * 1.3) * w * 0.35) | 0;
      this._clouds.ellipse(w / 2 + ox, y, w * 0.4, 28).fill({ color: 0xffe0a0, alpha: 0.05 + i * 0.01 });
    }

    // Pulsing parchment hotspot — radial-ish glow under the banner.
    const cx = w / 2, cy = h * 0.4;
    const pulse = 0.5 + 0.5 * Math.sin(t * 0.9);
    this._spot.clear();
    for (let r = 6; r > 0; r--) {
      const radius = 220 + r * 24;
      this._spot.circle(cx, cy, radius)
        .fill({ color: 0xffc080, alpha: (0.04 + pulse * 0.04) / r });
    }

    // Banner positioning — small floaty bob.
    this._title.position.set(cx, cy - 12 + Math.sin(t * 0.8) * 2);
    this._sub.position.set(cx, cy + 32);
    // Scale up on big screens, never below 1.
    const s = Math.min(1.3, Math.max(0.85, w / 1200));
    this._title.scale.set(s);
    this._sub.scale.set(s);
  }
}
