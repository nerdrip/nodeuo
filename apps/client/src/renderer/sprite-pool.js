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

import { MeshSimple, Sprite, Texture } from 'pixi.js';

const DEFAULT_CAP = 4096;
const textureDescriptor = Object.getOwnPropertyDescriptor(Sprite.prototype, 'texture');

export function retainTexture(texture) {
  if (!texture || texture === Texture.EMPTY) return;
  texture._uoLiveSpriteRefs = ((texture._uoLiveSpriteRefs | 0) + 1) >>> 0;
}

export function releaseTexture(texture) {
  if (!texture || texture === Texture.EMPTY) return;
  texture._uoLiveSpriteRefs = Math.max(0, (texture._uoLiveSpriteRefs | 0) - 1);
  if (texture._uoLiveSpriteRefs === 0 && typeof texture._uoDisposeWhenUnused === 'function') {
    const dispose = texture._uoDisposeWhenUnused;
    texture._uoDisposeWhenUnused = null;
    dispose();
  }
}

/**
 * Return true only while `sp` still belongs to the caller that captured the
 * supplied generation. Pooled sprites deliberately survive `release()`, so
 * checking `destroyed` alone is not an ownership check: an old animation
 * registry can otherwise keep writing textures into a sprite that has since
 * been recycled as a paperdoll layer, house roof, or unrelated world item.
 */
export function spriteLeaseValid(sp, generation) {
  return !!sp
    && !sp.destroyed
    && sp._uoPoolActive === true
    && (sp._uoPoolGeneration >>> 0) === (generation >>> 0);
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
  constructor(cap = DEFAULT_CAP, reuseDelayMs = 80, now = () => performance.now()) {
    /** @type {{sprite: Sprite, reusableAt: number}[]} */
    this._free = [];
    this._cap = cap;
    this._reuseDelayMs = Math.max(0, Number(reuseDelayMs) || 0);
    this._now = typeof now === 'function' ? now : () => performance.now();
    this._activeCount = 0;
    this._reuseCount = 0;
    this._allocCount = 0;
  }

  /** Take a sprite, optionally pre-bound to `texture`. */
  acquire(texture) {
    const now = this._now();
    let sp = null;
    for (let i = this._free.length - 1; i >= 0; i--) {
      if (this._free[i].reusableAt > now) continue;
      sp = this._free[i].sprite;
      this._free[i] = this._free[this._free.length - 1];
      this._free.pop();
      break;
    }
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
    // Pixi render groups may still contain the old draw instruction until
    // the frame boundary.  Delayed reuse prevents a season remount from
    // turning a released tree/roof sprite into a screen-sized copy carrying
    // another static's texture and transform.
    this._free.push({ sprite: sp, reusableAt: this._now() + this._reuseDelayMs });
  }

  /** Drop the entire pool (test teardown / scene change). */
  destroyAll() {
    for (const { sprite: sp } of this._free) {
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

class LandMeshPool {
  constructor(cap = 2048, reuseDelayMs = 120, now = () => performance.now()) {
    this._free = [];
    this._cap = cap;
    this._reuseDelayMs = Math.max(0, Number(reuseDelayMs) || 0);
    this._now = typeof now === 'function' ? now : () => performance.now();
    this._active = 0;
    this._allocs = 0;
    this._reuses = 0;
  }
  acquire(texture, vertices, uvs, indices) {
    // A destroyed chunk can still have a Pixi render instruction queued for
    // the current frame.  Reusing its MeshSimple immediately (most visible
    // during a season/facet remount) lets that stale instruction observe the
    // new texture/geometry and produces screen-sized foliage/roof polygons.
    // Keep released meshes in a short quarantine spanning several frames.
    const now = this._now();
    let mesh = null;
    for (let i = this._free.length - 1; i >= 0; i--) {
      const entry = this._free[i];
      if (entry.reusableAt > now) continue;
      mesh = entry.mesh;
      this._free[i] = this._free[this._free.length - 1];
      this._free.pop();
      break;
    }
    if (!mesh) {
      mesh = new MeshSimple({ texture, vertices, uvs, indices });
      mesh._uoLandMeshPool = true; this._allocs++;
      retainTexture(texture);
    } else {
      this._reuses++;
      releaseTexture(mesh.texture); mesh.texture = texture; retainTexture(texture);
      // Keep Pixi's Buffer objects and their typed-array backing stores when
      // topology is unchanged.  Replacing `.data` while a pooled MeshSimple
      // still had a render instruction queued could leave the GPU reading
      // the previous allocation for one frame.  A mass remount (season/facet
      // change) then displayed a few land tiles as screen-sized polygons.
      // In-place copies are both cheaper and race-free; only replace when a
      // future topology genuinely changes the buffer length/type.
      const updateBuffer = (buffer, next) => {
        const current = buffer?.data;
        if (current?.constructor === next.constructor && current.length === next.length) {
          current.set(next);
        } else if (buffer) {
          buffer.data = next;
        }
        buffer?.update?.();
      };
      const positions = mesh.geometry.getBuffer('aPosition'); updateBuffer(positions, vertices);
      const uv = mesh.geometry.getBuffer('aUV'); updateBuffer(uv, uvs);
      // Most land meshes currently share one topology, but the renderer is
      // allowed to choose the smoother diagonal for a slope.  Leaving the
      // pooled mesh's old index buffer in place made a reused tile inherit
      // the previous tile's triangulation (and, after tessellation changes,
      // potentially an entirely different index count).
      const index = mesh.geometry.indexBuffer;
      if (index) updateBuffer(index, indices);
    }
    mesh.visible = true; mesh.alpha = 1; mesh.tint = 0xffffff; mesh.filters = null;
    mesh.position.set(0, 0); mesh.scale.set(1, 1); mesh.rotation = 0;
    mesh._uoLandMeshActive = true; this._active++;
    return mesh;
  }
  release(mesh) {
    if (!mesh?._uoLandMeshPool || !mesh._uoLandMeshActive || mesh.destroyed) return false;
    mesh._uoLandMeshActive = false; this._active = Math.max(0, this._active - 1);
    if (mesh.parent) { try { mesh.parent.removeChild(mesh); } catch {} }
    releaseTexture(mesh.texture); mesh.texture = Texture.EMPTY; mesh.visible = false; mesh.filters = null;
    if (this._free.length >= this._cap) {
      try { mesh.destroy(); } catch {}
    } else {
      this._free.push({ mesh, reusableAt: this._now() + this._reuseDelayMs });
    }
    return true;
  }
  stats() { return { free: this._free.length, active: this._active, cap: this._cap, allocs: this._allocs, reuses: this._reuses }; }
  destroyAll() { for (const { mesh } of this._free) try { mesh.destroy(); } catch {} this._free.length = 0; this._active = 0; }
}

export const landMeshPool = new LandMeshPool();
export { LandMeshPool };
export function acquireLandMesh(texture, vertices, uvs, indices) { return landMeshPool.acquire(texture, vertices, uvs, indices); }
export function releaseLandMesh(mesh) { return landMeshPool.release(mesh); }
