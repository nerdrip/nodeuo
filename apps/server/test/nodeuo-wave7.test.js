import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeUOErrorCode } from '@uo/nodeuo-protocol';
import { handleNodeUOWave7Feature } from '../src/net/handlers/nodeuo-wave7.js';
import { PlatformOperations } from '../src/systems/platform-operations.js';

const temporaryDirectories = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function request(feature, payload = {}) { return { feature, payload }; }

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-wave7-'));
  temporaryDirectories.push(root);
  const scriptsDir = path.join(root, 'scripts'); fs.mkdirSync(scriptsDir);
  const mobile = { serial: 1, name: 'Alice', nodeUOWorldLayer: 'base',
    _nodeUOConsent: { categories: { diagnostics: true, performance: true } } };
  const target = { serial: 2, name: 'Target', nodeUOWorldLayer: 'base' };
  const party = { leader: 1, members: [1, 2] };
  const platformOperations = new PlatformOperations({ saveDir: root, scriptsDir });
  platformOperations.createModerationCase({ reporter: 'alice', summary: 'Existing case' });
  platformOperations.upsertLiveEvent({ id: 'invasion', phases: [{ id: 'warning' }] }, 'admin');
  const state = {
    id: 'session-1', accountName: 'alice', account: { accessLevel: 'Admin' }, mobile,
    nodeUOFeatures: new Map([['world.layers', 1], ['protocol.policy', 1], ['world.components', 1]]),
    ctx: {
      saveDir: root, platformOperations, world: { mobiles: new Map([[1, mobile], [2, target]]), items: new Map() },
      partyRegistry: { partyOf: () => party }, handlers: { refreshSurroundings() {} },
      contentReleases: { snapshot: () => ({ revision: 8,
        active: { id: 'summer', fingerprint: 'sha256:abc', revision: 8, files: [{ name: 'map.json' }] } }) },
      protocolCosts: { snapshot: () => ({ features: [{ feature: 'world.layers', avgMs: 0.2, maxMs: 1.1,
        bytesIn: 20, bytesOut: 40 }] }) }, nodeUOSettings: { value: { features: {} } },
    },
  };
  return { state, mobile, target, party };
}

describe('NodeUO schema v7 services', () => {
  it('provides policy, expiring subscription leases, costs and conformance fixtures', () => {
    const { state } = fixture();
    expect(handleNodeUOWave7Feature(state, request('protocol.policy', { feature: 'world.layers' })))
      .toMatchObject({ ok: true, entries: [{ feature: 'world.layers', negotiated: true }] });
    const acquired = handleNodeUOWave7Feature(state, request('protocol.subscription-leases', {
      operation: 'acquire', target: 'world.components', rateHz: 20, ttlMs: 10_000,
    }));
    expect(acquired).toMatchObject({ ok: true, lease: { target: 'world.components', subscription: { rateHz: 20 } } });
    expect(handleNodeUOWave7Feature(state, request('protocol.subscription-leases', {
      operation: 'renew', leaseId: acquired.lease.leaseId, ttlMs: 20_000,
    }))).toMatchObject({ ok: true, lease: { renewals: 1 } });
    expect(handleNodeUOWave7Feature(state, request('protocol.cost-hints', { feature: 'world.layers' })))
      .toMatchObject({ ok: true, hints: [{ feature: 'world.layers', measuredAvgMs: 0.2 }] });
    expect(handleNodeUOWave7Feature(state, request('protocol.conformance', {
      probes: ['world.layers'], nonce: 'probe-1',
    }))).toMatchObject({ ok: true, nonce: 'probe-1', schemaVersion: 7,
      fixtures: [{ feature: 'world.layers', valid: true }] });
  });

  it('filters world layers server-side and maintains revision-safe party loot policy', () => {
    const { state, target, party } = fixture();
    expect(handleNodeUOWave7Feature(state, request('world.layers', {
      operation: 'set', targetSerial: 2, layer: 'event:invasion',
    }))).toMatchObject({ ok: true, targetSerial: 2, layer: 'event:invasion', serverFiltered: true });
    expect(target.nodeUOWorldLayer).toBe('event:invasion');
    const updated = handleNodeUOWave7Feature(state, request('party.loot-policy', {
      operation: 'set', expectedRevision: 1, policy: { mode: 'round-robin', threshold: 50 },
    }));
    expect(updated).toMatchObject({ ok: true, policy: { revision: 2, mode: 'round-robin', threshold: 50 } });
    expect(party._nodeUOLootPolicy).toEqual(updated.policy);
    expect(handleNodeUOWave7Feature(state, request('party.loot-policy', {
      operation: 'set', expectedRevision: 1, policy: { mode: 'leader' },
    }))).toMatchObject({ ok: false, code: NodeUOErrorCode.Conflict });
  });

  it('retains consented frame diagnostics only in the session and exposes safe forms', () => {
    const { state, mobile } = fixture();
    expect(handleNodeUOWave7Feature(state, request('diagnostics.client-frame', {
      renderer: 'webgl', samples: [{ at: 1, frameMs: 18, scripts: [{ source: 'ui.js', duration: 4 }] }],
    }))).toMatchObject({ ok: true, accepted: 1, retained: 'session' });
    expect(state._nodeUOFrameDiagnostics).toMatchObject({ renderer: 'webgl', samples: [{ frameMs: 18 }] });
    expect(handleNodeUOWave7Feature(state, request('ui.safe-schema'))).toMatchObject({ ok: true,
      forms: expect.arrayContaining([expect.objectContaining({ id: 'support.report' })]) });
    expect(handleNodeUOWave7Feature(state, request('ui.safe-schema', {
      operation: 'submit', formId: 'support.report', values: { category: 'bug', summary: 'Report from client' },
    }))).toMatchObject({ ok: true, case: { category: 'bug', reporter: 'alice' } });
    mobile._nodeUOConsent.categories.performance = false;
    expect(handleNodeUOWave7Feature(state, request('diagnostics.client-frame', { samples: [] })))
      .toMatchObject({ ok: false, code: NodeUOErrorCode.PermissionDenied });
  });

  it('signs release metadata and serves resumable durable streams', () => {
    const { state } = fixture();
    const signed = handleNodeUOWave7Feature(state, request('protocol.signed-content', { releaseId: 'summer' }));
    const publicKey = crypto.createPublicKey({ key: Buffer.from(signed.publicKey, 'base64url'), type: 'spki', format: 'der' });
    expect(crypto.verify(null, Buffer.from(JSON.stringify(signed.document)), publicKey,
      Buffer.from(signed.signature, 'base64url'))).toBe(true);
    const first = handleNodeUOWave7Feature(state, request('protocol.resumable-streams', {
      stream: 'incidents', limit: 1,
    }));
    expect(first).toMatchObject({ ok: true, stream: 'incidents', entries: [expect.any(Object)],
      resumeToken: expect.stringContaining('.') });
    expect(handleNodeUOWave7Feature(state, request('protocol.resumable-streams', {
      stream: 'incidents', token: first.resumeToken, limit: 1,
    }))).toMatchObject({ ok: true, cursor: 1 });
  });
});
