// TCP socket → WebSocket-shaped adapter.
//
// NetState was written against the `ws` library's WebSocket interface (one
// 'message' event per framed binary blob). Real UO clients (UO Steam, Razor,
// stock OSI client, ClassicUO desktop) talk raw TCP. This adapter wraps a
// `net.Socket` so it looks like a WebSocket from NetState's perspective —
// same callbacks, same `send(buf, {binary})`, same `readyState`.
//
// Key behaviour the adapter papers over:
//
//   1. **Framing** — WS gives one frame per 'message'; TCP gives a stream.
//      NetState already buffers and frames via `frameIncoming` in its
//      `_feed` loop, so we just forward each TCP 'data' chunk as one
//      'message' event with `isBinary = true`. The framer cooperates: it
//      consumes whole packets and leaves any partial tail in the buffer.
//
//   2. **Bare seed prefix** — Older UO protocol revisions (and even modern
//      ones in compat mode) prepend a 4-byte LITTLE-ENDIAN seed BEFORE the
//      first opcode-prefixed packet. The seed is the client's "session id"
//      that ServUO uses to bind a relay handoff. When the first byte isn't
//      a known login opcode (0xEF, 0x80, 0x91), we strip the leading 4
//      bytes and continue framing normally. ENABLE_LOGIN_PACKET_EF
//      (modern clients) sends BOTH bare seed AND 0xEF, so the same strip
//      works there too — handleLoginSeed pulls the seed from inside 0xEF
//      and the bare prefix is discarded harmlessly.
//
//   3. **Lifecycle** — net.Socket emits 'close' when either side ends. We
//      mirror it as 'close' on the adapter so NetState's _onClose runs
//      and cleans up world state (drops carried items, broadcasts removal,
//      clears callbacks).

import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';

/** Login-flow opcodes that legitimately appear as the FIRST byte after the
 *  TCP handshake on a server that does not require a bare seed prefix. If
 *  we see one of these, we skip the strip — the client is in the modern
 *  "0xEF embeds the seed" mode. */
const KNOWN_FIRST_OPCODES = new Set([0xEF, 0x80, 0x91]);

export class TcpAdapter extends EventEmitter {
  /** @param {import('node:net').Socket} socket */
  constructor(socket) {
    super();
    this.socket = socket;
    /** @type {'arraybuffer' | 'nodebuffer'} */
    this.binaryType = 'nodebuffer';
    /** Mirrors WebSocket.readyState: 0=connecting, 1=open, 2=closing, 3=closed. */
    this.readyState = 1;
    this._seedHandled = false;
    /** Used to buffer the first chunk if it arrives in pieces shorter than 4 bytes. */
    this._seedBuf = null;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit('close');
    });
    socket.on('error', (err) => {
      this.emit('error', err);
    });
    // Disable Nagle so login handshake pings don't get coalesced into the
    // first reply. UO clients are tolerant but this matches ServUO's
    // SocketAsyncEventArgs configuration and shaves a few ms off login.
    socket.setNoDelay?.(true);
  }

  /** Bytes queued in Node's writable stream. NetState uses the same property
   * as WebSocket.bufferedAmount to disconnect a peer that cannot keep up. */
  get bufferedAmount() {
    return Number(this.socket?.writableLength) || 0;
  }

  _onData(chunk) {
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!this._seedHandled) {
      // Concatenate any earlier short chunk so we have ≥1 byte to inspect.
      if (this._seedBuf) {
        buf = Buffer.concat([this._seedBuf, buf]);
        this._seedBuf = null;
      }
      if (buf.length === 0) return;
      const firstByte = buf[0];
      if (KNOWN_FIRST_OPCODES.has(firstByte)) {
        // Modern flow — first packet is opcode-prefixed. No strip.
        this._seedHandled = true;
      } else {
        if (buf.length < 4) {
          // Need 4 bytes to decide. Hold and wait for more.
          this._seedBuf = buf;
          return;
        }
        // Bare 4-byte seed. We don't need its value (handleLoginSeed
        // reads the seed embedded in 0xEF, and devAutoAccept bypasses
        // the seed check anyway). Drop the prefix and proceed.
        buf = buf.subarray(4);
        this._seedHandled = true;
        if (buf.length === 0) return;
      }
    }
    this.emit('message', buf, true);
  }

  /**
   * @param {Uint8Array | Buffer} payload
   * @param {{ binary?: boolean }} [_opts] — ignored; TCP is always binary.
   */
  send(payload, _opts) {
    if (this.readyState !== 1) return;
    const b = Buffer.isBuffer(payload)
      ? payload
      : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
    try {
      this.socket.write(b);
    } catch (e) {
      // Socket closed underneath us — surface as error so NetState can clean up.
      this.emit('error', e);
    }
  }

  /**
   * @param {number} [_code]   ignored — TCP has no close code
   * @param {string} [_reason] ignored — TCP has no close reason
   */
  close(_code, _reason) {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    try { this.socket.end(); } catch { /* ignore */ }
    // Hard-destroy after a short grace period so a peer that doesn't FIN
    // doesn't leave us with a half-open socket forever.
    setTimeout(() => {
      try { this.socket.destroy(); } catch { /* ignore */ }
    }, 200).unref();
  }
}
