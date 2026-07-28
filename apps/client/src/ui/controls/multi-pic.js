// NodeUO server-gump extension: compact isometric preview of a complete
// house/boat multi.  A multi is not an item graphic, so showing its first
// component with `tilepicfit` produced misleading candles, doors or single
// roof fragments in the Create catalogue.  This control projects every
// visible component into a small, bounded silhouette instead.

import { Graphics } from 'pixi.js';
import { Control } from '../control.js';
import { assets } from '../../assets/asset-manager.js';

const ROLE_COLORS = Object.freeze({
  roof: 0x9f5d42,
  wall: 0xd0bf8b,
  floor: 0x7e735e,
  door: 0x86522f,
  stair: 0xb7ad91,
  teleporter: 0xb167c7,
  misc: 0x91989b,
});

function tileColor(tile) {
  const role = assets.houseRole?.(tile.id | 0);
  if (role && ROLE_COLORS[role]) return ROLE_COLORS[role];
  const z = tile.z | 0;
  if (z >= 20) return ROLE_COLORS.roof;
  if (z >= 7) return ROLE_COLORS.wall;
  return ROLE_COLORS.floor;
}

export class MultiPic extends Control {
  constructor(multiId, { width = 64, height = 48 } = {}) {
    super();
    this.multiId = multiId | 0;
    this.width = Math.max(20, Math.min(256, width | 0));
    this.height = Math.max(16, Math.min(192, height | 0));
    this.acceptMouseInput = false;
    this._graphics = new Graphics();
    this.node.addChild(this._graphics);
    this._draw();
  }

  _draw() {
    const g = this._graphics;
    g.clear();
    const tiles = (assets.multiTiles(this.multiId) ?? [])
      .filter((tile) => tile && tile.visible !== false && (tile.id | 0) > 0)
      .map((tile) => ({
        tile,
        px: ((tile.x | 0) - (tile.y | 0)) * 2,
        py: ((tile.x | 0) + (tile.y | 0)) - (tile.z | 0) * 0.24,
      }))
      .sort((a, b) => ((a.tile.x | 0) + (a.tile.y | 0)) - ((b.tile.x | 0) + (b.tile.y | 0))
        || (a.tile.z | 0) - (b.tile.z | 0));

    if (tiles.length === 0) {
      g.roundRect(2, 2, this.width - 4, this.height - 4, 4)
        .fill({ color: 0x161616, alpha: 0.8 })
        .stroke({ width: 1, color: 0x806a38, alpha: 0.8 });
      g.moveTo(this.width * 0.3, this.height * 0.65)
        .lineTo(this.width * 0.5, this.height * 0.35)
        .lineTo(this.width * 0.7, this.height * 0.65)
        .stroke({ width: 2, color: 0x9b8650, alpha: 0.85 });
      return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const point of tiles) {
      minX = Math.min(minX, point.px - 2);
      maxX = Math.max(maxX, point.px + 2);
      minY = Math.min(minY, point.py - 1);
      maxY = Math.max(maxY, point.py + 2);
    }
    const sourceW = Math.max(1, maxX - minX);
    const sourceH = Math.max(1, maxY - minY);
    const pad = 3;
    const scale = Math.min(
      (this.width - pad * 2) / sourceW,
      (this.height - pad * 2) / sourceH,
    );
    const offsetX = pad + (this.width - pad * 2 - sourceW * scale) / 2 - minX * scale;
    const offsetY = pad + (this.height - pad * 2 - sourceH * scale) / 2 - minY * scale;
    const halfW = Math.max(0.7, 2 * scale);
    const halfH = Math.max(0.45, scale);

    for (const point of tiles) {
      const x = offsetX + point.px * scale;
      const y = offsetY + point.py * scale;
      g.poly([x, y - halfH, x + halfW, y, x, y + halfH, x - halfW, y], true)
        .fill({ color: tileColor(point.tile), alpha: 0.94 });
    }
  }
}
