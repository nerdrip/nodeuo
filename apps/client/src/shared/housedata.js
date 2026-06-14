// Housedata accessor. Mirrors apps/scripts/src/data.js' `api.housedata`
// + apps/client/src/assets/asset-manager.js' role/doorPiece lookup.
//
// `housedata.json` (extractor output, served at `/assets/housedata.json`)
// catalogues every UO housing tile by role:
//
//   { walls:    [{ category, styles: [{ pieces: [graphicId, ...] }] }],
//     doors:    [{ category, styles: [{ pieces: [g0..g7] }] }],
//     floors:   [...], stairs: [...], roofs: [...],
//     misc:     [...], teleprts: [...] }
//
// Doors are special: every category ships exactly 8 CLOSED pieces
// (facings/hinges). The open graphic is the next art id
// (`closedId + 1`) per ServUO BaseDoor. pieceIdx is only the index
// inside that closed-piece list; do not use pieceIdx or itemId parity
// as an open/closed flag because some runs start at an odd graphic.
//
// SHARED MODULE: pure data over the parsed housedata JSON. Caller
// passes the JSON in; we return plain strings / objects. No fetch.

/** Build the (role, doorPiece, doorCategoryPieces) accessor trio from a
 *  parsed housedata.json. Mirrors `apps/scripts/src/data.js` line ~162.
 *
 *  Returns `{ roleFor, doorPiece, doorCategoryPieces }`:
 *    • roleFor(graphicId)      → 'wall' | 'door' | 'floor' | 'stair' |
 *                                'roof' | 'misc' | 'teleporter' | null
 *    • doorPiece(graphicId)    → { category, pieceIdx } | null
 *    • doorCategoryPieces(cat) → [g0..g7]               | null
 *
 *  Returns `null` if the housedata payload is missing or malformed.
 */
export function buildHousedataAccessor(housedata) {
  if (!housedata || typeof housedata !== 'object') return null;

  const roleMap = new Map();
  const addRole = (role, list) => {
    if (!Array.isArray(list)) return;
    for (const cat of list) {
      for (const style of (cat?.styles ?? [])) {
        for (const g of (style?.pieces ?? [])) {
          const id = g | 0;
          if (id > 0 && !roleMap.has(id)) roleMap.set(id, role);
        }
      }
    }
  };
  addRole('wall',       housedata.walls);
  addRole('door',       housedata.doors);
  addRole('floor',      housedata.floors);
  addRole('stair',      housedata.stairs);
  addRole('roof',       housedata.roofs);
  addRole('misc',       housedata.misc);
  addRole('teleporter', housedata.teleprts);

  const doorMap = new Map();
  for (const cat of (housedata.doors ?? [])) {
    for (const style of (cat?.styles ?? [])) {
      const pieces = style?.pieces ?? [];
      for (let i = 0; i < pieces.length; i++) {
        const g = pieces[i] | 0;
        if (g > 0 && !doorMap.has(g)) {
          doorMap.set(g, { category: cat.category, pieceIdx: i });
        }
      }
    }
  }

  return {
    roleFor: (graphicId) => roleMap.get(graphicId | 0) ?? null,
    doorPiece: (graphicId) => doorMap.get(graphicId | 0) ?? null,
    doorCategoryPieces: (category) =>
      housedata.doors?.find?.((c) => c.category === category)?.styles?.[0]?.pieces ?? null,
  };
}

/** Resolve the OTHER half of a closed hinge pair from housedata
 *  (`pieceIdx ^ 1`). This is useful for double-door pairing, not for
 *  opening a door. Runtime open art is `closedId + 1`.
 *  Returns the paired CLOSED graphic id, or `null` when pieces are not
 *  available.
 *  @param {number} currentGraphic
 *  @param {{ category: string, pieceIdx: number } | null} info
 *  @param {(cat:string) => number[] | null} doorCategoryPieces */
export function pairedDoorGraphic(currentGraphic, info, doorCategoryPieces) {
  if (!info) return null;
  const pieces = doorCategoryPieces(info.category);
  if (!Array.isArray(pieces)) return null;
  const otherIdx = info.pieceIdx ^ 1;        // paired closed hinge
  return pieces[otherIdx] ?? null;
}
