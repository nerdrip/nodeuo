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
let _tiledata = null;
let _mobileManifest = null;
/** Decoded/cropped gump PNG promises. Bounds repeated Sharp work when an
 * operator flips through many mobiles wearing the same common equipment. */
const _tileCache = new Map();
const TILE_CACHE_MAX = 256;

function customGump(gumpId) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, 'asset-overrides.json'), 'utf8'))?.gump?.[String(gumpId)];
    const relative = typeof value === 'string' ? value : value?.file;
    if (!relative || relative.includes('..')) return null;
    const file = path.resolve(ASSETS_DIR, relative);
    if (!file.startsWith(`${ASSETS_DIR}${path.sep}`) || !fs.existsSync(file)) return null;
    return { file, mtime: Math.trunc(fs.statSync(file).mtimeMs) };
  } catch { return null; }
}

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

function loadEquipmentMetadata() {
  _tiledata ||= JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, 'tiledata.json'), 'utf8'));
  if (!_mobileManifest) {
    const index = path.join(ASSETS_DIR, 'mobiles-atlas-index.json');
    const legacy = path.join(ASSETS_DIR, 'mobiles-atlas.json');
    _mobileManifest = JSON.parse(fs.readFileSync(fs.existsSync(index) ? index : legacy, 'utf8'));
  }
  return { tiledata: _tiledata, mobiles: _mobileManifest };
}

export async function extractGumpTile(gumpId) {
  const custom = customGump(gumpId);
  const key = `${gumpId}:${custom?.mtime ?? 'native'}`;
  if (_tileCache.has(key)) return _tileCache.get(key);
  const pending = extractGumpTileUncached(gumpId, custom);
  _tileCache.set(key, pending);
  if (_tileCache.size > TILE_CACHE_MAX) _tileCache.delete(_tileCache.keys().next().value);
  try { return await pending; }
  catch (error) { _tileCache.delete(key); throw error; }
}

async function extractGumpTileUncached(gumpId, custom) {
  if (custom) return sharp(custom.file).png().toBuffer();
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

/** Map definition-owned appearance → paperdoll gump. This mirrors the client:
 * explicit definition IDs first, then EquipConv, then tiledata.animId. */
function pickEquipGumpId(item, isFemale, body) {
  const explicit = Number(isFemale
    ? (item.paperdollFemaleGumpId ?? item.paperdollGumpId ?? item.paperdollMaleGumpId)
    : (item.paperdollMaleGumpId ?? item.paperdollGumpId ?? item.paperdollFemaleGumpId));
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const itemId = item.itemId | 0;
  if (!itemId) return 0;
  let metadata;
  try { metadata = loadEquipmentMetadata(); } catch { return 0; }
  const renderBody = metadata.mobiles?.bodyConv?.[body] ?? body;
  const conversion = metadata.mobiles?.equipConv?.[renderBody]?.[itemId]
    ?? metadata.mobiles?.equipConv?.[body]?.[itemId];
  let animationId = Number(conversion?.gump ?? 0) | 0;
  if (animationId >= 60000) animationId -= 60000;
  else if (animationId >= 50000) animationId -= 50000;
  if (animationId <= 0) animationId = Number(metadata.tiledata?.statics?.[itemId]?.animId ?? 0) | 0;
  if (animationId <= 0) return 0;
  const female = animationId + 60000;
  const male = animationId + 50000;
  if (isFemale && loadGumpManifest().tiles?.[female]) return female;
  return loadGumpManifest().tiles?.[male] ? male : 0;
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
  /** @type {Map<number, object>} */
  const byLayer = new Map();
  const indexed = world?._childrenByParent?.get?.(mob.serial);
  const equipped = indexed
    ? Array.from(indexed, (serial) => world.items.get(serial)).filter(Boolean)
    : (world?.items?.values?.() ?? []);
  for (const it of equipped) {
    if (it.parent !== mob.serial) continue;
    if ((it.layer ?? 0) === 0) continue;
    byLayer.set(it.layer | 0, it);
  }
  for (const layer of LAYER_ORDER) {
    const eq = byLayer.get(layer);
    if (!eq) continue;
    const gumpId = pickEquipGumpId(eq, isFemale, mob.bodyId ?? mob.body);
    const tile = await extractGumpTile(gumpId);
    if (tile) composites.push({ input: tile, top: 19, left: 8 });
  }

  if (composites.length) canvas = canvas.composite(composites);
  return canvas.png().toBuffer();
}
