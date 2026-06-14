// Decoration extractor — walk every `.cfg` under templates/ServUO/Data/Decoration
// and emit a flat JSON list of placeable entries that the server can apply
// via the [decorate command at start-up.
//
// ServUO `.cfg` line format (Decorate.cs:140-220):
//   <TypeName> 0xHEX (Param=Value, Param=Value, ...)
//   X Y Z
//   X Y Z
//   ...
// Comments start with '#' and blank lines are ignored.
//
// We capture:
//   - type:    the C# class name (Static, MetalDoor, LibraryBookcase, ...)
//              The server uses this to decide whether to bind a script
//              (door, sign, container, light, etc.).
//   - itemId:  the graphic ID after the type — already a usable Pixi/UO
//              static graphic.
//   - params:  parsed (Facing=WestCW, Hue=0xD, Light=Circle150, ...).
//   - x,y,z:   one tile per coord triplet.
//   - map:     resolved from the folder name. Britannia → both Felucca (0)
//              and Trammel (1). Single-facet folders → that facet only.
//
// Output: apps/scripts/src/data/decorations.json (one big array). Optimised
// for fast load — string interning happens on the runtime side.
//
//   node packages/extractor/decoration.js [--src templates/ServUO/Data/Decoration] \
//                                      [--out apps/scripts/src/data/decorations.json]

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

// Folder → facet id list. Mirrors Decorate.cs `Generate("deco", "Data/Decoration/<X>", ...)`.
const FACET_MAP = {
  'Britannia':       [0, 1],            // both classic facets
  'Felucca':         [0],
  'Trammel':         [1],
  'Ilshenar':        [2],
  'Malas':           [3],
  'Tokuno':          [4],
  'Stygian Abyss':   [5],
  'TerMur':          [5],
  'Underworld':      [5],
  'Magincia':        [1],                // ServUO's New Magincia is Trammel
  'Old':             [0, 1],             // pre-revamp legacy data
  'Mondain\'s Legacy':[2, 3],
  'TimeOfLegends':   [5],
  'Wrong':           [0],                // wrong-revamp on Felucca
  'Exodus':          [3],
};

function parseHeader(line) {
  // <TypeName> 0xHEX (Param=Val, Param=Val, ...)
  // Tokens after the parens are optional. ID may be in decimal too.
  const m = line.match(/^([A-Za-z0-9_]+)\s+(0x[0-9A-Fa-f]+|\d+)(?:\s*\((.*)\))?\s*$/);
  if (!m) return null;
  const type = m[1];
  const itemId = m[2].startsWith('0x') ? parseInt(m[2].slice(2), 16) : parseInt(m[2], 10);
  const params = {};
  if (m[3]) {
    for (const part of m[3].split(/[;,]\s*/)) {
      const eq = part.indexOf('=');
      if (eq < 0) {
        // Bare flag like `Unlit` / `Unprotected`.
        const flag = part.trim();
        if (flag) params[flag] = true;
        continue;
      }
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      // Numeric / hex / boolean conversion.
      if (/^0x[0-9A-Fa-f]+$/.test(v)) params[k] = parseInt(v.slice(2), 16);
      else if (/^-?\d+$/.test(v))     params[k] = parseInt(v, 10);
      else if (/^(true|false)$/i.test(v)) params[k] = /^true$/i.test(v);
      else                            params[k] = v;
    }
  }
  return { type, itemId, params };
}

function parseCoord(line) {
  // "X Y Z" or "X Y Z something" (rare LightSource tokens have a 4th word).
  const m = line.match(/^(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
  if (!m) return null;
  return { x: parseInt(m[1], 10), y: parseInt(m[2], 10), z: parseInt(m[3], 10) };
}

function parseCfg(text) {
  const lines = text.split(/\r?\n/);
  /** @type {{type:string, itemId:number, x:number, y:number, z:number, hue?:number, params?:any}[]} */
  const out = [];
  let header = null;
  for (const raw of lines) {
    let line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    // Strip trailing comments.
    const hash = line.indexOf('#');
    if (hash > 0) line = line.slice(0, hash).trim();
    if (!line) continue;
    if (/^[A-Za-z]/.test(line)) {
      header = parseHeader(line);
      if (!header) header = null;
      continue;
    }
    if (!header) continue;
    const c = parseCoord(line);
    if (!c) continue;
    const entry = {
      type: header.type, itemId: header.itemId,
      x: c.x, y: c.y, z: c.z,
    };
    const p = header.params;
    if (p && Object.keys(p).length) {
      if (typeof p.Hue === 'number')         entry.hue = p.Hue;
      if (typeof p.Name === 'string')        entry.name = p.Name;
      if (typeof p.LabelNumber === 'number') entry.labelNumber = p.LabelNumber;
      if (typeof p.Facing === 'string')      entry.facing = p.Facing;
      if (typeof p.Light === 'string')       entry.light = p.Light;
      if (typeof p.Content === 'string')     entry.content = p.Content;
      if (typeof p.ContentType === 'string') entry.contentType = p.ContentType;
      if (typeof p.PointDest === 'string')   entry.pointDest = p.PointDest;
      if (typeof p.MapDest === 'string')     entry.mapDest = p.MapDest;
      if (p.Unlit)         entry.unlit = true;
      if (p.Unprotected)   entry.unprotected = true;
    }
    out.push(entry);
  }
  return out;
}

function walkCfgFiles(root) {
  /** @type {{path:string, folder:string}[]} */
  const out = [];
  const walk = (dir, ancestor) => {
    let stat;
    try { stat = statSync(dir); } catch { return; }
    if (!stat.isDirectory()) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p, ancestor ?? name);
      else if (s.isFile() && p.toLowerCase().endsWith('.cfg')) {
        out.push({ path: p, folder: ancestor ?? basename(dir) });
      }
    }
  };
  walk(root, null);
  return out;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    out[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const src = args.src ?? 'templates/ServUO/Data/Decoration';
const out = args.out ?? 'apps/scripts/src/data/decorations.json';
const signsSrc = args.signs ?? 'templates/ServUO/Data/signs.cfg';
const signsOut = args.signsOut ?? 'apps/scripts/src/data/signs.json';
const teleSrc  = args.teleporters ?? 'templates/ServUO/Data/teleporters.csv';
const teleOut  = args.teleportersOut ?? 'apps/scripts/src/data/teleporters.json';

if (!existsSync(src)) {
  console.error(`[decorate] source missing: ${src}`);
  process.exit(2);
}

console.log(`[decorate] scanning ${src}…`);
const files = walkCfgFiles(src);
console.log(`[decorate] ${files.length} .cfg files`);

const decorations = [];
let unknownFolders = new Set();
const typeCounts = new Map();

for (const f of files) {
  const facets = FACET_MAP[f.folder];
  if (!facets) {
    unknownFolders.add(f.folder);
    continue;
  }
  let entries;
  try {
    entries = parseCfg(readFileSync(f.path, 'utf8'));
  } catch (e) {
    console.warn(`[decorate] parse failed: ${f.path}`, e.message);
    continue;
  }
  for (const e of entries) {
    typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
    for (const map of facets) {
      decorations.push({ ...e, map });
    }
  }
}

if (unknownFolders.size) {
  console.warn(`[decorate] unmapped folders skipped: ${[...unknownFolders].join(', ')}`);
}
console.log(`[decorate] ${decorations.length} placements (top 10 types):`);
for (const [t, c] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${t.padEnd(28)} ${c}`);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(decorations));
console.log(`[decorate] → ${out} (${(JSON.stringify(decorations).length / 1024 / 1024).toFixed(2)} MB)`);

// signs.cfg — ServUO `SignParser.cs::SignEntry.LoadConfig` format:
//   <map> <itemID> <X> <Y> <Z> <text>
//
// `map` semantics from ServUO:
//   0 = both Britannia facets (Felucca + Trammel)
//   1 = Felucca only
//   2 = Trammel only
//   3 = Ilshenar
//   4 = Malas
//   5 = Tokuno
//
// `text` is either a plain caption or `#<cliloc>` for localized signs.
//
// PRIOR BUG: the original regex captured first column as itemId — but
// ServUO puts MAP first. Every sign in the extracted JSON had
// itemId=0 (the map id) and the real itemId leaked into the X
// coordinate; signs spawned with no graphic at impossible
// coordinates. Pure parser fix; signgen.js's runtime remap (added
// 2026-05-11) detects the old shape and rebuilds at boot for
// existing dumps.
if (existsSync(signsSrc)) {
  const text = readFileSync(signsSrc, 'utf8');
  const signs = [];
  let n = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    // 5 numeric fields then text (text may itself contain a `#cliloc`).
    const m = line.match(/^(\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(.+)$/);
    if (!m) continue;
    const sourceMap = parseInt(m[1], 10);
    const itemId = parseInt(m[2], 10);
    const x = parseInt(m[3], 10), y = parseInt(m[4], 10), z = parseInt(m[5], 10);
    const tail = m[6].trim();
    let labelNumber = 0;
    let captionText = '';
    if (tail.startsWith('#')) {
      labelNumber = parseInt(tail.slice(1), 10) | 0;
    } else {
      captionText = tail;
    }
    // Translate ServUO map id → array of our facet ids that this sign
    // covers. ServUO 0 = both britannia (Tram + Fel), 1 = Fel, 2 = Tram.
    let facets;
    switch (sourceMap) {
      case 0: facets = [0, 1]; break;
      case 1: facets = [0];    break;
      case 2: facets = [1];    break;
      case 3: facets = [2];    break;
      case 4: facets = [3];    break;
      case 5: facets = [4];    break;
      default: facets = [sourceMap]; break;
    }
    for (const map of facets) {
      signs.push({
        type: 'Sign', itemId, x, y, z, hue: 0,
        labelNumber, name: captionText || undefined, map,
      });
    }
    n++;
  }
  writeFileSync(signsOut, JSON.stringify(signs));
  console.log(`[signs] ${n} unique → ${signs.length} placements → ${signsOut}`);
} else {
  console.warn(`[signs] skip — ${signsSrc} missing`);
}

// teleporters.csv — pipe-delimited records (",,,,,,,,").
//   X,Y,Z,SrcMap, DestX,DestY,DestZ,DestMap, BackTeleporter
if (existsSync(teleSrc)) {
  const text = readFileSync(teleSrc, 'utf8');
  const teles = [];
  const lines = text.split(/\r?\n/);
  let n = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const f = line.split(',');
    if (f.length < 9) continue;
    const e = {
      x: parseInt(f[0], 10), y: parseInt(f[1], 10), z: parseInt(f[2], 10),
      map: mapNameToId(f[3]),
      destX: parseInt(f[4], 10), destY: parseInt(f[5], 10), destZ: parseInt(f[6], 10),
      destMap: mapNameToId(f[7]),
      back: /^true$/i.test(f[8]),
    };
    if (Number.isFinite(e.x) && Number.isFinite(e.y) && e.map != null && e.destMap != null) {
      teles.push(e); n++;
    }
  }
  writeFileSync(teleOut, JSON.stringify(teles));
  console.log(`[teleporters] ${n} records → ${teleOut}`);
} else {
  console.warn(`[teleporters] skip — ${teleSrc} missing`);
}

function mapNameToId(s) {
  if (!s) return null;
  const k = s.trim().toLowerCase();
  if (k === 'felucca')  return 0;
  if (k === 'trammel')  return 1;
  if (k === 'ilshenar') return 2;
  if (k === 'malas')    return 3;
  if (k === 'tokuno')   return 4;
  if (k === 'termur' || k === 'ter mur' || k === 'stygianabyss' || k === 'stygian abyss') return 5;
  const n = parseInt(k, 10);
  return Number.isFinite(n) ? n : null;
}
