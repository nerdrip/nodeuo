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

import { PacketWriter } from '@uo/protocol';
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
function buildHouseAddItem(g, x, y) {
  const w = _open(0x06);
  w.writeU8(0x00); w.writeU32(g >>> 0);
  w.writeU8(0x00); w.writeU32(x >>> 0);
  w.writeU8(0x00); w.writeU32(y >>> 0);
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
  }
  install() {
    if (this._installed) return;
    this._installed = true;
    bus.on('house:custom-start', ({ serial }) => this.beginEdit(serial));
    bus.on('house:custom-end',   () => this.exit());
  }

  // High-level state transitions ------------------------------------------
  beginEdit(serial) {
    this.state = HouseCustomState.Editing;
    this.targetSerial = serial >>> 0;
    this.currentFloor = 1;
    bus.emit('house:custom-state', { state: this.state });
  }
  exit() {
    if (this.state === HouseCustomState.Idle) return;
    try { net.send(buildHouseExit()); } catch { /* socket */ }
    this.state = HouseCustomState.Idle;
    this.targetSerial = 0;
    this.clearPreviewTile();
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
    this.previewZ = z | 0;
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
  backup()  { try { net.send(buildHouseBackup());  } catch { /* socket */ } }
  restore() { try { net.send(buildHouseRestore()); } catch { /* socket */ } }
  commit()  { try { net.send(buildHouseCommit());  } catch { /* socket */ } }
  sync()    { try { net.send(buildHouseSync());    } catch { /* socket */ } }
  clear()   { try { net.send(buildHouseClear());   } catch { /* socket */ } }
  revert()  { try { net.send(buildHouseRevert());  } catch { /* socket */ } }

  // Per-tile authoring -----------------------------------------------------

  /** Place / erase based on current brush kind at (x, y, z). */
  place(x, y, z) {
    if (this.state !== HouseCustomState.Editing) return;
    if (!this.brush) return;
    if (this.brushKind === 'roof') {
      try { net.send(buildHouseAddRoof(this.brush, x, y, z | 0)); } catch { /* socket */ }
    } else if (this.brushKind === 'stair') {
      try { net.send(buildHouseAddStair(this.brush, x, y)); } catch { /* socket */ }
    } else {
      try { net.send(buildHouseAddItem(this.brush, x, y)); } catch { /* socket */ }
    }
  }
  erase(graphic, x, y, z) {
    if (this.state === HouseCustomState.Idle) return;
    if (this.brushKind === 'roof') {
      try { net.send(buildHouseDeleteRoof(graphic, x, y, z | 0)); } catch { /* socket */ }
    } else {
      try { net.send(buildHouseDeleteItem(graphic, x, y, z | 0)); } catch { /* socket */ }
    }
  }
}

export const houseCustomization = new HouseCustomizationManager();
