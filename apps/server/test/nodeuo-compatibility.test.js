import { describe, expect, it, vi } from 'vitest';
import {
  handleNodeUOText,
  NODEUO_NEGOTIATION_TIMEOUT_MS,
  pushCommandCatalogue,
} from '../src/net/handlers.js';
import {
  advertisedFeatureList,
  NodeUOFeature,
  NodeUOJsonKind,
  schemaFingerprintForFeature,
  serializeNodeUOMessage,
} from '@uo/nodeuo-protocol';
import { CommandRegistry } from '../src/net/commands.js';
import { acceptNodeUORenegotiation, offerNodeUORenegotiation, offerNodeUOSession } from '../src/net/handlers/nodeuo-session.js';

function jsonState(id = 7) {
  return {
    id, nodeUOJsonTransport: true, nodeUOProtocol: null, nodeUOFeatures: new Map(),
    nodeUOJsonStats: { rejected: 0, expired: 0 }, sent: [],
    sendNodeUOMessage(message) { this.sent.push(message); return true; },
    supportsNodeUO(feature) { return !!this.nodeUOProtocol && this.nodeUOFeatures.has(feature); },
    ctx: { commands: { commands: new Map() }, config: { shardName: 'Test' } },
  };
}

describe('NodeUO extension compatibility boundary', () => {
  it('atomically swaps a live feature map only after matching renegotiation acceptance', () => {
    const state = jsonState(44);
    state.nodeUOProtocol = { major: 2, minor: 0, json: true };
    state.nodeUOFeatures = new Map([['protocol.renegotiate', 1], ['party.markers', 1]]);
    state.ctx.nodeUOSettings = { value: { features: { 'party.markers': false } } };
    expect(offerNodeUORenegotiation(state, 'test-rollout')).toBe(true);
    expect(state.nodeUOFeatures.has('party.markers')).toBe(true);
    const prepare = state.sent[0].payload;
    const result = acceptNodeUORenegotiation(state, {
      epoch: prepare.epoch, features: prepare.features, manifest: { schemas: prepare.manifest.schemas },
    });
    expect(result).toMatchObject({ ok: true, operation: 'activate', epoch: prepare.epoch });
    expect(state.nodeUOFeatures.has('protocol.renegotiate')).toBe(true);
    expect(state.nodeUOFeatures.has('party.markers')).toBe(false);
  });

  it('negotiates JSON v2 exclusively through text and string feature ids', () => {
    const state = jsonState();
    expect(offerNodeUOSession(state)).toBe(true);
    expect(state.sent[0]).toMatchObject({ kind: NodeUOJsonKind.Hello, feature: 'protocol.session' });
    const accepted = serializeNodeUOMessage({ kind: NodeUOJsonKind.Accept, feature: 'protocol.session',
      payload: { protocol: 2, features: advertisedFeatureList()
        .filter((entry) => entry.id === 'party.markers' || entry.id === 'social.state') } });
    expect(handleNodeUOText(state, accepted)).toBe(true);
    expect(state.nodeUOProtocol).toEqual({ major: 2, minor: 0, json: true });
    expect(state.nodeUOFeatures.get('party.markers')).toBe(1);
    expect([...state.nodeUOFeatures.keys()].every((id) => typeof id === 'string')).toBe(true);
  });

  it('removes schema-incompatible features and transitive dependants', () => {
    const state = jsonState(8);
    offerNodeUOSession(state);
    const accepted = serializeNodeUOMessage({ kind: NodeUOJsonKind.Accept, feature: 'protocol.session',
      payload: { protocol: 2,
        features: advertisedFeatureList().filter((entry) => [
          'world.delta', 'world.components', 'protocol.state-repair',
        ].includes(entry.id)),
        manifest: { schemas: {
          'world.delta': 'fnv1a64:incompatible',
          'world.components': schemaFingerprintForFeature('world.components'),
          'protocol.state-repair': schemaFingerprintForFeature('protocol.state-repair'),
        } } } });
    expect(handleNodeUOText(state, accepted)).toBe(true);
    expect([...state.nodeUOFeatures]).toEqual([]);
  });

  it('falls back to standard UO when JSON negotiation times out', () => {
    vi.useFakeTimers();
    try {
      const state = jsonState(99);
      offerNodeUOSession(state, Date.now());
      vi.advanceTimersByTime(NODEUO_NEGOTIATION_TIMEOUT_MS + 1);
      expect(state._nodeUOSessionOffer.expired).toBe(true);
      expect(state.nodeUOProtocol).toBeNull();
      expect(state.nodeUOFeatures.size).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('never pushes the private command catalogue to a classic client', () => {
    const state = { send: vi.fn(), sendNodeUOMessage: vi.fn(), supportsNodeUO: () => false,
      ctx: { commands: { commands: new Map() } } };
    pushCommandCatalogue(state);
    expect(state.send).not.toHaveBeenCalled();
    expect(state.sendNodeUOMessage).not.toHaveBeenCalled();
  });

  it('publishes canonical commands as JSON v2 without binary fallback', () => {
    const registry = new CommandRegistry();
    registry.register({ name: 'tp', aliases: ['tpto'], access: 'GM', help: 'Teleport.', run() {} });
    registry.register({ name: 'gump', hidden: true, access: 'Admin', help: 'Diagnostic.', run() {} });
    const state = jsonState(12);
    state.nodeUOProtocol = { major: 2, minor: 0, json: true };
    state.nodeUOFeatures = new Map([[NodeUOFeature.RichGumps, 1]]);
    state.account = { username: 'admin', accessLevel: 'Admin' };
    state.ctx.commands = registry;
    state.send = vi.fn();
    state.sendSystemMessage = vi.fn();
    pushCommandCatalogue(state);
    expect(state.send).not.toHaveBeenCalled();
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]).toMatchObject({
      feature: NodeUOFeature.RichGumps, kind: NodeUOJsonKind.Event,
      payload: { eventKind: 0, data: { operation: 'command-catalogue',
        commands: [{ name: 'tp', help: 'Teleport.', access: 'GM' }] } },
    });
  });
});
