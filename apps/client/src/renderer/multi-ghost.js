// Ghost preview for multi placement. While targetManager.multi is set,
// shows a semi-transparent rendering of the multi snapped to the world
// tile under the cursor. Mirrors ClassicUO's
// Game/UI/MultiTargetingControl.cs at MVP scope.

import { Container } from 'pixi.js';
import { worldToScreenX, worldToScreenY, depthKey, TILE_HALF_H, LAYER_STATIC } from './iso.js';
import { assets } from '../assets/asset-manager.js';
import { applyHueTo } from './hue-filter.js';
import { targetManager } from '../managers/target-manager.js';
import { targetCursor } from '../managers/target-cursor.js';
import { world } from '../world/world.js';
import { acquireSprite, releaseSprite } from './sprite-pool.js';

// CUO `Game/Managers/TargetManager.cs::IsMulti` tints each footprint
// tile by `worldMap.IsBuildable`. We approximate with land-flag +
// statics: a tile is unbuildable if any static on it is impassable
// and not a surface (wall, fence, tree), or if a non-movable item
// occupies it. ServUO's full house-placement check (terrain slope,
// guarded region, no-build flags) is server-side; here we just give
// a fast visual hint so the user can tell which corners will reject.
const FLAG_IMPASSABLE = 0x00000040;
const FLAG_SURFACE    = 0x00000200;

function tileBuildable(wx, wy, map = world.player?.map ?? world.mapId ?? 1) {
  const cx = wx >> 3, cy = wy >> 3;
  const statics = assets.staticsAt?.(cx, cy) ?? [];
  const lx = wx & 7, ly = wy & 7;
  for (const s of statics) {
    if (s.x !== lx || s.y !== ly) continue;
    const info = assets.tiledata?.statics?.[s.id | 0];
    if (!info) continue;
    const impassable = (info.flags & FLAG_IMPASSABLE) !== 0;
    const surface    = (info.flags & FLAG_SURFACE) !== 0;
    if (impassable && !surface) return false;
  }
  // Dynamic items: refuse if a non-movable item occupies the tile.
  if (world.forEachItemNear) {
    let blocked = false;
    world.forEachItemNear(wx, wy, map, 0, (it) => {
      if (it.movable !== false) return undefined;
      blocked = true;
      return false;
    });
    if (blocked) return false;
  } else if (world.itemsNear || world.itemsAt) {
    const nearby = world.itemsNear
      ? world.itemsNear(wx, wy, map, 0)
      : world.itemsAt(wx, wy, map, 0);
    for (const it of nearby) {
      if (it.movable === false) return false;
    }
  } else if (world.items) {
    for (const it of world.items.values()) {
      if (it.parent || it.x !== wx || it.y !== wy || (it.map ?? map) !== map) continue;
      if (it.movable === false) return false;
    }
  }
  return true;
}

export class MultiGhost {
  /** @param {import('pixi.js').Container} parent  the world layer */
  constructor(parent) {
    this.parent = parent;
    this.container = new Container();
    this.container.alpha = 0.55;
    this.container.zIndex = 900_000_000;
    this.parent.addChild(this.container);
    /** Last (multiId, wx, wy, wz) we mounted. */
    this._last = null;
    this._sprites = [];
    this._loadSeq = 0;
  }

  destroy() {
    this._clearSprites();
    this.container.destroy({ children: true });
  }

  _clearSprites() {
    this._loadSeq++;
    if (this._sprites.length === 0 && this.container.children.length === 0) return;
    for (const sp of this._sprites) releaseSprite(sp);
    this._sprites.length = 0;
    this.container.removeChildren();
  }

  /** Update the ghost based on the picked tile under the cursor. Pass
   *  null to hide. Idempotent — only re-mounts on actual changes. */
  async update(originTile) {
    if (!targetManager.multi || !originTile) {
      if (this._last !== null) this._clearSprites();
      this._last = null;
      return;
    }
    const m = targetManager.multi;
    const key = `${m.multiId}|${originTile.x}|${originTile.y}|${originTile.z}`;
    if (key === this._last) return;
    this._last = key;
    this._clearSprites();
    const seq = this._loadSeq;

    const tiles = assets.multiTiles(m.multiId);
    if (!tiles) return;
    // Audit #39 client P3 #12 — CUO `MultiTargetingControl.cs` tints
    // each tile green (placeable) or red (blocked). Was: uniform half-
    // alpha, so the user couldn't tell which corners would reject.
    // Audit #40 deferred #15 — also publish the overall validity to
    // `target-cursor` so the cursor caption recolours red when any
    // tile would reject (mirror CUO "TargetCursor.IsBuildable").
    let anyBlocked = false;
    for (const t of tiles) {
      if (!t.visible) continue;
      const wx = originTile.x + t.x;
      const wy = originTile.y + t.y;
      const wz = originTile.z + t.z;
      const tex = await assets.staticTexture(t.id);
      if (seq !== this._loadSeq) return;
      if (!tex) continue;
      const centerX = worldToScreenX(wx, wy);
      const centerY = worldToScreenY(wx, wy, wz);
      const sp = acquireSprite(tex);
      sp.anchor.set(0.5, 1);
      sp.position.set(centerX, centerY + TILE_HALF_H);
      sp.zIndex = depthKey(wx, wy, wz, LAYER_STATIC);
      // Validity tint takes priority over the multi's stored hue — the
      // user needs to see "can I place here?" more than the boat's
      // paint colour. Pixi v8 `tint` is a multiplicative shader uniform
      // so the silhouette + shading still read through.
      const buildable = tileBuildable(wx, wy, originTile.map ?? world.player?.map ?? world.mapId ?? 1);
      if (!buildable) anyBlocked = true;
      if (buildable && m.hue && assets.huesTexture && assets.huesMeta) {
        applyHueTo(sp, m.hue, 1, assets.huesTexture, assets.huesMeta.count);
      } else {
        sp.tint = buildable ? 0x80ff80 : 0xff5555;
      }
      this.container.addChild(sp);
      this._sprites.push(sp);
    }
    try { targetCursor.setPlacementValid(!anyBlocked); }
    catch { /* cursor not installed (boot ordering) */ }
  }
}
