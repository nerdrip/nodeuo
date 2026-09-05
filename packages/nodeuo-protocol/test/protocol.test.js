import { describe, expect, it } from 'vitest';
import {
  NODEUO_FEATURE_CATALOG,
  NODEUO_JSON_SUBPROTOCOL,
  NodeUOJsonKind,
  advertisedFeatureList,
  buildNodeUOManifest,
  createNodeUOMessage,
  isNodeUOMessageExpired,
  NodeUOFeature,
  negotiateFeatures,
  normalizeSubscription,
  parseNodeUOFrame,
  parseNodeUOMessage,
  serializeNodeUOMessage,
  serializeNodeUOFrame,
  createNodeUORpcCancel,
  createNodeUORpcRequest,
  normalizeNodeUORpcRequest,
  NODEUO_JSON_SCHEMA_DIALECT,
  schemaDocumentForFeature,
  validateFeaturePayload,
  checkNodeUOPreconditions,
  createNodeUOError,
  NodeUOErrorCode,
} from '../src/index.js';

describe('NodeUO JSON Protocol v2', () => {
  it('uses text JSON and an unbounded string feature registry', () => {
    expect(NODEUO_JSON_SUBPROTOCOL).toBe('nodeuo.json.v2');
    expect(NODEUO_FEATURE_CATALOG.length).toBeGreaterThan(64);
    expect(new Set(NODEUO_FEATURE_CATALOG.map((entry) => entry.id)).size).toBe(NODEUO_FEATURE_CATALOG.length);
    const text = serializeNodeUOMessage({ kind: NodeUOJsonKind.Event, feature: 'party.markers',
      seq: 4, requiresAck: true, payload: { x: 1 } });
    expect(typeof text).toBe('string');
    expect(parseNodeUOMessage(text).payload).toEqual({ x: 1 });
    expect(parseNodeUOMessage(text)).toMatchObject({ seq: 4, requiresAck: true });
  });

  it('negotiates every feature independently', () => {
    const selected = negotiateFeatures(
      [{ id: 'world.delta', minimum: 1, maximum: 3 }, { id: 'future.feature', minimum: 4, maximum: 9 }],
      [{ id: 'world.delta', minimum: 2, maximum: 2 }, { id: 'future.feature', minimum: 1, maximum: 6 }],
    );
    expect(selected).toEqual([
      { id: 'future.feature', version: 6 },
      { id: 'world.delta', version: 2 },
    ]);
  });

  it('uses semantic feature names with no global bit mask', () => {
    expect(NodeUOFeature.NpcDialog).toBe('npc.dialog');
    expect(NodeUOFeature.WorldDelta).toBe('world.delta');
    expect(Object.values(NodeUOFeature).every((id) => typeof id === 'string')).toBe(true);
    expect(new Set(Object.values(NodeUOFeature)).size).toBe(Object.values(NodeUOFeature).length);
  });

  it('rejects unsafe trees and expires replaceable events', () => {
    const message = createNodeUOMessage({ feature: 'movement.hints', ttlMs: 50, sentAt: 100, payload: {} });
    expect(isNodeUOMessageExpired(message, 151)).toBe(true);
    expect(() => parseNodeUOMessage('{"nodeuo":2,"kind":"event","feature":"x","payload":{"__proto__":1}}'))
      .toThrow(/forbidden/);
  });

  it('negotiates dependency-safe manifests and bounded JSON frame batches', () => {
    const offered = advertisedFeatureList();
    const manifest = buildNodeUOManifest(offered);
    expect(manifest.fingerprint).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
    expect(manifest.features.find((entry) => entry.id === 'world.components'))
      .toMatchObject({ dependencies: ['world.delta'], schema: expect.stringMatching(/^fnv1a64:/) });
    expect(negotiateFeatures(
      [{ id: 'world.components', minimum: 1, maximum: 1 }],
      [{ id: 'world.components', minimum: 1, maximum: 1 }],
    )).toEqual([]);
    const text = serializeNodeUOFrame([
      { feature: 'flow.qos', payload: { pressure: 'normal' } },
      { feature: 'clock.sync', kind: NodeUOJsonKind.Ping, payload: { at: 1 } },
    ]);
    expect(parseNodeUOFrame(text)).toHaveLength(2);
    expect(() => serializeNodeUOFrame(Array.from({ length: 65 }, () => ({ feature: 'x' })))).toThrow(/1-64/);
  });

  it('normalizes selective subscriptions with hard bounds', () => {
    expect(normalizeSubscription({
      target: 'world.components', components: ['position', 'position', 'Vitals'],
      fields: ['x', '__proto__'], rateHz: 500, maxEntities: 50_000,
    })).toEqual({ target: 'world.components', components: ['position', 'vitals'],
      fields: ['x'], rateHz: 60, maxEntities: 2048 });
  });

  it('bounds spatial subscriptions, bandwidth and level of detail', () => {
    expect(normalizeSubscription({ target: 'world.components', levelOfDetail: 'minimal',
      maxBytesPerSecond: 1, area: { type: 'circle', map: 1, x: 50, y: 60, radius: 999 } }))
      .toMatchObject({ levelOfDetail: 'minimal', maxBytesPerSecond: 16 * 1024,
        area: { type: 'circle', map: 1, x: 50, y: 60, radius: 256 } });
  });

  it('describes schema lifecycle and validates stable payload boundaries', () => {
    const manifest = buildNodeUOManifest(advertisedFeatureList());
    expect(manifest.version).toBeGreaterThanOrEqual(2);
    expect(manifest.features.find((entry) => entry.id === 'protocol.rpc')).toMatchObject({
      lifecycle: { status: 'stable', since: '2.1' },
    });
    expect(validateFeaturePayload('protocol.rpc', { targetFeature: 'vendor.search', method: 'search' }).ok).toBe(true);
    expect(validateFeaturePayload('protocol.rpc', { targetFeature: 'vendor.search' })).toMatchObject({
      ok: false, errors: [{ path: '$.method', expected: 'required' }],
    });
    expect(schemaDocumentForFeature('inventory.transactions')).toMatchObject({
      $schema: NODEUO_JSON_SCHEMA_DIALECT,
      $id: expect.stringContaining('/inventory.transactions/'),
      title: 'inventory.transactions',
    });
    expect(validateFeaturePayload('inventory.transactions', { operation: 'commit', mutations: [
      { serial: 1, x: 10, y: 20 }, { serial: 2, x: -1, y: 20 },
    ] })).toMatchObject({ ok: false, errors: expect.arrayContaining([
      { path: '$.mutations[1].x', expected: 'minimum 0' },
    ]) });
    expect(validateFeaturePayload('ui.accessibility', {
      operation: 'set', preferences: { scale: 4, contrast: 'neon' },
    }).ok).toBe(false);
  });

  it('publishes live renegotiation, asset preflight, and diagnostics as independent features', () => {
    const manifest = buildNodeUOManifest(advertisedFeatureList());
    expect(manifest.version).toBeGreaterThanOrEqual(5);
    expect(manifest.features).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'protocol.renegotiate' }),
      expect.objectContaining({ id: 'assets.client-profile' }),
      expect.objectContaining({ id: 'content.preflight' }),
      expect.objectContaining({ id: 'diagnostics.trace' }),
    ]));
    expect(manifest.features.find((row) => row.id === 'interaction.catalog')?.maximum).toBe(2);
    expect(manifest.features.find((row) => row.id === 'world.region-prefetch')?.maximum).toBe(2);
  });

  it('negotiates the game-system workbench without consuming a binary capability bit', () => {
    const manifest = buildNodeUOManifest(advertisedFeatureList());
    expect(NodeUOFeature.GameSystems).toBe('game.systems');
    expect(manifest.version).toBeGreaterThanOrEqual(8);
    expect(manifest.features.find((row) => row.id === 'game.systems')).toMatchObject({
      dependencies: ['ui.structured', 'world.events'],
      lifecycle: { status: 'stable', since: '2.7' },
    });
    expect(validateFeaturePayload('game.systems', {
      operation: 'action', systemId: 'regional-invasions', instanceId: 'instance:1', actionId: 'scout',
    }).ok).toBe(true);
  });

  it('builds bounded cancellable RPC envelopes without changing the UO transport', () => {
    const request = createNodeUORpcRequest({ id: 'c.9', targetFeature: 'vendor.search',
      method: 'search', params: { query: 'sword' }, timeoutMs: 90_000 });
    expect(request).toMatchObject({ kind: 'request', feature: 'protocol.rpc', id: 'c.9',
      ttlMs: 30_000, payload: { method: 'search', timeoutMs: 30_000 } });
    expect(normalizeNodeUORpcRequest(request.payload).targetFeature).toBe('vendor.search');
    expect(createNodeUORpcCancel('c.9')).toMatchObject({ kind: 'cancel', replyTo: 'c.9' });
  });

  it('round-trips bounded causality, transaction and precondition metadata', () => {
    const text = serializeNodeUOMessage({
      feature: 'protocol.transactions', id: 'c.77', traceId: 'trace:77',
      correlationId: 'interaction:9', causationId: 'click:4', transactionId: 'tx:3',
      deadlineAt: 123456, preconditions: { revision: 8, alive: true, ignored: {} },
      payload: { operation: 'commit', actions: [] },
    });
    expect(parseNodeUOMessage(text)).toMatchObject({
      traceId: 'trace:77', correlationId: 'interaction:9', causationId: 'click:4',
      transactionId: 'tx:3', deadlineAt: 123456,
      preconditions: { revision: 8, alive: true },
    });
    expect(checkNodeUOPreconditions({ revision: 8, alive: true }, { revision: 9, alive: true }))
      .toEqual({ ok: false, failed: [{ key: 'revision', expected: 8, actual: 9 }] });
  });

  it('creates stable machine-readable error contracts', () => {
    expect(createNodeUOError(NodeUOErrorCode.RateLimited, 'slow down', {
      retryable: true, retryAfterMs: 500, traceId: 'trace:1', recovery: 'retry',
    })).toMatchObject({ ok: false, code: 'rate-limited', retryable: true,
      retryAfterMs: 500, traceId: 'trace:1', recovery: 'retry' });
  });
});
