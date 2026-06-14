// Server-side land + statics provider.
//
// Reads the flat extractor output that lives at
// `apps/client/public/assets/map<facet>.bin` + `staidx<facet>.bin` +
// `statics<facet>.bin` (the same files the client mmaps for rendering).
// Each file is loaded once per facet on first access and kept in
// memory; the maps are big (~90 MB total for facet 0) but the server
// runs on the same box and we want O(1) walkability lookups during
// movement validation.
//
// Block layout (mirrors CUO `MapLoader` / `StaticsLoader`):
//   map<facet>.bin      column-major blocks: idx = bx * blocksTall + by
//                       block = u32 header + 8×8 land cells (3 bytes each)
//                       cell layout is `tileId(u16) z(i8)` and CELL ORDER
//                       inside the block is row-major (y outer, x inner)
//                       — `cellIdx = innerY * 8 + innerX`.
//   staidx<facet>.bin   8 bytes per block: u32 offset + u32 length into bin.
//   statics<facet>.bin  records of 7 bytes: tileId(u16) dx dy z(i8) hue(u16).
//
// Earlier this provider expected a per-chunk file layout that the
// extractor never produced — every `landAt` returned null and
// `staticsAt` returned [], so movement validation degraded to "anywhere
// is fine". That's why doors / walls / water didn't block the player.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BLOCK_BYTES = 196;
const STATIC_RECORD = 7;

const DEFAULT_ASSETS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'client', 'public', 'assets',
);

export class LandProvider {
  /**
   * @param {string} [assetsDir] absolute path to `apps/client/public/assets`
   */
  constructor(assetsDir = DEFAULT_ASSETS_DIR) {
    this.assetsDir = assetsDir;
    /** @type {Map<number, { meta:any, mapBuf:Buffer, idxBuf:Buffer, datBuf:Buffer } | null>} */
    this._byFacet = new Map();
    /** Sparse edit overlay — `${facet}|${x}|${y}` → { tileId, z }. Survives
     *  restarts via load/saveEditsSync. The map editor in the admin
     *  panel writes here; landAt + the wire path consult it before
     *  reading the on-disk mapBuf so the new tile sticks. */
    this._edits = new Map();
  }

  /** Stamp a single tile override. Returns the previous value (or null). */
  setLandTile(facet, x, y, tileId, z) {
    const key = `${facet}|${x}|${y}`;
    const prev = this._edits.get(key) ?? this.landAt(facet, x, y);
    this._edits.set(key, { tileId: tileId & 0xffff, z: z | 0 });
    return prev;
  }

  /** Drop a single override (revert to disk-stored tile). */
  clearLandTile(facet, x, y) {
    this._edits.delete(`${facet}|${x}|${y}`);
  }

  /** Number of overlay edits in memory — admin UI shows the count. */
  editCount() { return this._edits.size; }

  /** Iterate every (facet, x, y, tileId, z) edit. Used by saveEditsSync. */
  *iterEdits() {
    for (const [k, v] of this._edits) {
      const [f, x, y] = k.split('|').map(Number);
      yield { facet: f, x, y, tileId: v.tileId, z: v.z };
    }
  }

  /** Persist overlay to a JSON file. Cheap — typically <1000 edits. */
  saveEditsSync(file) {
    const arr = [...this.iterEdits()];
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(arr));
      return { written: arr.length };
    } catch (e) {
      return { error: e.message };
    }
  }

  /** Load overlay from a JSON file. Missing file is fine — empty overlay. */
  loadEditsSync(file) {
    try {
      if (!fs.existsSync(file)) return { loaded: 0 };
      const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
      let loaded = 0;
      for (const e of arr ?? []) {
        if (Number.isFinite(e?.facet) && Number.isFinite(e?.x) && Number.isFinite(e?.y)) {
          this._edits.set(`${e.facet}|${e.x}|${e.y}`, { tileId: e.tileId | 0, z: e.z | 0 });
          loaded++;
        }
      }
      return { loaded };
    } catch (e) {
      return { error: e.message };
    }
  }

  /** Lazy-load every file for `facet`. Cached after first hit.
   *  When a facet's files are missing we transparently fall through
   *  to facet 0 — the default extractor only writes map0 / staidx0 /
   *  statics0, but pre-AOS shards put characters on facet 1 (Trammel)
   *  by default. Trammel and Felucca share identical geometry on the
   *  britannia mainland so this alias is invisible in practice; if a
   *  shard later wants a real Trammel diff (housing, etc.), they can
   *  drop a real map1.bin in and the alias auto-disengages. */
  _load(facet) {
    let bundle = this._byFacet.get(facet);
    if (bundle !== undefined) return bundle;
    bundle = this._tryLoadOne(facet) ?? (facet !== 0 ? this._tryLoadOne(0) : null);
    this._byFacet.set(facet, bundle);
    return bundle;
  }

  _tryLoadOne(facet) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(this.assetsDir, `map${facet}.json`), 'utf8'));
      const mapBuf = fs.readFileSync(path.join(this.assetsDir, `map${facet}.bin`));
      const idxBuf = fs.readFileSync(path.join(this.assetsDir, `staidx${facet}.bin`));
      const datBuf = fs.readFileSync(path.join(this.assetsDir, `statics${facet}.bin`));
      return { meta, mapBuf, idxBuf, datBuf };
    } catch { return null; }
  }

  /** Return the meta (or null) so other systems can ask for map dimensions. */
  metaFor(facet) {
    return this._load(facet)?.meta ?? null;
  }

  /** Sample the land tile at world (x,y). Returns `{tileId, z}` or null.
   *  Consults the in-memory edit overlay BEFORE the disk-backed map
   *  buffer so admin-panel map-editor changes take effect immediately
   *  for both walk validation (server) and serialised block fetches
   *  (admin UI rendering). */
  landAt(facet, x, y) {
    const editKey = `${facet}|${x}|${y}`;
    const edit = this._edits.get(editKey);
    if (edit) return { tileId: edit.tileId, z: edit.z };
    const b = this._load(facet);
    if (!b) return null;
    const cx = Math.floor(x / 8), cy = Math.floor(y / 8);
    if (cx < 0 || cy < 0 || cx >= b.meta.blocksWide || cy >= b.meta.blocksTall) return null;
    // Column-major chunk index — matches our extractor + CUO.
    const block = cx * b.meta.blocksTall + cy;
    const blockOff = block * BLOCK_BYTES;
    const cellIdx = (y & 7) * 8 + (x & 7);
    const off = blockOff + 4 + cellIdx * 3;
    if (off + 3 > b.mapBuf.length) return null;
    return { tileId: b.mapBuf.readUInt16LE(off), z: b.mapBuf.readInt8(off + 2) };
  }

  /** Sample just the z of the land tile at (x,y). Returns 0 if unloaded. */
  landZ(facet, x, y) {
    return this.landAt(facet, x, y)?.z ?? 0;
  }

  /**
   * Decode all statics sitting on world tile (x,y). Returns [] when the
   * facet isn't on disk. Each record: `{tileId, z, hue}`.
   */
  staticsAt(facet, x, y) {
    const b = this._load(facet);
    if (!b) return [];
    const cx = Math.floor(x / 8), cy = Math.floor(y / 8);
    if (cx < 0 || cy < 0 || cx >= b.meta.blocksWide || cy >= b.meta.blocksTall) return [];
    const block = cx * b.meta.blocksTall + cy;
    const idxOff = block * 8;
    if (idxOff + 8 > b.idxBuf.length) return [];
    const off = b.idxBuf.readUInt32LE(idxOff);
    const len = b.idxBuf.readInt32LE(idxOff + 4);
    if (off === 0xFFFFFFFF || len <= 0) return [];
    const dx = x & 7, dy = y & 7;
    const out = [];
    const count = (len / STATIC_RECORD) | 0;
    for (let i = 0; i < count; i++) {
      const p = off + i * STATIC_RECORD;
      if (p + STATIC_RECORD > b.datBuf.length) break;
      if (b.datBuf.readUInt8(p + 2) !== dx) continue;
      if (b.datBuf.readUInt8(p + 3) !== dy) continue;
      out.push({
        tileId: b.datBuf.readUInt16LE(p),
        z: b.datBuf.readInt8(p + 4),
        hue: b.datBuf.readUInt16LE(p + 5),
      });
    }
    return out;
  }
}

/** Module-level singleton used by the movement handler. */
export const landProvider = new LandProvider();
