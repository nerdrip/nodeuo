// MinimapGump — small overhead-style overlay showing the player's
// surroundings. Mirrors ClassicUO's Game/UI/Gumps/MiniMapGump.cs (small
// variant). We use the radar-colours derived from the land-tile graphics:
// average each tile's pixels into one RGB and store it in a 1-pixel-per-tile
// minimap texture, then crop the visible window.
//
// Implementation strategy (PHASE 7 minimal):
//   - We don't have a pre-computed radar texture, so we sample by
//     rendering 64×64 nearby tiles as 1×1 pixels each and updating a
//     CPU buffer every few frames.
//   - The buffer is uploaded to a Pixi Texture and drawn inside the gump.

import { Texture, Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { world } from '../../world/world.js';
import { assets } from '../../assets/asset-manager.js';
import { packCanvasColor, packedLandRadarColor } from '../../shared/radar-color.js';
import { acquireUiSprite, releaseUiSprite } from '../../renderer/sprite-pool.js';

const RADIUS_TILES = 32;     // 64×64 tiles around the player
const PX_PER_TILE  = 2;      // each tile = 2px square (so map is 128×128)
const TILE_COUNT    = RADIUS_TILES * 2;
const SIZE_PX      = RADIUS_TILES * 2 * PX_PER_TILE;

function paintDot2(pixels, x, y, packed) {
  if (x < 0 || y < 0 || x + 1 >= SIZE_PX || y + 1 >= SIZE_PX) return;
  const row = y * SIZE_PX + x;
  pixels[row] = packed;
  pixels[row + 1] = packed;
  pixels[row + SIZE_PX] = packed;
  pixels[row + SIZE_PX + 1] = packed;
}

export class MinimapGump extends WindowGump {
  constructor() {
    super({ title: 'Minimap', width: SIZE_PX + 20, height: SIZE_PX + 38, x: window.innerWidth - SIZE_PX - 30, y: 60 });

    if (typeof OffscreenCanvas !== 'undefined') {
      this._canvas = new OffscreenCanvas(SIZE_PX, SIZE_PX);
    } else {
      this._canvas = document.createElement('canvas');
      this._canvas.width = SIZE_PX;
      this._canvas.height = SIZE_PX;
    }
    this._ctx = this._canvas.getContext('2d');
    this._img = this._ctx?.createImageData(SIZE_PX, SIZE_PX) ?? null;
    this._pixelsU32 = this._img ? new Uint32Array(this._img.data.buffer) : null;
    this._texture = Texture.from(this._canvas);
    this._sprite = acquireUiSprite(this._texture);
    this._sprite.position.set(10, 28);
    this.node.addChild(this._sprite);

    this._playerDot = new Graphics()
      .circle(0, 0, 2.5)
      .fill({ color: 0xffe680 });
    this._playerDot.position.set(10 + SIZE_PX / 2, 28 + SIZE_PX / 2);
    this.node.addChild(this._playerDot);

    this._lastRender = 0;
    this._terrainAge = Infinity;
    this._terrainMap = null;
    this._terrainCx = 0;
    this._terrainCy = 0;
    this._basePixels = null;
    this._terrainScratch = null;
    this._coordLbl = new Label('', { fontSize: 10, hue: 0xc0b890, stroke: false });
    this._coordLbl.setPosition(10, 28 + SIZE_PX + 2);
    this.add(this._coordLbl);
  }

  get type() { return 'minimap'; }

  dispose() {
    releaseUiSprite(this._sprite);
    this._sprite = null;
    super.dispose?.();
  }

  /** Called from GameScene.update with `dt` so we can throttle redraws. */
  tick(dt) {
    if (!world.player) return;
    this._lastRender += dt;
    this._terrainAge += dt;
    if (this._lastRender < 0.25) return; // 4 Hz
    this._lastRender = 0;
    const coord = `${world.player.x}, ${world.player.y}`;
    if (this._coordText !== coord) {
      this._coordText = coord;
      this._coordLbl.setText(coord);
    }
    this._render(this._terrainAge >= 2);
  }

  _render(forceTerrain = false) {
    if (!this._ctx || !world.player) return;
    const cx = world.player.x | 0, cy = world.player.y | 0;
    const map = world.player.map ?? world.mapId ?? 1;
    const mobileRev = world._mobileSpatialRevision ?? 0;
    const radarRev = assets.radarcol?.land?.length ?? 0;
    if (!forceTerrain
        && cx === this._lastFrameCx
        && cy === this._lastFrameCy
        && map === this._lastFrameMap
        && mobileRev === this._lastFrameMobileRev
        && radarRev === this._lastFrameRadarRev) return;
    this._lastFrameCx = cx;
    this._lastFrameCy = cy;
    this._lastFrameMap = map;
    this._lastFrameMobileRev = mobileRev;
    this._lastFrameRadarRev = radarRev;
    const img = this._img ?? (this._img = this._ctx.createImageData(SIZE_PX, SIZE_PX));
    const pixels = this._pixelsU32 ?? (this._pixelsU32 = new Uint32Array(img.data.buffer));
    if (!this._basePixels || this._basePixels.length !== pixels.length) {
      this._basePixels = new Uint32Array(pixels.length);
    }
    if (forceTerrain || this._terrainMap !== map) {
      this._paintFullTerrain(this._basePixels, cx, cy, map);
      this._terrainMap = map;
      this._terrainCx = cx;
      this._terrainCy = cy;
      this._terrainAge = 0;
    } else {
      const dx = cx - this._terrainCx;
      const dy = cy - this._terrainCy;
      if (dx !== 0 || dy !== 0) {
        if (Math.abs(dx) < TILE_COUNT && Math.abs(dy) < TILE_COUNT) {
          this._scrollTerrain(this._basePixels, dx, dy, cx, cy, map);
        } else {
          this._paintFullTerrain(this._basePixels, cx, cy, map);
        }
        this._terrainCx = cx;
        this._terrainCy = cy;
        this._terrainAge = 0;
      }
    }
    pixels.set(this._basePixels);
    // Mobile dots — CUO `MiniMapGump.cs` iterates `World.Mobiles` and
    // paints a 2×2 notoriety-coloured rect per nearby mob (player gold,
    // party blue, criminal grey, murderer red…). Without this the
    // minimap was just a terrain-radar with no situational awareness.
    const paintMobile = (m) => {
      if ((m.map ?? map) !== map) return;
      const dx = (m.x | 0) - cx;
      const dy = (m.y | 0) - cy;
      if (dx < -RADIUS_TILES || dx >= RADIUS_TILES) return;
      if (dy < -RADIUS_TILES || dy >= RADIUS_TILES) return;
      const px = (dx + RADIUS_TILES) * PX_PER_TILE;
      const py = (dy + RADIUS_TILES) * PX_PER_TILE;
      let color = NOTO_COLOR[m.notoriety ?? 1] ?? 0xc0c0c0;
      if (m.serial === world.player.serial) color = 0xffffff;
      else if (m._party) color = 0x80c0ff;
      paintDot2(pixels, px, py, packCanvasColor(color));
    };
    if (typeof world.forEachMobileNear === 'function') {
      world.forEachMobileNear(cx, cy, map, RADIUS_TILES, true, paintMobile);
    } else {
      const nearby = world.mobilesNear
        ? world.mobilesNear(cx, cy, map, RADIUS_TILES, true)
        : world.mobiles.values();
      for (const m of nearby) paintMobile(m);
    }
    this._ctx.putImageData(img, 0, 0);
    this._texture.source.update();
  }

  _paintFullTerrain(pixels, cx, cy, map) {
    for (let ly = 0; ly < TILE_COUNT; ly++) {
      for (let lx = 0; lx < TILE_COUNT; lx++) {
        this._paintTerrainTile(pixels, lx, ly, cx + lx - RADIUS_TILES, cy + ly - RADIUS_TILES, map);
      }
    }
  }

  _scrollTerrain(pixels, tileDx, tileDy, cx, cy, map) {
    const scratch = this._terrainScratch && this._terrainScratch.length === pixels.length
      ? this._terrainScratch
      : (this._terrainScratch = new Uint32Array(pixels.length));
    scratch.fill(0xff000000);
    const pxDx = tileDx * PX_PER_TILE;
    const pxDy = tileDy * PX_PER_TILE;
    const dstX0 = Math.max(0, -pxDx);
    const dstX1 = Math.min(SIZE_PX, SIZE_PX - pxDx);
    const copyW = dstX1 - dstX0;
    const srcX0 = dstX0 + pxDx;
    for (let y = 0; y < SIZE_PX; y++) {
      const sy = y + pxDy;
      if (sy < 0 || sy >= SIZE_PX) continue;
      if (copyW <= 0) continue;
      const dstRow = y * SIZE_PX;
      const srcRow = sy * SIZE_PX;
      scratch.set(
        pixels.subarray(srcRow + srcX0, srcRow + srcX0 + copyW),
        dstRow + dstX0,
      );
    }
    pixels.set(scratch);
    for (let ly = 0; ly < TILE_COUNT; ly++) {
      for (let lx = 0; lx < TILE_COUNT; lx++) {
        const oldLx = lx + tileDx;
        const oldLy = ly + tileDy;
        if (oldLx >= 0 && oldLx < TILE_COUNT && oldLy >= 0 && oldLy < TILE_COUNT) continue;
        this._paintTerrainTile(pixels, lx, ly, cx + lx - RADIUS_TILES, cy + ly - RADIUS_TILES, map);
      }
    }
  }

  _paintTerrainTile(pixels, lx, ly, tx, ty, map) {
    const land = assets.landAt(tx, ty, map);
    const packed = land ? packedLandRadarColor(land.id) : 0xff000000;
    const pxX = lx * PX_PER_TILE;
    const pxY = ly * PX_PER_TILE;
    paintDot2(pixels, pxX, pxY, packed);
  }
}

// Mirror health-bar-gump's notoriety palette so dots match the bar
// colours overhead — CUO `NotorietyFlag.cs::GetHue`.
const NOTO_COLOR = {
  1: 0x33ccff,   // innocent — cyan (post-2026-05-12 fix)
  2: 0x55ff55,   // ally — green
  3: 0xa0a0a0,   // grey
  4: 0xa0a0a0,   // criminal — grey
  5: 0xff8030,   // enemy — orange
  6: 0xff3030,   // murderer — red
  7: 0xffe060,   // invulnerable — yellow
};
