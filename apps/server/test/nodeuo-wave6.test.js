import { describe, expect, it } from 'vitest';
import { advertisedFeatureList, NodeUOErrorCode, NodeUOJsonKind } from '@uo/nodeuo-protocol';
import { handleNodeUOJsonMessage } from '../src/net/handlers/nodeuo-modern.js';
import { handleNodeUOFeatureRequest } from '../src/net/handlers/nodeuo-features.js';
import { handleNodeUOWave6Feature } from '../src/net/handlers/nodeuo-wave6.js';

function request(feature, payload = {}) { return { feature, payload }; }

function fixture() {
  const mobile = { serial: 1, name: 'Player', x: 100, y: 100, z: 0, map: 0, dead: false,
    _nodeUOConsent: { revision: 1, categories: { diagnostics: true } }, activeQuests: [{ id: 'tutorial', progress: [1] }] };
  const backpack = { serial: 10, itemId: 0x0e75, parent: 1, layer: 21, amount: 1 };
  const ingots = { serial: 11, itemId: 0x1bf2, parent: 10, amount: 8, name: 'Iron ingots' };
  const hiddenTarget = { serial: 2, name: 'Hidden', x: 101, y: 100, z: 0, map: 0, dead: false };
  const world = { mobiles: new Map([[1, mobile], [2, hiddenTarget]]),
    items: new Map([[10, backpack], [11, ingots]]) };
  const state = {
    id: 'test-session', stage: 'inWorld', accountName: 'alice', account: { accessLevel: 'admin' },
    mobile, _visibleMobiles: new Set(), _visibleItems: new Set([10, 11]),
    nodeUOFeatures: new Map([['protocol.transactions', 1]]),
    ctx: {
      world, commands: { list: () => [{ name: 'where', access: 'Player', help: 'Show location.' },
        { name: 'secret', access: 'Admin', help: 'Staff command.' }] },
      systems: { crafting: { allRecipes: () => [{ id: 'sword', name: 'Sword', outputItemId: 0x13b9,
        outputCount: 1, inputs: [{ itemId: 0x1bf2, count: 5 }] }] } },
      quests: { getQuest: () => ({ objectives: [{ kind: 'collect', target: 'ingots', count: 3, hint: 'Find iron.' }] }) },
      dayNight: { season: 2, hourOfDay: () => 12, currentPhase: () => 'day', currentLevel: () => 4 },
      contentDependencies: { impact: (node) => ({ ok: node === 'script:known.js' }),
        snapshot: () => ({ revision: 'abc', nodes: [{ id: 'script:known.js', kind: 'script', path: 'known.js' }] }) },
      scriptRuntime: { generation: 3, loaded: [{ file: 'known.js' }] },
      ai: { behaviors: new Map([['aggressive', {}]]) },
      economyLedger: { receipts: () => [{ id: 'receipt-1' }], verify: () => ({ ok: true }) },
      contentReleases: { preflight: () => ({ ok: true, warnings: [] }) }, connections: new Set(),
    },
  };
  return { state, mobile };
}

describe('NodeUO wave 6 functional services', () => {
  it('returns real inventory and crafting projections from authoritative state', () => {
    const { state } = fixture();
    expect(handleNodeUOWave6Feature(state, request('inventory.views'))).toMatchObject({
      ok: true, total: 1, items: [{ serial: 11, amount: 8 }],
    });
    expect(handleNodeUOWave6Feature(state, request('crafting.plan', { recipes: ['sword'] }))).toMatchObject({
      ok: true, executable: true, materials: [{ itemId: 0x1bf2, required: 5, available: 8, missing: 0 }],
    });
  });

  it('preflights hidden combat targets without leaking their location', () => {
    const { state } = fixture();
    const result = handleNodeUOWave6Feature(state, request('combat.preflight', { targetSerial: 2 }));
    expect(result).toMatchObject({ ok: true, allowed: false });
    expect(result.reasons).toContain('target-not-visible');
  });

  it('commits supported preference operations atomically and rejects unsupported actions', () => {
    const { state, mobile } = fixture();
    const committed = handleNodeUOWave6Feature(state, request('protocol.transactions', {
      operation: 'commit', transactionId: 'tx.1', preconditions: { alive: true },
      actions: [{ type: 'CONSENT.UPDATE', category: 'voice', granted: true },
        { type: 'accessibility.update', preferences: { reduceMotion: true } }],
    }));
    expect(committed).toMatchObject({ ok: true, transactionId: 'tx.1', committed: 2 });
    expect(mobile._nodeUOConsent.categories.voice).toBe(true);
    expect(mobile.nodeUOAccessibility.reduceMotion).toBe(true);
    expect(handleNodeUOWave6Feature(state, request('protocol.transactions', {
      operation: 'commit', actions: [{ type: 'world.delete' }],
    }))).toMatchObject({ ok: false, code: NodeUOErrorCode.Unsupported });
  });

  it('exposes command schemas, content impact, guidance and verified receipts', () => {
    const { state } = fixture();
    expect(handleNodeUOWave6Feature(state, request('protocol.command-schema')).commands).toHaveLength(2);
    expect(handleNodeUOWave6Feature(state, request('content.dependencies', {
      operation: 'impact', node: 'script:known.js',
    })).ok).toBe(true);
    expect(handleNodeUOWave6Feature(state, request('quest.guidance')).quests[0].next.hint).toBe('Find iron.');
    expect(handleNodeUOWave6Feature(state, request('trade.receipts'))).toMatchObject({
      ok: true, verified: true, receipts: [{ id: 'receipt-1' }],
    });
  });

  it('requires explicit diagnostic consent for evidence and moderation reports', () => {
    const { state, mobile } = fixture();
    expect(handleNodeUOWave6Feature(state, request('support.evidence')).privacy).toMatchObject({
      rawPackets: false, chat: false, credentials: false,
    });
    mobile._nodeUOConsent.categories.diagnostics = false;
    expect(handleNodeUOWave6Feature(state, request('moderation.case', { summary: 'report' })))
      .toMatchObject({ ok: false, code: NodeUOErrorCode.PermissionDenied });
  });

  it('serializes contract failures as structured error envelopes', async () => {
    const { state, mobile } = fixture(); const sent = [];
    mobile._nodeUOConsent.categories.diagnostics = false;
    state.nodeUOJsonTransport = true;
    state.nodeUOProtocol = { major: 2, minor: 0, json: true };
    state.nodeUOFeatures = new Map(advertisedFeatureList().map((entry) => [entry.id, entry.maximum]));
    state.supportsNodeUO = (feature) => typeof feature !== 'string' || state.nodeUOFeatures.has(feature);
    state.sendNodeUOMessage = (message) => { sent.push(message); return true; };
    state.ctx.handleNodeUOFeatureRequest = handleNodeUOFeatureRequest;
    expect(handleNodeUOJsonMessage(state, {
      kind: NodeUOJsonKind.Request, id: 'request.1', feature: 'moderation.case',
      payload: { operation: 'create', summary: 'A report requiring consent.' } })).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent.at(-1)).toMatchObject({ kind: NodeUOJsonKind.Error, replyTo: 'request.1',
      payload: { ok: false, code: NodeUOErrorCode.PermissionDenied, retryable: false } });
  });
});
