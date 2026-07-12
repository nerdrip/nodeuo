// Sprite pool — reuse Pixi Sprite instances instead of creating/destroying
// one per land tile / static / item / corpse. The hot path in
// tile-renderer mounts hundreds of sprites per chunk, and a player walking
// across the world creates and destroys thousands per minute. Each
// `new Sprite()` allocates ~12 small JS objects (attachInfo, transform,
// _bounds, etc) and `sp.destroy()` releases them, all going through the
// V8 heap and triggering minor GCs every few seconds.
//
// The pool keeps a free-list of recycled sprites. `acquire(texture)`
// returns one (re-bound to the new texture, position-reset, filters cleared).
// `release(sp)` puts it back. `destroyAll()` drops the pool (e.g. on
// scene teardown) so V-RAM textures can be GC'd.
//
// Cap: 4096. If the free-list overflows, the excess is destroyed to keep
// memory bounded — but in practice steady-state traffic stays well under
// the cap (typical chunk 64 tiles × ~20 chunks = 1280 sprites).
//
// Why not in tile-renderer.js? Several call-sites use sprites (chunk
// land/static, chunk items, mobile renderer in some flows). A standalone
// module keeps the policy consistent across all of them.

import { Sprite, Texture } from 'pixi.js';

const DEFAULT_CAP = 4096;
const textureDescriptor = Object.getOwnPropertyDescriptor(Sprite.prototype, 'texture');

function retainTexture(texture) {
  if (!texture || texture === Texture.EMPTY) return;
  texture._uoLiveSpriteRefs = ((texture._uoLiveSpriteRefs | 0) + 1) >>> 0;
}

function releaseTexture(texture) {
  if (!texture || texture === Texture.EMPTY) return;
  texture._uoLiveSpriteRefs = Math.max(0, (texture._uoLiveSpriteRefs | 0) - 1);
  if (texture._uoLiveSpriteRefs === 0 && typeof texture._uoDisposeWhenUnused === 'function') {
    const dispose = texture._uoDisposeWhenUnused;
    texture._uoDisposeWhenUnused = null;
    dispose();
  }
}

/**
 * Pixi does not retain-count Texture objects. Cache eviction used to call
 * `texture.destroy(false)` while a visible Sprite still pointed at that
 * sub-texture, blanking paperdolls, worn equipment and world items at
 * random. Install an instance-level proxy on pooled sprites so every later
 * `sprite.texture = next` assignment is tracked too (animation hot paths
 * swap textures directly instead of going through the pool).
 */
function installTrackedTexture(sp) {
  if (sp._uoTextureTracked || !textureDescriptor?.get || !textureDescriptor?.set) return;
  Object.defineProperty(sp, 'texture', {
    configurable: true,
    enumerable: true,
    get() { return textureDescriptor.get.call(this); },
    set(next) {
      const prev = textureDescriptor.get.call(this);
      const value = next ?? Texture.EMPTY;
      if (prev === value) return;
      textureDescriptor.set.call(this, value);
      retainTexture(value);
      releaseTexture(prev);
    },
  });
  sp._uoTextureTracked = true;
  // The constructor assigned the initial texture before the proxy existed.
  retainTexture(textureDescriptor.get.call(sp));
}

class SpritePool {
  constructor(cap = DEFAULT_CAP) {
    /** @type {Sprite[]} */
    this._free = [];
    this._cap = cap;
    this._activeCount = 0;
    this._reuseCount = 0;
    this._allocCount = 0;
  }

  /** Take a sprite, optionally pre-bound to `texture`. */
  acquire(texture) {
    let sp = this._free.pop();
    if (sp) {
      this._reuseCount++;
      sp.visible = true;
      sp.alpha = 1;
      sp.rotation = 0;
      sp.scale.set(1, 1);
      sp.pivot.set(0, 0);
      sp.skew.set(0, 0);
      sp.filters = null;
      sp.tint = 0xFFFFFF;
      sp.blendMode = 'normal';
      sp.zIndex = 0;
      sp.eventMode = undefined;
      sp.cursor = undefined;
      sp.hitArea = null;
      sp.mask = null;
      // Anchor reset to default (0,0). Callers that need a custom anchor
      // set it explicitly after acquire (matches `new Sprite()` semantics).
      sp.anchor.set(0, 0);
      sp.position.set(0, 0);
      sp.texture = texture ?? Texture.EMPTY;
    } else {
      this._allocCount++;
      sp = new Sprite(texture ?? Texture.EMPTY);
      installTrackedTexture(sp);
      sp._uoPoolGeneration = 0;
    }
    sp._uoPoolGeneration = ((sp._uoPoolGeneration | 0) + 1) >>> 0;
    sp._uoPoolActive = true;
    this._activeCount++;
    return sp;
  }

  /**
   * Return a sprite to the pool. Detaches it from any parent and clears
   * filters but does NOT destroy the underlying GPU texture (callers
   * keep ownership of the cached atlas pages).
   *
   * Caller should ensure the sprite is removed from its container first
   * (`parent.removeChild(sp)`) — we don't traverse the scene graph.
   */
  release(sp) {
    if (!sp) return;
    if (sp.destroyed) return;
    if (!sp._uoPoolActive) return;
    sp._uoPoolActive = false;
    // Invalidate outstanding requestAnimationFrame callbacks (spawn shimmer,
    // door swing, mount fade) before this object can be reused elsewhere.
    sp._uoPoolGeneration = ((sp._uoPoolGeneration | 0) + 1) >>> 0;
    this._activeCount = Math.max(0, this._activeCount - 1);
    if (sp.parent) {
      try { sp.parent.removeChild(sp); } catch { /* ignore */ }
    }
    sp.visible = false;
    sp.filters = null;
    // Release the live texture reference immediately. Keeping it on free
    // sprites made every once-visible atlas page look permanently active.
    sp.texture = Texture.EMPTY;
    if (this._free.length >= this._cap) {
      // Pool is full — destroy the surplus rather than leak.
      try { sp.destroy(); } catch { /* ignore */ }
      return;
    }
    this._free.push(sp);
  }

  /** Drop the entire pool (test teardown / scene change). */
  destroyAll() {
    for (const sp of this._free) {
      try { sp.destroy(); } catch { /* ignore */ }
    }
    this._free.length = 0;
    this._activeCount = 0;
  }

  stats() {
    return {
      free: this._free.length,
      active: this._activeCount,
      cap: this._cap,
      allocs: this._allocCount,
      reuses: this._reuseCount,
    };
  }
}

// Module-level singleton — most callers want the global pool. Tests can
// instantiate their own SpritePool() if they need isolation.
export const spritePool = new SpritePool();
export { SpritePool };

/** Convenience: replace `new Sprite(tex)` everywhere with `acquireSprite(tex)`. */
export function acquireSprite(texture) { return spritePool.acquire(texture); }

/** Convenience: replace `sp.destroy()` everywhere with `releaseSprite(sp)`. */
export function releaseSprite(sp) { spritePool.release(sp); }
