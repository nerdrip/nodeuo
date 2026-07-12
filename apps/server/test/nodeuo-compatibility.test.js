import { describe, expect, it, vi } from 'vitest';
import {
  extNodeUOCapabilities,
  NodeUOCapability,
  NodeUOCapabilityMessage,
} from '@uo/protocol';
import { buildHandlers, pushCommandCatalogue } from '../src/net/handlers.js';
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
