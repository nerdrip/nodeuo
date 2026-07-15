import { describe, expect, it, vi } from 'vitest';
import {
  extNodeUOCapabilities,
  NodeUOCapability,
  NodeUOCapabilityMessage,
} from '@uo/protocol';
import {
  buildHandlers,
  NODEUO_NEGOTIATION_TIMEOUT_MS,
  offerNodeUOCapabilities,
  pushCommandCatalogue,
} from '../src/net/handlers.js';
import { CommandRegistry } from '../src/net/commands.js';

describe('NodeUO extension compatibility boundary', () => {
  it('ignores a private capability accept arriving on a generic transport', () => {
    const state = {
      nodeUOTransport: false,
      nodeUOProtocol: null,
      nodeUOCapabilities: 0,
    };
    const pkt = extNodeUOCapabilities({
      kind: NodeUOCapabilityMessage.Accept,
      capabilities: NodeUOCapability.RichGumps,
    });

    buildHandlers()[0xBF](state, pkt);
    expect(state.nodeUOProtocol).toBeNull();
    expect(state.nodeUOCapabilities).toBe(0);
  });

  it('requires a live server offer and masks accepted capabilities', () => {
    const state = {
      nodeUOTransport: true,
      nodeUOProtocol: null,
      nodeUOCapabilities: 0,
      send: vi.fn(),
      ctx: { commands: { commands: new Map() } },
      supportsNodeUO(capability) {
        return this.nodeUOProtocol?.major === 1
          && (this.nodeUOCapabilities & capability) === capability;
      },
    };
    offerNodeUOCapabilities(state);
    const pkt = extNodeUOCapabilities({
      kind: NodeUOCapabilityMessage.Accept,
      capabilities: (NodeUOCapability.RichGumps | 0x80000000) >>> 0,
    });
    buildHandlers()[0xBF](state, pkt);
    expect(state.nodeUOProtocol).toEqual({ major: 1, minor: 0 });
    expect(state.nodeUOCapabilities).toBe(NodeUOCapability.RichGumps);
    clearTimeout(state._nodeUOCapabilityTimer);
  });

  it('falls back to standard UO when negotiation times out', () => {
    vi.useFakeTimers();
    try {
      const state = {
        nodeUOTransport: true, nodeUOProtocol: null, nodeUOCapabilities: 0,
        send: vi.fn(), id: 99,
      };
      offerNodeUOCapabilities(state, Date.now());
      vi.advanceTimersByTime(NODEUO_NEGOTIATION_TIMEOUT_MS + 1);
      expect(state._nodeUOCapabilityOffer.expired).toBe(true);
      expect(state.nodeUOProtocol).toBeNull();
      expect(state.nodeUOCapabilities).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores an accept that was never offered', () => {
    const state = { nodeUOTransport: true, nodeUOProtocol: null, nodeUOCapabilities: 0 };
    const pkt = extNodeUOCapabilities({ kind: NodeUOCapabilityMessage.Accept });
    buildHandlers()[0xBF](state, pkt);
    expect(state.nodeUOProtocol).toBeNull();
    expect(state.nodeUOCapabilities).toBe(0);
  });

  it('never pushes the private command catalogue without RichGumps negotiation', () => {
    const send = vi.fn();
    const state = {
      send,
      supportsNodeUO: () => false,
      ctx: { commands: { commands: new Map() } },
    };
    pushCommandCatalogue(state);
    expect(send).not.toHaveBeenCalled();
  });

  it('publishes canonical visible commands without aliases or hidden diagnostics', () => {
    const registry = new CommandRegistry();
    registry.register({
      name: 'tp', aliases: ['tpto'], access: 'GM', help: 'Teleport.', run() {},
    });
    registry.register({
      name: 'gump', hidden: true, access: 'Admin', help: 'Diagnostic.', run() {},
    });
    const sent = [];
    const state = {
      send: (pkt) => sent.push(pkt),
      sendSystemMessage() {},
      supportsNodeUO: (cap) => cap === NodeUOCapability.RichGumps,
      accountName: 'admin',
      account: { username: 'admin', accessLevel: 'Admin' },
      ctx: { commands: registry },
    };

    pushCommandCatalogue(state);
    expect(sent).toHaveLength(1);
    const pkt = sent[0];
    expect((pkt[3] << 8) | pkt[4]).toBe(0x00A0);
    const payloadLength = (pkt[5] << 8) | pkt[6];
    const body = JSON.parse(Buffer.from(pkt.subarray(7, 7 + payloadLength)).toString('utf8'));
    expect(body.commands.map((c) => c.name)).toEqual(['tp']);
  });
});
