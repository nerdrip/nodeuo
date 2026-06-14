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

import { Sprite } from 'pixi.js';

const DEFAULT_CAP = 4096;

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
      sp.filters = null;
      sp.tint = 0xFFFFFF;
      sp.blendMode = 'normal';
      sp.zIndex = 0;
      // Anchor reset to default (0,0). Callers that need a custom anchor
      // set it explicitly after acquire (matches `new Sprite()` semantics).
      sp.anchor.set(0, 0);
      sp.position.set(0, 0);
      if (texture) sp.texture = texture;
    } else {
      this._allocCount++;
      sp = new Sprite(texture);
    }
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
    this._activeCount = Math.max(0, this._activeCount - 1);
    if (sp.parent) {
      try { sp.parent.removeChild(sp); } catch { /* ignore */ }
    }
    sp.visible = false;
    sp.filters = null;
    // Keep the texture pointer alive — atlas Texture instances are shared
    // across many sprites, releasing the pointer doesn't help.
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
