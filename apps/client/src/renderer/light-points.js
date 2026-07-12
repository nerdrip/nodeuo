// LightPoints — per-source point lights painted as additive radial
// gradients on top of the world layer at night. Mirrors ClassicUO's
// Renderer/Lights system at MVP scope (no per-tile per-direction
// normals).
//
// Strategy:
//   1. Maintain a registry of "light sources" — { x, y, radius, hue, attached? }
//      where `attached` may be a serial that pins the light to a moving mobile
//      (torch in pack, fire-mage robe glow, lantern overhead).
//   2. Every frame, draw a single `Graphics` whose primitive list is one
//      radial soft-disk per visible source. The sprites provide the warm
//      glow, while `visibleApertures()` feeds the LightOverlay with
//      cut-out circles so light actually reveals the world underneath.
//   3. When `world.lightLevel` is daylight (≤ 4) we skip the draw — the
//      overlay alpha is already 0 there.
//
// Pixi cannot draw real radial gradients in immediate-mode v8 without
// a custom mesh, so we approximate with N concentric rings of decreasing
// alpha. 4 rings looks soft enough at our screen scale and only costs
// 4 fills per source.

import { Container, Sprite, Texture, Graphics } from 'pixi.js';
import { worldToScreenX, worldToScreenY } from './iso.js';
import { world } from '../world/world.js';
import { camera } from './camera.js';
import { bus } from '../core/event-bus.js';
import { profile } from '../managers/profile-manager.js';

const TILE_PX = 22;          // approx world->screen radius scale per tile
const HELD_LIGHT_LAYERS = [1, 2]; // one-handed / two-handed equipment layers
const LAND_COUNT = 0x4000;
const LIGHT_CULL_TILES = 18;
const LIGHT_MAX_VISIBLE = 160;
const LIGHT_MAX_APERTURES = 64;
const LIGHT_DEFAULT_TINT = 0xfff2d0;
const LIGHT_SECTOR_SHIFT = 4; // 16x16 tiles
const OCCLUSION_CACHE_INITIAL = 256;

// Cache of Pixi textures decoded from `light.mul` (via lights.json). Keyed
// by lightIndex; populated lazily inside `_loadTiledataLightMap()` once
// the JSON resolves. ClassicUO `LightsLoader.cs::GetLight()` builds the
// same per-emitter texture by reading 5-bit signed intensity bytes and
// expanding to grayscale RGBA — `_buildLightTexture` below does the
// identical decode.
const _lightTextures = new Map();
// Fallback radial-gradient texture used when a light source has no
// matching `light.mul` shape (e.g. attached personal-light, curated
// entries without a lightIndex). Smooth quadratic falloff, NO rings.
let _fallbackRadialTex = null;
function _buildFallbackRadialTexture() {
  if (_fallbackRadialTex) return _fallbackRadialTex;
  // Attached/player lights are frequently enlarged to a 300-400 px disc.
  // A 64 px source combined with the client's nearest-neighbour pixel-art
  // policy produced the large square mosaic visible around the avatar.
  // Keep this procedural light comfortably above its largest display size;
  // it is a single shared texture, so the extra memory is negligible.
  const SIZE = 256, R0 = SIZE / 2;
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x - R0, y - R0) / R0;
      // Smooth quadratic falloff. Avoid a hard centre plateau because
      // held/personal light sits directly on top of the avatar and a
      // saturated core reads like a yellow ring around the player.
      const t = Math.min(1, d);
      const v = Math.max(0, 255 * (1 - t * t)) | 0;
      const i = (y * SIZE + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      // Alpha gate — fully transparent outside the falloff envelope
      // so additive blend doesn't tint the inert ring.
      data[i + 3] = v > 0 ? 255 : 0;
    }
  }
  try {
    const canvas = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(SIZE, SIZE)
      : document.createElement('canvas');
    if (!canvas.width) canvas.width = SIZE;
    if (!canvas.height) canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    const img = new ImageData(data, SIZE, SIZE);
    ctx.putImageData(img, 0, 0);
    _fallbackRadialTex = Texture.from(canvas);
    try { _fallbackRadialTex.source.scaleMode = 'linear'; } catch { /* Pixi backend */ }
  } catch { /* extremely old browsers — leave null and skip lights */ }
  return _fallbackRadialTex;
}

/** Decode a single `light.mul` entry (base64 0..31 intensities) into a
 *  Pixi Texture. ClassicUO `LightsLoader.cs:32-71` produces the same
 *  grayscale RGBA: `intensity = pixel * 8`, R=G=B=intensity, alpha=255
 *  where non-zero. The greyscale texture is then `tint`-ed per emitter
 *  at draw time so a torch glows amber, lava glows red, etc. */
function _buildLightTexture(entry) {
  const w = entry.w | 0, h = entry.h | 0;
  if (!w || !h) return null;
  let buf;
  try {
    buf = (typeof atob === 'function')
      ? Uint8Array.from(atob(entry.pixels), (c) => c.charCodeAt(0))
      : Buffer.from(entry.pixels, 'base64');
  } catch { return null; }
  if (!buf || buf.length < w * h) return null;
  const rgba = new Uint8ClampedArray(w * h * 4);
  // CUO `LightsLoader.cs:56` uses `v << 3` which produces 0..248 —
  // accurate but our dim-rect overlay attenuates the additive
  // contribution before it reaches the framebuffer, so the visible
  // glow ends up too subtle vs CUO's multiply-LRT composite. Boost
  // the per-pixel luminance via `Math.min(255, v * 10)` so the
  // brightest pixels saturate at 255 and the falloff stays in the
  // bright half of the curve. Outer-ring softness preserved by the
  // texture's own pixel grid — no rings introduced.
  for (let i = 0; i < w * h; i++) {
    const v = buf[i] | 0;        // 0..31 (already normalised in lights.json)
    const lum = Math.min(255, v * 10);
    rgba[i * 4]     = lum;
    rgba[i * 4 + 1] = lum;
    rgba[i * 4 + 2] = lum;
    rgba[i * 4 + 3] = v > 0 ? 255 : 0;
  }
  try {
    const canvas = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(w, h)
      : document.createElement('canvas');
    if (!canvas.width) canvas.width = w;
    if (!canvas.height) canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
    const tex = Texture.from(canvas);
    // Light masks are continuous intensity fields, not pixel art. Global
    // nearest sampling turns individual light.mul texels into dark squares.
    try { tex.source.scaleMode = 'linear'; } catch { /* Pixi backend */ }
    return tex;
  } catch { return null; }
}

export function lightTextureMode(lightIndex, attachedToPlayer = false) {
  // Equipment/personal lights move with the avatar and are scaled far beyond
  // their native light.mul dimensions. Use the smooth radial field there;
  // retain canonical shaped masks for fixed lamps, forges and windows.
  return attachedToPlayer || !lightIndex ? 'radial' : 'mask';
}

class LightPoints {
  constructor() {
    /** @type {Map<string, { x:number, y:number, z:number, radius:number, color:number, attachedSerial?:number, lightIndex?:number, flicker?:number, pulse?:number, pulseSpeed?:number, phase?:number }>} */
    this._sources = new Map();
    this._nextId = 1;
    /** Container with `blendMode='add'` that holds one Sprite per
     *  visible light source. ClassicUO renders the same way (sprite
     *  per light, additive blend into the LRT — `GameScene.cs:1095`). */
    this._layer = null;
    /** Pool of reusable Sprites — grown lazily, hidden when no light
     *  occupies that slot this frame. Avoids GC churn on every tick. */
    this._spritePool = [];
    this._visibleSlots = 0;
    this._parent = null;
    this._equipmentLightIds = new Map();
    this._equipmentLiveMarks = new Map();
    this._equipmentSpecCache = new Map();
    this._sourceSectors = new Map();
    this._sourceSectorById = new Map();
    this._attachedSourceIds = new Set();
    this._candidateSources = [];
    this._candidateSourceSlots = [];
    this._apertures = [];
    this._apertureRevision = 0;
    this._apertureSignature = '';
    this._sourceSlots = new Map();
    this._sourceSlotIds = [];
    this._freeSourceSlots = [];
    this._sourceCapacity = 0;
    this._sourceX = new Float32Array(0);
    this._sourceY = new Float32Array(0);
    this._sourceZ = new Float32Array(0);
    this._sourceRadius = new Float32Array(0);
    this._sourceFlicker = new Float32Array(0);
    this._sourcePulse = new Float32Array(0);
    this._sourcePulseSpeed = new Float32Array(0);
    this._sourcePhase = new Float32Array(0);
    this._sourceColor = new Uint32Array(0);
    this._sourceAttachedSerial = new Uint32Array(0);
    this._sourceLightIndex = new Uint32Array(0);
    this._equipmentScanId = 0;
    this._lastEquipmentScanAt = 0;
    this._syncProfileFlags();
    this._profileSub = bus.on('profile:changed', ({ path } = {}) => {
      if (!path || path.startsWith('graphics.')
          || path.startsWith('light.')
          || path.startsWith('experimental.')
          || path.startsWith('debug.')) {
        this._syncProfileFlags();
      }
    });
    this._profileResetSub = bus.on('profile:reset', () => this._syncProfileFlags());
    this._profileBoundSub = bus.on('profile:bound', () => this._syncProfileFlags());
    this.equipmentLightStats = {
      scans: 0, cacheHits: 0, cacheMisses: 0,
    };
    this.lightFrameStats = {
      ticks: 0,
      candidates: 0,
      visible: 0,
      apertures: 0,
      blocked: 0,
      lastMs: 0,
      maxMs: 0,
      occlusionCalls: 0,
      occlusionHits: 0,
      occlusionMisses: 0,
      occlusionCapacity: OCCLUSION_CACHE_INITIAL,
    };
  }

  _syncProfileFlags() {
    const maxVisible = Number(profile.get('graphics.lightMaxVisible'));
    const cullTiles = Number(profile.get('graphics.lightCullTiles'));
    this._skipLighting = profile.get('debug.skipLighting') === true;
    this._useOcclusion = profile.get('light.shadows') !== false
      && profile.get('experimental.enableShadows') !== false
      && profile.get('graphics.shadowsEnabled') !== false;
    this._useColoredLights = profile.get('graphics.useColoredLights') !== false;
    this._useDarkNights = profile.get('light.useDarkNights') !== false;
    this._maxVisible = Number.isFinite(maxVisible)
      ? Math.max(16, Math.min(512, maxVisible | 0))
      : LIGHT_MAX_VISIBLE;
    this._lightCullTiles = Number.isFinite(cullTiles)
      ? Math.max(6, Math.min(64, cullTiles | 0))
      : LIGHT_CULL_TILES;
  }

  _growSourceBuffers(minCapacity) {
    if (minCapacity <= this._sourceCapacity) return;
    let next = this._sourceCapacity || 16;
    while (next < minCapacity) next <<= 1;
    const grow = (current, Type) => {
      const out = new Type(next);
      if (current?.length) out.set(current);
      return out;
    };
    this._sourceX = grow(this._sourceX, Float32Array);
    this._sourceY = grow(this._sourceY, Float32Array);
    this._sourceZ = grow(this._sourceZ, Float32Array);
    this._sourceRadius = grow(this._sourceRadius, Float32Array);
    this._sourceFlicker = grow(this._sourceFlicker, Float32Array);
    this._sourcePulse = grow(this._sourcePulse, Float32Array);
    this._sourcePulseSpeed = grow(this._sourcePulseSpeed, Float32Array);
    this._sourcePhase = grow(this._sourcePhase, Float32Array);
    this._sourceColor = grow(this._sourceColor, Uint32Array);
    this._sourceAttachedSerial = grow(this._sourceAttachedSerial, Uint32Array);
    this._sourceLightIndex = grow(this._sourceLightIndex, Uint32Array);
    this._sourceCapacity = next;
  }

  _allocateSourceSlot(id, src) {
    let slot = this._sourceSlots.get(id);
    if (slot !== undefined) return slot;
    slot = this._freeSourceSlots.length ? this._freeSourceSlots.pop() : this._sourceSlotIds.length;
    this._growSourceBuffers(slot + 1);
    this._sourceSlotIds[slot] = id;
    this._sourceSlots.set(id, slot);
    this._writeSourceSlot(slot, src);
    return slot;
  }

  _freeSourceSlot(id) {
    const slot = this._sourceSlots.get(id);
    if (slot === undefined) return;
    this._sourceSlots.delete(id);
    this._sourceSlotIds[slot] = null;
    this._sourceX[slot] = 0;
    this._sourceY[slot] = 0;
    this._sourceZ[slot] = 0;
    this._sourceRadius[slot] = 0;
    this._sourceFlicker[slot] = 0;
    this._sourcePulse[slot] = 0;
    this._sourcePulseSpeed[slot] = 0;
    this._sourcePhase[slot] = 0;
    this._sourceColor[slot] = 0;
    this._sourceAttachedSerial[slot] = 0;
    this._sourceLightIndex[slot] = 0;
    this._freeSourceSlots.push(slot);
  }

  _writeSourceSlot(slot, src) {
    if (slot === undefined || !src) return;
    this._growSourceBuffers(slot + 1);
    this._sourceX[slot] = Number(src.x) || 0;
    this._sourceY[slot] = Number(src.y) || 0;
    this._sourceZ[slot] = Number(src.z) || 0;
    this._sourceRadius[slot] = Number(src.radius) || 0;
    this._sourceFlicker[slot] = Number(src.flicker) || 0;
    this._sourcePulse[slot] = Number(src.pulse) || 0;
    this._sourcePulseSpeed[slot] = Number(src.pulseSpeed) || 0;
    this._sourcePhase[slot] = Number(src.phase) || 0;
    this._sourceColor[slot] = (src.color ?? LIGHT_DEFAULT_TINT) >>> 0;
    this._sourceAttachedSerial[slot] = src.attachedSerial ? (src.attachedSerial >>> 0) : 0;
    this._sourceLightIndex[slot] = src.lightIndex ? (src.lightIndex >>> 0) : 0;
  }

  _sourceBySlot(slot) {
    const id = this._sourceSlotIds[slot];
    return id == null ? null : this._sources.get(id);
  }

  _hideAll() {
    for (let i = 0; i < this._visibleSlots; i++) {
      const spr = this._spritePool[i];
      if (spr?.visible) spr.visible = false;
    }
    this._visibleSlots = 0;
  }

  _sourceSectorKey(x, y) {
    const sx = (x | 0) >> LIGHT_SECTOR_SHIFT;
    const sy = (y | 0) >> LIGHT_SECTOR_SHIFT;
    return ((sy & 0xffff) * 0x10000) + (sx & 0xffff);
  }

  _attachedMobile(serial) {
    const s = serial >>> 0;
    if (!s) return null;
    return world.mobiles.get(s) || (((world.player?.serial >>> 0) === s) ? world.player : null);
  }

  _indexSource(id, src) {
    if (!id || !src) return;
    if (src.attachedSerial) {
      this._attachedSourceIds.add(id);
      return;
    }
    const key = this._sourceSectorKey(src.x, src.y);
    let set = this._sourceSectors.get(key);
    if (!set) { set = new Set(); this._sourceSectors.set(key, set); }
    set.add(id);
    this._sourceSectorById.set(id, key);
  }

  _unindexSource(id) {
    if (!id) return;
    this._attachedSourceIds.delete(id);
    const key = this._sourceSectorById.get(id);
    if (key === undefined) return;
    const set = this._sourceSectors.get(key);
    if (set) {
      set.delete(id);
      if (set.size === 0) this._sourceSectors.delete(key);
    }
    this._sourceSectorById.delete(id);
  }

  _collectCandidateSourceSlots(px, py, radius) {
    const out = this._candidateSourceSlots;
    out.length = 0;
    const sxLo = ((px - radius) | 0) >> LIGHT_SECTOR_SHIFT;
    const sxHi = ((px + radius) | 0) >> LIGHT_SECTOR_SHIFT;
    const syLo = ((py - radius) | 0) >> LIGHT_SECTOR_SHIFT;
    const syHi = ((py + radius) | 0) >> LIGHT_SECTOR_SHIFT;
    for (let sy = syLo; sy <= syHi; sy++) {
      for (let sx = sxLo; sx <= sxHi; sx++) {
        const set = this._sourceSectors.get(((sy & 0xffff) * 0x10000) + (sx & 0xffff));
        if (!set) continue;
        for (const id of set) {
          const slot = this._sourceSlots.get(id);
          if (slot !== undefined) out.push(slot);
        }
      }
    }
    for (const id of this._attachedSourceIds) {
      const slot = this._sourceSlots.get(id);
      if (slot === undefined) continue;
      const attachedSerial = this._sourceAttachedSerial[slot] >>> 0;
      const m = this._attachedMobile(attachedSerial);
      if (m) {
        const x = m.x | 0;
        const y = m.y | 0;
        if (Math.abs(x - px) > radius || Math.abs(y - py) > radius) continue;
      }
      out.push(slot);
    }
    return out;
  }

  _collectCandidateSources(px, py, radius) {
    const slots = this._collectCandidateSourceSlots(px, py, radius);
    const out = this._candidateSources;
    out.length = 0;
    for (let i = 0; i < slots.length; i++) {
      const src = this._sourceBySlot(slots[i]);
      if (src) out.push(src);
    }
    return out;
  }

  /** Mount the lights container under a Pixi parent (typically the
   *  `worldOverlay` layer so the additive sprites composite ON TOP of
   *  the night dim rect). */
  install(parent) {
    this._parent = parent;
    this._layer = new Container();
    this._layer.blendMode = 'add';
    parent.sortableChildren = true;
    this._layer.zIndex = 0;
    // Mounted on `worldOverlay` (the same screen-space layer as the
    // night dim rect). The sprite coords are computed in iso world-
    // pixel space by `worldToScreen()`, so we apply the camera
    // transform manually inside `tick()`. Mounting here puts the
    // additive composite AFTER the dim rect in the GPU pipeline so
    // brightening overcomes the night alpha instead of being
    // attenuated by it.
    parent.addChild(this._layer);
    // Clip mask — the dim rect on LightOverlay is sized to the
    // game-viewport rect (camera.viewX..viewW × viewY..viewH), but
    // a light Sprite placed near the player can overflow that rect
    // and bleed into the chrome / sidebar UI. User report 2026-05-19
    // "światło wystaje za ekran gry". Pixi v8 supports a Graphics
    // mask on a Container — we resize it every tick to track
    // `camera.viewX/viewW/...`. Mounted as a child so transforms
    // sync with the layer's parent space.
    this._clipMask = new Graphics();
    // Explicitly opt out of pointer events on the mask + layer so
    // nothing in the lights pipeline absorbs clicks that should
    // reach gump controls / chat input underneath.
    this._clipMask.eventMode = 'none';
    this._layer.eventMode = 'none';
    this._layer.addChild(this._clipMask);
    this._layer.mask = this._clipMask;
    // Build the fallback texture now (synchronous, cheap) so the
    // first tick has something to draw even if lights.json is still
    // resolving for the per-emitter shapes.
    _buildFallbackRadialTexture();
    // ClassicUO parity — personal light (0x4E PersonalLight) renders
    // as a localized additive disc anchored to the player tile, NOT
    // as a uniform reduction of the overall darkness rect (which is
    // what `light-overlay.js` used to do, washing the entire viewport
    // when a torch was lit). Manage a single attached source keyed
    // off `_personalLightId`; sync its radius to the latest 0x4E
    // level whenever the packet arrives.
    this._personalLightId = null;
    // Buffer the latest personal level if the packet arrives before
    // `world.player` binds (login race) — apply it on world:login-complete.
    this._pendingPersonalLevel = null;
    this._personalSub = bus.on('atmosphere:personal-light', ({ serial, level }) => {
      if (!world.player) {
        this._pendingPersonalLevel = level | 0;
        return;
      }
      if (serial !== world.player.serial) return;
      this._syncPersonalLight(level | 0);
    });
    this._loginSub = bus.on('world:login-complete', () => {
      if (this._pendingPersonalLevel != null) {
        this._syncPersonalLight(this._pendingPersonalLevel);
        this._pendingPersonalLevel = null;
      }
    });
  }

  /** Map a 0x4E personal light level (0..30, higher = brighter in
   *  the OSI/CUO convention) to a tile-radius for the additive disc.
   *  ServUO `BaseLight.Light` ships values around 8-11 for hand-held
   *  lights, 25 for Night Sight. CUO renders these as roughly 5-12
   *  tile radii. We clamp generously so even max-bright doesn't
   *  light up the entire viewport. */
  _syncPersonalLight(level) {
    if (level <= 0) {
      if (this._personalLightId) {
        this._unindexSource(this._personalLightId);
        this._sources.delete(this._personalLightId);
        this._freeSourceSlot(this._personalLightId);
        this._personalLightId = null;
      }
      return;
    }
    // 0..30 → ~3..9 tile radius. Torch (9) → ~5 tiles, lantern (11)
    // → ~5.6 tiles, night sight (25) → ~8.5 tiles. Tuned so a torch
    // in hand carves a small clearing around the player without
    // illuminating off-screen lamps.
    const radius = Math.max(2, Math.min(9, 2 + level * 0.28));
    if (!this._personalLightId) {
      const player = world.player;
      this._personalLightId = `lp_personal`;
      const src = {
        x: player?.x ?? 0, y: player?.y ?? 0, z: player?.z ?? 0,
        radius, color: 0xffe0a0,
        attachedSerial: player?.serial ?? 0,
      };
      this._sources.set(this._personalLightId, src);
      this._allocateSourceSlot(this._personalLightId, src);
      this._indexSource(this._personalLightId, src);
    } else {
      const src = this._sources.get(this._personalLightId);
      if (src) {
        src.radius = radius;
        const slot = this._sourceSlots.get(this._personalLightId);
        if (slot !== undefined) this._writeSourceSlot(slot, src);
      }
    }
  }

  destroy() {
    this._personalSub?.(); this._personalSub = null;
    this._loginSub?.();    this._loginSub    = null;
    this._profileSub?.(); this._profileSub = null;
    this._profileResetSub?.(); this._profileResetSub = null;
    this._profileBoundSub?.(); this._profileBoundSub = null;
    if (this._layer) {
      try { this._layer.destroy({ children: true }); } catch { /* ignore */ }
      this._layer = null;
    }
    this._spritePool.length = 0;
    this._visibleSlots = 0;
    this._equipmentLightIds.clear();
    this._equipmentLiveMarks.clear();
    this._equipmentSpecCache.clear();
    this._sourceSectors.clear();
    this._sourceSectorById.clear();
    this._attachedSourceIds.clear();
    this._candidateSources.length = 0;
    this._candidateSourceSlots.length = 0;
    this._sourceSlots.clear();
    this._sourceSlotIds.length = 0;
    this._freeSourceSlots.length = 0;
    this._sources.clear();
  }

  /**
   * Register a static light source (torch on the wall, fire pit). Returns
   * a token used to remove the source later. `lightIndex` (when supplied
   * by `staticLightSpec`) is the canonical CUO `light.mul` shape — used
   * to pick the matching emission texture in `tick()`. Sources with no
   * lightIndex fall back to the radial-gradient texture so the disc
   * still has smooth falloff (NOT bullseye rings).
   */
  add({ x, y, z = 0, radius = 4, color = 0xffd070, attachedSerial, lightIndex = 0,
        flicker = 0, pulse = 0, pulseSpeed = 0 }) {
    const n = this._nextId++;
    const id = n;
    const src = {
      x, y, z, radius, color, attachedSerial, lightIndex,
      flicker, pulse, pulseSpeed,
      phase: (n * 2.399963229728653) % (Math.PI * 2),
    };
    this._sources.set(id, src);
    this._allocateSourceSlot(id, src);
    this._indexSource(id, src);
    return id;
  }

  /** Update a previously added source's position / parameters in-place. */
  update(id, patch) {
    const src = this._sources.get(id);
    if (!src) return;
    const wasAttached = !!src.attachedSerial;
    const attachmentChanges = Object.prototype.hasOwnProperty.call(patch, 'attachedSerial')
      && patch.attachedSerial !== src.attachedSerial;
    const nextAttached = attachmentChanges ? !!patch.attachedSerial : wasAttached;
    const staticPositionChanges = !wasAttached && !nextAttached
      && (patch.x != null || patch.y != null);
    const needsReindex = attachmentChanges || staticPositionChanges;
    if (needsReindex) this._unindexSource(id);
    if (patch.x != null) src.x = patch.x;
    if (patch.y != null) src.y = patch.y;
    if (patch.z != null) src.z = patch.z;
    if (patch.radius != null) src.radius = patch.radius;
    if (patch.color != null) src.color = patch.color;
    if (Object.prototype.hasOwnProperty.call(patch, 'attachedSerial')) {
      src.attachedSerial = patch.attachedSerial ? (patch.attachedSerial >>> 0) : undefined;
    }
    if (patch.lightIndex != null) src.lightIndex = patch.lightIndex;
    if (patch.flicker != null) src.flicker = patch.flicker;
    if (patch.pulse != null) src.pulse = patch.pulse;
    if (patch.pulseSpeed != null) src.pulseSpeed = patch.pulseSpeed;
    if (needsReindex) this._indexSource(id, src);
    const slot = this._sourceSlots.get(id);
    if (slot !== undefined) this._writeSourceSlot(slot, src);
  }

  remove(id) {
    this._unindexSource(id);
    this._sources.delete(id);
    this._freeSourceSlot(id);
  }

  size() { return this._sources.size; }

  /** Current frame's screen-space light cut-outs for LightOverlay. */
  visibleApertures() {
    return {
      revision: this._apertureRevision,
      items: this._apertures,
      count: this._apertures.length,
    };
  }

  _commitApertures() {
    let signature = `${this._apertures.length}|`;
    for (let i = 0; i < this._apertures.length; i++) {
      const a = this._apertures[i];
      signature += `${Math.round(a.x)},${Math.round(a.y)},${Math.round(a.radius)},${Math.round(a.strength * 20)};`;
    }
    if (signature !== this._apertureSignature) {
      this._apertureSignature = signature;
      this._apertureRevision++;
    }
  }

  /** Per-frame draw — one Sprite per visible light, additive blend, native
   *  `light.mul` falloff shape (greyscale alpha-tint). Mirrors ClassicUO
   *  `GameScene.PrepareLightsRendering` line 1058+ as closely as Pixi v8
   *  + WebGL2 allow: same per-emitter `light.Texture`, same additive
   *  pass, same per-emitter hue tint. CUO composites the result via a
   *  multiply-blend against the world; we composite via additive on top
   *  of the existing dim rect (worldOverlay layering) — perceptually
   *  the same effect at our scale, simpler shader pipeline. */
  tick(now = performance.now()) {
    if (!this._layer) return;
    const tickStart = performance.now();
    const apertures = this._apertures;
    apertures.length = 0;
    if (this._skipLighting) {
      this._hideAll();
      this._commitApertures();
      this._recordFrameStats(tickStart, 0, 0);
      return;
    }
    let level = world.lightLevel | 0;
    // Match the dungeon-overlay rule in light-overlay.js — if the
    // player's current region is a cave/dungeon we render at level
    // 26 regardless of the day-night cycle, so torches + forges glow
    // at "noon" indoors. Without this branch, `[setlight 0` made
    // every dungeon lamp invisible.
    if (this._useDarkNights && world.player
        && (world.lastRegionKind === 'cave' || world.lastRegionKind === 'dungeon')) {
      level = Math.max(level, 26);
    }
    const darknessFactor = Math.max(0, Math.min(1, (level - 3) / 8));
    // Daylight short-circuit — hide every pooled sprite, no render.
    const player = world.player;
    if (darknessFactor <= 0 || !player) {
      this._hideAll();
      this._commitApertures();
      this._recordFrameStats(tickStart, 0, 0);
      return;
    }
    this._syncEquipmentLights(now);
    _beginOcclusionFrame(player.x | 0, player.y | 0, player.z | 0);
    // Audit #46 P3 — occlusion is opt-in via `light.shadows` profile
    // flag (default true on modern hardware). Wall tiles between the
    // light and the player dim the contribution; a torch in the next
    // room glows ~30 % instead of full strength.
    const useOcclusion = this._useOcclusion;
    const useColoredLights = this._useColoredLights;

    // Manual camera transform — `_layer` lives on the untransformed
    // `worldOverlay`. Mirrors camera.js:197-209.
    const zoom = camera?.zoom ?? 1;
    const cx = camera?.cx ?? 0;
    const cy = camera?.cy ?? 0;
    const ox = camera ? camera.viewX + camera.viewW / 2 - cx * zoom : 0;
    const oy = camera ? camera.viewY + camera.viewH / 2 - cy * zoom : 0;
    // Resize clip mask to the current viewport so additive sprites
    // never bleed onto the chrome / sidebar. Cheap (one rect refresh
    // per frame; Pixi caches the geometry until invalidated).
    if (this._clipMask && camera) {
      const vx = camera.viewX | 0, vy = camera.viewY | 0;
      const vw = Math.max(1, camera.viewW | 0);
      const vh = Math.max(1, camera.viewH | 0);
      if (this._maskX !== vx || this._maskY !== vy
          || this._maskW !== vw || this._maskH !== vh) {
        this._clipMask.clear();
        this._clipMask.rect(vx, vy, vw, vh).fill({ color: 0xffffff });
        this._maskX = vx; this._maskY = vy;
        this._maskW = vw; this._maskH = vh;
      }
    }

    let slot = 0;
    let apertureCount = 0;
    let blockedByOcclusion = 0;
    const playerX = player.x | 0;
    const playerY = player.y | 0;
    const cullTiles = this._lightCullTiles || LIGHT_CULL_TILES;
    const maxVisible = this._maxVisible || LIGHT_MAX_VISIBLE;
    const candidateSlots = this._collectCandidateSourceSlots(playerX, playerY, cullTiles);
    const candidateCount = candidateSlots.length;
    for (let i = 0; i < candidateSlots.length; i++) {
      const sourceSlot = candidateSlots[i] | 0;
      let x = this._sourceX[sourceSlot];
      let y = this._sourceY[sourceSlot];
      let z = this._sourceZ[sourceSlot];
      const radius = this._sourceRadius[sourceSlot];
      const color = this._sourceColor[sourceSlot] >>> 0;
      const attachedSerial = this._sourceAttachedSerial[sourceSlot] >>> 0;
      const lightIndex = this._sourceLightIndex[sourceSlot] >>> 0;
      const flicker = this._sourceFlicker[sourceSlot];
      const pulse = this._sourcePulse[sourceSlot];
      const pulseSpeed = this._sourcePulseSpeed[sourceSlot];
      const phase = this._sourcePhase[sourceSlot];
      // Read mobile lerp offsets for smooth follow. `m.offsetX/Y/Z` are
      // sub-tile residuals from `beginMoveStep` — adding them to the
      // world-screen position makes the light glide with the avatar
      // through the 200-400 ms walk lerp instead of jumping tile-to-
      // tile. User report 2026-05-19 "podczas poruszania się postaci
      // światło nie przechodzi płynnie". Used purely as a screen-
      // pixel patch added below; the tile coords stay as-is so the
      // tile-distance cull from the player's tile still works.
      let lerpOffX = 0, lerpOffY = 0;
      if (attachedSerial) {
        const m = this._attachedMobile(attachedSerial);
        if (m) {
          x = m.x; y = m.y; z = m.z;
          lerpOffX = m.offsetX | 0;
          lerpOffY = m.offsetY | 0;
        }
      }
      // Cull by tile distance to player.
      if (Math.abs(x - playerX) > cullTiles || Math.abs(y - playerY) > cullTiles) continue;
      // Vertical (z) cull — a light source on a different floor /
      // building interior shouldn't leak to the player outside. UO Z
      // units are ½-foot increments and a typical floor-to-ceiling
      // is 20 Z (the Britain bank floor sits at z=20). Player standing
      // outside at z=0 can't see a torch on the bank's first-floor
      // tile (z=20) until they step inside the bank's entrance which
      // brings them up to the same z. User report 2026-05-19 "jeżeli
      // jakieś źródło światła jest w pomieszczeniu to powinno je
      // być widać dopiero po wejściu do środka". Skip personal-light
      // (always rendered at the player) — only world-static / attached
      // mobile lights are gated.
      const playerZ = player.z | 0;
      const isPersonalAttached = (attachedSerial === (world.player?.serial ?? 0));
      if (!isPersonalAttached && Math.abs((z | 0) - playerZ) > 10) continue;
      // Per-light occlusion scalar. 1.0 = fully visible, 0.0 = blocked.
      let occlusionScalar = 1.0;
      if (useOcclusion && (x !== player.x || y !== player.y)) {
        occlusionScalar = _rayOcclusion(x, y, playerX, playerY, z, playerZ);
      }
      if (occlusionScalar < 0.05) {
        blockedByOcclusion++;
        occlusionScalar = 0.28;
      } else if (occlusionScalar < 0.99) {
        blockedByOcclusion++;
      }
      if (slot >= maxVisible && !attachedSerial) continue;

      // Resolve the per-emitter texture. ClassicUO uses light.mul
      // entry indexed by `lightIndex` from tiledata (`AddLight` line
      // 466); we fall back to the smooth radial gradient when the
      // emitter has no .mul shape mapped (personal light from 0x4E,
      // curated entries without an index hint).
      const textureMode = lightTextureMode(lightIndex, isPersonalAttached);
      const tex = textureMode === 'mask'
        ? (_lightTextures.get(lightIndex) || _fallbackRadialTex)
        : _fallbackRadialTex;
      if (!tex) continue;

      const spX = worldToScreenX(x, y);
      const spY = worldToScreenY(x, y, z);
      // Add lerp offsets (in iso world-pixel space already) so an
      // attached mobile's light glides through the walk animation
      // instead of snapping to the destination tile on each step.
      const sx = Math.round(ox + (spX + lerpOffX) * zoom);
      const sy = Math.round(oy + (spY + lerpOffY - 22) * zoom);
      // Scale the native texture so it covers `radius` tiles
      // diametrically. `radius * TILE_PX * 2` is the disc's screen
      // diameter at zoom 1; dividing by the texture's native width
      // produces the per-axis scale factor. Camera zoom applied
      // separately since `_layer` is untransformed.
      const targetDiameter = radius * TILE_PX * 2 * zoom;
      const baseRadiusPx = Math.max(8, targetDiameter * 0.55);
      if (camera && (
        sx + baseRadiusPx < camera.viewX - 4
        || sx - baseRadiusPx > camera.viewX + camera.viewW + 4
        || sy + baseRadiusPx < camera.viewY - 4
        || sy - baseRadiusPx > camera.viewY + camera.viewH + 4
      )) continue;
      let scale = targetDiameter / Math.max(8, tex.width);
      let alpha = occlusionScalar;
      if (flicker > 0) {
        const f = Math.sin(now * 0.011 + phase)
                + 0.45 * Math.sin(now * 0.027 + phase * 1.7);
        const wobble = f * flicker;
        scale *= 1 + wobble;
        alpha *= Math.max(0.72, Math.min(1.16, 1 + wobble * 1.4));
      }
      if (pulse > 0) {
        const speed = pulseSpeed || 0.003;
        const p = 0.5 + 0.5 * Math.sin(now * speed + phase);
        scale *= 1 + pulse * p;
        alpha *= 0.82 + 0.24 * p;
      }
      alpha = Math.max(0, Math.min(1, alpha * darknessFactor));

      if (apertureCount < LIGHT_MAX_APERTURES || isPersonalAttached) {
        const aperture = {
          x: sx,
          y: sy,
          radius: Math.max(8, Math.max(tex.width, tex.height) * scale * 0.5),
          strength: alpha,
        };
        if (apertureCount < LIGHT_MAX_APERTURES) {
          apertures.push(aperture);
          apertureCount++;
        } else {
          // Candidate sectors are visited before attached sources. Keep the
          // player's held/personal light even in an unusually dense scene.
          apertures[LIGHT_MAX_APERTURES - 1] = aperture;
        }
      }

      let spr = this._spritePool[slot];
      if (!spr) {
        spr = new Sprite(tex);
        spr.anchor.set(0.5);
        spr.blendMode = 'add';
        spr.eventMode = 'none';
        this._layer.addChild(spr);
        this._spritePool.push(spr);
      } else if (spr.texture !== tex) {
        spr.texture = tex;
      }
      if (!spr.visible) spr.visible = true;
      if (spr.x !== sx) spr.x = sx;
      if (spr.y !== sy) spr.y = sy;
      if (spr._uoLightScale !== scale) {
        spr.scale.set(scale, scale);
        spr._uoLightScale = scale;
      }
      // CUO tints the grayscale .mul pixels with the emitter's hue
      // (Game/Renderer:hued shader, GameScene.cs:1117). Pixi v8 `tint`
      // multiplies RGB channels of the texture — for a pure-greyscale
      // texture this is identical to the CUO formula.
      const tint = useColoredLights ? color : LIGHT_DEFAULT_TINT;
      if (spr.tint !== tint) spr.tint = tint;
      const spriteAlpha = isPersonalAttached ? alpha * 0.52 : alpha * 0.46;
      if (spr.alpha !== spriteAlpha) spr.alpha = spriteAlpha;
      slot++;
    }
    candidateSlots.length = 0;
    // Hide pooled sprites that weren't claimed this frame.
    for (let i = slot; i < this._visibleSlots; i++) {
      const spr = this._spritePool[i];
      if (spr?.visible) spr.visible = false;
    }
    this._visibleSlots = slot;
    this._commitApertures();
    this._recordFrameStats(tickStart, candidateCount, slot, apertureCount, blockedByOcclusion);
  }

  _recordFrameStats(tickStart, candidates, visible, apertures = 0, blocked = 0) {
    const stats = this.lightFrameStats;
    stats.ticks++;
    stats.candidates = candidates | 0;
    stats.visible = visible | 0;
    stats.apertures = apertures | 0;
    stats.blocked = blocked | 0;
    const ms = Math.max(0, performance.now() - tickStart);
    stats.lastMs = ms;
    if (ms > stats.maxMs) stats.maxMs = ms;
    stats.occlusionCalls = _occlusionFrameCalls | 0;
    stats.occlusionHits = _occlusionFrameHits | 0;
    stats.occlusionMisses = _occlusionFrameMisses | 0;
    stats.occlusionCapacity = _occlusionCacheKeys.length | 0;
  }

  _syncEquipmentLights(now) {
    if (now - (this._lastEquipmentScanAt || 0) < 250) return;
    this._lastEquipmentScanAt = now;
    const scanId = ((this._equipmentScanId + 1) >>> 0) || 1;
    this._equipmentScanId = scanId;
    this.equipmentLightStats.scans++;
    const player = world.player;
    const map = player?.map ?? world.mapId ?? 1;
    const visitMobile = (mob) => {
      if (!mob || mob.isDead || mob.dead) return;
      const serial = mob.serial >>> 0;
      const spec = this._mobileEquipmentLightSpecCached(mob, serial);
      if (!spec) return;
      if (mob === world.player && this._personalLightId) return;
      this._equipmentLiveMarks.set(serial, scanId);
      let lightId = this._equipmentLightIds.get(serial);
      if (!lightId) {
        lightId = this.add({
          x: mob.x | 0, y: mob.y | 0, z: mob.z | 0,
          radius: spec.radius, color: spec.color,
          attachedSerial: serial,
          lightIndex: spec.lightIndex,
          flicker: spec.flicker,
          pulse: spec.pulse,
          pulseSpeed: spec.pulseSpeed,
        });
        this._equipmentLightIds.set(serial, lightId);
      } else {
        this.update(lightId, {
          radius: spec.radius,
          color: spec.color,
          lightIndex: spec.lightIndex,
          attachedSerial: serial,
          flicker: spec.flicker,
          pulse: spec.pulse,
          pulseSpeed: spec.pulseSpeed,
        });
      }
    };
    if (player && typeof world.forEachMobileNear === 'function') {
      world.forEachMobileNear(player.x | 0, player.y | 0, map, 18, true, visitMobile);
    } else {
      const mobiles = player && typeof world.mobilesNear === 'function'
        ? world.mobilesNear(player.x | 0, player.y | 0, map, 18, true)
        : world.mobiles.values();
      for (const mob of mobiles) visitMobile(mob);
    }
    for (const [serial, lightId] of this._equipmentLightIds) {
      if (this._equipmentLiveMarks.get(serial) === scanId) continue;
      this.remove(lightId);
      this._equipmentLightIds.delete(serial);
      this._equipmentLiveMarks.delete(serial);
      this._equipmentSpecCache.delete(serial);
    }
  }

  _mobileEquipmentLightSpecCached(mob, serial) {
    if (!mob?.equipment) return null;
    const eqA = mob.equipment.get?.(HELD_LIGHT_LAYERS[0]);
    const eqB = mob.equipment.get?.(HELD_LIGHT_LAYERS[1]);
    const aId = eqA?.itemId | 0;
    const aHue = eqA?.hue | 0;
    const bId = eqB?.itemId | 0;
    const bHue = eqB?.hue | 0;
    const cached = this._equipmentSpecCache.get(serial);
    if (cached
        && cached.aId === aId && cached.aHue === aHue
        && cached.bId === bId && cached.bHue === bHue) {
      this.equipmentLightStats.cacheHits++;
      return cached.spec;
    }
    const spec = mobileEquipmentLightSpec(mob);
    this._equipmentSpecCache.set(serial, { aId, aHue, bId, bHue, spec });
    this.equipmentLightStats.cacheMisses++;
    return spec;
  }
}

// Audit #46 P3 — light occlusion sampler. Walks a Bresenham-style line
// from (x0,y0) to (x1,y1) on the tile grid checking for tall surface
// statics that would block line-of-sight from the light source.
// Returns 1.0 = unblocked, 0.0 = blocked. Cached per-frame.
let _lightOcclusionFrame = 0;
let _occlusionTargetX = 0;
let _occlusionTargetY = 0;
let _occlusionTargetZ = 0;
let _occlusionCacheKeys = new Float64Array(OCCLUSION_CACHE_INITIAL);
let _occlusionCacheValues = new Float32Array(OCCLUSION_CACHE_INITIAL);
let _occlusionCacheGeneration = new Uint32Array(OCCLUSION_CACHE_INITIAL);
let _occlusionGeneration = 1;
let _occlusionCount = 0;
let _occlusionFrameCalls = 0;
let _occlusionFrameHits = 0;
let _occlusionFrameMisses = 0;
const _occlusionFallbackCache = new Map();

function _beginOcclusionFrame(targetX = 0, targetY = 0, targetZ = 0) {
  _lightOcclusionFrame = (_lightOcclusionFrame + 1) >>> 0;
  _occlusionGeneration = (_occlusionGeneration + 1) >>> 0;
  if (_occlusionGeneration === 0) {
    _occlusionCacheGeneration.fill(0);
    _occlusionGeneration = 1;
  }
  _occlusionCount = 0;
  _occlusionFrameCalls = 0;
  _occlusionFrameHits = 0;
  _occlusionFrameMisses = 0;
  _occlusionFallbackCache.clear();
  _occlusionTargetX = targetX | 0;
  _occlusionTargetY = targetY | 0;
  _occlusionTargetZ = targetZ | 0;
}

function _occlusionSourceKey(x, y, lightZ, playerZ) {
  // Exact numeric key for the common light->current-player path. Map
  // coords fit in 16 bits and z in 8 bits; the packed value stays under
  // JS's 53-bit integer precision ceiling. This avoids allocating a
  // string for every visible light on every frame.
  return ((x & 0xffff)
        + (y & 0xffff) * 0x10000
        + (((lightZ | 0) + 128) & 0xff) * 0x100000000
        + (((playerZ | 0) + 128) & 0xff) * 0x10000000000);
}

function _hashOcclusionKey(key) {
  let h = key | 0;
  h ^= (key / 0x100000000) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

function _growOcclusionCache() {
  const oldKeys = _occlusionCacheKeys;
  const oldValues = _occlusionCacheValues;
  const oldGeneration = _occlusionCacheGeneration;
  const oldGen = _occlusionGeneration;
  const nextCap = Math.min(4096, oldKeys.length << 1);
  if (nextCap <= oldKeys.length) return;
  _occlusionCacheKeys = new Float64Array(nextCap);
  _occlusionCacheValues = new Float32Array(nextCap);
  _occlusionCacheGeneration = new Uint32Array(nextCap);
  const oldCount = _occlusionCount;
  _occlusionCount = 0;
  for (let i = 0; i < oldKeys.length; i++) {
    if (oldGeneration[i] !== oldGen) continue;
    _setOcclusionCachedValue(oldKeys[i], oldValues[i]);
  }
  _occlusionCount = oldCount;
}

function _getOcclusionCachedValue(key) {
  const keys = _occlusionCacheKeys;
  const generation = _occlusionCacheGeneration;
  const mask = keys.length - 1;
  let idx = _hashOcclusionKey(key) & mask;
  for (let probe = 0; probe < keys.length; probe++) {
    if (generation[idx] !== _occlusionGeneration) return undefined;
    if (keys[idx] === key) return _occlusionCacheValues[idx];
    idx = (idx + 1) & mask;
  }
  return undefined;
}

function _setOcclusionCachedValue(key, value) {
  if ((_occlusionCount + 1) * 2 >= _occlusionCacheKeys.length) _growOcclusionCache();
  const keys = _occlusionCacheKeys;
  const generation = _occlusionCacheGeneration;
  const mask = keys.length - 1;
  let idx = _hashOcclusionKey(key) & mask;
  for (let probe = 0; probe < keys.length; probe++) {
    if (generation[idx] !== _occlusionGeneration) {
      generation[idx] = _occlusionGeneration;
      keys[idx] = key;
      _occlusionCacheValues[idx] = value;
      _occlusionCount++;
      return;
    }
    if (keys[idx] === key) {
      _occlusionCacheValues[idx] = value;
      return;
    }
    idx = (idx + 1) & mask;
  }
}

function _rayOcclusion(x0, y0, x1, y1, lightZ, playerZ) {
  // Per-frame cache key.
  _occlusionFrameCalls++;
  const targetMatches = (x1 | 0) === _occlusionTargetX
    && (y1 | 0) === _occlusionTargetY
    && (playerZ | 0) === _occlusionTargetZ;
  let key;
  let cached;
  if (targetMatches) {
    key = _occlusionSourceKey(x0, y0, lightZ, playerZ);
    cached = _getOcclusionCachedValue(key);
  } else {
    key = `${x0},${y0},${x1},${y1},${lightZ | 0},${playerZ | 0}`;
    cached = _occlusionFallbackCache.get(key);
  }
  if (cached !== undefined) {
    _occlusionFrameHits++;
    return cached;
  }
  _occlusionFrameMisses++;
  // Sample once per crossed tile. The old fixed 6-sample version could
  // skip a one-tile bank wall, and the z predicate ignored ground-level
  // walls entirely, so indoor lights leaked outdoors.
  const dx = Math.abs((x1 | 0) - (x0 | 0));
  const dy = Math.abs((y1 | 0) - (y0 | 0));
  const steps = Math.max(2, Math.min(48, Math.ceil(Math.max(dx, dy))));
  let blocked = false;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const sx = Math.round(x0 + (x1 - x0) * t);
    const sy = Math.round(y0 + (y1 - y0) * t);
    if (_isOccluderNear(sx, sy, Math.min(lightZ, playerZ))) {
      blocked = true;
      break;
    }
  }
  const scalar = blocked ? 0.0 : 1.0;
  if (targetMatches) _setOcclusionCachedValue(key, scalar);
  else _occlusionFallbackCache.set(key, scalar);
  return scalar;
}

export function sampleLightOcclusionForTests(x0, y0, x1, y1, lightZ = 0, playerZ = 0) {
  _beginOcclusionFrame(x1, y1, playerZ);
  const first = _rayOcclusion(x0, y0, x1, y1, lightZ, playerZ);
  const second = _rayOcclusion(x0, y0, x1, y1, lightZ, playerZ);
  return {
    first,
    second,
    calls: _occlusionFrameCalls,
    hits: _occlusionFrameHits,
    misses: _occlusionFrameMisses,
    capacity: _occlusionCacheKeys.length,
  };
}

function _isOccluderNear(x, y, baseZ) {
  if (_isOccluder(x, y, baseZ)) return true;
  // LOS rays often pass between two wall tiles in isometric art. Check
  // the direct neighbours so bank/house walls block reliably without
  // needing expensive per-pixel wall masks.
  return _isOccluder(x + 1, y, baseZ)
      || _isOccluder(x - 1, y, baseZ)
      || _isOccluder(x, y + 1, baseZ)
      || _isOccluder(x, y - 1, baseZ);
}

/** True when a tile at (x,y) has a tall surface static above baseZ. */
function _isOccluder(x, y, baseZ) {
  const tr = (typeof globalThis !== 'undefined') && globalThis.__tileRenderer;
  if (!tr?.dynamicTallsAt && !tr?._dynamicTalls && !tr?.visuals) return false;
  const blocksAtZ = (t) => {
    if (!t || t.isTransparent) return false;
    const z = t.z | 0;
    const h = Math.max(t.height | 0, t.isWall ? 20 : 0, t.isRoof ? 6 : 0, t.isCeilingSurface ? 6 : 0);
    const top = z + h;
    const rayZ = (baseZ | 0) + 8;
    if (t.isWall) return z <= rayZ + 8 && top >= rayZ;
    if (t.isRoof || t.isCeilingSurface) return z >= (baseZ | 0) + 4;
    return h >= 8 && z <= rayZ + 8 && top >= rayZ;
  };
  // Check dynamic tall statics (placed multi components).
  const dynamicEntries = tr.dynamicTallsAt?.(x, y);
  if (dynamicEntries) {
    for (const t of dynamicEntries) {
      if (blocksAtZ(t)) return true;
    }
  } else if (tr._dynamicTalls) {
    for (const entries of tr._dynamicTalls.values()) {
      for (const t of entries) {
        if (t.x === x && t.y === y && blocksAtZ(t)) return true;
      }
    }
  }
  // Check chunk visuals' tall statics list (faster — already indexed
  // by chunk).
  if (tr.visuals) {
    const key = ((y >> 3) << 16) | ((x >> 3) & 0xffff);
    const vis = tr.visuals.get(key);
    const statics = vis?.tallStaticsAt?.(x, y) ?? vis?._tallStatics;
    if (statics) {
      for (const t of statics) {
        if (t.x === x && t.y === y && blocksAtZ(t)) return true;
      }
    }
  }
  return false;
}

export const lightPoints = new LightPoints();

// ---------------------------------------------------------------------------
// Light-source itemId table. Mirrors ClassicUO `Renderer/LightSource.cs`
// (which reads `tiledata.HasFlag(LightSource)` in the C# client). We keep
// the most common emitters as a runtime whitelist so torches/campfires/lava
// glow before we have a real tiledata light-flag pipeline. Each entry is
// `[itemId, radius, color]` — radius in tiles, color hex used additively.
const STATIC_LIGHTS = new Map([
  // Torches (wall + standing) — 0x0A0C..0x0A15 covers every torch
  // graphic ServUO ships (lit + unlit pairs).
  [0x0A0C, [4, 0xFFB060]], [0x0A0D, [4, 0xFFB060]], [0x0A0E, [4, 0xFFB060]],
  [0x0A0F, [4, 0xFFB060]], [0x0A10, [4, 0xFFB060]], [0x0A11, [4, 0xFFB060]],
  [0x0A12, [4, 0xFFB060]], [0x0A13, [4, 0xFFB060]],
  [0x0A14, [4, 0xFFB060]], [0x0A15, [4, 0xFFB060]],
  // Sconces / wall torches alt graphics
  [0x0E68, [4, 0xFFB060]], [0x0E69, [4, 0xFFB060]],
  // Standing lanterns / hand lanterns
  [0x0A18, [5, 0xFFD080]], [0x0A19, [5, 0xFFD080]],
  [0x0A1A, [5, 0xFFD080]], [0x0A1B, [5, 0xFFD080]],
  [0x0A1C, [5, 0xFFD080]], [0x0A1D, [5, 0xFFD080]],
  [0x0A22, [5, 0xFFD080]], [0x0A23, [5, 0xFFD080]],
  [0x0A24, [5, 0xFFD080]], [0x0A25, [5, 0xFFD080]],
  // Street lamps & wall lanterns — ServUO `Items/Lights/WallLantern.cs`
  // + `Items/Lights/StreetLight.cs`. User report 2026-05-18: "uliczne
  // latarnie nie dają światła". These IDs aren't in tiledata
  // FLAG_LIGHT_SRC either, so the auto cross-reference path misses
  // them. Curated whitelist below covers every common town-light
  // graphic plus the carpentry-craftable lamp posts.
  // Iron / brass wall lanterns (single-bulb).
  [0x0B1F, [5, 0xFFD080]], [0x0B20, [5, 0xFFD080]],
  [0x0B21, [5, 0xFFD080]], [0x0B22, [5, 0xFFD080]],
  [0x0B23, [5, 0xFFD080]], [0x0B24, [5, 0xFFD080]],
  [0x0B25, [5, 0xFFD080]], [0x0B26, [5, 0xFFD080]],
  // Gargoyle-style wall lanterns.
  [0x0E2D, [5, 0xFFD080]], [0x0E2E, [5, 0xFFD080]],
  [0x0E2F, [5, 0xFFD080]], [0x0E30, [5, 0xFFD080]],
  // Tall lamp posts (carpentry + town deco).
  [0x0B1A, [6, 0xFFD080]], [0x0B1B, [6, 0xFFD080]],
  [0x0B1C, [6, 0xFFD080]], [0x0B1D, [6, 0xFFD080]],
  [0x0B1E, [6, 0xFFD080]],
  [0x1853, [6, 0xFFD080]], [0x1854, [6, 0xFFD080]],
  [0x1855, [6, 0xFFD080]], [0x1856, [6, 0xFFD080]],
  [0x1857, [6, 0xFFD080]], [0x1858, [6, 0xFFD080]],
  // Wooden lamp posts.
  [0x0DCC, [6, 0xFFD080]], [0x0DCD, [6, 0xFFD080]],
  [0x0DCE, [6, 0xFFD080]], [0x0DCF, [6, 0xFFD080]],
  // Campfire
  [0x0DE3, [6, 0xFFA040]], [0x0DE4, [6, 0xFFA040]],
  // Candelabras / candle stands
  [0x0A26, [3, 0xFFE0A0]], [0x0A27, [3, 0xFFE0A0]],
  [0x0A28, [3, 0xFFE0A0]], [0x0A29, [3, 0xFFE0A0]],
  [0x0A2A, [2, 0xFFE0A0]], [0x0A2B, [2, 0xFFE0A0]],
  [0x0A2C, [2, 0xFFE0A0]], [0x0A2D, [2, 0xFFE0A0]],
  // Skull / Halloween lanterns
  [0x14F4, [4, 0xFFC060]], [0x14F5, [4, 0xFFC060]],
  // Fireplaces
  [0x097F, [5, 0xFFA040]], [0x0980, [5, 0xFFA040]],
  // Forge embers — Britain Royal Forge + every blacksmith forge tile.
  [0x0FB1, [4, 0xFF7030]], [0x0FB2, [4, 0xFF7030]],
  [0x197A, [4, 0xFF7030]], [0x197E, [4, 0xFF7030]],
  // Braziers (functional.js declares them as light sources).
  [0x0E31, [5, 0xFFB060]], [0x0E32, [5, 0xFFB060]],
  [0x0E33, [5, 0xFFB060]], [0x0E34, [5, 0xFFB060]],
  // Moongates / summoned gates — these are animated statics, but many
  // classic data sets do not tag them as LightSource. Give them a
  // coloured pulsing glow so public gates read like portals at night.
  [0x0F6C, [7, 0x70A4FF, 2, 'pulse']], // blue public moongate
  [0x0DDA, [7, 0xFF5868, 2, 'pulse']], // red public moongate
  [0x1FD4, [7, 0x7CA8FF, 2, 'pulse']], // Tokuno public moongate
  [0x1AF3, [7, 0x8CB4FF, 2, 'pulse']], // summon moongate
  [0x1FEB, [7, 0x8CB4FF, 2, 'pulse']], // summon moongate alt frame
]);

// Lava tile graphics — broader radius, deeper red.
for (let id = 0x1B7E; id <= 0x1B83; id++) STATIC_LIGHTS.set(id, [3, 0xFF5020]);
for (let id = 0x1F4E; id <= 0x1F50; id++) STATIC_LIGHTS.set(id, [3, 0xFF5020]);
for (let id = 0x12EE; id <= 0x134B; id++) STATIC_LIGHTS.set(id, [3, 0xFF5020, 2, 'flicker']);
for (let id = 0x1A19; id <= 0x1A75; id++) STATIC_LIGHTS.set(id, [3, 0xFF5020, 2, 'flicker']);

// Spell fields are server-created statics on many shards. They are also
// animated, so a low-radius coloured glow makes the field readable in
// dark dungeons without lighting the whole screen.
for (let id = 0x398C; id <= 0x399A; id++) STATIC_LIGHTS.set(id, [3, 0xFF6038, 2, 'flicker']);
STATIC_LIGHTS.set(0x3E27, [3, 0xFF6038, 2, 'flicker']);
STATIC_LIGHTS.set(0x3E31, [3, 0xFF6038, 2, 'flicker']);
for (let id = 0x3946; id <= 0x395A; id++) STATIC_LIGHTS.set(id, [3, 0x70A0FF, 2, 'pulse']);
for (let id = 0x3914; id <= 0x3924; id++) STATIC_LIGHTS.set(id, [3, 0x62D870, 2, 'pulse']);

function _dynamicLightParams(mode) {
  switch (mode) {
    case 'pulse':   return { pulse: 0.10, pulseSpeed: 0.0032 };
    case 'flicker': return { flicker: 0.055 };
    default:        return { flicker: 0.035 };
  }
}

function _staticLightSpecFromEntry(entry, fallbackMode = '') {
  const mode = entry[3] || fallbackMode;
  return {
    radius: entry[0],
    color: entry[1],
    peak: 31,
    lightIndex: entry[2] ?? 2,
    ..._dynamicLightParams(mode),
  };
}

// ---------------------------------------------------------------------------
// Audit rev.4 P2 — full light.mul integration.
//
// `STATIC_LIGHTS` above is a curated whitelist (~30 entries) for the most
// common torches/lanterns. The canonical UO database carries ~100 light
// emission masks in `light.mul`, indexed by `lightIndex` in `tiledata.mul`
// per static itemId (every item with `FLAG_LIGHT_SRC` carries a non-zero
// lightIndex pointing into light.mul).
//
// Strategy:
//   1. Fetch `/assets/lights.json` once at install — caches every entry as
//      `{ w, h, pixels }` (base64-encoded 0..31 intensity grid).
//   2. Build `STATIC_LIGHTS_FROM_TILEDATA: Map<itemId, [radius, color]>` by
//      walking `tiledata.json::statics` for FLAG_LIGHT_SRC (bit 27 of the
//      low 32 flags), reading `lightIndex`, and looking the entry up in
//      `lights.json`. Radius is derived from `max(w, h) / 2`.
//   3. Default color stays warm-amber until we tint per-emitter (lava /
//      forge keep their curated override above).
//
// All lookups still go through `staticLightSpec(itemId)` so call-sites in
// tile-renderer don't change. If neither lights.json nor tiledata.json is
// present (dev without extracted assets) the curated map is the fallback.

let _tiledataLightMap = null;

async function _loadTiledataLightMap() {
  if (_tiledataLightMap !== null) return _tiledataLightMap;
  _tiledataLightMap = new Map();
  try {
    const [lights, td] = await Promise.all([
      fetch('/assets/lights.json').then((r) => r.ok ? r.json() : null).catch(() => null),
      fetch('/assets/tiledata.json').then((r) => r.ok ? r.json() : null).catch(() => null),
    ]);
    if (!lights?.entries || !td?.statics) return _tiledataLightMap;
    // Audit #46 P1#1 — CUO `TileDataLoader.cs:505`
    // `LightSource = 0x00800000` (bit 23). Previous mask 0x4000_0000
    // matched nothing → cross-ref Map stayed empty, only the curated
    // ~30-entry `STATIC_LIGHTS` whitelist emitted light.
    const FLAG_LIGHT_SRC = 0x00800000;
    // Build a Pixi texture for every `light.mul` entry up front. We do
    // it inside this load because lights.json is what gives us the
    // pixel grids; tile-renderer queries `staticLightSpec()` at chunk
    // populate which now also returns `lightIndex` so `tick()` can
    // pick the right texture (or fall back to the radial gradient).
    const entries = lights.entries;
    for (const k of Object.keys(entries)) {
      const idx = k | 0;
      if (_lightTextures.has(idx)) continue;
      const tex = _buildLightTexture(entries[k]);
      if (tex) _lightTextures.set(idx, tex);
    }
    const measuredByLightIndex = new Map();
    for (let id = 0; id < td.statics.length; id++) {
      const s = td.statics[id];
      if (!s) continue;
      if (((s.flags | 0) & FLAG_LIGHT_SRC) === 0) continue;
      const li = s.lightIndex | 0;
      if (!li) continue;
      const e = lights.entries[li];
      if (!e || !e.w || !e.h) continue;
      // Audit #46 P2 — pixel-grid intensity. CUO `Lights.cs` scans the
      // emission mask to find the actual cutoff distance + peak
      // intensity, rather than treating each entry as a full radius
      // circle. We decode the base64 grid once per lightIndex and compute:
      //   radius = farthest non-zero pixel distance from center
      //   peak   = max intensity (0..31)
      let measured = measuredByLightIndex.get(li);
      if (!measured) {
        measured = measureLightGrid(e);
        measuredByLightIndex.set(li, measured);
      }
      const { radius, peak } = measured;
      // Default warm-amber for ambient torches; if curated map has an
      // override (e.g. lava red) we leave the curated entry in place.
      const spec = [radius, 0xFFC078, peak, li];
      if (!STATIC_LIGHTS.has(id)) {
        _tiledataLightMap.set(id, spec);
      }
      // Some extractor outputs keep only the global static slot
      // (local id + 0x4000). Mirror that entry to the local graphic id
      // only when the local slot is absent; otherwise we would turn
      // unrelated post-AOS global-art lights into classic local ids.
      const localId = id >= LAND_COUNT ? id - LAND_COUNT : id;
      if (localId !== id && !td.statics[localId] && !STATIC_LIGHTS.has(localId)) {
        _tiledataLightMap.set(localId, spec);
      }
    }
  } catch (e) { console.warn('[lights] tiledata link failed', e); }
  return _tiledataLightMap;
}

/** Decode base64 grid of 0..31 intensities into radius + peak.
 *  Returns `{ radius, peak }` with reasonable fallbacks when the
 *  payload is malformed. */
export function measureLightGrid(entry) {
  const fallback = { radius: Math.max(1, Math.round(Math.max(entry.w, entry.h) / 2)), peak: 31 };
  try {
    const buf = (typeof atob === 'function')
      ? Uint8Array.from(atob(entry.pixels), (c) => c.charCodeAt(0))
      : Buffer.from(entry.pixels, 'base64');
    if (!buf?.length) return fallback;
    const w = entry.w | 0;
    const h = entry.h | 0;
    const cx = w / 2, cy = h / 2;
    let radius = 0, peak = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = buf[y * w + x] | 0;
        if (!v) continue;
        if (v > peak) peak = v;
        const dx = x - cx, dy = y - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > radius) radius = d;
      }
    }
    if (!peak || !radius) return fallback;
    // Quantize radius to tiles (≈22 px per tile in iso). Light system
    // works in tile units, not pixels.
    const tileR = Math.max(1, Math.min(20, Math.round(radius / 11)));
    return { radius: tileR, peak };
  } catch { return fallback; }
}

// Kick the load on module evaluation — install() runs much later but the
// async fetch is cheap and the result is cached.
_loadTiledataLightMap();

/** Lookup helper for tile-renderer / mobile-renderer. Returns
 *  `{ radius, color }` or `null` for non-emitters. Order:
 *   1. Curated `STATIC_LIGHTS` (per-emitter color overrides — lava /
 *      forge / Halloween lanterns).
 *   2. `lights.json` × `tiledata.json` cross-reference (every static
 *      with FLAG_LIGHT_SRC). Default warm-amber color.
 *   3. null — non-emitter. */
export function staticLightSpec(itemId) {
  const e = STATIC_LIGHTS.get(itemId | 0);
  // ClassicUO `GameScene.AddLight` (lines 489-512) hardcodes lightIndex 2
  // for the canonical torch/lamp graphic ranges. We mirror that here so
  // curated entries pick a sensible light.mul shape — without a hint
  // they'd fall through to the radial-gradient fallback.
  if (e) return _staticLightSpecFromEntry(e);
  if (_tiledataLightMap) {
    const t = _tiledataLightMap.get(itemId | 0);
    if (t) {
      return {
        radius: t[0],
        color: t[1],
        peak: t[2] ?? 31,
        lightIndex: t[3] ?? 0,
        flicker: 0.025,
      };
    }
  }
  return null;
}

export function mobileEquipmentLightSpec(mob) {
  if (!mob?.equipment) return null;
  let best = null;
  for (const layer of HELD_LIGHT_LAYERS) {
    const eq = mob.equipment.get?.(layer);
    const spec = eq ? staticLightSpec(eq.itemId | 0) : null;
    if (!spec) continue;
    if (!best || (spec.radius | 0) > (best.radius | 0)) best = spec;
  }
  return best;
}
