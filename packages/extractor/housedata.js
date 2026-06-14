// House customization data extractor — parses UO ASCII config tables
// (walls.txt, doors.txt, floors.txt, stairs.txt, roof.txt, misc.txt,
// teleprts.txt, suppinfo.txt) into a single JSON the client uses to
// drive HouseCustomizationGump.
//
// Each file is tab-separated with a 1-line type header (`int int int ...
// string`) followed by a 1-line column-name header, then data rows.
// Some files have a blank line between the type header and the column
// header — skip blank lines defensively.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve } from 'node:path';

/** Read a UO TSV table.
 *  Returns { columns: string[], rows: Record<string, string|number>[] }.
 */
function readTSV(path) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/);
  // First non-blank line: the int/int/.../string types row.
  // Second non-blank line: column names.
  // Subsequent: data.
  let typesLine = null;
  let columns = null;
  const rows = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (typesLine == null) { typesLine = line.split('\t'); continue; }
    if (columns == null)   { columns   = line.split('\t'); continue; }
    const cols = raw.split('\t');
    if (cols.length === 0) continue;
    /** @type {Record<string, any>} */
    const row = {};
    for (let i = 0; i < columns.length; i++) {
      const name = columns[i] || `col${i}`;
      const type = typesLine[i] || 'string';
      const v = (cols[i] ?? '').trim();
      if (type === 'int') row[name] = v === '' ? 0 : parseInt(v, 10) | 0;
      else                row[name] = v;
    }
    rows.push(row);
  }
  return { columns: columns ?? [], rows };
}

/** Build a category → styles[] tree from a wall/floor/door/etc. table.
 *  Each row maps to a `style` (variant within category) plus pieces. */
function groupByCategory(rows, pieceCols) {
  /** @type {Map<number, { category:number, styles:any[], cliloc?:number, comment?:string }>} */
  const byCat = new Map();
  for (const row of rows) {
    const cat = row.Category | 0;
    if (!byCat.has(cat)) byCat.set(cat, { category: cat, styles: [] });
    const entry = byCat.get(cat);
    if (row.TID && !entry.cliloc) entry.cliloc = row.TID | 0;
    const style = {
      style: row.Style | 0,
      pieces: pieceCols.map((c) => row[c] | 0).filter((g) => g > 0),
      featureMask: row.FeatureMask | 0,
      comment: row.Comment || '',
    };
    entry.styles.push(style);
    if (!entry.comment) entry.comment = row.Comment || '';
  }
  return [...byCat.values()].sort((a, b) => a.category - b.category);
}

const WALL_PIECES = [
  'South1', 'South2', 'South3', 'Corner', 'East1', 'East2', 'East3', 'Post',
  'WindowS', 'AltWindowS', 'WindowE', 'AltWindowE', 'SecondAltWindowS', 'SecondAltWindowE',
];
const DOOR_PIECES = ['Piece1','Piece2','Piece3','Piece4','Piece5','Piece6','Piece7','Piece8'];
const MISC_PIECES = ['Piece1','Piece2','Piece3','Piece4','Piece5','Piece6','Piece7','Piece8'];
const FLOOR_PIECES = Array.from({ length: 16 }, (_, i) => `F${i + 1}`);
const TELEPRT_PIECES = FLOOR_PIECES;
const STAIR_PIECES = ['North','East','South','West','Squared1','Squared2','Rounded1','Rounded2',
                      'MultiNorth','MultiEast','MultiSouth','MultiWest','Block'];
const ROOF_PIECES = ['North','East','South','West','NSCrosspiece','EWCrosspiece',
                     'NDent','EDent','SDent','WDent','NTPiece','ETPiece','STPiece','WTPiece',
                     'XPiece','Extra Piece'];

/** @param {string} src @param {string} out */
export async function extractHouseData(src, out) {
  /** @type {Record<string, ReturnType<typeof groupByCategory>>} */
  const data = {};
  const safe = (name, pieces) => {
    const p = join(src, name);
    try {
      const tsv = readTSV(p);
      return groupByCategory(tsv.rows, pieces);
    } catch (e) {
      console.warn(`[housedata] skip ${name}: ${e?.message}`);
      return [];
    }
  };
  data.walls    = safe('walls.txt',    WALL_PIECES);
  data.doors    = safe('doors.txt',    DOOR_PIECES);
  data.floors   = safe('floors.txt',   FLOOR_PIECES);
  data.stairs   = safe('stairs.txt',   STAIR_PIECES);
  data.roofs    = safe('roof.txt',     ROOF_PIECES);
  data.misc     = safe('misc.txt',     MISC_PIECES);
  data.teleprts = safe('teleprts.txt', TELEPRT_PIECES);

  // suppinfo.txt — per-tile support/adjacency metadata. Less structured
  // than the others (col 0 is a symbol tag, not a category int). We store
  // a flat array of records keyed by tileNumber.
  data.suppinfo = readSuppInfo(join(src, 'suppinfo.txt'));

  // Counts log (skip suppinfo since it's not a category-grouped file).
  const totals = Object.fromEntries(
    Object.entries(data)
      .filter(([k]) => k !== 'suppinfo')
      .map(([k, v]) => [k, { categories: v.length, styles: v.reduce((a, e) => a + e.styles.length, 0) }])
  );

  const json = JSON.stringify(data);
  writeFileSync(join(out, 'housedata.json'), json);

  // Auto-copy into the scripts side too. Server-side scripts ship with
  // the same housedata via `apps/scripts/src/data/housedata.json` so
  // door-auto-bind / region heuristics get the same authoritative table
  // without manual copying. Tries a few likely paths so the extractor
  // can be invoked from a workspace root with a non-default `--out`.
  const candidates = [
    'apps/scripts/src/data/housedata.json',                      // monorepo root
    join(out, '..', '..', '..', 'scripts', 'src', 'data', 'housedata.json'),
  ];
  for (const c of candidates) {
    try {
      const target = isAbsolute(c) ? c : resolve(c);
      if (existsSync(dirname(target))) {
        writeFileSync(target, json);
        break;
      }
    } catch { /* keep trying */ }
  }
  return { totals, suppinfo: data.suppinfo.length };
}

function readSuppInfo(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch { return []; }
  const lines = text.split(/\r?\n/);
  const out = [];
  let header = null;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    if (header === null) { header = true; continue; }      // skip types row
    if (header === true) { header = 'cols'; continue; }    // skip column-name row
    const cols = raw.split('\t');
    if (cols.length < 2) continue;
    const tileNumber = parseInt(cols[1], 10);
    if (!Number.isFinite(tileNumber)) continue;
    out.push({
      symbol: cols[0],
      tileNumber,
      top:        parseInt(cols[2]  || '0', 10) | 0,
      bottom:     parseInt(cols[3]  || '0', 10) | 0,
      adjUN:      parseInt(cols[4]  || '0', 10) | 0,
      adjLN:      parseInt(cols[5]  || '0', 10) | 0,
      adjUE:      parseInt(cols[6]  || '0', 10) | 0,
      adjLE:      parseInt(cols[7]  || '0', 10) | 0,
      adjUS:      parseInt(cols[8]  || '0', 10) | 0,
      adjLS:      parseInt(cols[9]  || '0', 10) | 0,
      adjUW:      parseInt(cols[10] || '0', 10) | 0,
      adjLW:      parseInt(cols[11] || '0', 10) | 0,
      directSupports: parseInt(cols[12] || '0', 10) | 0,
      cangoW:     parseInt(cols[13] || '0', 10) | 0,
      cangoN:     parseInt(cols[14] || '0', 10) | 0,
      cangoNWC:   parseInt(cols[15] || '0', 10) | 0,
      comment:    cols[16] ?? '',
    });
  }
  return out;
}
