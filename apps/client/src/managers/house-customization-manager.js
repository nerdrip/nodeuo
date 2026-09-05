// HouseCustomizationManager — drives the house-builder edit flow.
// Mirrors the action surface of CUO `Game/Managers/HouseCustomizationManager.cs`.
// The gump reads the extracted housedata catalogue; this manager keeps the
// draft state and emits byte-for-byte standard 0xD7 authoring commands.
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

import { PacketWriter } from '@uo/protocol';
import { NodeUOFeature, NodeUOHouseToolsMessage, NodeUOJsonKind } from '@uo/nodeuo-protocol';
import { net } from '../net/net-client.js';
import { buildCustomHouseDataRequest } from '../net/outgoing.js';
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
function buildHouseBackup()         { return _close(_open(0x02)); }
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
function buildHouseAddItem(g, x, y) {
  const w = _open(0x06);
  w.writeU8(0x00); w.writeU32(g >>> 0);
  w.writeU8(0x00); w.writeU32(x >>> 0);
  w.writeU8(0x00); w.writeU32(y >>> 0);
  // Keep 0xD7 byte-for-byte standard so this client can customize on ServUO,
  // POL and other emulators. NodeUO derives the piece role from housedata.
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
    this._lastCollaborationCursorAt = 0;
    this._commitPending = false;
  }
  install() {
    if (this._installed) return;
    this._installed = true;
    bus.on('net:close', () => this._finishLocal());
    bus.on('house:custom-start', ({ serial }) => this.beginEdit(serial));
    bus.on('house:custom-end',   () => this._finishLocal());
    bus.on('house:design', ({ serial, tiles }) => {
      if (this.state === HouseCustomState.Idle || (serial >>> 0) !== this.targetSerial) return;
      const foundation = world.items.get(this.targetSerial);
      if (!foundation || !Array.isArray(tiles)) return;
      this.draftTiles = tiles.map((tile) => ({
        graphic: tile.graphic >>> 0,
        kind: tile.kind ?? 'item',
        x: (foundation.x | 0) + (tile.x | 0),
        y: (foundation.y | 0) + (tile.y | 0),
        z: (foundation.z | 0) + (tile.z | 0),
      }));
      bus.emit('house:draft-changed', { tiles: this.draftTiles });
    });
    bus.on('nodeuo:house-tools', ({ payload }) => {
      this.toolState = {
        operation: payload?.operation ?? null,
        history: payload?.history ?? this.toolState.history,
        templates: payload?.templates ?? this.toolState.templates,
        validation: payload?.validation ?? null,
        message: payload?.message ?? '',
        ok: payload?.ok,
      };
      bus.emit('house:tools-result', this.toolState);
      if (payload?.operation === 'commit') {
        this._commitPending = false;
        if (payload.ok) this._finishLocal();
      }
    });
  }

  // High-level state transitions ------------------------------------------
  beginEdit(serial) {
    this.state = HouseCustomState.Editing;
    this.targetSerial = serial >>> 0;
    this.currentFloor = 1;
    this.draftTiles = [];
    this._draftBackup = [];
    this._commitPending = false;
    bus.emit('house:draft-changed', { tiles: [] });
    bus.emit('house:custom-state', { state: this.state });
    this._collaborate('join');
    // Request the editable state even when its revision matches our cached
    // committed design. Standard shards can freeze fixtures only for the
    // customizing client, so the cached non-editing payload is insufficient.
    try { net.send(buildCustomHouseDataRequest(this.targetSerial)); } catch { /* socket */ }
  }
  exit() {
    if (this.state === HouseCustomState.Idle) return;
    try { net.send(buildHouseExit()); } catch { /* socket */ }
    this._finishLocal();
  }
  _finishLocal() {
    this._collaborate('leave');
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
    const now = performance.now();
    if (now - this._lastCollaborationCursorAt >= 100) {
      this._lastCollaborationCursorAt = now;
      this._collaborate('cursor', { x: this.previewX, y: this.previewY, z: this.previewZ,
        tool: this.brushKind });
    }
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
    if (this._commitPending) return false;
    const waitsForResult = net.supportsNodeUO?.(NodeUOFeature.HouseTools) === true;
    this._commitPending = waitsForResult;
    try { net.send(buildHouseCommit()); } catch { /* socket */ }
    if (!waitsForResult) this._finishLocal();
    return !waitsForResult;
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
    if (!net.supportsNodeUO?.(NodeUOFeature.HouseTools)) return false;
    try {
      const requestId = ++this._requestId;
      return net.sendNodeUOMessage({
        kind: NodeUOJsonKind.Event, feature: 'housing.tools',
        payload: { eventKind: kind, requestId, data: payload },
        idempotencyKey: `house:${requestId}`,
      });
    } catch { return false; }
  }
  _collaborate(operation, payload = {}) {
    if (!net.nodeUOJsonTransport || !net.supportsNodeUO?.('housing.collaboration')) return false;
    return net.sendNodeUOMessage({ kind: NodeUOJsonKind.Event, feature: 'housing.collaboration',
      delivery: operation === 'cursor' ? 'latest' : 'reliable',
      replace: operation === 'cursor' ? 'house-cursor' : undefined,
      ttlMs: operation === 'cursor' ? 1000 : undefined,
      payload: { operation, data: { ...payload, houseSerial: this.targetSerial >>> 0 } },
    });
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

  _relativeToFoundation(x, y, z = 0) {
    const foundation = world.items.get(this.targetSerial);
    return foundation
      ? { x: (x | 0) - (foundation.x | 0), y: (y | 0) - (foundation.y | 0), z: (z | 0) - (foundation.z | 0) }
      : { x: x | 0, y: y | 0, z: z | 0 };
  }

  /** Place / erase based on current brush kind at (x, y, z). */
  place(x, y, z) {
    if (this.state !== HouseCustomState.Editing) return;
    if (!this.brush) return;
    const floorZ = (z | 0) + 7 + (Math.max(1, this.currentFloor | 0) - 1) * 20;
    const relative = this._relativeToFoundation(x, y, floorZ);
    if (this.brushKind === 'roof') {
      try { net.send(buildHouseAddRoof(this.brush, relative.x, relative.y, relative.z)); } catch { /* socket */ }
    } else if (this.brushKind === 'stair') {
      try { net.send(buildHouseAddStair(this.brush, relative.x, relative.y)); } catch { /* socket */ }
    } else {
      try { net.send(buildHouseAddItem(this.brush, relative.x, relative.y)); } catch { /* socket */ }
    }
    this.draftTiles.push({
      graphic: this.brush | 0, kind: this.brushKind,
      x: x | 0, y: y | 0, z: floorZ,
    });
    bus.emit('house:draft-changed', { tiles: this.draftTiles });
  }
  erase(graphic, x, y, z) {
    if (this.state === HouseCustomState.Idle) return;
    const relative = this._relativeToFoundation(x, y, z);
    if (this.brushKind === 'roof') {
      try { net.send(buildHouseDeleteRoof(graphic, relative.x, relative.y, relative.z)); } catch { /* socket */ }
    } else {
      try { net.send(buildHouseDeleteItem(graphic, relative.x, relative.y, relative.z)); } catch { /* socket */ }
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
