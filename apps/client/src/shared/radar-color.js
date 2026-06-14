import { assets } from '../assets/asset-manager.js';

let _paletteRef = null;
const _rgbCache = new Map();
const _packedCache = new Map();

function syncPaletteCache() {
  const palette = assets.radarcol?.land ?? null;
  if (palette === _paletteRef) return;
  _paletteRef = palette;
  _rgbCache.clear();
  _packedCache.clear();
}

export function packCanvasColor(color) {
  return 0xff000000 | ((color & 0xff) << 16) | (color & 0x00ff00) | ((color >>> 16) & 0xff);
}

/** Resolve a land tile id to the canonical radar RGB, with the same
 * fallback palette the world map and minimap historically used. */
export function landRadarColor(landId) {
  const id = landId | 0;
  syncPaletteCache();
  const cached = _rgbCache.get(id);
  if (cached !== undefined) return cached;

  let rgb;
  const palette = _paletteRef;
  if (palette && id >= 0 && id < palette.length && palette[id] !== undefined) {
    rgb = palette[id] | 0;
  } else if (id === 0xA8) {
    rgb = 0x143a5a;
  } else if (id === 0x03) {
    rgb = 0x1c4a22;
  } else if (id >= 0xC0 && id < 0xE0) {
    rgb = 0x4d3a20;
  } else if (id >= 0x21B && id < 0x230) {
    rgb = 0x5e5b54;
  } else if (id === 0) {
    rgb = 0x000000;
  } else {
    const h = ((id * 0x9E3779B1) ^ (id << 5)) >>> 0;
    rgb = ((h & 0x7f) + 0x40) << 16
      | (((h >>> 8) & 0x7f) + 0x60) << 8
      | (((h >>> 16) & 0x7f) + 0x40);
  }
  _rgbCache.set(id, rgb);
  return rgb;
}

export function packedLandRadarColor(landId) {
  const id = landId | 0;
  syncPaletteCache();
  const cached = _packedCache.get(id);
  if (cached !== undefined) return cached;
  const packed = packCanvasColor(landRadarColor(id));
  _packedCache.set(id, packed);
  return packed;
}
