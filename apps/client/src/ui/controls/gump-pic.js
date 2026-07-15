// GumpPic — a textured rectangle pulled from gump.mul. Mirrors ClassicUO's
// Game/UI/Controls/GumpPic.cs.
//
// Real sprite data comes from `assets.gumpTexture(id)` once the asset
// pipeline has loaded. Until then (or for ids that aren't in the atlas)
// we fall back to a hash-coloured rectangle so the gump still has a
// visible shape.

import { Texture, Rectangle } from 'pixi.js';
import { Control } from '../control.js';
import { assets } from '../../assets/asset-manager.js';
import { applyHueTo } from '../../renderer/hue-filter.js';
import { createShimmer } from '../loading-shimmer.js';
import { acquireSprite, releaseSprite } from '../../renderer/sprite-pool.js';

function canvasSourceFromTexture(tex) {
  const src = tex?.source?.resource ?? tex?.source ?? tex?.baseTexture?.resource;
  const candidates = [
    src,
    src?.source,
    src?.resource,
    src?.image,
    src?.canvas,
    src?.bitmap,
    src?.texture?.source?.resource,
  ];
  for (const img of candidates) {
    if (!img) continue;
    if (typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement) return img;
    if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) return img;
    if (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement) return img;
    if (typeof OffscreenCanvas !== 'undefined' && img instanceof OffscreenCanvas) return img;
    if (img.width > 0 && img.height > 0 && (img.tagName === 'IMG' || img.getContext || img.close)) return img;
  }
  return null;
}

function pngFallbackUrlForTexture(tex) {
  const url = tex?._uoAtlasPageUrl;
  if (!url) return null;
  const s = String(url);
  if (s.endsWith('.ktx2')) return s.replace(/\.ktx2$/i, '.png');
  if (s.endsWith('.png')) return s;
  return null;
}

export class GumpPic extends Control {
  constructor(gumpId, opts = {}) {
    const { hue = 0, width = 32, height = 32,
            srcX = 0, srcY = 0, srcW = 0, srcH = 0 } = opts;
    super();
    this.gumpId = gumpId | 0;
    this.hue = hue | 0;
    this.tint = 0xffffff;
    this.width = width;
    this.height = height;
    // Do not infer "auto size" from the numeric value 32x32. A large
    // number of controls deliberately request exactly 32x32 (action-bar
    // slots, spell icons, buttons). The old value-based check expanded
    // those controls to the source texture's natural dimensions after an
    // asynchronous atlas load, which made gumps appear to change to random
    // sizes. Track whether the caller supplied a size instead.
    this._explicitSize = Object.prototype.hasOwnProperty.call(opts, 'width')
      || Object.prototype.hasOwnProperty.call(opts, 'height');
    // PicInPic crop window. (0,0,0,0) means "use full sprite".
    this._srcX = srcX | 0;
    this._srcY = srcY | 0;
    this._srcW = srcW | 0;
    this._srcH = srcH | 0;
    /** @type {Sprite | null} the textured sprite, when the atlas resolves */
    this._sprite = null;
    /** Gray-silver shimmer placeholder shown while the atlas page loads.
     *  Replaces the per-id hash-coloured rect — the rainbow of bright
     *  fillers used to read as "broken UI" rather than "loading". */
    this._shimmer = createShimmer(this.width, this.height);
    this.node.addChild(this._shimmer.gfx);
    this._mountTexture();
  }

  setSize(w, h) {
    this._explicitSize = true;
    super.setSize(w, h);
    if (this._sprite) {
      this._sprite.width  = w;
      this._sprite.height = h;
    } else {
      this._shimmer?.resize(w, h);
    }
  }

  /** Enable canvas-2d alpha hit-testing — clicks fall through to the
   *  gump beneath when our texture is transparent at the click point.
   *  Mirrors CUO's `Arts.PixelCheck`. Used by the paperdoll so the
   *  full-body backpack overlay (260×237 sprite, mostly empty) doesn't
   *  steal clicks targeted at the body silhouette below. */
  enablePixelCheck() { this._pixelCheck = true; }

  hitTest(lx, ly) {
    if (!super.hitTest(lx, ly)) return false;
    if (!this._pixelCheck) return true;
    // Pixel-checked controls are deliberately sparse overlays
    // (paperdoll equipment is the big one). Treating a loading or
    // missing texture as opaque lets invisible placeholders steal
    // double-clicks from real controls beneath them; that is how the
    // paperdoll backpack could open when the user clicked a spellbook.
    if (!this._tex) return false;
    return this._sampleAlpha(lx, ly) > 8;
  }

  /** Build a cached alpha slab for pixel-checked gumps. Pixi v8 may
   *  back atlas pages with a KTX2 texture source that cannot be drawn
   *  into canvas; in that case we asynchronously load the PNG fallback
   *  only for hit-testing. Until the slab is ready, sparse overlays are
   *  treated as transparent so they cannot steal paperdoll clicks. */
  _ensureAlphaData() {
    if (this._pxData || this._pxLoading || this._pxFailed || typeof document === 'undefined') return;
    const tex = this._tex;
    const frame = tex?.frame ?? tex?._frame;
    if (!tex || !frame) return;
    const paint = (img) => {
      try {
        const cv = document.createElement('canvas');
        cv.width = frame.width; cv.height = frame.height;
        cv.getContext('2d').drawImage(img, frame.x, frame.y, frame.width, frame.height,
                                            0, 0, frame.width, frame.height);
        this._pxCanvas = cv;
        this._pxData = cv.getContext('2d').getImageData(0, 0, frame.width, frame.height).data;
        this._invalidateUiPickCache();
        return true;
      } catch {
        return false;
      }
    };
    const img = canvasSourceFromTexture(tex);
    if (img && paint(img)) return;
    const fallbackUrl = pngFallbackUrlForTexture(tex);
    if (fallbackUrl && typeof Image !== 'undefined') {
      const generation = this.captureAsyncGeneration();
      this._pxLoading = true;
      const png = new Image();
      png.decoding = 'async';
      png.onload = () => {
        if (!this.asyncGenerationValid(generation)) return;
        this._pxLoading = false;
        if (!paint(png)) this._pxFailed = true;
      };
      png.onerror = () => { if (this.asyncGenerationValid(generation)) { this._pxLoading = false; this._pxFailed = true; } };
      png.src = fallbackUrl;
      return;
    }
    this._pxFailed = true;
  }

  /** Read a single pixel's alpha from the gump texture. Lazy-builds a
   *  cached canvas-2d copy of the source page so subsequent samples
   *  are O(1). */
  _sampleAlpha(lx, ly) {
    this._ensureAlphaData();
    const tex = this._tex;
    const frame = tex?.frame ?? tex?._frame;
    if (!frame || !this._pxData) return 0;
    // Map control-local → texture-local. The sprite stretches the
    // texture to (this.width × this.height); convert proportionally.
    const tx = Math.floor((lx / this.width)  * frame.width);
    const ty = Math.floor((ly / this.height) * frame.height);
    if (tx < 0 || ty < 0 || tx >= frame.width || ty >= frame.height) return 0;
    return this._pxData[(ty * frame.width + tx) * 4 + 3];
  }

  setHue(h) {
    this.hue = h | 0;
    if (this._sprite && assets.huesTexture && assets.huesMeta) {
      applyHueTo(this._sprite, this.hue, this.hue ? 1 : 0, assets.huesTexture, assets.huesMeta.count);
    }
  }

  setTint(t) {
    const rgb = ((typeof t === 'number' ? t : 0xffffff) & 0xffffff) >>> 0;
    if (rgb === this.tint) return;
    this.tint = rgb;
    if (this._sprite) this._sprite.tint = rgb;
  }

  async _mountTexture() {
    const generation = this.captureAsyncGeneration();
    const loaded = await assets.gumpTexture(this.gumpId);
    if (!this.asyncGenerationValid(generation)) return;
    const tex = loaded ?? assets.placeholderTexture('gump', this.width || 32, this.height || 32);
    this._tex = loaded ?? null;
    this._pxCanvas = null;
    this._pxData = null;
    this._pxLoading = false;
    this._pxFailed = false;
    // PicInPic: build a sub-texture that maps only the requested (sx, sy,
    // srcW, srcH) rect from the source atlas. Mirrors ClassicUO
    // `GumpPicInPic` which uses `Renderer.DrawSpritePartial`. Without the
    // crop, quest-progress / arena scoreboard / BOD windows displayed
    // the full sprite stretched to the requested box.
    let useTex = tex;
    if (loaded && this._srcW > 0 && this._srcH > 0) {
      try {
        const baseFrame = tex.frame ?? tex._frame;
        const fx = (baseFrame?.x ?? 0) + this._srcX;
        const fy = (baseFrame?.y ?? 0) + this._srcY;
        useTex = new Texture({
          source: tex.source,
          frame: new Rectangle(fx, fy, this._srcW, this._srcH),
        });
        useTex._uoAtlasPageUrl = tex._uoAtlasPageUrl;
        useTex._uoAtlasPageKind = tex._uoAtlasPageKind;
        useTex._uoAtlasPageKey = tex._uoAtlasPageKey;
      } catch {
        useTex = tex;            // PixiJS version mismatch — fall back
      }
    }
    this._sprite = acquireSprite(useTex);
    this._sprite._uoMissingAsset = !loaded ? { kind: 'gump', id: this.gumpId } : null;
    this._sprite.position.set(0, 0);
    this._sprite.tint = this.tint;
    // If the user gave explicit dimensions, stretch to them; otherwise use
    // the sprite's natural size and update bounds so hit-test matches.
    if (!this._explicitSize) {
      this.width  = useTex.width;
      this.height = useTex.height;
    } else {
      this._sprite.width  = this.width;
      this._sprite.height = this.height;
    }
    if (this.hue && assets.huesTexture && assets.huesMeta) {
      applyHueTo(this._sprite, this.hue, 1, assets.huesTexture, assets.huesMeta.count);
    }
    this.node.addChild(this._sprite);
    this._shimmer?.dispose();
    this._shimmer = null;
    this.onResize?.();
  }

  dispose() {
    if (this._sprite) releaseSprite(this._sprite);
    this._sprite = null;
    this._shimmer?.dispose();
    this._shimmer = null;
    super.dispose();
  }
}
