// Tests for the TCP↔WS adapter that lets legacy UO clients connect to
// the same NetState pipeline that browser clients use over WebSocket.
//
// Coverage:
//   1. Modern flow (first byte 0xEF): no seed strip, packet flows through.
//   2. Legacy flow (first byte not 0xEF/0x80/0x91): leading 4 bytes are
//      treated as bare seed and stripped before forwarding.
//   3. Short first chunk (<4 bytes) of a legacy stream: adapter buffers
//      until it has enough to decide.
//   4. Subsequent chunks bypass the seed-strip logic entirely.
//   5. send() forwards a Buffer to the underlying socket.
//   6. close() ends the socket and flips readyState.

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { TcpAdapter } from '../src/net/tcp-adapter.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.write = vi.fn(() => true);
    this.end = vi.fn();
    this.destroy = vi.fn();
    this.setNoDelay = vi.fn();
    this.cork = vi.fn();
    this.uncork = vi.fn();
    this.remoteAddress = '127.0.0.1';
    this.remotePort = 12345;
  }
}

describe('TcpAdapter', () => {
  it('forwards 0xEF-prefixed first chunk without strip (modern client)', () => {
    const sock = new FakeSocket();
    const adapter = new TcpAdapter(sock);
    const seen = [];
    adapter.on('message', (data, isBinary) => seen.push({ data, isBinary }));

    const pkt = Buffer.from([0xEF, 0x12, 0x34, 0x56, 0x78, 0xAA]);
    sock.emit('data', pkt);

    expect(seen).toHaveLength(1);
    expect(seen[0].isBinary).toBe(true);
    expect(Buffer.from(seen[0].data)).toEqual(pkt);
  });

  it('strips a bare 4-byte seed when first byte is unknown (legacy client)', () => {
    const sock = new FakeSocket();
    const adapter = new TcpAdapter(sock);
    const seen = [];
    adapter.on('message', (data) => seen.push(Buffer.from(data)));

    // 4-byte seed, then a 0x80 AccountLogin packet.
    const seed = Buffer.from([0x12, 0x34, 0x56, 0x78]);
    const after = Buffer.from([0x80, 0x01, 0x02]);
    sock.emit('data', Buffer.concat([seed, after]));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(after);
  });

  it('buffers a short first chunk until 4 bytes are available', () => {
    const sock = new FakeSocket();
    const adapter = new TcpAdapter(sock);
    const seen = [];
    adapter.on('message', (data) => seen.push(Buffer.from(data)));

    // Two 2-byte chunks of seed, then the first real packet.
    sock.emit('data', Buffer.from([0x12, 0x34]));
    expect(seen).toHaveLength(0); // not enough yet

    sock.emit('data', Buffer.from([0x56, 0x78, 0x80, 0x01]));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(Buffer.from([0x80, 0x01]));
  });

  it('does not re-strip on subsequent chunks', () => {
    const sock = new FakeSocket();
    const adapter = new TcpAdapter(sock);
    const seen = [];
    adapter.on('message', (data) => seen.push(Buffer.from(data)));

    // Modern flow — first 0xEF chunk.
    sock.emit('data', Buffer.from([0xEF, 0xAA, 0xBB]));
    // Subsequent chunk that LOOKS like a seed (first byte 0x12) — must
    // be passed through verbatim. Seed-strip only applies to the very
    // first bytes after connect.
    sock.emit('data', Buffer.from([0x12, 0x99, 0x88]));

    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(Buffer.from([0x12, 0x99, 0x88]));
  });

  it('forwards Uint8Array via send() to socket.write as a Buffer', () => {
    const sock = new FakeSocket();
    const adapter = new TcpAdapter(sock);

    const payload = new Uint8Array([0xA8, 0x01, 0x02, 0x03]);
    adapter.send(payload, { binary: true });

    expect(sock.write).toHaveBeenCalledTimes(1);
    const arg = sock.write.mock.calls[0][0];
    expect(Buffer.isBuffer(arg)).toBe(true);
    expect(arg).toEqual(Buffer.from(payload));
  });

  it('corks a same-turn packet burst without changing write order', async () => {
    const sock = new FakeSocket();
    const adapter = new TcpAdapter(sock);
    adapter.send(Uint8Array.of(0x11));
    adapter.send(Uint8Array.of(0x22));
    expect(sock.cork).toHaveBeenCalledTimes(1);
    expect(sock.write.mock.calls.map(([payload]) => payload[0])).toEqual([0x11, 0x22]);
    await Promise.resolve();
    expect(sock.uncork).toHaveBeenCalledTimes(1);
  });

  it('writes a batch through scatter/gather-friendly corking in packet order', () => {
    const sock = new FakeSocket();
    const adapter = new TcpAdapter(sock);
    expect(adapter.sendBatch([Uint8Array.of(0x33), Buffer.from([0x44, 0x45])])).toBe(true);
    expect(sock.cork).toHaveBeenCalledTimes(1);
    expect(sock.write.mock.calls.map(([payload]) => [...payload])).toEqual([[0x33], [0x44, 0x45]]);
    expect(sock.uncork).toHaveBeenCalledTimes(1);
  });

  it('close() ends the socket and flips readyState', () => {
    const sock = new FakeSocket();
    const adapter = new TcpAdapter(sock);

    expect(adapter.readyState).toBe(1);
    adapter.close();
    expect(adapter.readyState).toBe(2);
    expect(sock.end).toHaveBeenCalledTimes(1);
  });

  it('emits close when the socket closes', () => {
    const sock = new FakeSocket();
    const adapter = new TcpAdapter(sock);
    const onClose = vi.fn();
    adapter.on('close', onClose);

    sock.emit('close');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(adapter.readyState).toBe(3);
  });

  it('drops send() after close', () => {
    const sock = new FakeSocket();
    const adapter = new TcpAdapter(sock);
    sock.emit('close');
    adapter.send(new Uint8Array([0x01, 0x02]));
    expect(sock.write).not.toHaveBeenCalled();
  });
});
