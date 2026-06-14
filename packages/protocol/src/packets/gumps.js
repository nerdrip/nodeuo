// 0xB0 DisplayGump — server asks the client to render a generic gump.
// 0xB1 GumpResponse — client reply with the picked button + switches + text fields.
//
// A "gump" in UO is a UI composition described in a small DSL of commands:
//   { page N }         — start page N (0 = always visible)
//   { noclose }        — disable right-click close
//   { resizepic x y id w h } — 3x3 window background
//   { text x y hue textId }  — label (textId indexes into the text table)
//   { button x y upId downId ?? pageOrReturn ?? ret } — clickable button
//   { radio x y offId onId state returnValue }
//   { checkbox x y offId onId state returnValue }
//   { textentry x y w h hue entryId initialTextId } — user input
//
// Full ServUO lookup: Server/Gumps/Gump.cs (Layout property) + RenderLayout.
// The wire format is: ASCII layout string (length-prefixed u16) + u16 textCount
// + textCount × length-prefixed Unicode strings.
//
// `GumpBuilder` is a small fluent builder producing both the layout and the
// text table, then the `displayGump(state, layout, texts, serial, gumpId)` API
// wraps it into a 0xB0 packet.

import { PacketWriter } from '../buffer.js';

/**
 * Convenience builder. Accumulates layout commands + a text table and
 * compiles into (layout: string, texts: string[]).
 */
export class GumpBuilder {
  constructor() {
    /** @type {string[]} */
    this._cmds = [];
    /** @type {string[]} */
    this._texts = [];
  }

  _addText(s) {
    const idx = this._texts.length;
    this._texts.push(s);
    return idx;
  }

  page(n) { this._cmds.push(`{ page ${n | 0} }`); return this; }
  noClose() { this._cmds.push(`{ noclose }`); return this; }
  noMove() { this._cmds.push(`{ nomove }`); return this; }
  noResize() { this._cmds.push(`{ noresize }`); return this; }
  group(n) { this._cmds.push(`{ group ${n | 0} }`); return this; }

  /**
   * 3x3 tiled background pattern. `gumpId` is a gump art id — common choices:
   * 0x0A28 small parchment, 0x13BE stone panel, 0x2436 scroll, 0x5100 AoS paper.
   */
  background(x, y, w, h, gumpId = 0x13BE) {
    this._cmds.push(`{ resizepic ${x | 0} ${y | 0} ${gumpId | 0} ${w | 0} ${h | 0} }`);
    return this;
  }

  /**
   * Static label. `hue` is an AoS color; 0 = default.
   */
  label(x, y, hue, text) {
    const idx = this._addText(String(text ?? ''));
    this._cmds.push(`{ text ${x | 0} ${y | 0} ${hue | 0} ${idx} }`);
    return this;
  }

  /**
   * Clickable button. `retOrPage` is the numeric return id sent back to the
   * server (if `kind === 1`) or page switched to client-side (if kind === 0).
   */
  button(x, y, upId, downId, kind, retOrPage) {
    this._cmds.push(`{ button ${x | 0} ${y | 0} ${upId | 0} ${downId | 0} ${kind | 0} 0 ${retOrPage | 0} }`);
    return this;
  }

  checkbox(x, y, offId, onId, checked, returnId) {
    this._cmds.push(`{ checkbox ${x | 0} ${y | 0} ${offId | 0} ${onId | 0} ${checked ? 1 : 0} ${returnId | 0} }`);
    return this;
  }

  radio(x, y, offId, onId, checked, returnId) {
    this._cmds.push(`{ radio ${x | 0} ${y | 0} ${offId | 0} ${onId | 0} ${checked ? 1 : 0} ${returnId | 0} }`);
    return this;
  }

  textEntry(x, y, w, h, hue, entryId, initialText = '') {
    const idx = this._addText(initialText);
    this._cmds.push(`{ textentry ${x | 0} ${y | 0} ${w | 0} ${h | 0} ${hue | 0} ${entryId | 0} ${idx} }`);
    return this;
  }

  compile() {
    return { layout: this._cmds.join(''), texts: this._texts.slice() };
  }
}

/**
 * 0xB0 DisplayGump. Variable length.
 *
 * @param {Object} p
 * @param {number} p.serial     target mobile serial (usually the viewer).
 * @param {number} p.gumpId     client-side gump type id (arbitrary; response echoes it).
 * @param {number} [p.x]
 * @param {number} [p.y]
 * @param {string} p.layout
 * @param {string[]} [p.texts]
 */
export function displayGump({ serial, gumpId, x = 0, y = 0, layout, texts = [] }) {
  const w = new PacketWriter(128);
  w.writeU8(0xB0);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU32(serial >>> 0);
  w.writeU32(gumpId >>> 0);
  w.writeU32(x >>> 0);
  w.writeU32(y >>> 0);
  const layoutBytes = new TextEncoder().encode(layout);
  w.writeU16((layoutBytes.length + 1) & 0xFFFF);   // includes NUL
  for (const b of layoutBytes) w.writeU8(b);
  w.writeU8(0);
  w.writeU16(texts.length & 0xFFFF);
  for (const t of texts) {
    const tb = new Uint8Array(t.length * 2);
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i) & 0xFFFF;
      tb[i * 2] = (c >> 8) & 0xFF;    // big-endian Unicode
      tb[i * 2 + 1] = c & 0xFF;
    }
    w.writeU16(t.length & 0xFFFF);
    for (const b of tb) w.writeU8(b);
  }
  w.setU16At(lenPos, w.length);
  return w.bytes();
}

/**
 * Parse a 0xB1 GumpResponse from the client.
 *
 * Layout:
 *   u8  0xB1
 *   u16 length
 *   u32 mobileSerial
 *   u32 gumpId
 *   u32 buttonId
 *   u32 switchCount
 *   u32[switchCount] switches         (radio/checkbox return ids that were on)
 *   u32 textCount
 *   textCount × { u16 entryId, u16 charCount, char16[charCount] } — BE Unicode
 *
 * @param {Uint8Array} pkt
 */
export function readGumpResponse(pkt) {
  if (pkt.length < 19 || pkt[0] !== 0xB1) {
    throw new Error('not a 0xB1 gump response');
  }
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  let o = 1;
  const len = dv.getUint16(o); o += 2; void len;
  const serial = dv.getUint32(o); o += 4;
  const gumpId = dv.getUint32(o); o += 4;
  const buttonId = dv.getUint32(o); o += 4;
  const switchCount = dv.getUint32(o); o += 4;
  const switches = [];
  for (let i = 0; i < switchCount; i++) {
    switches.push(dv.getUint32(o)); o += 4;
  }
  const textCount = dv.getUint32(o); o += 4;
  /** @type {{entryId:number, text:string}[]} */
  const textEntries = [];
  for (let i = 0; i < textCount; i++) {
    const entryId = dv.getUint16(o); o += 2;
    const chars = dv.getUint16(o); o += 2;
    let text = '';
    for (let j = 0; j < chars; j++) {
      const hi = dv.getUint8(o); o += 1;
      const lo = dv.getUint8(o); o += 1;
      text += String.fromCharCode((hi << 8) | lo);
    }
    textEntries.push({ entryId, text });
  }
  return { serial, gumpId, buttonId, switches, textEntries };
}

/**
 * 0xBF 0x24 CloseGump — tell the client to dismiss a specific gump id.
 *
 * @param {number} gumpId
 * @param {number} [buttonId]  the value that the server considers "closed" (usually 0).
 */
export function closeGump(gumpId, buttonId = 0) {
  const w = new PacketWriter(16);
  w.writeU8(0xBF);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU16(0x0004); // subcmd: close gump
  w.writeU32(gumpId >>> 0);
  w.writeU32(buttonId >>> 0);
  w.setU16At(lenPos, w.length);
  return w.bytes();
}
