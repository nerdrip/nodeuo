import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerNodeUOMod } from '../src/net/handlers/nodeuo-modern.js';
import {
  handleNodeUOWave3Feature,
  publishCombatTelegraph,
  recordNpcInteraction,
} from '../src/net/handlers/nodeuo-wave3.js';
import { NodeUOSettingsStore } from '../src/systems/nodeuo-settings.js';
import { World } from '../src/world/world.js';

const temporary = [];
const unregister = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const remove of unregister.splice(0)) remove();
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture({ staff = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-wave3-'));
  temporary.push(directory);
  const world = new World();
  const mobile = world.createMobile({ name: 'Tester', x: 100, y: 100, z: 0, map: 1 });
  mobile._nodeUOConsent = { revision: 1, categories: {
    performance: false, diagnostics: false, voice: true, personalization: false,
  } };
  mobile.activeQuests = { tutorial: { stage: 1, progress: { 0: 2 } } };
  const messages = [];
  const packets = [];
  const settings = new NodeUOSettingsStore(path.join(directory, 'settings.json'), {
    instances: [{ id: 'dungeon', label: 'Dungeon', url: 'wss://instance.example.test/nodeuo',
      secret: 'instance-secret-1234' }],
  });
  const state = {
    id: `session-${mobile.serial}`, accountName: 'tester', account: { accessLevel: staff ? 'gm' : 'player' },
    mobile, nodeUOJsonTransport: true,
    nodeUOFeatures: new Map([
      ['party.tactics', 1], ['combat.telegraphs', 1], ['voice.spatial-state', 1],
    ]),
    supportsNodeUO: () => true,
    send: (packet) => packets.push(packet),
    sendNodeUOMessage: (message) => { messages.push(message); return true; },
    ctx: { world, saveDir: directory, nodeUOSettings: settings, connections: [], vendors: new Map(),
      quests: { getQuest: (id) => id === 'tutorial' ? { name: 'First steps', description: 'Learn the basics.',
        objectives: [{ kind: 'collect', target: 'bandage', count: 3 }] } : null },
      partyRegistry: { partyOf: () => null } },
  };
  mobile.client = state;
  return { directory, world, mobile, state, settings, messages, packets };
}

function request(state, feature, payload = {}) {
  return handleNodeUOWave3Feature(state, { feature, payload });
}

describe('NodeUO wave 3 authoritative services', () => {
  it('commits an owned inventory layout atomically and emits ordinary UO updates', () => {
    const { world, mobile, state, packets } = fixture();
    const backpack = world.createItem({ itemId: 0x0e75, parent: mobile.serial, layer: 21,
      x: 0, y: 0, z: 0, gridX: 0, gridY: 0 });
    const first = world.createItem({ itemId: 0x0f7a, parent: backpack.serial,
      x: 0, y: 0, z: 0, gridX: 10, gridY: 12 });
    const second = world.createItem({ itemId: 0x0f84, parent: backpack.serial,
      x: 0, y: 0, z: 0, gridX: 14, gridY: 16 });

    const rejected = request(state, 'inventory.transactions', { operation: 'commit',
      containerSerial: backpack.serial, expectedRevision: 0,
      mutations: [{ serial: first.serial, x: 40, y: 50 }, { serial: 0xdeadbeef, x: 1, y: 1 }] });
    expect(rejected.ok).toBe(false);
    expect([first.gridX, first.gridY]).toEqual([10, 12]);

    const committed = request(state, 'inventory.transactions', { operation: 'commit',
      transactionId: 'layout.1', containerSerial: backpack.serial, expectedRevision: 0,
      mutations: [{ serial: first.serial, x: 40, y: 50 }, { serial: second.serial, x: 60, y: 70 }] });
    expect(committed).toMatchObject({ ok: true, transactionId: 'layout.1', committed: 2, revision: 1 });
    expect([first.gridX, first.gridY, second.gridX, second.gridY]).toEqual([40, 50, 60, 70]);
    expect(packets).toHaveLength(2);
    expect(packets.every((packet) => packet[0] === 0x25)).toBe(true);
    expect(request(state, 'inventory.transactions', { operation: 'snapshot',
      containerSerial: backpack.serial }).items[0]).toHaveProperty('x');
  });

  it('derives quests and markets from live server registries instead of placeholder data', () => {
    const { world, state } = fixture();
    const graph = request(state, 'quest.graph', { questId: 'tutorial' });
    expect(graph.quests[0]).toMatchObject({ id: 'tutorial', name: 'First steps',
      nodes: [{ kind: 'collect', target: 'bandage', required: 3, progress: 2 }] });

    const vendor = world.createMobile({ name: 'Merchant', x: 102, y: 100, z: 0, map: 1 });
    state.ctx.vendors.set(vendor.serial, { buyStock: [
      { serial: 71, itemId: 0x13b9, hue: 0, amount: 2, price: 90, name: 'Viking Sword' },
      { serial: 72, itemId: 0x13b9, hue: 0, amount: 1, price: 110, name: 'Viking Sword' },
    ] });
    expect(request(state, 'economy.market-stream', { query: 'sword' }).entries[0])
      .toMatchObject({ name: 'Viking Sword', minimumPrice: 90, maximumPrice: 110, offers: 3, vendors: 1 });
  });

  it('persists accessibility and NPC relationship state on the authoritative player', () => {
    const { world, mobile, state } = fixture();
    const npc = world.createMobile({ name: 'Guide', x: 101, y: 100, z: 0, map: 1 });
    recordNpcInteraction(mobile, npc, 'open');
    recordNpcInteraction(mobile, npc, 'choice');
    expect(request(state, 'npc.relationships', { npcSerial: npc.serial }).relationships[0])
      .toMatchObject({ npcSerial: npc.serial, talks: 1, choices: 1 });
    expect(request(state, 'ui.accessibility', { operation: 'set', preferences: {
      scale: 9, contrast: 'high', reduceMotion: true, screenReader: true,
    } })).toMatchObject({ ok: true, preferences: { scale: 3, contrast: 'high', reduceMotion: true } });
    expect(mobile.nodeUOAccessibility.screenReader).toBe(true);
  });

  it('signs asset patchsets and keeps the private Ed25519 key out of the response', () => {
    const { state, directory } = fixture();
    const result = request(state, 'assets.patchsets', {});
    const publicKey = crypto.createPublicKey({ key: Buffer.from(result.publicKey, 'base64url'),
      type: 'spki', format: 'der' });
    expect(result).toMatchObject({ ok: true, algorithm: 'Ed25519', patchset: { complete: true } });
    expect(result).not.toHaveProperty('privateKey');
    expect(crypto.verify(null, Buffer.from(JSON.stringify(result.patchset)), publicKey,
      Buffer.from(result.signature, 'base64url'))).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(directory, 'nodeuo-assets-ed25519.pem')).mode & 0o777).toBe(0o600);
    }
  });

  it('stages, validates, and commits staff configuration with revision conflict protection', () => {
    const { state, settings } = fixture({ staff: true });
    const begun = request(state, 'admin.config-transactions', { operation: 'begin' });
    expect(begun).toMatchObject({ ok: true, baseRevision: 1 });
    expect(request(state, 'admin.config-transactions', { operation: 'stage',
      transactionId: begun.transactionId, patch: { network: { bytesPerSecond: 900_000 } } })).toMatchObject({ ok: true, staged: true });
    expect(request(state, 'admin.config-transactions', { operation: 'validate',
      transactionId: begun.transactionId }).preview.network.bytesPerSecond).toBe(900_000);
    expect(request(state, 'admin.config-transactions', { operation: 'commit',
      transactionId: begun.transactionId })).toMatchObject({ ok: true, revision: 2 });
    expect(settings.snapshot().network.bytesPerSecond).toBe(900_000);

    const stale = request(state, 'admin.config-transactions', { operation: 'begin' });
    settings.update({ defaultProfile: 'minimal' });
    expect(request(state, 'admin.config-transactions', { operation: 'commit',
      transactionId: stale.transactionId })).toMatchObject({ ok: false, error: 'settings revision conflict' });
  });

  it('publishes tactical, combat, voice, path, handoff, privacy, and permission services', () => {
    const { world, mobile, state, messages } = fixture({ staff: true });
    const plan = request(state, 'party.tactics', { operation: 'update', expectedRevision: 0,
      plan: { name: 'Alpha', roles: [{ serial: mobile.serial, role: 'tank' }],
        route: [{ x: 101, y: 100, map: 1 }] } });
    expect(plan).toMatchObject({ ok: true, revision: 1, plan: { name: 'Alpha' } });
    expect(messages.some((message) => message.feature === 'party.tactics')).toBe(true);

    publishCombatTelegraph(state.ctx, { source: mobile, target: mobile, label: 'Test swing' });
    expect(request(state, 'combat.telegraphs', { cursor: 0 }).telegraphs.at(-1))
      .toMatchObject({ sourceSerial: mobile.serial, label: 'Test swing' });
    expect(request(state, 'voice.spatial-state', { operation: 'heartbeat' }).members[0])
      .toMatchObject({ serial: mobile.serial, x: 100, y: 100 });
    expect(request(state, 'network.path-selection', { candidates: ['webtransport'],
      metrics: { websocketRttMs: 20, webtransportRttMs: 10 } })).toMatchObject({
      selected: 'websocket', reliableUO: 'websocket', fallback: 'websocket',
    });

    const prepared = request(state, 'instance.live-handoff', { operation: 'prepare', routeId: 'dungeon' });
    expect(prepared).toMatchObject({ ok: true, prepared: true, routeId: 'dungeon' });
    expect(request(state, 'instance.live-handoff', { operation: 'commit', token: prepared.token }))
      .toMatchObject({ ok: true, committed: true, reconnectUrl: 'wss://instance.example.test/nodeuo' });
    expect(request(state, 'instance.live-handoff', { operation: 'commit', token: prepared.token }).ok).toBe(false);

    const remove = registerNodeUOMod('example.staff-tools', () => ({ ok: true }), {
      roles: ['gm'], permissions: ['world.read'], version: 2, description: 'Staff tools',
    });
    unregister.push(remove);
    expect(request(state, 'mods.permissions').namespaces).toContainEqual(expect.objectContaining({
      namespace: 'example.staff-tools', version: 2, permissions: ['world.read'], roles: ['gm'],
    }));
    expect(request(state, 'protocol.privacy-contract')).toMatchObject({
      ok: true, classifications: { personal: expect.arrayContaining(['inventory']) },
    });
    expect(request(state, 'spectator.full-stream', { targetSerial: mobile.serial })).toMatchObject({
      ok: true, entities: expect.arrayContaining([expect.objectContaining({ serial: mobile.serial })]),
    });
    expect(world.mobiles.has(mobile.serial)).toBe(true);
  });
});
