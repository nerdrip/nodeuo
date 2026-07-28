// HouseCustomizationManager — drives the house-builder edit flow.
// Mirrors the action surface of CUO `Game/Managers/HouseCustomizationManager.cs`
// without the asset catalog parsing (walls.txt / floors.txt / etc. —
// those are content tables we'll wire when we extract them).
//
// Server protocol: every authoring action is a 0xD7 packet with:
//   u8 op (0xD7)
//   u16 length
//   u32 playerSerial
//   u16 subopId
//   <field bytes — most subops use 0x00 separators between u32s>
//   u8 0x0A terminator
//
// The state machine sits idle until the player enters edit mode (server
// emits 0xBF 0x20 HouseCustomization with start). The HouseCustomizationGump
// places drag-tools, picks tiles, and calls our builders to send 0xD7
// commands. The actual rendering happens elsewhere (multi-ghost overlay).

import {
  PacketWriter, extNodeUOHouseTools, NodeUOCapability, NodeUOHouseToolsMessage,
} from '@uo/protocol';
import { net } from '../net/net-client.js';
import { world } from '../world/world.js';
import { bus } from '../core/event-bus.js';

export const HouseCustomState = Object.freeze({
  Idle:    0,
  Editing: 1,
  Erasing: 2,
});

// ---------- 0xD7 builder helpers --------------------------------------

function _open(subopId) {
  const w = new PacketWriter(64);
  w.writeU8(0xD7);
  w.writeU16(0);            // length patched at flush
  w.writeU32((world.player?.serial ?? 0) >>> 0);
  w.writeU16(subopId & 0xffff);
  return w;
}
function _close(w) {
  w.writeU8(0x0A);
  const len = w.length;
  // Patch the u16 length field at byte 1.
  w.setU16At?.(1, len);
  return w.bytes();
}

// Subop catalogue (CUO `OutgoingPackets.Send_CustomHouse*`).
function buildHouseBackup()         { const w = _open(0x02); w.writeU8(0x0A); return w.bytes(); }
function buildHouseRestore()        { return _close(_open(0x03)); }
function buildHouseCommit()         { return _close(_open(0x04)); }
function buildHouseDeleteItem(g, x, y, z) {
  const w = _open(0x05);
  w.writeU8(0x00); w.writeU32(g >>> 0);
  w.writeU8(0x00); w.writeU32(x >>> 0);
  w.writeU8(0x00); w.writeU32(y >>> 0);
  w.writeU8(0x00); w.writeI32(z | 0);
  return _close(w);
}
const HOUSE_KIND_CODE = Object.freeze({ item: 0, wall: 1, door: 2, floor: 3, misc: 4, teleport: 5 });
function buildHouseAddItem(g, x, y, kind = 'item') {
  const w = _open(0x06);
  w.writeU8(0x00); w.writeU32(g >>> 0);
  w.writeU8(0x00); w.writeU32(x >>> 0);
  w.writeU8(0x00); w.writeU32(y >>> 0);
  // NodeUO extension: one optional kind byte before the standard 0x0A
  // terminator. Classic clients omit it and remain fully compatible.
  w.writeU8(HOUSE_KIND_CODE[kind] ?? 0);
  return _close(w);
}
function buildHouseExit()           { return _close(_open(0x0C)); }
function buildHouseAddStair(g, x, y){
  const w = _open(0x0D);
  w.writeU8(0x00); w.writeU32(g >>> 0);
  w.writeU8(0x00); w.writeU32(x >>> 0);
  w.writeU8(0x00); w.writeU32(y >>> 0);
  return _close(w);
}
function buildHouseSync()           { return _close(_open(0x0E)); }
function buildHouseClear()          { return _close(_open(0x10)); }
function buildHouseGoToFloor(floor) {
  const w = _open(0x12);
  w.writeU32(0);
  w.writeU8(floor & 0xff);
  return _close(w);
}
function buildHouseAddRoof(g, x, y, z) {
  const w = _open(0x13);
  w.writeU8(0x00); w.writeU32(g >>> 0);
  w.writeU8(0x00); w.writeU32(x >>> 0);
  w.writeU8(0x00); w.writeU32(y >>> 0);
  w.writeU8(0x00); w.writeI32(z | 0);
  return _close(w);
}
function buildHouseDeleteRoof(g, x, y, z) {
  const w = _open(0x14);
  w.writeU8(0x00); w.writeU32(g >>> 0);
  w.writeU8(0x00); w.writeU32(x >>> 0);
  w.writeU8(0x00); w.writeU32(y >>> 0);
  w.writeU8(0x00); w.writeI32(z | 0);
  return _close(w);
}
function buildHouseRevert()         { return _close(_open(0x1A)); }

// ---------- Manager ----------------------------------------------------

class HouseCustomizationManager {
  constructor() {
    this.state = HouseCustomState.Idle;
    this.targetSerial = 0;
    this.currentFloor = 1;
    /** active brush graphic (wall/floor/door/roof/stair) */
    this.brush = 0;
    this.brushKind = 'item';   // 'item' | 'roof' | 'stair' | 'eraser'
    this.previewX = null;
    this.previewY = null;
    this.previewZ = 0;
    this._installed = false;
    this._requestId = 0;
    this.toolState = { history: null, templates: [], validation: null };
    this.draftTiles = [];
    this._draftBackup = [];
  }
  install() {
    if (this._installed) return;
    this._installed = true;
    bus.on('house:custom-start', ({ serial }) => this.beginEdit(serial));
    bus.on('house:custom-end',   () => this.exit());
    bus.on('nodeuo:house-tools', ({ payload }) => {
      this.toolState = {
        history: payload?.history ?? this.toolState.history,
        templates: payload?.templates ?? this.toolState.templates,
        validation: payload?.validation ?? null,
        message: payload?.message ?? '',
        ok: payload?.ok,
      };
      bus.emit('house:tools-result', this.toolState);
    });
  }

  // High-level state transitions ------------------------------------------
  beginEdit(serial) {
    this.state = HouseCustomState.Editing;
    this.targetSerial = serial >>> 0;
    this.currentFloor = 1;
    this.draftTiles = [];
    this._draftBackup = [];
    bus.emit('house:draft-changed', { tiles: [] });
    bus.emit('house:custom-state', { state: this.state });
  }
  exit() {
    if (this.state === HouseCustomState.Idle) return;
    try { net.send(buildHouseExit()); } catch { /* socket */ }
    this._finishLocal();
  }
  _finishLocal() {
    this.state = HouseCustomState.Idle;
    this.targetSerial = 0;
    this.clearPreviewTile();
    this.draftTiles = [];
    this._draftBackup = [];
    bus.emit('house:draft-changed', { tiles: [] });
    bus.emit('house:custom-state', { state: this.state });
    bus.emit('house:brush-changed', null);
  }

  setBrush(graphic, kind = 'item') {
    this.brush = graphic | 0; this.brushKind = kind;
    // Audit rev.4 P3 — surface preview state on the bus so the tile
    // renderer can paint a half-transparent ghost of the active
    // brush at the cursor tile during edit. The renderer subscribes
    // and reads the latest `brush`, `brushKind`, and the cursor
    // world tile to draw the preview.
    bus.emit('house:brush-changed', { graphic: this.brush, kind: this.brushKind });
  }

  /** Audit rev.4 P3 — preview-tile coordinates updated by the
   *  game-scene mouse-move handler whenever the cursor moves over
   *  a tile during edit. Reading this from the tile renderer lets
   *  the preview ghost track the cursor at the user's frame rate
   *  without a bus event per pixel. */
  setPreviewTile(x, y, z = 0) {
    this.previewX = x | 0;
    this.previewY = y | 0;
    this.previewZ = (z | 0) + 7 + (Math.max(1, this.currentFloor | 0) - 1) * 20;
  }

  clearPreviewTile() {
    this.previewX = null;
    this.previewY = null;
    this.previewZ = 0;
  }

  isPreviewActive() {
    return this.state === HouseCustomState.Editing
      && this.brush !== 0
      && this.previewX != null
      && this.previewY != null;
  }
  toggleEraser() {
    this.state = this.state === HouseCustomState.Erasing
      ? HouseCustomState.Editing
      : HouseCustomState.Erasing;
    bus.emit('house:custom-state', { state: this.state });
  }
  goToFloor(floor) {
    this.currentFloor = floor | 0;
    try { net.send(buildHouseGoToFloor(this.currentFloor)); } catch { /* socket */ }
  }
  backup()  {
    this._draftBackup = this.draftTiles.map((tile) => ({ ...tile }));
    try { net.send(buildHouseBackup()); } catch { /* socket */ }
  }
  restore() {
    this.draftTiles = this._draftBackup.map((tile) => ({ ...tile }));
    bus.emit('house:draft-changed', { tiles: this.draftTiles });
    try { net.send(buildHouseRestore()); } catch { /* socket */ }
  }
  commit()  {
    try { net.send(buildHouseCommit()); } catch { /* socket */ }
    this._finishLocal();
  }
  sync()    { try { net.send(buildHouseSync());    } catch { /* socket */ } }
  clear()   {
    this.draftTiles = [];
    bus.emit('house:draft-changed', { tiles: [] });
    try { net.send(buildHouseClear()); } catch { /* socket */ }
  }
  revert()  {
    this.draftTiles = [];
    bus.emit('house:draft-changed', { tiles: [] });
    try { net.send(buildHouseRevert()); } catch { /* socket */ }
  }

  _tool(kind, payload = {}) {
    if (!net.supportsNodeUO?.(NodeUOCapability.HouseTools)) return false;
    try {
      net.send(extNodeUOHouseTools({ kind, requestId: ++this._requestId, payload }));
      return true;
    } catch { return false; }
  }
  undo() { return this._tool(NodeUOHouseToolsMessage.Undo) || (this.restore(), false); }
  redo() { return this._tool(NodeUOHouseToolsMessage.Redo); }
  validate() { return this._tool(NodeUOHouseToolsMessage.Validate); }
  copyArea(x1, y1, x2, y2, zMin = -20, zMax = 100) {
    return this._tool(NodeUOHouseToolsMessage.Copy, { x1, y1, x2, y2, zMin, zMax });
  }
  pasteAt(x, y, zOffset = 0, replace = false) {
    return this._tool(NodeUOHouseToolsMessage.Paste, { x, y, zOffset, replace });
  }
  saveTemplate(name, rect = null) {
    return this._tool(NodeUOHouseToolsMessage.SaveTemplate, { name, rect });
  }
  applyTemplate(name, x, y, zOffset = 0, replace = false) {
    return this._tool(NodeUOHouseToolsMessage.ApplyTemplate, { name, x, y, zOffset, replace });
  }

  // Per-tile authoring -----------------------------------------------------

  /** Place / erase based on current brush kind at (x, y, z). */
  place(x, y, z) {
    if (this.state !== HouseCustomState.Editing) return;
    if (!this.brush) return;
    const floorZ = (z | 0) + 7 + (Math.max(1, this.currentFloor | 0) - 1) * 20;
    if (this.brushKind === 'roof') {
      try { net.send(buildHouseAddRoof(this.brush, x, y, floorZ)); } catch { /* socket */ }
    } else if (this.brushKind === 'stair') {
      try { net.send(buildHouseAddStair(this.brush, x, y)); } catch { /* socket */ }
    } else {
      try { net.send(buildHouseAddItem(this.brush, x, y, this.brushKind)); } catch { /* socket */ }
    }
    this.draftTiles.push({
      graphic: this.brush | 0, kind: this.brushKind,
      x: x | 0, y: y | 0, z: floorZ,
    });
    bus.emit('house:draft-changed', { tiles: this.draftTiles });
  }
  erase(graphic, x, y, z) {
    if (this.state === HouseCustomState.Idle) return;
    if (this.brushKind === 'roof') {
      try { net.send(buildHouseDeleteRoof(graphic, x, y, z | 0)); } catch { /* socket */ }
    } else {
      try { net.send(buildHouseDeleteItem(graphic, x, y, z | 0)); } catch { /* socket */ }
    }
    for (let i = this.draftTiles.length - 1; i >= 0; i--) {
      const tile = this.draftTiles[i];
      if (tile.x === (x | 0) && tile.y === (y | 0)) {
        this.draftTiles.splice(i, 1);
        break;
      }
    }
    bus.emit('house:draft-changed', { tiles: this.draftTiles });
  }
}

export const houseCustomization = new HouseCustomizationManager();
