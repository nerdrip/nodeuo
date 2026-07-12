// Lighting overlay — a single full-screen rect that darkens the world
// view based on `world.lightLevel`. Mirrors ClassicUO's Renderer
// LightSystem. Audit rev.4 P2 — full `light.mul` decoder + tiledata
// `lightIndex` cross-reference now live in `light-points.js` (~100
// emission masks). The overlay here handles the global darkness rect
// + day/night cycle; per-static glows are layered on top via
// `lightPoints.tick()` from the game scene.
//
// Point lights are handled in two passes:
//   1. `light-points.js` renders the warm additive glow sprites.
//   2. This overlay receives the current visible light apertures and
//      cuts stepped soft holes out of the global darkness rect, so a
//      held torch actually reveals world pixels instead of painting a
//      pale fog over night.
//
// 0x4F OverallLight payload: 0 = daylight, 30 = pitch black night.
// We map linearly to alpha 0..0.85.

import { Graphics } from 'pixi.js';
import { world } from '../world/world.js';
import { bus } from '../core/event-bus.js';
import { profile } from '../managers/profile-manager.js';
import { seasonManager, Season } from '../managers/season-manager.js';

const MAX_DARKNESS = 0.85;
const LIGHT_APERTURE_BASE_ALPHA = 0.18;
const LIGHT_CUT_BANDS = [
  { radius: 1.00, alpha: 0.18 },
  { radius: 0.78, alpha: 0.19 },
  { radius: 0.55, alpha: 0.20 },
  { radius: 0.32, alpha: 0.25 },
];

export function seasonOverlayTint(season) {
  switch (season | 0) {
    case Season.Spring:     return { color: 0x8cff9c, alpha: 0.035 };
    case Season.Summer:     return { color: 0xb8ff80, alpha: 0.025 };
    case Season.Fall:       return { color: 0xff9040, alpha: 0.08 };
    case Season.Winter:     return { color: 0x88aaff, alpha: 0.10 };
    case Season.Desolation: return { color: 0x404044, alpha: 0.18 };
    default:                return null;
  }
}

export function darknessOverlayColor(level, useAlternativeLights = false) {
  const t = Math.max(0, Math.min(30, Number(level) || 0)) / 30;
  if (useAlternativeLights) {
    // CUO's alternative-light mode keeps dark areas cooler and less
    // sepia, which reads better on shards with many custom coloured
    // emitters. This only changes the darkness wash; point lights stay
    // per-emitter tinted in light-points.js.
    const r = Math.round(0x34 * (1 - t) + 0x04 * t);
    const g = Math.round(0x4a * (1 - t) + 0x0c * t);
    const b = Math.round(0x58 * (1 - t) + 0x26 * t);
    return (r << 16) | (g << 8) | b;
  }
  const r = Math.round(0x50 * (1 - t));
  const g = Math.round(0x40 * (1 - t));
  const b = Math.round(0x48 * (1 - t) + 0x18 * t);
  return (r << 16) | (g << 8) | b;
}

// 0x4E PersonalLight (server -> client) carries a per-mobile light level
// for the player's own avatar — independent of the global 0x4F overall
// light level. ClassicUO `LightSystem.cs` renders the personal light as
// a localized additive disc anchored to the player's tile, NOT a
// uniform reduction of the global darkness rect. Earlier our overlay
// subtracted `personalLightLevel` from `overall` (line ~135), which
// brightened the ENTIRE viewport when a torch was lit — user report
// 2026-05-19 "pochodnia ... rozświetla cały obszar gry". Personal
// light is now handled by `light-points.js#syncPersonalLight` which
// attaches a moving disc to the player serial; this module no longer
// modifies darkness based on it. The variable below is kept (and
// imported by light-points.js) so the disc strength stays in sync
// with 0x4E packets.
export let personalLightLevel = 0;
bus.on('atmosphere:personal-light', ({ serial, level }) => {
  if (serial !== world.player?.serial) return;
  personalLightLevel = Math.max(0, Math.min(30, level | 0));
});

export class LightOverlay {
  /** @param {import('pixi.js').Container} parent  the UI overlay layer */
  constructor(parent) {
    this.parent = parent;
    this._gfx = new Graphics();
    this._gfx.zIndex = 1; // above world, below DOM/UI gumps
    this._clipMask = new Graphics();
    this._clipMask.eventMode = 'none';
    // Defensively opt out of pointer events so the full-viewport dim
    // rect never absorbs clicks meant for the world / gumps beneath
    // (gump-control hit-testing in UIManager walks the picked tree
    // from `pickAtScreen` so a Graphics with `eventMode: 'auto'`
    // would intercept input on the entire game viewport — user
    // report 2026-05-19 commands stopped working after night).
    this._gfx.eventMode = 'none';
    this.parent.addChild(this._gfx);
    this.parent.addChild(this._clipMask);
    this._gfx.mask = this._clipMask;
    this._lastLevel = -1;
    this._lastW = 0;
    this._lastH = 0;
    this._lastPlayerLevel = -1;
    this._lastSeason = -1;
    this._lastAltLight = null;
    this._lastApertureRevision = -1;
    this._lastApertureCount = -1;
    this._displayLevel = null;
    this._lastTickAt = 0;
    this._syncProfileFlags();
    // Invalidate the redraw cache whenever season flips so the tint
    // wash repaints next tick instead of waiting for an unrelated
    // level / viewport change.
    this._seasonSub = bus.on('season:changed', () => { this._lastLevel = -1; });
    this._profileSub = bus.on('profile:changed', ({ path } = {}) => {
      if (!path || path.startsWith('debug.')
          || path.startsWith('light.')
          || path.startsWith('graphics.')) {
        this._syncProfileFlags();
      }
    });
    this._profileResetSub = bus.on('profile:reset', () => this._syncProfileFlags());
    this._profileBoundSub = bus.on('profile:bound', () => this._syncProfileFlags());
  }

  _syncProfileFlags() {
    this._skipLighting = profile.get('debug.skipLighting') === true;
    this._dayNightCycle = profile.get('light.dayNightCycle') === true;
    this._customLight = profile.get('light.custom') === true;
    this._customLightLevel = Math.max(0, Math.min(30, profile.get('light.level') ?? 12));
    this._customLightType = profile.get('light.type') | 0;
    this._useDarkNights = profile.get('light.useDarkNights') !== false;
    this._useAlternativeLights = profile.get('graphics.useAlternativeLights') === true;
    this._lastLevel = -1;
  }

  destroy() {
    this._seasonSub?.();
    this._profileSub?.();
    this._profileResetSub?.();
    this._profileBoundSub?.();
    this._gfx.destroy();
    this._clipMask?.destroy();
  }

  /** Per-frame; cheap (only redraws when level / viewport changed).
   *  `viewX/Y` is the screen-space origin of the gameplay rect (set by
   *  camera.setViewport) and `viewW/H` its size — the dim rect is
   *  clamped to that rectangle so it never paints over the chrome
   *  outside the play area. */
  tick(viewX, viewY, viewW, viewH, apertures = null) {
    if (this._skipLighting) {
      if (this._lastSkippedLighting !== true) {
        this._gfx.clear();
        this._clipMask?.clear();
        this._lastSkippedLighting = true;
        this._lastLevel = -1;
      }
      return;
    }
    this._lastSkippedLighting = false;
    let overall = Math.max(0, Math.min(30, world.lightLevel | 0));
    // Day/night cycle — CUO `World.SetLightLevel` is server-pushed once
    // per real-time hour. When the shard never pushes 0x4F and the user
    // enabled `light.dayNightCycle`, we run a 20-minute synthetic cycle
    // so the client doesn't sit at flat noon forever. Range [4..28] —
    // never quite full dark (so torches stay readable) nor full white.
    const serverLightIsFresh = world.lastLightPacketAt > 0
      && Date.now() - world.lastLightPacketAt < 60_000;
    if (this._dayNightCycle && !this._customLight && !serverLightIsFresh) {
      const period = 1200_000;          // 20 min in ms
      const t = (Date.now() % period) / period;        // 0..1
      // Cosine — high noon at t=0.25, midnight at t=0.75.
      const cyc = 0.5 - 0.5 * Math.cos(2 * Math.PI * (t + 0.25));
      overall = Math.max(overall, Math.round(4 + 24 * cyc));
    }
    // Audit #34 P3 #11 — CUO Options "Day & Night" panel:
    //   UseCustomLightLevel: bool — when true, override server level
    //   LightLevel: 0..30 slider value
    //   LightLevelType: 0 = absolute (replace), 1 = minimum (clamp)
    // Without the toggle, players had no way to brighten a dungeon
    // when their character's torch broke. Defaults to off so existing
    // shards stay on server light truth.
    if (this._customLight) {
      const custom = this._customLightLevel;
      if (this._customLightType === 1) {
        // Minimum: cap effective darkness at the slider value.
        overall = Math.min(overall, custom);
      } else {
        // Absolute: replace.
        overall = custom;
      }
    }
    // Audit rev.4 P3 — dungeon dark flag. CUO `GameSceneLight.cs`
    // forces overall light to 26 (deep darkness) when the player's
    // current tile is flagged as dungeon (FLAG_DUNGEON in the canon
    // tiledata bit table) and the user hasn't opted out via
    // `light.useDarkNights = false`. We piggyback on the existing
    // region-tracker `_lastRegionKind` set in game-scene.
    if (world.player) {
      const rk = world.lastRegionKind;
      if ((rk === 'cave' || rk === 'dungeon') && this._useDarkNights) {
        overall = Math.max(overall, 26);
      }
    }
    // Ease server/admin changes over a short interval. The target remains
    // authoritative; only the visual overlay interpolates between packets.
    const now = performance.now();
    if (this._displayLevel == null) this._displayLevel = overall;
    const dt = this._lastTickAt ? Math.min(100, now - this._lastTickAt) : 16;
    this._lastTickAt = now;
    const blend = 1 - Math.exp(-dt / 420);
    this._displayLevel += (overall - this._displayLevel) * blend;
    if (Math.abs(overall - this._displayLevel) < 0.01) this._displayLevel = overall;
    overall = this._displayLevel;
    const apertureItems = apertures?.items ?? apertures ?? [];
    const apertureCount = Math.max(0, apertures?.count ?? apertureItems.length ?? 0);
    const apertureRevision = apertureCount > 0 ? (apertures?.revision ?? 0) : 0;
    // ClassicUO parity — overlay darkness is now a function ONLY of
    // overall + region + custom. Personal light is rendered by
    // `light-points.js` as a localized additive disc on the player
    // tile so the brightness clearing is bounded to that disc's
    // radius instead of washing the entire viewport.
    const altLights = this._useAlternativeLights;
    const sId = seasonManager.season | 0;
    const hasApertures = apertureCount > 0;
    if (Math.abs(overall - this._lastLevel) < 0.005
        && altLights === this._lastAltLight
        && sId === this._lastSeason
        && apertureRevision === this._lastApertureRevision
        && apertureCount === this._lastApertureCount
        && viewX === this._lastX && viewY === this._lastY
        && viewW === this._lastW && viewH === this._lastH) return;
    this._lastLevel = overall;
    this._lastAltLight = altLights;
    this._lastSeason = sId;
    this._lastApertureRevision = apertureRevision;
    this._lastApertureCount = apertureCount;
    this._lastX = viewX;
    this._lastY = viewY;
    this._lastW = viewW;
    this._lastH = viewH;

    const effective = overall;
    const alpha = (effective / 30) * MAX_DARKNESS;
    this._gfx.clear();
    if (this._clipMask) {
      this._clipMask.clear();
      this._clipMask.rect(viewX, viewY, viewW, viewH).fill({ color: 0xffffff });
    }
    if (alpha > 0) {
      const color = darknessOverlayColor(effective, altLights);
      if (!hasApertures) {
        this._gfx.rect(viewX, viewY, viewW, viewH).fill({ color, alpha });
      } else {
        let maxRadius = 0;
        for (let i = 0; i < apertureCount; i++) {
          const r = apertureItems[i]?.radius ?? 0;
          if (r > maxRadius) maxRadius = r;
        }
        const pad = Math.ceil(maxRadius) + 6;
        const rx = viewX - pad;
        const ry = viewY - pad;
        const rw = viewW + pad * 2;
        const rh = viewH + pad * 2;
        const baseAlpha = alpha * LIGHT_APERTURE_BASE_ALPHA;
        if (baseAlpha > 0.001) this._gfx.rect(rx, ry, rw, rh).fill({ color, alpha: baseAlpha });
        for (const band of LIGHT_CUT_BANDS) {
          const bandAlpha = alpha * band.alpha;
          if (bandAlpha <= 0.001) continue;
          this._gfx.rect(rx, ry, rw, rh).fill({ color, alpha: bandAlpha });
          for (let i = 0; i < apertureCount; i++) {
            const a = apertureItems[i];
            if (!a) continue;
            const strength = Math.max(0, Math.min(1, a.strength ?? 1));
            const r = (a.radius ?? 0) * band.radius * (0.55 + strength * 0.45);
            if (r >= 3) this._gfx.circle(a.x, a.y, r).cut();
          }
        }
      }
    }
    // Seasonal mood tint — a faint full-screen wash on top of the
    // light overlay. Spring/Summer are subtle green-bright bias, Fall
    // is amber, Winter is cool blue, Desolation is grey-brown.
    const t = seasonOverlayTint(sId);
    if (t) {
      this._gfx.rect(viewX, viewY, viewW, viewH).fill({ color: t.color, alpha: t.alpha });
    }
  }
}
