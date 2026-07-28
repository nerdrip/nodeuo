// Tiledata accessor. Centralises the two quirks every consumer hits:
//
//   1. Land vs static lookup tables — tiledata.json ships
//      `{land: [...], statics: [...]}` and the indexes differ in
//      semantics: a land id N maps to `land[N]`, while a static graphic
//      id can show up at EITHER `statics[id]` (LOCAL) or
//      `statics[id + 0x4000]` (GLOBAL, post-extract). The dual lookup
//      avoids the "renamed dump" foot-gun where one surface reads
//      LOCAL and the other GLOBAL and they silently disagree on
//      height / flags / name.
//   2. Some grandfathered admin code uses `LAND_COUNT = 16384` as a
//      magic-number alias for 0x4000. Both spellings are exported here
//      so neither side has to switch.
//
// SHARED MODULE: takes the parsed tiledata.json as a plain object and
// returns plain numbers / strings. No fetch, no Pixi, no Node. Caller
// owns the JSON (asset-manager.js on the client, AT.tiledata in the
// admin editor) and just hands it in.

/** Local→global static graphic offset. CUO + ServUO + extractor all
 *  use 0x4000 as the boundary between land (0..0x3FFF) and static
 *  (0x4000+) ids inside a unified `tiledata` table. */
export const LAND_COUNT = 0x4000;

/** Resolve a static entry from tiledata regardless of whether the
 *  caller passed a LOCAL or GLOBAL id. Returns `null` when the entry
 *  isn't catalogued (silent-fallback callers are then free to render
 *  "static 0x????" placeholders).
 *  @param {{land?: any[], statics?: any[]}} tiledata
 *  @param {number} id  LOCAL static graphic id (0..0xBFFF) or already-shifted GLOBAL
 *  @returns {{ name?: string, height?: number, flags?: number, layer?: number } | null} */
export function staticEntry(tiledata, id) {
  const t = tiledata?.statics;
  if (!t) return null;
  const idx = id | 0;
  return t[idx] ?? t[idx + LAND_COUNT] ?? null;
}

/** Resolve a land entry. tileId is the raw 14-bit land id from map.mul
 *  (already in the 0..0x3FFF range — no shift needed). */
export function landEntry(tiledata, id) {
  return tiledata?.land?.[id | 0] ?? null;
}

/** Display name with a graceful fallback. Mirrors the admin editor
 *  default ("static 0x100") so palette / inspector tooltips look the
 *  same in both surfaces. */
export function staticNameOf(tiledata, id) {
  const e = staticEntry(tiledata, id);
  return e?.name ?? `static 0x${(id | 0).toString(16)}`;
}

/** Implementation-marker art is present under both `nodraw` and
 * `no draw` spellings (plus suffixes such as `nodraw_hover`). It is map
 * scaffolding and must never reach a player's renderer. */
export function isNoDrawStatic(tiledata, id) {
  const name = String(staticEntry(tiledata, id)?.name ?? '').trim();
  return /^no\s*draw(?:\b|_)/i.test(name);
}

export function landNameOf(tiledata, id) {
  const e = landEntry(tiledata, id);
  return e?.name ?? `land 0x${(id | 0).toString(16)}`;
}

/** Static height (Z extent). Used by movement.js AABB blocker check
 *  and by the admin editor's z-stack visualiser. */
export function staticHeight(tiledata, id) {
  return (staticEntry(tiledata, id)?.height) | 0;
}

/** Tile flags as a single integer. JS i32 sign-flips on bit 31
 *  (0x80000000 = FLAG_STAIR_RIGHT) — we `>>> 0` so callers can mask
 *  with the unsigned constants from tiledata-flags.js. */
export function staticFlags(tiledata, id) {
  return (staticEntry(tiledata, id)?.flags >>> 0) | 0;
}

export function landFlags(tiledata, id) {
  return (landEntry(tiledata, id)?.flags >>> 0) | 0;
}
