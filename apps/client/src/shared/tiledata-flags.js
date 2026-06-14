// CUO TileFlag enum (TileDataLoader.cs:404) — the subset both the
// in-game client and the admin editor need. Centralised so we can't
// drift between surfaces (e.g. one calling `flags & 0x40` for impassable
// while the other uses 0x80 because someone misread the table).
//
// SHARED MODULE: pure constants + small predicate helpers, no runtime
// imports. Safe to load directly into both Pixi and the admin DOM editor.

export const FLAG_BACKGROUND  = 0x00000001;
export const FLAG_WEAPON      = 0x00000002;
export const FLAG_TRANSPARENT = 0x00000004;
export const FLAG_TRANSLUCENT = 0x00000008;
export const FLAG_WALL        = 0x00000010;
export const FLAG_DAMAGING    = 0x00000020;
export const FLAG_IMPASSABLE  = 0x00000040;
export const FLAG_WET         = 0x00000080;
export const FLAG_SURFACE     = 0x00000200;
export const FLAG_BRIDGE      = 0x00000400;
export const FLAG_GENERIC     = 0x00000800;
export const FLAG_WINDOW      = 0x00001000;
export const FLAG_NOSHOOT     = 0x00002000;
export const FLAG_ARTICLE_A   = 0x00004000;
export const FLAG_ARTICLE_AN  = 0x00008000;
export const FLAG_INTERNAL    = 0x00010000;
export const FLAG_FOLIAGE     = 0x00020000;
export const FLAG_PARTIAL_HUE = 0x00040000;
export const FLAG_NO_HOUSE    = 0x00080000;
export const FLAG_MAP         = 0x00100000;
export const FLAG_CONTAINER   = 0x00200000;
export const FLAG_WEARABLE    = 0x00400000;
export const FLAG_LIGHT_SRC   = 0x00800000;
export const FLAG_ANIMATION   = 0x01000000;
export const FLAG_NO_DIAGONAL = 0x02000000;
export const FLAG_ARMOR       = 0x04000000;
export const FLAG_ROOF        = 0x10000000;
export const FLAG_DOOR        = 0x20000000;
export const FLAG_STAIR_BACK  = 0x40000000;
// 0x80000000 is `FLAG_STAIR_RIGHT` per ServUO — JS bitops force i32 so
// we expose it as the unsigned int and recommend `(flags >>> 0) & FLAG_STAIR_RIGHT`.
export const FLAG_STAIR_RIGHT = 0x80000000 >>> 0;

/** Walk-blocker test. Doors flip dynamically via item.door.isOpen so
 *  they're treated as passable here; the runtime block check folds
 *  the open/closed state in separately. Mirrors the placemulti +
 *  decorate role classifier so static + dynamic stay in sync. */
export function isSolidFlag(flags) {
  const f = flags | 0;
  if (f & FLAG_DOOR) return false;
  return (f & FLAG_IMPASSABLE) !== 0;
}

/** Roof / wall / floor classifier used by the indoor cut-off
 *  (transparent-roof-on-enter) and the admin editor's category filter.
 *  Returns a single string so callers can switch on it directly. */
export function classifyTileFlags(flags) {
  const f = flags | 0;
  if (f & FLAG_ROOF)       return 'roof';
  if (f & FLAG_WALL)       return 'wall';
  if (f & FLAG_BRIDGE)     return 'bridge';
  if (f & FLAG_SURFACE)    return 'surface';
  if (f & FLAG_FOLIAGE)    return 'foliage';
  if (f & FLAG_BACKGROUND) return 'background';
  return 'static';
}
