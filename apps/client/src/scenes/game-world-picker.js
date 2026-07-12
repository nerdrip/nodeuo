// Screen/world hit-testing for the in-game scene. This module deliberately
// owns no Pixi objects and mutates no world state: callers can reuse one
// picker for the lifetime of a scene and unit-test it with lightweight deps.

import { screenToWorld, worldToScreenX, worldToScreenY } from '../renderer/iso.js';
import { staticEntry } from '../shared/tiledata.js';

export class GameWorldPicker {
  constructor({ world, camera, assets, isMobileLayerReady = () => true }) {
    this.world = world;
    this.camera = camera;
    this.assets = assets;
    this.isMobileLayerReady = isMobileLayerReady;
  }

  pickTile(sx, sy) {
    const { world, camera, assets } = this;
    if (!world.player) return null;
    const zoom = camera.zoom || 1;
    const isoX = camera.cx + (sx - (camera.viewX + camera.viewW / 2)) / zoom;
    const isoY = camera.cy + (sy - (camera.viewY + camera.viewH / 2)) / zoom;
    let point = screenToWorld(isoX, isoY, world.player.z | 0);
    let x = Math.round(point.x);
    let y = Math.round(point.y);
    let land = assets.landAt(x, y);
    // One refinement with terrain elevation keeps drops and targeting
    // aligned on stairs and steep land without an iterative hot-path loop.
    point = screenToWorld(isoX, isoY, land?.z ?? 0);
    x = Math.round(point.x);
    y = Math.round(point.y);
    land = assets.landAt(x, y);
    return { x, y, z: land?.z ?? 0 };
  }

  worldScreenPoint(x, y, z = 0) {
    const { camera } = this;
    const zoom = camera.zoom || 1;
    return {
      x: camera.viewX + camera.viewW / 2 + (worldToScreenX(x, y) - camera.cx) * zoom,
      y: camera.viewY + camera.viewH / 2 + (worldToScreenY(x, y, z) - camera.cy) * zoom,
    };
  }

  playerScreenPoint() {
    const { world, camera } = this;
    const player = world.player;
    if (!player) {
      return { x: camera.viewX + camera.viewW / 2, y: camera.viewY + camera.viewH / 2 };
    }
    const point = this.worldScreenPoint(player.x, player.y, player.z);
    const zoom = camera.zoom || 1;
    point.x += (player.offsetX || 0) * zoom;
    point.y += ((player.offsetY || 0) - (player.offsetZ || 0) - 3) * zoom;
    return point;
  }

  pickItem(sx, sy) {
    const { world, camera, assets } = this;
    if (!world.player || !world.items) return null;
    const zoom = camera.zoom || 1;
    const toleranceX = Math.max(14, 22 * zoom);
    let best = null;
    const visit = (item) => {
      if ((item.parent && item.parent !== 0) || item.multiId) return undefined;
      const point = this.worldScreenPoint(item.x, item.y, item.z);
      const entry = staticEntry(assets.tiledata, item.itemId | 0);
      const spriteHeight = entry?.height ? Math.max(22, entry.height * 4 + 22) : 80;
      const dx = Math.abs(point.x - sx);
      const below = sy - point.y;
      const above = point.y - sy;
      if (dx > toleranceX || below > 8 || above > spriteHeight * zoom) return undefined;
      const distance = Math.abs(above);
      if (!best || distance < best.dist || (distance === best.dist && item.z > best.z)) {
        best = {
          serial: item.serial >>> 0,
          itemId: item.itemId | 0,
          hue: item.hue | 0,
          amount: item.amount | 0,
          movable: ((item.flags | 0) & 0x20) !== 0,
          x: item.x | 0,
          y: item.y | 0,
          z: item.z | 0,
          dist: distance,
        };
      }
      return undefined;
    };
    if (world.forEachItemNear) {
      world.forEachItemNear(
        world.player.x,
        world.player.y,
        world.player.map ?? world.mapId ?? 1,
        24,
        visit,
      );
    } else {
      const items = world.itemsNear
        ? world.itemsNear(world.player.x, world.player.y, world.player.map ?? world.mapId ?? 1, 24)
        : world.items.values();
      for (const item of items) visit(item);
    }
    return best;
  }

  pickStatic(sx, sy) {
    const { world, camera, assets } = this;
    if (!world.player) return null;
    const tile = this.pickTile(sx, sy);
    if (!tile) return null;
    const zoom = camera.zoom || 1;
    let best = null;
    // A 5x5 tile probe crosses at most four 8x8 map blocks in the common
    // case. Numeric chunk keys avoid transient strings on repeated targeting.
    const seenChunks = new Set();
    for (let y = tile.y - 2; y <= tile.y + 2; y++) {
      for (let x = tile.x - 2; x <= tile.x + 2; x++) {
        const chunkX = x >> 3;
        const chunkY = y >> 3;
        const chunkKey = (chunkY << 16) | (chunkX & 0xffff);
        if (seenChunks.has(chunkKey)) continue;
        seenChunks.add(chunkKey);
        const entries = assets.staticsAt?.(chunkX, chunkY) ?? [];
        for (const entry of entries) {
          const worldX = chunkX * 8 + (entry.x | 0);
          const worldY = chunkY * 8 + (entry.y | 0);
          if (Math.abs(worldX - tile.x) > 2 || Math.abs(worldY - tile.y) > 2) continue;
          const point = this.worldScreenPoint(worldX, worldY, entry.z | 0);
          const tiledata = staticEntry(assets.tiledata, entry.id | 0);
          const height = Math.max(22, (tiledata?.height ?? 14) * 4 + 22) * zoom;
          const dx = Math.abs(sx - point.x);
          const above = point.y - sy;
          if (dx > 22 * zoom || above < -7 * zoom || above > height) continue;
          const distance = dx + Math.max(0, above) * 0.35 - (entry.z | 0) * 0.02;
          if (!best || distance < best.dist) {
            best = {
              serial: 0,
              x: worldX,
              y: worldY,
              z: entry.z | 0,
              graphic: entry.id | 0,
              dist: distance,
            };
          }
        }
      }
    }
    if (!best) return null;
    const { dist: _distance, ...target } = best;
    return target;
  }

  pickEntity(sx, sy) {
    const { world, camera } = this;
    if (!world.player || !this.isMobileLayerReady()) return null;
    const zoom = camera.zoom || 1;
    const halfWidth = 18 * zoom;
    const height = 80 * zoom;
    const footPadding = 6 * zoom;
    let best = null;
    const visit = (mobile) => {
      const point = this.worldScreenPoint(mobile.x, mobile.y, mobile.z);
      if (Math.abs(point.x - sx) > halfWidth) return undefined;
      if (sy > point.y + footPadding || sy < point.y - height) return undefined;
      const distance = Math.abs(point.x - sx) + Math.abs(point.y - sy) * 0.5;
      if (!best || distance < best.dist) best = { serial: mobile.serial, dist: distance };
      return undefined;
    };
    if (world.forEachMobileNear) {
      world.forEachMobileNear(
        world.player.x,
        world.player.y,
        world.player.map ?? world.mapId ?? 1,
        24,
        true,
        visit,
      );
    } else {
      const nearby = world.mobilesNear
        ? world.mobilesNear(world.player.x, world.player.y, world.player.map ?? world.mapId ?? 1, 24, true)
        : world.mobiles.values();
      for (const mobile of nearby) visit(mobile);
    }
    return best;
  }
}
