// HealthLinesManager — thin overhead HP bars drawn above every visible
// mobile. Mirrors ClassicUO `Game/Managers/HealthLinesManager.cs`.
//
// Why: without overhead bars the player has no UI affordance to pick a
// target. CUO renders 8×3 px bars (red/green/yellow) below each mobile
// in view, plus optional "ShowMobilesHP" full-bar variant. We keep the
// minimum viable behaviour: bar visible when `hp < hpMax` (Mode = 1 in
// CUO terms). The HUD-side toggle is left to a future profile flag.
//
// The manager sits next to MobileRenderer in the world layer. It reads
// `world.mobiles`, queries the matching MobileSprite for screen position,
// and updates a Pixi Graphics primitive per serial. We avoid one Graphics
// per bar — there's a single shared `Graphics` we re-clear each frame,
// which is far cheaper than spawning 30+ tiny scene-graph nodes.

import { Container, Graphics } from 'pixi.js';
import { worldToScreenX, worldToScreenY, depthKey, LAYER_MOBILE } from '../renderer/iso.js';
import { world } from '../world/world.js';
import { party } from './party-manager.js';
import { profile } from './profile-manager.js';
import { bus } from '../core/event-bus.js';

const BAR_W = 32;
const BAR_H = 3;
const FALLBACK_HEAD_Y = -77;
const NEAR_TILES = 18;      // ClientViewRange default

const COLOR_BG       = 0x000000;
const COLOR_FRAME    = 0x4a3a18;
const COLOR_HP_OK    = 0x4caa4c;
const COLOR_HP_PARTY = 0x4caaff;
const COLOR_HP_LOW   = 0xb04040;
const COLOR_HP_POIS  = 0x4ca06e;
const COLOR_HP_INV   = 0xd0c060;

export class HealthLinesManager {
  /** @param {Container} parent — typically `gc.world` (depth-sorted). */
  constructor(parent) {
    this.parent = parent;
    this.container = new Container();
    this.container.label = 'health-lines';
    this.container.sortableChildren = true;
    parent.addChild(this.container);
    this._gfx = new Graphics();
    this._gfx.zIndex = 9_999_999;     // always on top within container
    this.container.addChild(this._gfx);
    this._wasDisabled = false;
    this._lastDrawHash = 0;
    this._lastDrawCount = -1;
    this._bars = [];
    this._showHealthOverhead = profile.get('gameplay.showHealthOverhead') !== false;
    this._profileSub = bus.on('profile:changed', ({ path } = {}) => {
      if (!path || path === 'gameplay.showHealthOverhead') {
        this._showHealthOverhead = profile.get('gameplay.showHealthOverhead') !== false;
        this._lastDrawCount = -1;
      }
    });
    this._profileResetSub = bus.on('profile:reset', () => {
      this._showHealthOverhead = profile.get('gameplay.showHealthOverhead') !== false;
      this._lastDrawCount = -1;
    });
    this._profileBoundSub = bus.on('profile:bound', () => {
      this._showHealthOverhead = profile.get('gameplay.showHealthOverhead') !== false;
      this._lastDrawCount = -1;
    });
  }

  /** Per-frame draw. Cheap: one clear + N immediate-mode rectangles. */
  draw(_now) {
    if (!this._showHealthOverhead) {
      if (!this._wasDisabled) {
        this._gfx.clear();
        this._wasDisabled = true;
        this._lastDrawCount = -1;
      }
      return;
    }
    this._wasDisabled = false;
    const player = world.player;
    if (!player) {
      if (this._lastDrawCount !== 0) this._gfx.clear();
      this._lastDrawCount = 0;
      this._lastDrawHash = 0;
      return;
    }
    const map = player.map ?? world.mapId ?? 1;
    const bars = this._bars;
    let barCount = 0;
    let hash = 0x811c9dc5 | 0;
    const mix = (v) => {
      hash ^= v | 0;
      hash = Math.imul(hash, 0x01000193) | 0;
    };
    mix(player.x | 0); mix(player.y | 0); mix(player.z | 0); mix(map | 0);
    const visitMobile = (m) => {
      if (m === player) return;
      if ((m.map ?? map) !== map) return;
      if (typeof m.hp !== 'number' || typeof m.hpMax !== 'number') return;
      if (m.hpMax <= 0) return;
      if (m.isDead) return;
      const forced = !!m._isLastTarget || !!m._isLastAttack;
      // Hide bar at full HP (CUO ShowWhen = "not full").
      if (!forced && m.hp >= m.hpMax) return;
      // Cull by tile distance — server already only sends nearby mobs
      // but a freshly logged-out mob may linger.
      const dx = Math.abs(m.x - player.x), dy = Math.abs(m.y - player.y);
      if (dx > NEAR_TILES || dy > NEAR_TILES) return;
      const spX = worldToScreenX(m.x, m.y);
      const spY = worldToScreenY(m.x, m.y, m.z);
      const sx = Math.round(spX + (m.offsetX | 0)) - (BAR_W >> 1);
      // MobileRenderer publishes the real top of the currently rendered
      // body frame.  A fixed feet-relative offset put the bar through the
      // face of tall humans and below the head of short creatures.  Keep
      // the health line just above the sprite (and therefore above its
      // overhead name) for every body/animation combination.
      const headY = Number.isFinite(m._spriteHeadOffset)
        ? m._spriteHeadOffset
        : FALLBACK_HEAD_Y;
      // Names start around headY - 6; keep the HP bar a full text-line above
      // that anchor instead of drawing both overlays through each other.
      const sy = Math.round(spY + (m.offsetY | 0) + headY) - 18;

      // Fill colour by state. Order matters: poison/yellow override the
      // notoriety/party tint.
      let fill = COLOR_HP_OK;
      if (party.isMember && party.isMember(m.serial)) fill = COLOR_HP_PARTY;
      if (m.hp / m.hpMax < 0.3) fill = COLOR_HP_LOW;
      if (m.poisoned)           fill = COLOR_HP_POIS;
      if (m.yellowHits)         fill = COLOR_HP_INV;
      const w = Math.max(0, Math.min(BAR_W, Math.round((BAR_W * m.hp) / m.hpMax)));
      const b = bars[barCount] || (bars[barCount] = { sx: 0, sy: 0, w: 0, fill: 0 });
      b.sx = sx; b.sy = sy; b.w = w; b.fill = fill;
      barCount++;
      mix(m.serial | 0); mix(sx); mix(sy); mix(w); mix(fill); mix(forced ? 1 : 0);
    };
    if (typeof world.forEachMobileNear === 'function') {
      world.forEachMobileNear(player.x, player.y, map, NEAR_TILES, true, visitMobile);
    } else {
      const nearby = world.mobilesNear
        ? world.mobilesNear(player.x, player.y, map, NEAR_TILES, true)
        : world.mobiles.values();
      for (const m of nearby) visitMobile(m);
    }
    bars.length = barCount;
    const count = barCount;
    const nextZ = depthKey(player.x, player.y, player.z + 4, LAYER_MOBILE);
    mix(nextZ | 0);
    if (count === this._lastDrawCount && (hash >>> 0) === this._lastDrawHash) {
      if (this.container.zIndex !== nextZ) this.container.zIndex = nextZ;
      return;
    }
    this._lastDrawCount = count;
    this._lastDrawHash = hash >>> 0;
    this._gfx.clear();
    for (const b of bars) {
      // Background + frame.
      this._gfx.rect(b.sx, b.sy, BAR_W, BAR_H).fill({ color: COLOR_BG, alpha: 0.85 });
      if (b.w > 0) this._gfx.rect(b.sx, b.sy, b.w, BAR_H).fill({ color: b.fill });
      this._gfx.rect(b.sx, b.sy, BAR_W, BAR_H).stroke({ width: 1, color: COLOR_FRAME, alpha: 0.6 });
    }
    // Keep above the mobile sprites.
    this.container.zIndex = nextZ;
  }

  destroy() {
    this._profileSub?.();
    this._profileResetSub?.();
    this._profileBoundSub?.();
    try { this.container.destroy({ children: true }); } catch { /* noop */ }
  }
}
