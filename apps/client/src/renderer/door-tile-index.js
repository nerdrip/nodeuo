// Incremental index of runtime door items over their canonical closed tiles.
// Chunk rendering uses it to suppress the matching sta*.mul door without
// scanning every world item. No Pixi dependency; ownership stays explicit.

const OPEN_OFFSETS_BY_PIECE = Object.freeze([
  { dx: -1, dy: 0 },
  { dx: 1, dy: -1 },
  { dx: -1, dy: 1 },
  { dx: 1, dy: 1 },
  { dx: 1, dy: 1 },
  { dx: 1, dy: -1 },
  { dx: 0, dy: 0 },
  { dx: 0, dy: -1 },
]);
const EMPTY_TILES = Object.freeze(new Set());

export class DoorTileIndex {
  constructor({ resolveDoorPiece, chunkSize = 8 }) {
    this.resolveDoorPiece = resolveDoorPiece;
    this.chunkSize = chunkSize;
    this.tilesByChunk = new Map();
    this.chunkBySerial = new Map();
    this.serialsByChunkTile = new Map();
  }

  chunkKey(x, y) {
    return ((Math.floor(y / this.chunkSize)) << 16)
      | (Math.floor(x / this.chunkSize) & 0xffff);
  }

  tileKey(x, y) {
    return ((y & 0xffff) << 16) | (x & 0xffff);
  }

  graphicState(itemId) {
    const id = itemId | 0;
    let info = this.resolveDoorPiece?.(id);
    if (info) {
      return {
        closedId: id,
        openId: id + 1,
        isOpen: false,
        info,
        offset: OPEN_OFFSETS_BY_PIECE[info.pieceIdx & 7] ?? { dx: 0, dy: 0 },
      };
    }
    info = this.resolveDoorPiece?.(id - 1);
    if (!info) return null;
    return {
      closedId: id - 1,
      openId: id,
      isOpen: true,
      info,
      offset: OPEN_OFFSETS_BY_PIECE[info.pieceIdx & 7] ?? { dx: 0, dy: 0 },
    };
  }

  register(item) {
    if (!item || item.parent) return null;
    const state = this.graphicState(item.itemId | 0);
    if (!state) return null;
    const serial = item.serial >>> 0;
    const existing = this.chunkBySerial.get(serial);
    if (existing != null) return existing;

    const canonicalX = state.isOpen ? item.x - state.offset.dx : item.x;
    const canonicalY = state.isOpen ? item.y - state.offset.dy : item.y;
    const chunkKey = this.chunkKey(canonicalX, canonicalY);
    const tileKey = this.tileKey(canonicalX, canonicalY);

    let tiles = this.tilesByChunk.get(chunkKey);
    if (!tiles) {
      tiles = new Set();
      this.tilesByChunk.set(chunkKey, tiles);
    }
    tiles.add(tileKey);
    let tileMap = this.serialsByChunkTile.get(chunkKey);
    if (!tileMap) {
      tileMap = new Map();
      this.serialsByChunkTile.set(chunkKey, tileMap);
    }
    let serials = tileMap.get(tileKey);
    if (!serials) {
      serials = new Set();
      tileMap.set(tileKey, serials);
    }
    serials.add(serial);
    this.chunkBySerial.set(serial, chunkKey);
    return chunkKey;
  }

  unregister(serial) {
    const normalized = serial >>> 0;
    const chunkKey = this.chunkBySerial.get(normalized);
    if (chunkKey === undefined) return null;
    this.chunkBySerial.delete(normalized);
    const tileMap = this.serialsByChunkTile.get(chunkKey);
    if (!tileMap) return chunkKey;
    for (const [tileKey, serials] of tileMap) {
      if (!serials.delete(normalized)) continue;
      if (serials.size === 0) {
        tileMap.delete(tileKey);
        const tiles = this.tilesByChunk.get(chunkKey);
        tiles?.delete(tileKey);
        if (tiles?.size === 0) this.tilesByChunk.delete(chunkKey);
      }
      break;
    }
    if (tileMap.size === 0) this.serialsByChunkTile.delete(chunkKey);
    return chunkKey;
  }

  has(serial) { return this.chunkBySerial.has(serial >>> 0); }
  chunkFor(serial) { return this.chunkBySerial.get(serial >>> 0); }
  tilesForChunkKey(chunkKey) { return this.tilesByChunk.get(chunkKey) ?? EMPTY_TILES; }

  clear() {
    this.tilesByChunk.clear();
    this.chunkBySerial.clear();
    this.serialsByChunkTile.clear();
  }
}
