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
import {
  createNodeUOMessage,
  NODEUO_JSON_SUBPROTOCOL,
  NodeUODelivery,
  parseNodeUOFrame,
  parseNodeUOMessage,
} from '@uo/nodeuo-protocol';

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

function unicodePacketText(packet) {
  let text = '';
  for (let offset = 48; offset + 1 < packet.length; offset += 2) {
    const code = (packet[offset] << 8) | packet[offset + 1];
    if (!code) break;
    text += String.fromCharCode(code);
  }
  return text;
}

describe('NetState._onClose', () => {
  it('advertises a classic custom-house revision once per streamed revision', () => {
    const ws = new FakeWs();
    const house = { customizable: true, revision: 7 };
    const state = new NetState(ws, {
      ...makeCtx(),
      houses: { houseByMultiSerial: () => house },
    });
    const foundation = {
      serial: 0x40000123, itemId: 0, multiId: 0x13EC,
      x: 100, y: 100, z: 0, map: 1, hue: 0, amount: 1,
      movable: false, _multiAnchor: true,
    };

    expect(state.sendItem(foundation)).toBe(true);
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect([...ws.send.mock.calls[1][0].subarray(0, 5)]).toEqual([0xBF, 0, 13, 0, 0x1D]);

    state.sendItem(foundation);
    expect(ws.send).toHaveBeenCalledTimes(3); // item update only

    house.revision = 8;
    state.sendItem(foundation);
    expect(ws.send).toHaveBeenCalledTimes(5);
    const revisionPacket = ws.send.mock.calls[4][0];
    expect([...revisionPacket.subarray(9, 13)]).toEqual([0, 0, 0, 8]);
  });

  it('moves private UI sentinels to typed JSON on v2 and keeps ordinary UO messages binary', () => {
    const ws = new FakeWs();
    const state = new NetState(ws, {
      ...makeCtx(), nodeUOTransport: true, nodeUOTransportVersion: NODEUO_JSON_SUBPROTOCOL,
    });
    state.nodeUOProtocol = { major: 2, minor: 0, json: true };
    state.nodeUOFeatures.set('crafting.workbench', 1);

    state.sendSystemMessage('@@OPEN_CRAFT_GUMP@@smithing|100.0');
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(typeof ws.send.mock.calls[0][0]).toBe('string');
    expect(parseNodeUOMessage(ws.send.mock.calls[0][0])).toMatchObject({
      feature: 'crafting.workbench',
      payload: { operation: 'open-gump', name: 'craft', payload: 'smithing|100.0' },
    });

    state.sendSystemMessage('A normal UO system message.');
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(ws.send.mock.calls[1][1]).toMatchObject({ binary: true });
  });

  it('replaces private UI sentinels with a rate-limited classic-client fallback notice', () => {
    const ws = new FakeWs();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const state = new NetState(ws, { ...makeCtx(), nodeUOSettings: { value: {
      compatibility: { noticeCooldownMs: 300_000 },
    } } });
    state.accountName = 'classic-player';
    state.clientVersionString = '7.0.100.0';

    try {
      state.sendSystemMessage('@@OPEN_BANKER_GUMP@@1250');
      state.sendSystemMessage('@@OPEN_BANKER_GUMP@@1250');
      expect(ws.send).toHaveBeenCalledOnce();
      const message = unicodePacketText(ws.send.mock.calls[0][0]);
      expect(message).toContain('requires the NodeUO client');
      expect(message).toContain('standard bank box remains available');
      expect(message).not.toContain('@@');
      expect(info).toHaveBeenCalledOnce();
      expect(info.mock.calls[0][0]).toContain('standard UO session continues');
    } finally {
      info.mockRestore();
    }
  });

  it('does not revive historical private UI sentinels for retired v1 state', () => {
    const ws = new FakeWs();
    const state = new NetState(ws, { ...makeCtx(), nodeUOTransport: true });
    state.nodeUOProtocol = { major: 1, minor: 0 };

    state.sendSystemMessage('@@OPEN_CRAFT_GUMP@@smithing|100.0');

    expect(ws.send).toHaveBeenCalledOnce();
    expect(unicodePacketText(ws.send.mock.calls[0][0])).toContain('requires the NodeUO client');
  });

  it('never leaks an unknown future private marker to a classic UO journal', () => {
    const ws = new FakeWs();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const state = new NetState(ws, makeCtx());

    try {
      state.sendSystemMessage('@@FUTURE_WIDGET@@opaque-data');
      expect(ws.send).toHaveBeenCalledOnce();
      const message = unicodePacketText(ws.send.mock.calls[0][0]);
      expect(message).toContain('requires the NodeUO client');
      expect(message).not.toContain('FUTURE_WIDGET');
      expect(message).not.toContain('opaque-data');
    } finally {
      info.mockRestore();
    }
  });

  it('batches negotiated JSON envelopes into one bounded text frame', () => {
    const ws = new FakeWs();
    const state = new NetState(ws, {
      ...makeCtx(), nodeUOTransport: true, nodeUOTransportVersion: NODEUO_JSON_SUBPROTOCOL,
    });
    state.nodeUOProtocol = { major: 2, minor: 0, json: true };
    state.nodeUOFeatures = new Map([['protocol.batch', 1], ['flow.qos', 1]]);
    const messages = [1, 2].map((seq) => createNodeUOMessage({
      feature: 'flow.qos', seq, payload: { seq },
    }));

    expect(state.sendNodeUOBatch(messages)).toBe(true);
    expect(ws.send).toHaveBeenCalledOnce();
    expect(typeof ws.send.mock.calls[0][0]).toBe('string');
    expect(parseNodeUOFrame(ws.send.mock.calls[0][0])).toMatchObject([
      { feature: 'flow.qos', seq: 1 }, { feature: 'flow.qos', seq: 2 },
    ]);
    expect(state.nodeUOJsonStats).toMatchObject({ sent: 2, framesSent: 1, batchedMessages: 2 });
  });

  it('queues rate-limited reliable JSON in FIFO order and flushes it within a hard bound', () => {
    vi.useFakeTimers();
    const ws = new FakeWs();
    const state = new NetState(ws, {
      ...makeCtx(), nodeUOTransport: true, nodeUOTransportVersion: NODEUO_JSON_SUBPROTOCOL,
    });
    state.nodeUOProtocol = { major: 2, minor: 1, json: true };
    state.nodeUOFeatures.set('flow.qos', 1);
    state.nodeUOBandwidth.tokens = -state.nodeUOBandwidth.criticalReserveBytes;
    const first = createNodeUOMessage({ feature: 'flow.qos', delivery: NodeUODelivery.Reliable,
      payload: { order: 1 } });
    const second = createNodeUOMessage({ feature: 'flow.qos', delivery: NodeUODelivery.Reliable,
      payload: { order: 2 } });
    expect(state.sendNodeUOMessage(first)).toBe(true);
    expect(state.sendNodeUOMessage(second)).toBe(true);
    expect(ws.send).not.toHaveBeenCalled();
    expect(state._nodeUOJsonReliableQueue).toHaveLength(2);
    state.nodeUOBandwidth.tokens = state.nodeUOBandwidth.burstBytes;
    vi.advanceTimersByTime(25);
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(ws.send.mock.calls.map(([text]) => parseNodeUOMessage(text).payload.order)).toEqual([1, 2]);
    expect(state._nodeUOJsonReliableQueue).toHaveLength(0);
    state.close('test');
    vi.useRealTimers();
  });

  it('clears every per-session interaction map on disconnect', () => {
    const ws = new FakeWs();
    const state = new NetState(ws, makeCtx());

    // Populate the maps that handlers normally attach lazily.
    state.targetCallbacks = new Map([[1, () => {}]]);
    state.activeGumps = new Map([[2, {}]]);
    state.activePrompts = new Map([[3, () => {}]]);
    state._nodeUOCompatibilityNotices = new Map([['ui.rich-gumps/banker', Date.now()]]);
    state.openContainers.add(0x40000001);

    ws.emit('close');

    expect(state.targetCallbacks.size).toBe(0);
    expect(state.activeGumps.size).toBe(0);
    expect(state.activePrompts.size).toBe(0);
    expect(state._nodeUOCompatibilityNotices.size).toBe(0);
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

  it('batches packet boundaries into one unchanged transport stream', () => {
    const ws = new FakeWs();
    const state = new NetState(ws, makeCtx());
    state.sendBatch([new Uint8Array([0x73, 1]), new Uint8Array([0x73, 2])]);
    expect(ws.send).toHaveBeenCalledOnce();
    expect(Buffer.from(ws.send.mock.calls[0][0])).toEqual(Buffer.from([0x73, 1, 0x73, 2]));
  });

  it('suppresses identical entity deltas per viewer without suppressing changes', () => {
    const ws = new FakeWs();
    const state = new NetState(ws, makeCtx());
    expect(state.sendEntityDelta(7, 1, new Uint8Array([0x77, 1]))).toBe(true);
    expect(state.sendEntityDelta(7, 1, new Uint8Array([0x77, 1]))).toBe(false);
    expect(state.sendEntityDelta(7, 1, new Uint8Array([0x77, 2]))).toBe(true);
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(state.backpressureStats.duplicateDeltas).toBe(1);
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
