// DeathScreen — fullscreen "YOU ARE DEAD" overlay + desaturate filter
// while the local player is dead. Mirrors ClassicUO `GameScene.CheckDeathScreen`
// + `EnableBlackWhiteEffect` semantics.
//
// Triggered by:
//   - 0xAF DisplayDeathAction with serial == player → start
//   - 0x2C DeathStatusResponse action == 0x02 (resurrect) → end
//   - mobile body change to a non-ghost graphic → end (defensive)

import { Graphics, ColorMatrixFilter } from 'pixi.js';
import { bus } from '../core/event-bus.js';
import { profile } from '../managers/profile-manager.js';

// Audit #35 F5 — CUO `Constants.cs:86 DEATH_SCREEN_TIMER = 1500`. Was
// 4000 (2.67× canonical). Banner lingered way past CUO's intent.
const SHOW_MS = 1500;

export class DeathScreen {
  /** @param {{ stage: Container }} args */
  constructor({ stage }) {
    this.stage = stage;
    this._active = false;
    this._endsAt = 0;
    this._dimmer = new Graphics();
    this._banner = new Graphics();
    this._dimmer.eventMode = 'none';
    this._banner.eventMode = 'none';
    stage.addChild(this._dimmer);
    stage.addChild(this._banner);
    this._dimmer.visible = false;
    this._banner.visible = false;
    this._filter = new ColorMatrixFilter();
    this._unsubs = [
      // Audit #35 F5 — self-death triggers from 0x2C, not 0xAF. CUO's
      // 0xAF handler early-returns for the local player; the canonical
      // self-death trigger is `DeathStatusResponse action != 0x01`.
      // Was: subscribed to `mobile:death` and filtered for player.serial
      // (which never fired because 0xAF DOES emit self-death in our
      // wire path; behaviour was actually correct-by-accident, but the
      // event semantics were wrong and the timer ran 2.67× too long).
      // Now: drive show() from `player:death-status` action !== 0x01.
      bus.on('player:death-status', ({ action }) => {
        // 0x02 = resurrect / manifest as alive again. 0x00 = manifest
        // as ghost (we keep the desaturate filter on for the ghost
        // walk; the banner has already faded by then).
        if (action === 0x02) this.hide();
        else if (action !== 0x01) this.show();
      }),
    ];
    this._tickSub = null;
  }

  show() {
    if (this._active) return;
    this._active = true;
    this._endsAt = performance.now() + SHOW_MS;
    if (!this._tickSub) this._tickSub = bus.on('frame:tick', (now) => this._tick(now));
    this._draw();
    // Audit #46 P2 — gate desaturate by `graphics.blackWhiteOnDeath`
    // profile flag (CUO `EnableBlackWhiteEffect`). Was unconditional →
    // user couldn't opt out via OptionsGump. When the flag is false,
    // only the dimmer + banner render (no global desaturate).
    const wantBW = profile?.get?.('graphics.blackWhiteOnDeath') !== false;
    if (!wantBW) return;
    if (this.stage.parent && Array.isArray(this.stage.parent.filters)) {
      if (!this.stage.parent.filters.includes(this._filter)) {
        this.stage.parent.filters = [...this.stage.parent.filters, this._filter];
      }
    } else if (this.stage.parent) {
      this.stage.parent.filters = [this._filter];
    }
    this._filter.desaturate();
  }
  hide() {
    if (!this._active) return;
    this._active = false;
    this._dimmer.visible = false;
    this._banner.visible = false;
    this._tickSub?.();
    this._tickSub = null;
    if (this.stage.parent?.filters) {
      this.stage.parent.filters = this.stage.parent.filters.filter((f) => f !== this._filter);
    }
  }

  _draw() {
    const w = window.innerWidth, h = window.innerHeight;
    this._dimmer.clear();
    this._dimmer.rect(0, 0, w, h).fill({ color: 0x000000, alpha: 0.55 });
    this._dimmer.visible = true;
    this._banner.clear();
    const bw = 380, bh = 72;
    const bx = (w - bw) >> 1, by = (h - bh) >> 1;
    this._banner.rect(bx, by, bw, bh)
      .fill({ color: 0x1a0c08, alpha: 0.9 })
      .stroke({ width: 2, color: 0xa83030, alpha: 0.9 });
    this._banner.visible = true;
    // Pixi Graphics has no text; draw "YOU ARE DEAD" as a DOM overlay.
    if (!this._dom) {
      const el = document.createElement('div');
      el.textContent = 'YOU ARE DEAD';
      el.style.cssText = `
        position:fixed; left:50%; top:50%;
        transform:translate(-50%,-50%);
        font: bold 28px 'Times New Roman', serif;
        color:#ffd2b0; letter-spacing:6px;
        pointer-events:none; z-index:9999;
        text-shadow: 0 0 16px #4a0a08;
      `;
      document.body.appendChild(el);
      this._dom = el;
    }
    this._dom.style.display = '';
  }

  _tick(now) {
    if (!this._active) return;
    if (now >= this._endsAt) {
      this._dimmer.visible = false;
      this._banner.visible = false;
      if (this._dom) this._dom.style.display = 'none';
      this._tickSub?.();
      this._tickSub = null;
    }
  }

  destroy() {
    for (const u of this._unsubs) u();
    this._unsubs.length = 0;
    this._tickSub?.();
    this._tickSub = null;
    if (this._dom) { this._dom.remove(); this._dom = null; }
    try { this._dimmer.destroy(); } catch { /* noop */ }
    try { this._banner.destroy(); } catch { /* noop */ }
  }
}
