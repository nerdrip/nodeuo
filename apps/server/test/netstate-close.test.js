// Regression test for S-05: NetState._onClose must clear the per-session
// interaction maps (targetCallbacks, activeGumps, activePrompts, openContainers).
// Previously these accumulated across reconnects on long-running shards and
// — worse — a reconnecting client could inherit a dangling target callback
// registered by the previous session.

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  MAX_INCOMING_PACKETS_PER_SECOND,
  MAX_PACKETS_PER_TURN,
  MAX_PENDING_RECEIVE_BYTES,
  MAX_PENDING_SEND_BYTES,
  SOFT_PENDING_SEND_BYTES,
  NetState,
  Stage,
} from '../src/net/net-state.js';

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.binaryType = '';
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.close = vi.fn();
    this.send = vi.fn();
  }
}

function makeCtx() {
  return {
    id: 1,
    world: { mobiles: new Map() },
    authKeys: null,
    config: { logPackets: false, huffmanOutgoing: false },
    handlers: {},
  };
}

describe('NetState._onClose', () => {
  it('clears every per-session interaction map on disconnect', () => {
    const ws = new FakeWs();
    const state = new NetState(ws, makeCtx());

    // Populate the maps that handlers normally attach lazily.
    state.targetCallbacks = new Map([[1, () => {}]]);
    state.activeGumps = new Map([[2, {}]]);
    state.activePrompts = new Map([[3, () => {}]]);
    state.openContainers.add(0x40000001);

    ws.emit('close');

    expect(state.targetCallbacks.size).toBe(0);
    expect(state.activeGumps.size).toBe(0);
    expect(state.activePrompts.size).toBe(0);
    expect(state.openContainers.size).toBe(0);
  });

  it('tolerates missing maps (handlers never attached them)', () => {
    const ws = new FakeWs();
    new NetState(ws, makeCtx());
    // Don't attach targetCallbacks / activeGumps / activePrompts — the cleanup
    // must use optional chaining and never throw.
    expect(() => ws.emit('close')).not.toThrow();
  });

  it('runs cleanup when the server initiates close', () => {
    const ws = new FakeWs();
    const state = new NetState(ws, makeCtx());
    state.targetCallbacks = new Map([[1, () => {}]]);

    state.close('protocol error');

    expect(ws.close).toHaveBeenCalledOnce();
    expect(state.targetCallbacks.size).toBe(0);
    expect(state._cleanupDone).toBe(true);
  });

  it('fuzzes gump-target lifecycle cleanup across disconnect', () => {
    for (let seed = 1; seed <= 32; seed++) {
      const ws = new FakeWs();
      const state = new NetState(ws, makeCtx());
      state.targetCallbacks = new Map();
      state.activeGumps = new Map();
      state.activePrompts = new Map();
      for (let i = 0; i < (seed * 17) % 19; i++) state.targetCallbacks.set(i, { timeout: null });
      for (let i = 0; i < (seed * 11) % 23; i++) state.activeGumps.set(i, { consumed: false });
      for (let i = 0; i < (seed * 7) % 13; i++) state.activePrompts.set(i, () => {});
      ws.emit('close');
      expect(state.targetCallbacks.size + state.activeGumps.size + state.activePrompts.size).toBe(0);
    }
  });

  it('disconnects a slow client before its ordered send queue grows unbounded', () => {
    const ws = new FakeWs();
    const state = new NetState(ws, makeCtx());
    ws.bufferedAmount = MAX_PENDING_SEND_BYTES + 1;

    state.send(new Uint8Array([0x73, 0x00]));

    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledOnce();
    expect(state._cleanupDone).toBe(true);
  });

  it('coalesces cosmetic packets while a client is above the soft watermark', () => {
    vi.useFakeTimers();
    const ws = new FakeWs();
    const state = new NetState(ws, makeCtx());
    ws.bufferedAmount = SOFT_PENDING_SEND_BYTES + 1;
    state.sendCosmetic(new Uint8Array([0x4f, 1]), 'light');
    state.sendCosmetic(new Uint8Array([0x4f, 2]), 'light');
    expect(ws.send).not.toHaveBeenCalled();
    expect(state.backpressureStats).toMatchObject({ deferred: 1, coalesced: 1 });
    ws.bufferedAmount = 0;
    vi.advanceTimersByTime(25);
    expect(ws.send).toHaveBeenCalledOnce();
    expect(state.backpressureStats.flushed).toBe(1);
    state.close('test');
    vi.useRealTimers();
  });
});

describe('NetState._feed framing', () => {
  it('accepts in-world keepalives and movements without poisoning the stream', () => {
    const ping = vi.fn();
    const move = vi.fn();
    const ctx = makeCtx();
    ctx.handlers = { 0x73: ping, 0x02: move };
    const state = new NetState(new FakeWs(), ctx);
    state.stage = Stage.InWorld;

    for (let seq = 0; seq <= 0xff; seq++) {
      // Exercise fragmented keepalive input as well as an ordinary complete
      // movement immediately after it. The old in-world filter stripped 0x73
      // and left `seq` to become the next packet's opcode.
      state._feed(new Uint8Array([0x73]));
      state._feed(new Uint8Array([seq]));
      state._feed(new Uint8Array([0x02, 0x07, seq, 0x2b, 0xfb, 0x96, 0x02]));
    }

    expect(ping).toHaveBeenCalledTimes(256);
    expect(move).toHaveBeenCalledTimes(256);
    expect(state._rx).toHaveLength(0);
  });

  it('dispatches a valid movement before discarding an unknown trailing byte', () => {
    const move = vi.fn();
    const ctx = makeCtx();
    ctx.handlers = { 0x02: move };
    const state = new NetState(new FakeWs(), ctx);
    state.stage = Stage.InWorld;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const movement = new Uint8Array([0x02, 0x07, 0x40, 0x2b, 0xfb, 0x96, 0x02]);

    try {
      state._feed(new Uint8Array([...movement, 0x26]));
    } finally {
      warn.mockRestore();
    }

    expect(move).toHaveBeenCalledOnce();
    expect(Array.from(move.mock.calls[0][1])).toEqual(Array.from(movement));
    expect(state._rx).toHaveLength(0);
    expect(state._closed).toBe(false);
  });

  it('yields between large coalesced packet batches', async () => {
    const ping = vi.fn();
    const ctx = makeCtx();
    ctx.handlers = { 0x73: ping };
    const state = new NetState(new FakeWs(), ctx);
    const count = MAX_PACKETS_PER_TURN + 17;
    const input = new Uint8Array(count * 2);
    for (let i = 0; i < count; i++) {
      input[i * 2] = 0x73;
      input[i * 2 + 1] = i & 0xff;
    }

    state._feed(input);
    expect(ping).toHaveBeenCalledTimes(MAX_PACKETS_PER_TURN);
    await new Promise((resolve) => setImmediate(resolve));
    expect(ping).toHaveBeenCalledTimes(count);
    expect(state._rx).toHaveLength(0);
  });

  it('closes receive-buffer and packet-rate floods', () => {
    const oversizedWs = new FakeWs();
    const oversized = new NetState(oversizedWs, makeCtx());
    oversized._feed(new Uint8Array(MAX_PENDING_RECEIVE_BYTES + 1));
    expect(oversizedWs.close).toHaveBeenCalledOnce();

    const floodWs = new FakeWs();
    const ctx = makeCtx();
    ctx.handlers = { 0x73: vi.fn() };
    const flood = new NetState(floodWs, ctx);
    flood._packetWindowCount = MAX_INCOMING_PACKETS_PER_SECOND;
    flood._feed(new Uint8Array([0x73, 1]));
    expect(floodWs.close).toHaveBeenCalledOnce();
  });
});
