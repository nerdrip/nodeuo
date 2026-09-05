import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkpointNodeUOResume,
  initializeNodeUOModern,
  handleNodeUOJsonMessage as handleServerNodeUOJsonMessage,
  registerNodeUOMod,
  sendNodeUOFeature,
  sendNodeUOChannel,
  trySendNodeUOEntityDelta,
} from '../src/net/handlers/nodeuo-modern.js';
import {
  advertisedFeatureList,
  NodeUOChannel,
  NodeUOChannelFlag,
  NodeUOChannelMessage,
  NodeUODelivery,
  NodeUOJsonKind,
  NodeUOWorldField,
  schemaFingerprintForFeature,
  serializeNodeUOMessage,
  stableJsonFingerprint,
} from '@uo/nodeuo-protocol';
import {
  handleNodeUOJsonMessage,
  nodeUOTranslate,
  resetNodeUOModernState,
} from '../../client/src/net/nodeuo-modern.js';
import { world as clientWorld } from '../../client/src/world/world.js';
import { NetClient } from '../../client/src/net/net-client.js';
import { handleNodeUOFeatureRequest as handleAdvancedFeature } from '../src/net/handlers/nodeuo-features.js';

function fixture() {
  const sent = [];
  const mobile = {
    serial: 1, definitionId: 'modern-player', name: 'Modern', bodyId: 0x190, body: 0x190, hue: 0, flags: 0,
    notoriety: 1, x: 100, y: 200, z: 0, map: 1, direction: 2,
    hp: 40, hpMax: 50, mana: 30, manaMax: 40, stam: 45, stamMax: 50,
    activeQuests: { tutorial: { title: 'Tutorial', stage: 2 } },
  };
  const item = { serial: 0x40000001, definitionId: 'artifact-book-armour', artId: 0x0e75, itemId: 0x0e75,
    paperdollGumpId: 0xc351, paperdollMaleGumpId: 0xc352, paperdollFemaleGumpId: 0xea62,
    hue: 0, amount: 1,
    x: 101, y: 200, z: 0, map: 1, direction: 0, parent: 0, layer: 0 };
  const state = {
    mobile, accountName: 'modern', nodeUOJsonTransport: true,
    nodeUOProtocol: { major: 2, minor: 0, json: true },
    nodeUOFeatures: new Map(advertisedFeatureList().map((entry) => [entry.id, entry.maximum])),
    _visibleMobiles: new Set(), _visibleItems: new Set([item.serial]),
    supportsNodeUO(feature) {
      return this.nodeUOFeatures.has(feature);
    },
    sendNodeUOMessage(message) { sent.push(message); return true; },
    ctx: {
      world: { mobiles: new Map([[mobile.serial, mobile]]), items: new Map([[item.serial, item]]) },
      config: { shardName: 'Test shard' }, dayNight: { season: 2, currentLevel: () => 8 },
      partyRegistry: { partyOf: () => null },
    },
  };
  return { state, sent, mobile, item };
}

afterEach(() => { vi.unstubAllGlobals(); resetNodeUOModernState(); clientWorld.reset(); });

describe('NodeUO modern negotiated channels', () => {
  it('uses semantic JSON components rather than bit masks on v2', () => {
    const { state, mobile } = fixture();
    const messages = [];
    state.nodeUOJsonTransport = true;
    state.nodeUOProtocol = { major: 2, minor: 0, json: true };
    state.nodeUOFeatures = new Map(advertisedFeatureList().map((entry) => [entry.id, entry.maximum]));
    state.supportsNodeUO = function supports(feature) {
      if (typeof feature === 'string') return this.nodeUOFeatures.has(feature);
      return true;
    };
    state.sendNodeUOMessage = (message) => { messages.push(message); return true; };
    expect(initializeNodeUOModern(state)).toBe(true);
    const snapshot = messages.find((message) => message.feature === 'world.progressive-snapshot');
    expect(snapshot.payload.entities[0]).toMatchObject({
      serial: mobile.serial, type: 'mobile', components: {
        position: { x: 100, y: 200 }, vitals: { hp: 40, stamina: 45 },
      },
    });
    expect(snapshot.payload.entities[0]).not.toHaveProperty('mask');
    expect(messages.some((message) => message.feature === 'assets.content-addressed')).toBe(true);
  });

  it('acknowledges one near-to-far login baseline without sending a duplicate snapshot', () => {
    const { state, mobile, item } = fixture();
    const messages = [];
    state.nodeUOJsonTransport = true;
    state.nodeUOProtocol = { major: 2, minor: 0, json: true };
    state.nodeUOFeatures = new Map(advertisedFeatureList().map((entry) => [entry.id, entry.maximum]));
    state.supportsNodeUO = function supports(feature) {
      return typeof feature !== 'string' || this.nodeUOFeatures.has(feature);
    };
    state.sendNodeUOMessage = (message) => { messages.push(message); return true; };
    initializeNodeUOModern(state);
    const progressive = messages.filter((message) => message.feature === 'world.progressive-snapshot');
    expect(progressive.length).toBeGreaterThan(0);
    expect(messages.some((message) => message.feature === 'world.components'
      && message.kind === NodeUOJsonKind.Snapshot)).toBe(false);

    const acknowledgements = [];
    const clientNet = { nodeUOJsonTransport: true, supportsNodeUO: () => true,
      sendNodeUOMessage: (message) => { acknowledgements.push(message); return true; } };
    const clientMobile = clientWorld.ensureMobile(mobile.serial);
    clientWorld.equipOnMobile(clientMobile, 22, { serial: item.serial, itemId: item.itemId, hue: item.hue });
    for (const message of progressive) expect(handleNodeUOJsonMessage(clientNet, message)).toBe(true);
    expect(clientWorld.mobiles.get(mobile.serial)).toMatchObject({
      definitionId: 'modern-player', bodyId: 0x190, body: 0x190, x: 100, y: 200, hp: 40,
    });
    expect(clientWorld.items.get(item.serial)).toMatchObject({
      definitionId: 'artifact-book-armour', artId: 0x0e75, itemId: 0x0e75,
      paperdollGumpId: 0xc351, paperdollMaleGumpId: 0xc352, paperdollFemaleGumpId: 0xea62,
    });
    expect(clientWorld.mobiles.get(mobile.serial).equipment.get(22)).toMatchObject({
      definitionId: 'artifact-book-armour', itemId: 0x0e75, paperdollGumpId: 0xc351,
    });
    expect(acknowledgements.at(-1)).toMatchObject({ kind: NodeUOJsonKind.Ack,
      feature: 'world.progressive-snapshot', ack: progressive.length });
    for (const acknowledgement of acknowledgements) handleServerNodeUOJsonMessage(state, acknowledgement);
    expect(state._nodeUOWorld.ready).toBe(true);
  });

  it('streams definition-owned appearance for equipped items outside ground-item visibility', () => {
    const { state, sent, mobile, item } = fixture();
    state._visibleItems.clear();
    item.parent = mobile.serial;
    item.layer = 22;
    state.ctx.world._childrenByParent = new Map([[mobile.serial, new Set([item.serial])]]);
    initializeNodeUOModern(state);
    const entities = sent
      .filter((message) => message.feature === 'world.progressive-snapshot')
      .flatMap((message) => message.payload.entities);
    expect(entities.find((entity) => entity.serial === item.serial)).toMatchObject({
      type: 'item',
      components: {
        appearance: {
          definitionId: 'artifact-book-armour', artId: 0x0e75,
          paperdollGumpId: 0xc351, paperdollFemaleGumpId: 0xea62,
        },
        containment: { parent: mobile.serial, layer: 22 },
      },
    });
  });

  it('applies bounded component subscriptions and publishes a filtered baseline', () => {
    const { state } = fixture();
    const messages = [];
    state.nodeUOJsonTransport = true;
    state.nodeUOProtocol = { major: 2, minor: 0, json: true };
    state.nodeUOFeatures = new Map(advertisedFeatureList().map((entry) => [entry.id, entry.maximum]));
    state.supportsNodeUO = function supports(feature) {
      return typeof feature !== 'string' || this.nodeUOFeatures.has(feature);
    };
    state.sendNodeUOMessage = (message) => { messages.push(message); return true; };

    expect(handleServerNodeUOJsonMessage(state, {
      kind: NodeUOJsonKind.Request, feature: 'protocol.subscriptions', id: 'c.subscription',
      payload: { target: 'world.components', components: ['position'], fields: ['x', 'y'],
        rateHz: 12, maxEntities: 1 },
    })).toBe(true);
    expect(state._nodeUOSubscriptions.get('world.components')).toMatchObject({
      components: ['position'], fields: ['x', 'y'], rateHz: 12, maxEntities: 1,
    });
    expect(messages.find((message) => message.kind === NodeUOJsonKind.Result)).toMatchObject({
      replyTo: 'c.subscription', payload: { ok: true },
    });
    const snapshot = messages.find((message) => message.kind === NodeUOJsonKind.Snapshot);
    expect(snapshot.payload.entities).toHaveLength(1);
    expect(snapshot.payload.entities[0].components).toEqual({ position: { x: 100, y: 200 } });
  });

  it('applies true circular AOI filters without revealing diagonal out-of-radius entities', () => {
    const { state, item } = fixture();
    const messages = [];
    item.x = 101; item.y = 201;
    state.nodeUOJsonTransport = true;
    state.nodeUOProtocol = { major: 2, minor: 1, json: true };
    state.nodeUOFeatures = new Map(advertisedFeatureList().map((entry) => [entry.id, entry.maximum]));
    state.supportsNodeUO = function supports(feature) {
      return typeof feature !== 'string' || this.nodeUOFeatures.has(feature);
    };
    state.sendNodeUOMessage = (message) => { messages.push(message); return true; };
    handleServerNodeUOJsonMessage(state, {
      kind: NodeUOJsonKind.Request, feature: 'protocol.subscriptions', id: 'c.circle',
      payload: { target: 'world.components', area: { type: 'circle', map: 1, x: 100, y: 200, radius: 1 } },
    });
    const snapshot = messages.find((message) => message.kind === NodeUOJsonKind.Snapshot);
    expect(snapshot.payload.entities.map((entity) => entity.serial)).toEqual([state.mobile.serial]);
  });

  it('repairs only visible authoritative entities and verifies their fingerprints', () => {
    const { state, item } = fixture();
    const messages = [];
    state.nodeUOJsonTransport = true;
    state.nodeUOProtocol = { major: 2, minor: 0, json: true };
    state.nodeUOFeatures = new Map(advertisedFeatureList().map((entry) => [entry.id, entry.maximum]));
    state.supportsNodeUO = function supports(feature) {
      return typeof feature !== 'string' || this.nodeUOFeatures.has(feature);
    };
    state.sendNodeUOMessage = (message) => { messages.push(message); return true; };

    handleServerNodeUOJsonMessage(state, {
      kind: NodeUOJsonKind.Request, feature: 'protocol.state-repair', id: 'c.repair',
      payload: { serials: [item.serial, 0x4000ffff], components: ['position'] },
    });
    const result = messages.find((message) => message.replyTo === 'c.repair');
    expect(result.payload.entities).toHaveLength(1);
    const entity = result.payload.entities[0];
    const hashable = { ...entity };
    delete hashable.stateHash;
    expect(entity.stateHash).toBe(`fnv1a64:${stableJsonFingerprint(hashable)}`);
  });

  it('requests targeted repair instead of applying a corrupted component row', async () => {
    const requests = vi.fn(() => Promise.resolve({ ok: true, entities: [] }));
    const clientNet = {
      nodeUOJsonTransport: true, supportsNodeUO: () => true,
      sendNodeUOMessage: () => true, sendNodeUORequest: requests,
    };
    expect(handleNodeUOJsonMessage(clientNet, {
      kind: NodeUOJsonKind.Snapshot, feature: 'world.components', seq: 1,
      payload: { baseline: 900, finalSequence: 1, entities: [{
        serial: 99, type: 'mobile', revision: 1, stateHash: 'fnv1a64:bad',
        components: { position: { x: 1, y: 2, z: 0, map: 0 } },
      }] },
    })).toBe(true);
    expect(clientWorld.mobiles.has(99)).toBe(false);
    expect(requests).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'protocol.state-repair', payload: { serials: [99], components: ['position'] },
    }));
    await Promise.resolve();
  });

  it('merges selectively subscribed fields without zeroing omitted component state', () => {
    const clientNet = { nodeUOJsonTransport: true, supportsNodeUO: () => true,
      sendNodeUOMessage: () => true };
    handleNodeUOJsonMessage(clientNet, {
      kind: NodeUOJsonKind.Snapshot, feature: 'world.components', seq: 1,
      payload: { baseline: 901, finalSequence: 1, entities: [{
        serial: 101, type: 'mobile', revision: 1,
        components: { position: { x: 10, y: 20, z: 4, map: 1, direction: 2 },
          status: { dead: false, poisoned: true } },
      }] },
    });
    handleNodeUOJsonMessage(clientNet, {
      kind: NodeUOJsonKind.Delta, feature: 'world.components', seq: 2,
      payload: { baseline: 901, entities: [{
        serial: 101, type: 'mobile', revision: 2,
        components: { position: { x: 11 }, status: { poisoned: false } },
      }] },
    });
    expect(clientWorld.mobiles.get(101)).toMatchObject({
      x: 11, y: 20, z: 4, map: 1, direction: 2, dead: false, poisoned: false,
    });
  });

  it('coalesces position updates to the negotiated subscription rate', () => {
    vi.useFakeTimers();
    const { state, mobile } = fixture();
    const messages = [];
    state.nodeUOJsonTransport = true;
    state.nodeUOProtocol = { major: 2, minor: 0, json: true };
    state.id = 5;
    state.nodeUOFeatures = new Map([['world.delta', 2], ['world.components', 1]]);
    state.supportsNodeUO = function supports(feature) {
      return typeof feature !== 'string' || this.nodeUOFeatures.has(feature);
    };
    state.sendNodeUOMessage = (message) => { messages.push(message); return true; };
    state._nodeUOWorld = { ready: true, baseline: 3, sequence: 1, acknowledged: 1, sent: 0 };
    state._nodeUOSubscriptions = new Map([['world.components', {
      target: 'world.components', components: [], fields: [], rateHz: 10, maxEntities: 512,
    }]]);

    expect(trySendNodeUOEntityDelta(state, mobile.serial, NodeUOWorldField.Position)).toBe(true);
    mobile.x = 111;
    expect(trySendNodeUOEntityDelta(state, mobile.serial, NodeUOWorldField.Position)).toBe(true);
    expect(messages).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(messages).toHaveLength(2);
    expect(messages[1].payload.entities[0].components.position.x).toBe(111);
    vi.useRealTimers();
  });

  it('negotiates new string features independently', () => {
    const messages = [];
    const state = {
      nodeUOJsonTransport: true, nodeUOProtocol: { major: 2 },
      nodeUOFeatures: new Map([['localization.message-format', 1]]),
      supportsNodeUO(feature) { return typeof feature === 'string' && this.nodeUOFeatures.has(feature); },
      sendNodeUOMessage(message) { messages.push(message); return true; },
    };
    expect(sendNodeUOChannel(state, {
      channel: NodeUOChannel.Interface, namespace: 'nodeuo.localization',
      kind: NodeUOChannelMessage.Snapshot, payload: { strings: { greeting: 'Hello' } },
    })).toBeGreaterThan(0);
    expect(messages[0]).toMatchObject({ feature: 'localization.message-format' });
  });

  it('client refuses offered schema mismatches before confirming dependent features', () => {
    vi.stubGlobal('WebSocket', { OPEN: 1 });
    const net = new NetClient();
    net.nodeUOJsonTransport = true;
    net._nodeUOProfileExplicit = true;
    net.nodeUOProfile = 'full';
    net.ws = { readyState: 1, bufferedAmount: 0, send: vi.fn() };
    const features = advertisedFeatureList().filter((entry) => [
      'world.delta', 'world.components', 'protocol.state-repair',
    ].includes(entry.id));
    expect(net._onNodeUOJsonMessage({
      kind: NodeUOJsonKind.Hello, feature: 'protocol.session', payload: {
        protocol: 2, features, manifest: { features: features.map((entry) => ({
          id: entry.id,
          schema: entry.id === 'world.delta'
            ? 'fnv1a64:incompatible' : schemaFingerprintForFeature(entry.id),
        })) },
      },
    })).toBe(true);
    expect([...net.nodeUOFeatures]).toEqual([]);
  });

  it('sends causal deadlines and supports abortable client requests', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1 });
    const net = new NetClient();
    net.nodeUOJsonTransport = true; net.nodeUONegotiated = true;
    net.nodeUOFeatures = new Map([['protocol.causality', 1]]);
    net.ws = { readyState: 1, bufferedAmount: 0, send: vi.fn() };
    const controller = new AbortController();
    const pending = net.sendNodeUORequest({ capability: 'protocol.causality', timeoutMs: 1000,
      traceId: 'trace.client', correlationId: 'correlation.client', transactionId: 'transaction.client',
      preconditions: { alive: true }, signal: controller.signal });
    const envelope = JSON.parse(net.ws.send.mock.calls[0][0]);
    expect(envelope).toMatchObject({ feature: 'protocol.causality', traceId: 'trace.client',
      correlationId: 'correlation.client', transactionId: 'transaction.client',
      preconditions: { alive: true } });
    expect(envelope.deadlineAt).toBeGreaterThan(Date.now());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(net._nodeUORequests.size).toBe(0);
  });

  it('single-flights idempotent mod requests and acknowledges tracked sequences', async () => {
    const sent = [];
    let executions = 0;
    let finish;
    const unregister = registerNodeUOMod('test.slow', () => {
      executions++;
      return new Promise((resolve) => { finish = resolve; });
    });
    const state = {
      accountName: 'modern', nodeUOJsonTransport: true, nodeUOProtocol: { major: 2 },
      nodeUOFeatures: new Map([['mods.channels', 2]]),
      supportsNodeUO(feature) { return this.nodeUOFeatures.has(feature); },
      sendNodeUOMessage(message) { sent.push(message); return true; },
      ctx: {},
    };
    const request = (id) => ({ kind: NodeUOJsonKind.Request, feature: 'mods.channels', id,
      idempotencyKey: 'same-operation', payload: { namespace: 'test.slow', data: { value: 1 } } });
    expect(handleServerNodeUOJsonMessage(state, request('c.1'))).toBe(true);
    expect(handleServerNodeUOJsonMessage(state, request('c.2'))).toBe(true);
    expect(executions).toBe(1);
    finish({ ok: true, value: 2 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent.filter((message) => message.kind === NodeUOJsonKind.Result))
      .toMatchObject([{ replyTo: 'c.1' }, { replyTo: 'c.2' }]);

    sent.length = 0;
    state.nodeUOFeatures.set('flow.qos', 1);
    expect(sendNodeUOFeature(state, { feature: 'flow.qos', seq: 8, requiresAck: true })).toBe(true);
    expect(state._nodeUOPendingAcks.size).toBe(1);
    handleServerNodeUOJsonMessage(state, { kind: NodeUOJsonKind.Ack, feature: 'flow.qos', ack: 8, payload: {} });
    expect(state._nodeUOPendingAcks.size).toBe(0);
    unregister();
  });

  it('applies semantic component deltas and acknowledges their feature', () => {
    const replies = [];
    const clientNet = { nodeUOJsonTransport: true, supportsNodeUO: () => true,
      sendNodeUOMessage: (message) => { replies.push(message); return true; } };
    expect(handleNodeUOJsonMessage(clientNet, {
      kind: 'snapshot', feature: 'world.components', seq: 1, requiresAck: true,
      payload: { baseline: 88, finalSequence: 1, entities: [{
        serial: 123, type: 'mobile', revision: 4,
        components: { position: { x: 7, y: 9, z: 1, map: 0, direction: 2 },
          appearance: { artId: 0x190, hue: 3 }, vitals: { hp: 20, hpMax: 25,
            mana: 10, manaMax: 12, stamina: 8, staminaMax: 9 },
          status: { poisoned: true } },
      }] },
    })).toBe(true);
    expect(clientWorld.mobiles.get(123)).toMatchObject({ x: 7, y: 9, hp: 20, stam: 8, poisoned: true });
    expect(replies.at(-1)).toMatchObject({ kind: 'ack', feature: 'world.components', ack: 1 });
  });

  it('formats negotiated localization variables and plurals without code execution', () => {
    clientWorld.nodeUOLocalization = { locale: 'pl-PL', strings: {
      greeting: 'Witaj {name}', apples: '{count, plural, one {# jabłko} few {# jabłka} other {# jabłek}}',
    } };
    expect(nodeUOTranslate('greeting', { name: 'Britannianin' })).toBe('Witaj Britannianin');
    expect(nodeUOTranslate('apples', { count: 3 })).toBe('3 jabłka');
    expect(nodeUOTranslate('missing.key')).toBe('missing.key');
  });

  it('calls a configured AI provider for dialogue but accepts only presentation output', async () => {
    const npc = { serial: 55, name: 'Iolo', kind: 'bard', x: 10, y: 10, z: 0, map: 1 };
    const mobile = { serial: 1, name: 'Avatar', x: 11, y: 10, z: 0, map: 1 };
    const history = [];
    const provider = vi.fn(async () => new Response(JSON.stringify({
      text: 'Witaj, podróżniku.', expression: 'warm', action: { grantGold: 999999 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', provider);
    const result = await handleAdvancedFeature({
      mobile, _nodeUONpcDialog: { npcSerial: npc.serial, history },
      ctx: {
        world: { mobiles: new Map([[npc.serial, npc]]) },
        nodeUOSettings: { snapshot: () => ({ ai: {
          enabled: true, endpoint: 'https://ai.example.test/dialogue',
          apiKey: 'secret', model: 'dialogue-model', timeoutMs: 1000,
        } }) },
      },
    }, { feature: 'npc.generative', payload: { prompt: 'Co słychać?' } });
    expect(provider).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, npcSerial: 55, speaker: 'Iolo',
      text: 'Witaj, podróżniku.', expression: 'warm', generated: true });
    expect(result).not.toHaveProperty('action');
    expect(history).toEqual([{ speaker: 'Iolo', text: 'Witaj, podróżniku.', generated: true }]);
  });

  it('publishes bounded tactical pings only to current party members', () => {
    const { state, mobile } = fixture();
    const sent = [];
    mobile.client = state;
    state.id = 7;
    state.nodeUOJsonTransport = true;
    state.nodeUOFeatures = new Map([['social.pings', 1]]);
    state.supportsNodeUO = (feature) => state.nodeUOFeatures.has(feature);
    state.sendNodeUOMessage = (message) => { sent.push(message); return true; };
    const result = handleAdvancedFeature(state, {
      feature: 'social.pings', payload: { operation: 'publish', ping: {
        x: 105, y: 202, map: 1, label: 'Tutaj!', ttlMs: 2500,
      } },
    });
    expect(result).toMatchObject({ ok: true, partyId: 'solo:1', pings: [{
      x: 105, y: 202, label: 'Tutaj!', createdBy: 1,
    }] });
    expect(result.pings[0].expiresAt - result.pings[0].createdAt).toBe(2500);
    expect(sent.at(-1)).toMatchObject({ feature: 'social.pings', kind: NodeUOJsonKind.Snapshot });
  });

  it('exposes a cursor-based world event stream with staff-authoritative publication', () => {
    const published = [];
    const state = {
      account: { accessLevel: 'Admin' }, mobile: { serial: 1, name: 'GM' },
      ctx: { connections: new Set([{ nodeUOJsonTransport: true,
        supportsNodeUO: (feature) => feature === 'world.events',
        nodeUOFeatures: new Map([['world.events', 1]]),
        sendNodeUOMessage: (message) => { published.push(message); return true; } }]) },
    };
    const created = handleAdvancedFeature(state, { feature: 'world.events', payload: {
      operation: 'publish', event: { type: 'invasion', title: 'Orcs', text: 'Britain is under attack.',
        location: { x: 100, y: 200, map: 1 } },
    } });
    expect(created).toMatchObject({ ok: true, event: { type: 'invasion', title: 'Orcs', cursor: expect.any(Number) } });
    expect(published[0]).toMatchObject({ feature: 'world.events', payload: { events: [{ title: 'Orcs' }] } });
    const listed = handleAdvancedFeature(state, { feature: 'world.events', payload: {
      operation: 'list', cursor: created.event.cursor - 1, limit: 1,
    } });
    expect(listed.events).toEqual([created.event]);
  });

  it('shares bounded world annotations only with the selected social scope', () => {
    const outbound = [];
    const party = { id: 'p1', leader: 1, members: [1, 2] };
    const member = { id: 2, mobile: { serial: 2, guildId: 'g1' }, nodeUOJsonTransport: true,
      nodeUOFeatures: new Map([['world.annotations', 1]]),
      supportsNodeUO: (feature) => feature === 'world.annotations',
      sendNodeUOMessage: (message) => { outbound.push(['member', message]); return true; } };
    const outsider = { id: 3, mobile: { serial: 3, guildId: 'g2' }, nodeUOJsonTransport: true,
      nodeUOFeatures: new Map([['world.annotations', 1]]),
      supportsNodeUO: (feature) => feature === 'world.annotations',
      sendNodeUOMessage: (message) => { outbound.push(['outsider', message]); return true; } };
    const state = { id: 1, mobile: { serial: 1, name: 'Cartographer', map: 1, z: 0, guildId: 'g1' },
      nodeUOJsonTransport: true, nodeUOFeatures: new Map([['world.annotations', 1]]),
      supportsNodeUO: (feature) => feature === 'world.annotations',
      sendNodeUOMessage: (message) => { outbound.push(['owner', message]); return true; },
      ctx: { partyRegistry: { partyOf: () => party }, connections: new Set([member, outsider]),
        world: { mobiles: new Map([[1, { client: null }], [2, { client: member }]]) } } };
    state.ctx.world.mobiles.get(1).client = state;
    const result = handleAdvancedFeature(state, { feature: 'world.annotations', payload: {
      operation: 'upsert', scope: 'party', annotation: {
        id: 'meeting', x: 120, y: 240, map: 1, label: 'Meeting point', kind: 'objective',
      },
    } });
    expect(result).toMatchObject({ ok: true, scope: 'party', annotations: [{
      id: 'meeting', label: 'Meeting point', createdBy: 1,
    }] });
    expect(outbound.map(([who]) => who).sort()).toEqual(['member', 'owner']);
  });

  it('coordinates editor leases and prevents conflicting map commits', () => {
    const sent = [];
    const connections = new Set();
    const makeEditor = (id) => ({ id, accountName: `gm${id}`, account: { accessLevel: 'GM' },
      mobile: { serial: id, name: `GM ${id}` }, nodeUOJsonTransport: true,
      nodeUOFeatures: new Map([['editor.collaboration', 1]]),
      supportsNodeUO: (feature) => feature === 'editor.collaboration',
      sendNodeUOMessage: (message) => { sent.push(message); return true; }, ctx: { connections } });
    const first = makeEditor(101), second = makeEditor(102);
    connections.add(first); connections.add(second);
    const acquired = handleAdvancedFeature(first, { feature: 'editor.collaboration', payload: {
      operation: 'acquire', resource: 'map:1:1:3',
    } });
    expect(acquired).toMatchObject({ ok: true, lease: { resource: 'map:1:1:3' } });
    expect(handleAdvancedFeature(second, { feature: 'editor.collaboration', payload: {
      operation: 'acquire', resource: 'map:1:1:3',
    } })).toMatchObject({ ok: false, error: 'resource is already leased' });

    const overlay = new Map();
    second.ctx.landProvider = {
      landAt: () => ({ tileId: 1, z: 0 }), setLandTile: vi.fn(), clearLandTile: vi.fn(),
      iterEdits: () => overlay.values(), saveEditsSync: vi.fn(() => ({ written: 0 })),
    };
    second.ctx.saveDir = 'test-save';
    const begin = handleAdvancedFeature(second, { feature: 'editor.transactions', payload: { operation: 'begin' } });
    handleAdvancedFeature(second, { feature: 'editor.transactions', payload: {
      operation: 'stage', transactionId: begin.transactionId,
      mutations: [{ facet: 1, x: 65, y: 193, tileId: 2, z: 0 }],
    } });
    expect(handleAdvancedFeature(second, { feature: 'editor.transactions', payload: {
      operation: 'commit', transactionId: begin.transactionId,
    } })).toMatchObject({ ok: false, error: 'editor lease conflict', resource: 'map:1:1:3' });
    expect(handleAdvancedFeature(first, { feature: 'editor.collaboration', payload: {
      operation: 'release', resource: 'map:1:1:3', leaseId: acquired.lease.leaseId,
    } })).toMatchObject({ ok: true, released: 'map:1:1:3' });
  });

  it('returns live AI scheduler diagnostics and a real path preview', () => {
    const inspect = vi.fn(() => ({ serial: 44, behavior: 'aggressive', status: 'running', tickCount: 8 }));
    const previewPath = vi.fn(() => ({ reachable: true, steps: 3, points: [{ x: 10, y: 10 }] }));
    const state = { account: { accessLevel: 'Admin' },
      ctx: { world: { mobiles: new Map([[44, { serial: 44, kind: 'orc' }]]) },
        ai: { inspect, previewPath } } };
    expect(handleAdvancedFeature(state, { feature: 'ai.inspector', payload: {
      serial: 44, targetSerial: 45, maxNodes: 999,
    } })).toMatchObject({ ok: true, npc: {
      serial: 44, kind: 'orc', status: 'running', path: { reachable: true, steps: 3 },
    } });
    expect(inspect).toHaveBeenCalledWith(44);
    expect(previewPath).toHaveBeenCalledWith(44, 45, { maxNodes: 999 });
  });

  it('dispatches standardized RPC results through existing authoritative feature handlers', async () => {
    const sent = [];
    const { state } = fixture();
    state.nodeUOJsonTransport = true;
    state.nodeUOProtocol = { major: 2, minor: 1, json: true };
    state.nodeUOFeatures = new Map([['protocol.rpc', 2], ['quest.journal', 1]]);
    state.supportsNodeUO = (feature) => state.nodeUOFeatures.has(feature);
    state.sendNodeUOMessage = (message) => { sent.push(message); return true; };
    expect(handleServerNodeUOJsonMessage(state, {
      kind: NodeUOJsonKind.Request, feature: 'protocol.rpc', id: 'c.rpc.1', payload: {
        targetFeature: 'quest.journal', method: 'get', params: {}, timeoutMs: 1000,
      },
    })).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent.at(-1)).toMatchObject({ kind: NodeUOJsonKind.Result, replyTo: 'c.rpc.1', payload: {
      ok: true, result: { quests: [{ id: 'tutorial', stage: 2 }] },
    } });
  });

  it('cancels a running RPC through the handler AbortSignal', async () => {
    const sent = [];
    let observedSignal;
    const unregister = registerNodeUOMod('test.cancel', ({ signal }) => {
      observedSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const state = {
      accountName: 'modern', nodeUOJsonTransport: true, nodeUOProtocol: { major: 2, minor: 1 },
      nodeUOFeatures: new Map([['protocol.rpc', 2], ['mods.channels', 3]]),
      supportsNodeUO(feature) { return this.nodeUOFeatures.has(feature); },
      sendNodeUOMessage(message) { sent.push(message); return true; }, ctx: {},
    };
    expect(handleServerNodeUOJsonMessage(state, {
      kind: NodeUOJsonKind.Request, feature: 'protocol.rpc', id: 'rpc.cancel', payload: {
        targetFeature: 'mods.channels', method: 'run', timeoutMs: 1000,
        params: { namespace: 'test.cancel', data: {} },
      },
    })).toBe(true);
    await Promise.resolve();
    expect(observedSignal?.aborted).toBe(false);
    expect(handleServerNodeUOJsonMessage(state, {
      kind: NodeUOJsonKind.Cancel, feature: 'protocol.rpc', replyTo: 'rpc.cancel', payload: { reason: 'stop' },
    })).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(observedSignal.aborted).toBe(true);
    expect(sent.at(-1)).toMatchObject({ kind: NodeUOJsonKind.Error, replyTo: 'rpc.cancel',
      payload: { ok: false, code: 'cancelled' } });
    unregister();
  });

  it('single-flights and caches idempotent RPC mutations', async () => {
    const sent = [];
    let executions = 0;
    let finish;
    const unregister = registerNodeUOMod('test.rpc-once', () => {
      executions++;
      return new Promise((resolve) => { finish = resolve; });
    });
    const state = {
      accountName: 'modern', nodeUOJsonTransport: true, nodeUOProtocol: { major: 2, minor: 1 },
      nodeUOFeatures: new Map([['protocol.rpc', 2], ['mods.channels', 3]]),
      supportsNodeUO(feature) { return this.nodeUOFeatures.has(feature); },
      sendNodeUOMessage(message) { sent.push(message); return true; }, ctx: {},
    };
    const request = (id) => ({
      kind: NodeUOJsonKind.Request, feature: 'protocol.rpc', id,
      idempotencyKey: 'mutation-1', payload: { targetFeature: 'mods.channels', method: 'apply',
        params: { namespace: 'test.rpc-once', data: {} } },
    });
    handleServerNodeUOJsonMessage(state, request('rpc.once.1'));
    handleServerNodeUOJsonMessage(state, request('rpc.once.2'));
    expect(executions).toBe(0);
    await Promise.resolve();
    expect(executions).toBe(1);
    finish({ ok: true, changed: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent.filter((message) => message.replyTo?.startsWith('rpc.once'))).toHaveLength(2);
    handleServerNodeUOJsonMessage(state, request('rpc.once.3'));
    expect(sent.at(-1)).toMatchObject({ replyTo: 'rpc.once.3', payload: {
      ok: true, result: { ok: true, changed: 1 },
    } });
    expect(executions).toBe(1);
    unregister();
  });

  it('checkpoints live sequence cursors before disconnect and restores only negotiated state', () => {
    const { state } = fixture();
    const issued = [];
    state.nodeUOJsonTransport = true;
    state.nodeUOProtocol = { major: 2, minor: 1, json: true };
    state.nodeUOFeatures = new Map(advertisedFeatureList().map((entry) => [entry.id, entry.maximum]));
    state.supportsNodeUO = function supports(feature) {
      return typeof feature !== 'string' || this.nodeUOFeatures.has(feature);
    };
    state.sendNodeUOMessage = (message) => { issued.push(message); return true; };
    initializeNodeUOModern(state);
    const resume = issued.find((message) => message.feature === 'session.resume');
    state._nodeUOSequences.set('nodeuo.quest', 77);
    state._nodeUOChannelAcks.set('quest.journal', 75);
    expect(checkpointNodeUOResume(state)).toBe(true);
    state._nodeUOSequences.clear();
    state._nodeUOChannelAcks.clear();

    const restoredMessages = [];
    const restored = { ...state, _nodeUOSequences: new Map(), _nodeUOChannelAcks: new Map(),
      _nodeUOWorld: { baseline: 999, sequence: 1, acknowledged: 0 },
      sendNodeUOMessage: (message) => { restoredMessages.push(message); return true; } };
    expect(handleServerNodeUOJsonMessage(restored, {
      kind: NodeUOJsonKind.Resume, feature: 'session.resume', id: 'c.resume.1',
      featureVersion: 3, payload: { token: resume.payload.token, baseline: resume.payload.baseline },
    })).toBe(true);
    const result = restoredMessages.find((message) => message.replyTo === 'c.resume.1');
    expect(result.payload).toMatchObject({ ok: true, restored: {
      mode: 'current-snapshot', baseline: 999,
      sequences: { 'nodeuo.quest': 77 }, acknowledged: { 'quest.journal': 75 },
    } });
  });

  it('commits map mutations atomically through a bounded editor transaction', () => {
    const overlay = new Map();
    const provider = {
      landAt: (_facet, x, y) => overlay.get(`${x}|${y}`) ?? { tileId: 1, z: 0 },
      setLandTile: (facet, x, y, tileId, z) => overlay.set(`${x}|${y}`, { facet, x, y, tileId, z }),
      clearLandTile: (_facet, x, y) => overlay.delete(`${x}|${y}`),
      iterEdits: () => overlay.values(),
      saveEditsSync: vi.fn(() => ({ written: overlay.size })),
    };
    const state = { id: 9, account: { accessLevel: 'Admin' },
      ctx: { landProvider: provider, saveDir: 'test-save', connections: new Set() } };
    const begin = handleAdvancedFeature(state, { feature: 'editor.transactions',
      payload: { operation: 'begin' } });
    expect(begin.ok).toBe(true);
    const staged = handleAdvancedFeature(state, { feature: 'editor.transactions', payload: {
      operation: 'stage', transactionId: begin.transactionId,
      mutations: [{ kind: 'land', facet: 1, x: 100, y: 200, tileId: 42, z: 3 }],
    } });
    expect(staged).toMatchObject({ ok: true, staged: 1 });
    const committed = handleAdvancedFeature(state, { feature: 'editor.transactions', payload: {
      operation: 'commit', transactionId: begin.transactionId,
    } });
    expect(committed).toMatchObject({ ok: true, committed: 1 });
    expect(overlay.get('100|200')).toMatchObject({ tileId: 42, z: 3 });
    expect(provider.saveEditsSync).toHaveBeenCalledOnce();
  });

  it('strictly validates, bounds-checks and deduplicates editor land mutations', () => {
    const overlay = new Map();
    const provider = {
      metaFor: () => ({ blocksWide: 2, blocksTall: 2 }),
      landAt: (_facet, x, y) => overlay.get(`${x}|${y}`) ?? { tileId: 1, z: 0 },
      setLandTile: (facet, x, y, tileId, z) => overlay.set(`${x}|${y}`, { facet, x, y, tileId, z }),
      clearLandTile: (_facet, x, y) => overlay.delete(`${x}|${y}`),
      iterEdits: () => overlay.values(),
      saveEditsSync: vi.fn(() => ({ written: overlay.size })),
    };
    const state = { account: { accessLevel: 'GM' },
      ctx: { landProvider: provider, saveDir: 'test-save', connections: new Set() } };
    const begin = handleAdvancedFeature(state, { feature: 'editor.transactions',
      payload: { operation: 'begin' } });

    expect(handleAdvancedFeature(state, { feature: 'editor.transactions', payload: {
      operation: 'stage', transactionId: begin.transactionId,
      mutations: [{ facet: 9, x: 1, y: 1, tileId: 1, z: 0 }],
    } })).toMatchObject({ ok: false, error: 'only valid land mutations are supported' });
    expect(handleAdvancedFeature(state, { feature: 'editor.transactions', payload: {
      operation: 'stage', transactionId: begin.transactionId,
      mutations: [{ facet: 1, x: 1.5, y: 1, tileId: 1, z: 0 }],
    } })).toMatchObject({ ok: false });

    expect(handleAdvancedFeature(state, { feature: 'editor.transactions', payload: {
      operation: 'stage', transactionId: begin.transactionId,
      mutations: [
        { facet: 1, x: 2, y: 3, tileId: 10, z: 1 },
        { facet: 1, x: 2, y: 3, tileId: 11, z: 2 },
      ],
    } })).toMatchObject({ ok: true, staged: 1 });
    expect(handleAdvancedFeature(state, { feature: 'editor.transactions', payload: {
      operation: 'commit', transactionId: begin.transactionId,
    } })).toMatchObject({ ok: true, committed: 1 });
    expect(overlay.get('2|3')).toMatchObject({ tileId: 11, z: 2 });

    const outside = handleAdvancedFeature(state, { feature: 'editor.transactions',
      payload: { operation: 'begin' } });
    handleAdvancedFeature(state, { feature: 'editor.transactions', payload: {
      operation: 'stage', transactionId: outside.transactionId,
      mutations: [{ facet: 1, x: 16, y: 1, tileId: 1, z: 0 }],
    } });
    expect(handleAdvancedFeature(state, { feature: 'editor.transactions', payload: {
      operation: 'commit', transactionId: outside.transactionId,
    } })).toMatchObject({ ok: false, error: 'land mutation is outside the loaded map' });
  });

  it('never sends private data when a JSON feature was not negotiated', () => {
    const { state, sent } = fixture();
    state.nodeUOFeatures.clear();
    expect(initializeNodeUOModern(state)).toBe(true);
    expect(sent).toEqual([]);
    expect(sendNodeUOChannel(state, {
      channel: NodeUOChannel.Assets, namespace: 'nodeuo.assets', payload: {},
    })).toBe(false);
  });

  it('publishes world, quest, asset, party, UI and resume snapshots as JSON', () => {
    const { state, sent } = fixture();
    expect(initializeNodeUOModern(state)).toBe(true);
    expect(sent.map((message) => message.feature)).toEqual(expect.arrayContaining([
      'world.progressive-snapshot', 'world.timeline', 'quest.journal',
      'assets.content-addressed', 'social.state', 'ui.structured', 'session.resume',
    ]));
    expect(sent.find((message) => message.feature === 'quest.journal')?.payload.quests[0])
      .toMatchObject({ id: 'tutorial', stage: 2 });
    expect(sent.every((message) => !(message instanceof Uint8Array))).toBe(true);
  });

  it('activates component deltas only after matching JSON baseline ACKs', () => {
    const { state, sent, mobile } = fixture();
    initializeNodeUOModern(state);
    const snapshots = sent.filter((message) => message.feature === 'world.progressive-snapshot');
    const clientReplies = [];
    const clientNet = { nodeUOJsonTransport: true, supportsNodeUO: () => true,
      sendNodeUOMessage: (message) => { clientReplies.push(message); return true; } };
    for (const message of snapshots) handleNodeUOJsonMessage(clientNet, message);
    for (const reply of clientReplies) handleServerNodeUOJsonMessage(state, reply);
    expect(state._nodeUOWorld.ready).toBe(true);
    sent.length = 0;
    mobile.x = 102;
    expect(trySendNodeUOEntityDelta(state, mobile.serial, NodeUOWorldField.Position)).toBe(true);
    expect(sent[0]).toMatchObject({
      kind: NodeUOJsonKind.Delta,
      payload: { entities: [{ serial: mobile.serial,
        components: { position: { x: 102, y: 200 } } }] },
    });
  });

  it('accepts only loss-tolerant complete JSON envelopes from a datagram sidecar', () => {
    const net = new NetClient();
    net.nodeUOJsonTransport = true;
    const received = [];
    net._onNodeUOJsonMessage = (message) => { received.push(message); return true; };
    const cosmetic = serializeNodeUOMessage({ feature: 'world.timeline',
      delivery: NodeUODelivery.LossTolerant, payload: { weather: 1 } });
    const reliable = serializeNodeUOMessage({ feature: 'assets.streaming',
      delivery: NodeUODelivery.Reliable, payload: {} });
    expect(net.receiveNodeUODatagram(cosmetic)).toBe(true);
    expect(net.receiveNodeUODatagram(reliable)).toBe(false);
    expect(received).toHaveLength(1);
  });

  it('applies sequenced JSON channels and acknowledges reliable messages', () => {
    const { state, sent } = fixture();
    const sequence = sendNodeUOChannel(state, {
      channel: NodeUOChannel.Assets, namespace: 'nodeuo.assets',
      kind: NodeUOChannelMessage.Delta, flags: NodeUOChannelFlag.AckRequired,
      payload: { changed: ['gump:4'] },
    });
    const message = sent.at(-1);
    const replies = [];
    const clientNet = { nodeUOJsonTransport: true, supportsNodeUO: () => true,
      sendNodeUOMessage: (reply) => { replies.push(reply); return true; } };
    expect(handleNodeUOJsonMessage(clientNet, message)).toBe(true);
    expect(sequence).toBeGreaterThan(0);
    expect(replies[0]).toMatchObject({
      kind: NodeUOJsonKind.Ack, feature: 'assets.streaming', ack: sequence,
    });
  });

  it('searches live vendor stock with paging and filters through JSON', async () => {
    const { state, sent } = fixture();
    const vendor = { serial: 9, name: 'Iolo', x: 101, y: 200, map: 1 };
    state.ctx.world.mobiles.set(vendor.serial, vendor);
    const vendors = { entries: () => new Map([[vendor.serial, {
      listStock: () => [
        { serial: 10, itemId: 0x13b9, name: 'Viking Sword', kind: 'weapon', amount: 4, price: 80 },
        { serial: 11, itemId: 0x0f0e, name: 'Empty Bottle', kind: 'resource', amount: 10, price: 5 },
      ],
    }]]).entries() };
    expect(handleServerNodeUOJsonMessage(state, {
      kind: NodeUOJsonKind.Request, feature: 'vendor.search', id: 'c.vendor.77',
      payload: { query: 'sword', kind: 'weapon', maxPrice: 100, limit: 5 },
    }, { vendors })).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    const result = sent.find((message) => message.replyTo === 'c.vendor.77');
    expect(result).toMatchObject({ kind: NodeUOJsonKind.Result,
      payload: { ok: true, total: 1,
        entries: [{ vendorSerial: vendor.serial, name: 'Viking Sword', price: 80 }] } });
  });
});
