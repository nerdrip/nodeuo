// Binary buffer reader/writer for UO protocol packets.
// UO is big-endian on the wire. This module wraps a Uint8Array with a DataView
// and provides the reading/writing primitives used throughout ServUO's
// PacketReader / PacketWriter (Server/Network/PacketReader.cs & PacketWriter.cs).

/**
 * Low-level writer. Grows backing buffer exponentially when needed.
 * Writes big-endian for multi-byte integers (UO wire format).
 */
export class PacketWriter {
  /** @param {number} [initialSize] */
  constructor(initialSize = 64) {
    this.buf = new Uint8Array(initialSize);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    this.offset = 0;
  }

  /** @param {number} n additional bytes required from current offset */
  _ensure(n) {
    const need = this.offset + n;
    if (need <= this.buf.byteLength) return;
    let cap = this.buf.byteLength || 64;
    while (cap < need) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.offset));
    this.buf = nb;
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
  }

  /** @returns {Uint8Array} finalized bytes (zero-copy view over backing buffer) */
  bytes() {
    return this.buf.subarray(0, this.offset);
  }

  get length() { return this.offset; }

  writeU8(v)  { this._ensure(1); this.view.setUint8(this.offset, v & 0xff); this.offset += 1; }
  writeI8(v)  { this._ensure(1); this.view.setInt8(this.offset, v);         this.offset += 1; }
  writeU16(v) { this._ensure(2); this.view.setUint16(this.offset, v & 0xffff, false); this.offset += 2; }
  writeI16(v) { this._ensure(2); this.view.setInt16(this.offset, v, false);  this.offset += 2; }
  writeU32(v) { this._ensure(4); this.view.setUint32(this.offset, v >>> 0, false); this.offset += 4; }
  writeI32(v) { this._ensure(4); this.view.setInt32(this.offset, v, false);  this.offset += 4; }

  /**
   * Write ASCII null-terminated (for login, chars, account names).
   * @param {string} s
   * @param {number} [fixedLen] if set, pads/truncates to exactly this many bytes
   */
  writeAsciiNull(s, fixedLen) {
    const bytes = asciiBytes(s);
    if (fixedLen !== undefined) {
      this._ensure(fixedLen);
      for (let i = 0; i < fixedLen; i++) {
        this.buf[this.offset + i] = i < bytes.length ? bytes[i] : 0;
      }
      this.offset += fixedLen;
    } else {
      this._ensure(bytes.length + 1);
      this.buf.set(bytes, this.offset);
      this.offset += bytes.length;
      this.buf[this.offset++] = 0;
    }
  }

  /** Write ASCII fixed-length (no terminator). */
  writeAsciiFixed(s, fixedLen) {
    const bytes = asciiBytes(s);
    this._ensure(fixedLen);
    for (let i = 0; i < fixedLen; i++) {
      this.buf[this.offset + i] = i < bytes.length ? bytes[i] : 0;
    }
    this.offset += fixedLen;
  }

  /** Write UTF-16 BE null-terminated (UO Unicode strings). */
  writeUnicodeNull(s) {
    this._ensure(s.length * 2 + 2);
    for (let i = 0; i < s.length; i++) {
      this.view.setUint16(this.offset, s.charCodeAt(i), false);
      this.offset += 2;
    }
    this.view.setUint16(this.offset, 0, false);
    this.offset += 2;
  }

  /** Write UTF-16 BE fixed length in *characters* (no terminator). */
  writeUnicodeFixed(s, fixedChars) {
    this._ensure(fixedChars * 2);
    for (let i = 0; i < fixedChars; i++) {
      this.view.setUint16(this.offset, i < s.length ? s.charCodeAt(i) : 0, false);
      this.offset += 2;
    }
  }

  /** @param {Uint8Array} data */
  writeBytes(data) {
    this._ensure(data.length);
    this.buf.set(data, this.offset);
    this.offset += data.length;
  }

  /** Zero-fill `count` bytes. */
  writeZero(count) {
    this._ensure(count);
    this.buf.fill(0, this.offset, this.offset + count);
    this.offset += count;
  }

  /** Set big-endian u16 at arbitrary position (used to patch length field). */
  setU16At(pos, v) { this.view.setUint16(pos, v & 0xffff, false); }
  setU8At(pos, v)  { this.view.setUint8(pos, v & 0xff); }
}

/**
 * Low-level reader. Expects big-endian.
 */
export class PacketReader {
  /** @param {Uint8Array} buf */
  constructor(buf, offset = 0, length = buf.length - offset) {
    this._buffer = null;
    this._bytes = null;
    this.view = null;
    this.reset(buf, offset, length);
  }

  reset(buf, offset = 0, length = buf.length - offset) {
    this.buf = buf;
    if (this._buffer !== buf.buffer) {
      this._buffer = buf.buffer;
      this._bytes = new Uint8Array(buf.buffer);
      this.view = new DataView(buf.buffer);
    }
    const base = buf.byteOffset + offset;
    this.start = base;
    this.offset = base;
    this.end = base + length;
    return this;
  }

  get remaining() { return this.end - this.offset; }

  _check(n) { if (this.offset + n > this.end) throw new RangeError(`PacketReader underflow: need ${n}, have ${this.end - this.offset}`); }

  readU8()  { this._check(1); return this.view.getUint8(this.offset++); }
  readI8()  { this._check(1); return this.view.getInt8(this.offset++); }
  readU16() { this._check(2); const v = this.view.getUint16(this.offset, false); this.offset += 2; return v; }
  readI16() { this._check(2); const v = this.view.getInt16(this.offset, false);  this.offset += 2; return v; }
  readU32() { this._check(4); const v = this.view.getUint32(this.offset, false); this.offset += 4; return v; }
  readI32() { this._check(4); const v = this.view.getInt32(this.offset, false);  this.offset += 4; return v; }

  /** Read ASCII until null terminator (or until max bytes). */
  readAsciiNull(max = Infinity) {
    let s = '';
    while (this.offset < this.end && s.length < max) {
      const c = this._bytes[this.offset++];
      if (c === 0) return s;
      s += String.fromCharCode(c);
    }
    return s;
  }

  /** Read exactly `n` bytes as ASCII; stop at first null (ServUO behavior). */
  readAsciiFixed(n) {
    this._check(n);
    let s = '';
    let nullSeen = false;
    for (let i = 0; i < n; i++) {
      const c = this._bytes[this.offset + i];
      if (c === 0) nullSeen = true;
      else if (!nullSeen) s += String.fromCharCode(c);
    }
    this.offset += n;
    return s;
  }

  readUnicodeNull(maxChars = Infinity) {
    let s = '';
    while (this.offset + 1 < this.end && s.length < maxChars) {
      const c = this.view.getUint16(this.offset, false);
      this.offset += 2;
      if (c === 0) return s;
      s += String.fromCharCode(c);
    }
    return s;
  }

  readUnicodeFixed(nChars) {
    this._check(nChars * 2);
    let s = '';
    for (let i = 0; i < nChars; i++) {
      const c = this.view.getUint16(this.offset, false);
      this.offset += 2;
      if (c !== 0) s += String.fromCharCode(c);
    }
    return s;
  }

  /** Return a view over the next `n` bytes and advance. */
  readBytes(n) {
    this._check(n);
    const out = this._bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  skip(n) { this._check(n); this.offset += n; }
}

/** @param {string} s @returns {Uint8Array} */
function asciiBytes(s) {
  // UO ASCII is strict 7-bit; anything outside becomes '?'. We use a manual encoder
  // so high codepoints don't silently corrupt packets.
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c > 0x7f ? 0x3f : c;
  }
  return out;
}

// re-export helper for tests
export { asciiBytes as _asciiBytes };
