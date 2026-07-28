// Paperdoll image composer for the admin panel.
//
// Reads the gump atlas pages (PNG) + manifest from the same folder Vite
// serves to the browser client (`apps/client/public/assets/`) and
// composites:
//   1. Body silhouette (gump 0x000C male / 0x000D female)
//   2. Each equipped layer's paperdoll gump, in CUO LayerOrder.
//
// Output: 260×437 PNG buffer the route hands back as `image/png`. The
// admin UI just `<img src="/api/mobiles/.../paperdoll">` and lets the
// browser cache it.
//
// Hue tinting is intentionally skipped here — the right tooling is the
// hue-filter shader the in-game client uses, which is a Pixi WebGL
// thing not available server-side. Showing the un-tinted base art is
// a "good enough" preview for an admin glance.

import sharp from './safe-sharp.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(HERE, '..', '..', '..', 'client', 'public', 'assets');

const W = 260;
const H = 437;

// CUO LayerOrder.cs — back-most first so foreground equipment overlays
// render on top of the body and earlier layers.
const LAYER_ORDER = [
  4,   // Pants
  5,   // Shirt
  3,   // Shoes
  17,  // Tunic / inner torso
  13,  // Torso (chest)
  18,  // Arms
  19,  // Bracelet (visible armor)
  20,  // Ring (skipped visually but kept for completeness)
  10,  // Skirt / Half-apron
  23,  // Outer torso (skirt)
  24,  // Outer legs
  16,  // Cloak
  6,   // Helm / hat
  9,   // Earrings
  12,  // Gloves
  22,  // Robe (overshirt)
  21,  // Backpack (always last visible: hangs at hip)
  2,   // Two-handed weapon
  1,   // One-handed weapon
];

/** @type {{ tiles: Record<string, {page:number,u:number,v:number,w:number,h:number}> } | null} */
let _gumpManifest = null;
/** Decoded/cropped gump PNG promises. Bounds repeated Sharp work when an
 * operator flips through many mobiles wearing the same common equipment. */
const _tileCache = new Map();
const TILE_CACHE_MAX = 256;

function loadGumpManifest() {
  if (_gumpManifest) return _gumpManifest;
  // Extractor names the manifest `gump-atlas.json` (singular); pages
  // are `gump-atlas-NNN.png`. The plural form was a typo in the
  // first paperdoll draft and made every preview return 500.
  const file = path.join(ASSETS_DIR, 'gump-atlas.json');
  if (!fs.existsSync(file)) {
    throw new Error(`gump-atlas.json not found at ${file} — run extract-assets first`);
  }
  _gumpManifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  return _gumpManifest;
}

export async function extractGumpTile(gumpId) {
  if (_tileCache.has(gumpId)) return _tileCache.get(gumpId);
  const pending = extractGumpTileUncached(gumpId);
  _tileCache.set(gumpId, pending);
  if (_tileCache.size > TILE_CACHE_MAX) _tileCache.delete(_tileCache.keys().next().value);
  try { return await pending; }
  catch (error) { _tileCache.delete(gumpId); throw error; }
}

async function extractGumpTileUncached(gumpId) {
  const m = loadGumpManifest();
  // tiles is an object keyed by stringified decimal id ("12" for 0x000C).
  const tile = m.tiles?.[String(gumpId)] ?? m.tiles?.[gumpId];
  if (!tile) return null;
  // Pages: gump-atlas-NNN.png (3-digit zero-pad to match extractor).
  const pagePath = path.join(ASSETS_DIR, `gump-atlas-${String(tile.page).padStart(3, '0')}.png`);
  if (!fs.existsSync(pagePath)) return null;
  // Re-create the sharp instance per-extract — sharp pipelines are
  // single-use and throw "extract_already_set" on second use.
  return sharp(pagePath).extract({
    left: tile.u, top: tile.v, width: tile.w, height: tile.h,
  }).png().toBuffer();
}

/** Map (body, itemId) → paperdoll gump id. Mirrors client `resolveEquipGumpId`
 *  in `apps/client/src/ui/gumps/paperdoll-gump.js`. Without UO equipconv
 *  hooked here we use the canonical itemId+50000 (male) / +60000 (female)
 *  fallback only. Most clothing ids map cleanly that way. */
function pickEquipGumpId(itemId, isFemale) {
  if (!itemId) return 0;
  const base = isFemale ? 60000 : 50000;
  return itemId + base;
}

/**
 * Compose a paperdoll PNG for a mobile. Returns a Buffer.
 * @param {*} world
 * @param {*} mob
 */
export async function composePaperdoll(world, mob) {
  const isFemale = mob.body === 0x191 || mob.body === 0x193 || mob.sex === 1;
  // Background — a parchment plate so the silhouette has context.
  let canvas = sharp({
    create: { width: W, height: H, channels: 4, background: { r: 38, g: 26, b: 14, alpha: 1 } },
  });
  /** @type {{ input: Buffer, top: number, left: number }[]} */
  const composites = [];

  // Body silhouette.
  const bodyGumpId = isFemale ? 0x000D : 0x000C;
  const bodyTile = await extractGumpTile(bodyGumpId);
  if (bodyTile) composites.push({ input: bodyTile, top: 19, left: 8 });

  // Walk equipped layers in CUO order.
  /** @type {Map<number, { itemId:number, hue:number }>} */
  const byLayer = new Map();
  const indexed = world?._childrenByParent?.get?.(mob.serial);
  const equipped = indexed
    ? Array.from(indexed, (serial) => world.items.get(serial)).filter(Boolean)
    : (world?.items?.values?.() ?? []);
  for (const it of equipped) {
    if (it.parent !== mob.serial) continue;
    if ((it.layer ?? 0) === 0) continue;
    byLayer.set(it.layer | 0, { itemId: it.itemId, hue: it.hue });
  }
  for (const layer of LAYER_ORDER) {
    const eq = byLayer.get(layer);
    if (!eq) continue;
    const gumpId = pickEquipGumpId(eq.itemId, isFemale);
    const tile = await extractGumpTile(gumpId);
    if (tile) composites.push({ input: tile, top: 19, left: 8 });
  }

  if (composites.length) canvas = canvas.composite(composites);
  return canvas.png().toBuffer();
}
