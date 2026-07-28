import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from './safe-sharp.js';

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../client/public/assets');
let manifest = null;
const cache = new Map();
const CACHE_LIMIT = 256;

function data() {
  manifest ??= JSON.parse(fs.readFileSync(path.join(ASSETS, 'static-atlas.json'), 'utf8'));
  return manifest;
}

/** Extract one LOCAL static-art tile (0..0xffff) from the browser atlas. */
export async function staticArtPng(itemId, { maxWidth = 160, maxHeight = 160 } = {}) {
  const local = Number(itemId) & 0xffff;
  const key = `${local}:${maxWidth}:${maxHeight}`;
  if (cache.has(key)) return cache.get(key);
  const atlas = data();
  // Extractor manifests use global static IDs (local + 0x4000).
  const tile = atlas.tiles?.[local + 0x4000] ?? atlas.tiles?.[local];
  if (!tile || tile.w < 1 || tile.h < 1) return null;
  const page = path.join(ASSETS, `static-atlas-${String(tile.page).padStart(3, '0')}.png`);
  if (!fs.existsSync(page)) return null;
  const promise = sharp(page)
    .extract({ left: tile.u, top: tile.v, width: tile.w, height: tile.h })
    .resize({ width: maxWidth, height: maxHeight, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  cache.set(key, promise);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  try { return await promise; }
  catch (error) { cache.delete(key); throw error; }
}

export function staticArtStatus(itemId) {
  const local = Number(itemId) & 0xffff;
  const tile = data().tiles?.[local + 0x4000] ?? data().tiles?.[local];
  return tile ? { ok: true, itemId: local, ...tile } : { ok: false, itemId: local };
}
