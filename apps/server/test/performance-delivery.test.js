import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleNodeUOWave4Feature } from '../src/net/handlers/nodeuo-wave4.js';
import { ContentReleaseManager } from '../src/systems/content-release-manager.js';
import { FeatureRolloutController } from '../src/systems/feature-rollouts.js';
import { World } from '../src/world/world.js';

const temporary = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(directory);
  return directory;
}

describe('performance and delivery controls', () => {
  it('publishes validated deterministic rollouts and trips unhealthy features', () => {
    const directory = tempDir('nodeuo-rollout-');
    const controller = new FeatureRolloutController(path.join(directory, 'rollouts.json'), {
      knownFeatures: ['world.region-prefetch'],
    });
    expect(controller.draft({ unknown: { stage: 'on' } }).ok).toBe(false);
    expect(controller.validate({ unknown: { stage: 'on' } })).toMatchObject({ ok: false });
    expect(controller.draft({ 'world.region-prefetch': {
      stage: 'canary', percentage: 25, minimumSamples: 10, maxErrorRate: 0.1,
    } })).toMatchObject({ ok: true });
    expect(controller.publish(1)).toMatchObject({ ok: true, revision: 2 });
    const peer = { accountName: 'same-account' };
    expect(controller.allowed(peer, 'world.region-prefetch'))
      .toBe(controller.allowed(peer, 'world.region-prefetch'));
    for (let index = 0; index < 10; index++) controller.observe('world.region-prefetch', false, 1000 + index);
    expect(controller.allowed(peer, 'world.region-prefetch', 2000)).toBe(false);
  });

  it('revalidates immutable asset hashes before activating or rolling back a release', async () => {
    const directory = tempDir('nodeuo-release-');
    const assets = path.join(directory, 'assets');
    fs.mkdirSync(assets);
    fs.writeFileSync(path.join(assets, 'mobiles-atlas-index.json'), '{"revision":"one"}\n');
    const manager = new ContentReleaseManager(path.join(directory, 'releases.json'), assets);
    const staged = await manager.stage({ label: 'atlas one', files: ['mobiles-atlas-index.json'] });
    fs.writeFileSync(path.join(assets, 'mobiles-atlas-index.json'), '{"revision":"changed"}\n');
    await expect(manager.activate(staged.release.id, 1)).resolves.toMatchObject({ ok: false });

    const first = await manager.stage({ label: 'atlas one checked', files: ['mobiles-atlas-index.json'] });
    await expect(manager.activate(first.release.id, 1)).resolves.toMatchObject({ ok: true, revision: 2 });
    fs.writeFileSync(path.join(assets, 'mobiles-atlas-index.json'), '{"revision":"two"}\n');
    const second = await manager.stage({ label: 'atlas two', files: ['mobiles-atlas-index.json'] });
    await expect(manager.activate(second.release.id, 2)).resolves.toMatchObject({ ok: true, revision: 3 });
    expect(manager.rollback(3)).toMatchObject({ ok: true, revision: 4,
      active: { label: 'atlas one checked' } });
  });

  it('runs consent, performance, interaction, prefetch, health and digest services on live state', async () => {
    const world = new World();
    const actor = world.createMobile({ name: 'Player', isPlayer: true, x: 100, y: 100, z: 0, map: 1, body: 400 });
    const npc = world.createMobile({ name: 'Banker', x: 101, y: 100, z: 0, map: 1, body: 17 });
    const item = world.createItem({ name: 'Chest', itemId: 0x0e40, x: 102, y: 100, z: 0, map: 1 });
    const observations = [];
    const state = {
      id: 'wave4-test', accountName: 'tester', mobile: actor,
      nodeUOFeatures: new Map([
        ['protocol.feature-health', 1], ['world.region-prefetch', 1], ['interaction.catalog', 1],
      ]),
      _visibleMobiles: new Set([npc.serial]), _visibleItems: new Set([item.serial]),
      ctx: { world, featureRollouts: { observe: (...args) => observations.push(args), snapshot: () => ({ active: {} }) },
        contentReleases: { snapshot: () => ({ revision: 2, active: { fingerprint: 'release-hash' } }) } },
    };
    const dialogs = { isScripted: () => true, open: () => true, sendPaperdoll: () => true };
    const call = (feature, payload = {}) => handleNodeUOWave4Feature(state, { feature, payload }, { npcDialogs: () => dialogs });

    expect(call('client.performance-hints', { fps: 30 })).toMatchObject({ ok: false, consentRequired: 'performance' });
    expect(call('protocol.consent', { operation: 'update', category: 'performance', granted: true, revision: 1 }))
      .toMatchObject({ ok: true, revision: 2 });
    expect(call('client.performance-hints', { frameP95Ms: 45, desiredRateHz: 200 }))
      .toMatchObject({ ok: true, applied: { levelOfDetail: 'minimal', rateHz: 60 } });
    const catalog = call('interaction.catalog', { targetSerial: npc.serial });
    expect(catalog.actions.map((action) => action.id)).toEqual(['dialog', 'paperdoll', 'inspect']);
    expect(call('interaction.catalog', { operation: 'invoke', targetSerial: npc.serial,
      expectedRevision: catalog.revision, actionId: 'dialog' })).toMatchObject({ ok: true, action: 'dialog' });
    expect(call('world.region-prefetch', {})).toMatchObject({ ok: true,
      bodies: expect.arrayContaining([400, 17]), items: expect.arrayContaining([0x0e40]) });
    expect(call('world.sector-digest', {}).digests.length).toBeGreaterThan(0);
    expect(call('protocol.feature-health', { reports: [{ feature: 'world.region-prefetch', status: 'failed' }] }))
      .toMatchObject({ ok: true, disabled: ['world.region-prefetch'] });
    await Promise.resolve();
    expect(state._nodeUODisabledFeatures.has('world.region-prefetch')).toBe(true);
    expect(observations).toContainEqual(['world.region-prefetch', false]);
  });
});
