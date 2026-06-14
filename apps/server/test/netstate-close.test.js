// Regression test for S-05: NetState._onClose must clear the per-session
// interaction maps (targetCallbacks, activeGumps, activePrompts, openContainers).
// Previously these accumulated across reconnects on long-running shards and
// — worse — a reconnecting client could inherit a dangling target callback
// registered by the previous session.

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { NetState } from '../src/net/net-state.js';

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.binaryType = '';
    this.readyState = 1;
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
});
