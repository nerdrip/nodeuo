// Compact spatial index for immutable multi blueprints. A placed house keeps
// one anchor plus interactive children; walls and floors live here instead of
// becoming thousands of durable Item entities.

function cellKey(map, x, y) { return `${map | 0}:${x | 0}:${y | 0}`; }

export class MultiSpatialIndex {
  constructor() {
    this.blockers = new Map();
    this.surfaces = new Map();
    this.keysByAnchor = new Map();
  }

  clear() {
    this.blockers.clear();
    this.surfaces.clear();
    this.keysByAnchor.clear();
  }

  _add(table, key, entry) {
    let bucket = table.get(key);
    if (!bucket) { bucket = new Map(); table.set(key, bucket); }
    bucket.set(`${entry.serial}:${entry.index}`, entry);
  }

  register(anchor) {
    if (!anchor?._multiAnchor || !anchor.serial) return false;
    this.unregister(anchor.serial);
    const keys = { blockers: new Set(), surfaces: new Set() };
    const map = anchor.map | 0, ox = anchor.x | 0, oy = anchor.y | 0, oz = anchor.z | 0;
    for (let index = 0; index < (anchor._multiCollision?.length ?? 0); index++) {
      const row = anchor._multiCollision[index];
      if (!Array.isArray(row) || row.length < 4) continue;
      const key = cellKey(map, ox + (row[0] | 0), oy + (row[1] | 0));
      this._add(this.blockers, key, {
        serial: anchor.serial >>> 0, index, z: oz + (row[2] | 0),
        height: Math.max(1, row[3] | 0), solid: true, _multiSpatial: true,
      });
      keys.blockers.add(key);
    }
    for (let index = 0; index < (anchor._multiSurfaces?.length ?? 0); index++) {
      const row = anchor._multiSurfaces[index];
      if (!Array.isArray(row) || row.length < 4) continue;
      const key = cellKey(map, ox + (row[0] | 0), oy + (row[1] | 0));
      this._add(this.surfaces, key, {
        serial: anchor.serial >>> 0, index, z: oz + (row[2] | 0),
        height: Math.max(0, row[3] | 0), bridge: row[4] === 1,
        surface: true, _multiSpatial: true,
      });
      keys.surfaces.add(key);
    }
    this.keysByAnchor.set(anchor.serial >>> 0, keys);
    return true;
  }

  unregister(serialValue) {
    const serial = Number(serialValue) >>> 0;
    const keys = this.keysByAnchor.get(serial);
    if (!keys) return false;
    const remove = (table, list) => {
      for (const key of list) {
        const bucket = table.get(key);
        if (!bucket) continue;
        for (const [entryKey, entry] of bucket) {
          if ((entry.serial >>> 0) === serial) bucket.delete(entryKey);
        }
        if (bucket.size === 0) table.delete(key);
      }
    };
    remove(this.blockers, keys.blockers);
    remove(this.surfaces, keys.surfaces);
    this.keysByAnchor.delete(serial);
    return true;
  }

  blockersAt(map, x, y) { return this.blockers.get(cellKey(map, x, y))?.values() ?? []; }
  surfacesAt(map, x, y) { return this.surfaces.get(cellKey(map, x, y))?.values() ?? []; }

  diagnostics() {
    let blockerEntries = 0, surfaceEntries = 0;
    for (const bucket of this.blockers.values()) blockerEntries += bucket.size;
    for (const bucket of this.surfaces.values()) surfaceEntries += bucket.size;
    return { anchors: this.keysByAnchor.size, blockerCells: this.blockers.size,
      surfaceCells: this.surfaces.size, blockerEntries, surfaceEntries };
  }
}
