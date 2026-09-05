import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeUOFeature, NodeUOSpellComposerMessage } from '@uo/nodeuo-protocol';
import { getSpell } from '../src/systems/spells/registry.js';
import {
  executeSpellGraph,
  getSpellcraftProfile,
  learnSpellcraft,
  SpellComposerService,
  validateSpellDraft,
  validateSpellForPublication,
} from '../src/systems/spells/composer.js';

const dirs = [];
const services = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function serviceFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-spells-'));
  dirs.push(dir);
  const service = new SpellComposerService(dir);
  services.push(service);
  return { dir, service };
}

function validDraft(overrides = {}) {
  return {
    name: 'Arc Flash', school: 'custom', target: 'mobile', mana: 30,
    range: 10, castTimeMs: 750, cooldownMs: 2500,
    area: { shape: 'single', radius: 0 },
    graph: {
      version: 1,
      nodes: [
        { id: 'start', type: 'start', x: 10, y: 20, config: {} },
        { id: 'fx', type: 'visual', x: 160, y: 20,
          config: { scope: 'target', graphic: 0x36BD, hue: 0x47E } },
        { id: 'hit', type: 'damage', x: 320, y: 20,
          config: { scope: 'target', amount: 20, element: 'energy', callback: 'eval()' } },
      ],
      edges: [{ from: 'start', to: 'fx' }, { from: 'fx', to: 'hit' }],
    },
    source: 'process.exit()',
    ...overrides,
  };
}

function adminState(sent = []) {
  return {
    account: { accessLevel: 'Admin' },
    nodeUOJsonTransport: true, nodeUOFeatures: new Map([[NodeUOFeature.SpellComposer, 1]]),
    supportsNodeUO: (cap) => cap === NodeUOFeature.SpellComposer,
    sendNodeUOMessage: (message) => { sent.push(message); return true; },
  };
}

function playerState(sent = [], username = 'Player One') {
  const mobile = {
    serial: 1, name: 'Researcher', skills: { 24: 0 },
    spellcraft: { version: 1, xp: 0, discoveries: [], lastPracticeAt: 0 },
  };
  const codex = { serial: 20, parent: 10, script: 'spell-schema-codex' };
  const state = {
    account: { username, accessLevel: 'Player' }, mobile,
    nodeUOJsonTransport: true, nodeUOFeatures: new Map([[NodeUOFeature.SpellComposer, 1]]),
    supportsNodeUO: (cap) => cap === NodeUOFeature.SpellComposer,
    sendNodeUOMessage: (message) => { sent.push(message); return true; }, sendSystemMessage: vi.fn(),
    ctx: {
      world: { items: new Map([[codex.serial, codex]]) },
      game: { inventory: { isInPack: (item) => item.parent === 10 } },
    },
  };
  mobile.client = state;
  return { state, mobile, codex };
}

function noviceDraft(overrides = {}) {
  const draft = validDraft({ range: 8, ...overrides });
  draft.graph.nodes.find((node) => node.type === 'damage').config.element = 'physical';
  return draft;
}

describe('visual spell graph composer', () => {
  it('accepts only whitelisted graph data and strips executable fields', () => {
    const result = validateSpellDraft(validDraft());
    expect(result.ok).toBe(true);
    expect(result.draft).not.toHaveProperty('source');
    expect(result.draft.graph.nodes.find((node) => node.id === 'hit').config)
      .toEqual({ scope: 'target', amount: 20, element: 'energy' });
    expect(result.draft.graph.version).toBe(1);

    expect(validateSpellDraft(validDraft({ graph: {
      version: 1,
      nodes: [{ id: 'start', type: 'start' }, { id: 'bad', type: 'run-javascript' }],
      edges: [{ from: 'start', to: 'bad' }],
    } })).ok).toBe(false);
  });

  it('rejects cycles, duplicate ids and nodes unreachable from Start', () => {
    const cyclic = validDraft();
    cyclic.graph.edges.push({ from: 'hit', to: 'start' });
    expect(validateSpellDraft(cyclic)).toMatchObject({ ok: false });

    const orphan = validDraft();
    orphan.graph.edges = [{ from: 'start', to: 'fx' }];
    expect(validateSpellDraft(orphan).errors.join(' ')).toContain('reachable');

    const duplicate = validDraft();
    duplicate.graph.nodes[2].id = 'fx';
    expect(validateSpellDraft(duplicate).errors.join(' ')).toContain('Duplicate');
  });

  it('migrates a legacy flat draft into a versioned graph', () => {
    const result = validateSpellDraft({
      name: 'Legacy Bolt', school: 'custom', target: 'mobile', mana: 20,
      range: 8, castTimeMs: 500, cooldownMs: 1000,
      effect: { type: 'damage', amount: 15, element: 'fire' },
      area: { shape: 'single' },
      sequence: [{ atMs: 0, kind: 'visual', graphic: 0x36BD, hue: 0 }],
    });
    expect(result.ok).toBe(true);
    expect(result.draft.graph.nodes.map((node) => node.type)).toEqual(['start', 'visual', 'damage']);
  });

  it('does not open on a standard UO transport', () => {
    const { service } = serviceFixture();
    const sent = [];
    expect(service.open({ send: (packet) => sent.push(packet), supportsNodeUO: () => false })).toBe(false);
    expect(sent).toEqual([]);
  });

  it('persists schema v3 and publishes a live spell with a stable numeric id', () => {
    const { dir, service } = serviceFixture();
    const sent = [];
    const state = adminState(sent);
    expect(service.open(state)).toBe(true);
    expect(sent[0]).toMatchObject({ feature: NodeUOFeature.SpellComposer,
      payload: { eventKind: NodeUOSpellComposerMessage.Open } });

    const saved = service.acceptDraft(state, 7, validDraft());
    expect(saved.ok).toBe(true);
    expect(saved.draft.spellId).toBeGreaterThanOrEqual(10_000);
    expect(getSpell(saved.draft.spellId)).toBeUndefined();

    const published = service.publishDraft(state, 9, { ...validDraft(), id: saved.draft.id });
    expect(published.ok).toBe(true);
    expect(published.draft.spellId).toBe(saved.draft.spellId);
    expect(getSpell(published.draft.spellId)).toMatchObject({
      name: 'Arc Flash', school: 'custom', cooldownMs: 2500,
    });
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'custom-spells.json'), 'utf8'));
    expect(disk).toMatchObject({ schemaVersion: 3, spells: [expect.objectContaining({ published: true })] });
  });

  it('lets a player author novice spells only while carrying a codex', () => {
    const { service } = serviceFixture();
    const { state, mobile, codex } = playerState();
    expect(service.open(state, { sourceSerial: 999 })).toBe(false);
    expect(service.open(state, { sourceSerial: codex.serial })).toBe(true);

    const saved = service.acceptDraft(state, 1, noviceDraft());
    expect(saved).toMatchObject({ ok: true, draft: { ownerAccount: 'player one', requiredRank: 1 } });
    expect(saved.draft.id).toMatch(/^custom:player-one-[a-z0-9]+-/);
    const published = service.publishDraft(state, 1, { ...noviceDraft(), id: saved.draft.id });
    expect(published.ok).toBe(true);
    expect(getSpellcraftProfile(mobile).xp).toBe(15);

    const locked = service.acceptDraft(state, 1, validDraft({ name: 'Locked Energy' }));
    expect(locked.ok).toBe(false);
    expect(locked.errors.join(' ')).toContain('energy');

    const rival = playerState([], 'Player Two');
    expect(service.open(rival.state, { sourceSerial: rival.codex.serial })).toBe(true);
    const stolen = service.acceptDraft(rival.state, 2, {
      ...noviceDraft(), id: saved.draft.id, name: 'Hijacked Schema',
    });
    expect(stolen.ok).toBe(false);
    expect(stolen.errors.join(' ')).toContain('only your own');
  });

  it('combines Inscription, research and discovered fragments, while admins bypass progression', () => {
    const { service } = serviceFixture();
    const { state, mobile, codex } = playerState();
    service.open(state, { sourceSerial: codex.serial });
    mobile.skills[24] = 100;
    learnSpellcraft(mobile, 'element:energy', 900);
    expect(getSpellcraftProfile(mobile)).toMatchObject({ level: 5, rank: 'Grandmaster' });

    const published = service.publishDraft(state, 1, validDraft({ name: 'Player Energy' }));
    expect(published.ok).toBe(true);
    const definition = getSpell(published.draft.spellId);
    expect(definition.canCast({ caster: { skills: { 24: 0 } }, accessLevel: 'Player' }))
      .toMatchObject({ ok: false, reason: 'spellcraft-rank' });
    expect(definition.canCast({ caster: {}, accessLevel: 'Administrator' })).toEqual({ ok: true });

    const admin = adminState();
    expect(service.publishDraft(admin, 99, validDraft({ name: 'Admin Energy' })).ok).toBe(true);
  });

  it('repairs duplicate persisted spell ids instead of aliasing two scrolls', () => {
    const { dir, service } = serviceFixture();
    const state = adminState();
    const first = service.publishDraft(state, 1, validDraft()).draft;
    const second = service.publishDraft(state, 2, validDraft({ name: 'Frost Arc' })).draft;
    service.dispose();
    services.splice(services.indexOf(service), 1);

    const file = path.join(dir, 'custom-spells.json');
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    disk.spells[1].spellId = disk.spells[0].spellId;
    fs.writeFileSync(file, JSON.stringify(disk));

    const reloaded = new SpellComposerService(dir);
    services.push(reloaded);
    const loadedFirst = reloaded.drafts.get(first.id);
    const loadedSecond = reloaded.drafts.get(second.id);
    expect(loadedFirst.spellId).toBe(first.spellId);
    expect(loadedSecond.spellId).not.toBe(loadedFirst.spellId);
    expect(getSpell(loadedFirst.spellId)?.name).toBe('Arc Flash');
    expect(getSpell(loadedSecond.spellId)?.name).toBe('Frost Arc');
  });

  it('applies publication balance to the complete graph footprint', () => {
    expect(validateSpellForPublication(validDraft({ mana: 1, cooldownMs: 0, castTimeMs: 0 }))).toMatchObject({ ok: false });
    const area = validDraft({ area: { shape: 'circle', radius: 12 } });
    area.graph.nodes[2].config.scope = 'area';
    expect(validateSpellForPublication(area).errors.join(' ')).toContain('damage footprint');
  });

  it('executes the graph once and resolves targets through the world', () => {
    const validated = validateSpellDraft(validDraft()).draft;
    const caster = { serial: 1, hp: 50, x: 10, y: 10, z: 0, map: 1 };
    const target = { serial: 2, hp: 50, x: 11, y: 10, z: 0, map: 1 };
    const world = { mobiles: new Map([[1, caster], [2, target]]), items: new Map() };
    const damage = vi.fn();
    executeSpellGraph(validated, { caster, target, world, deps: { damage } });
    expect(damage).toHaveBeenCalledOnce();
    expect(damage).toHaveBeenCalledWith(world, target, 20, expect.objectContaining({ attacker: caster }));
  });

  it('requires a carried codex and blank scroll, then creates a bound scroll', () => {
    const { service } = serviceFixture();
    const sent = [];
    const published = service.publishDraft(adminState(), 1, noviceDraft()).draft;
    const { state, mobile } = playerState(sent);
    const codex = { serial: 20, parent: 10, script: 'spell-schema-codex' };
    const blank = { serial: 21, parent: 10, definitionId: 'blank-scroll', amount: 2 };
    const world = { items: new Map([[20, codex], [21, blank]]) };
    const created = [];
    state.mobile = mobile;
    state.ctx = {
      world,
      game: {
        inventory: {
          isInPack: (item) => item.parent === 10,
          findInPack: (_mob, predicate) => [...world.items.values()].find(predicate),
        },
        mobile: { giveItem: (_mob, data) => { const item = { serial: 22, ...data }; created.push(item); return item; } },
        item: { destroy: vi.fn() },
      },
      protocol: { containerContentUpdate: () => new Uint8Array([1]), removeEntity: () => new Uint8Array([2]) },
    };
    const result = service.scribeDraft(state, 2, { id: published.id, sourceSerial: codex.serial });
    expect(result).toMatchObject({ ok: true, scribed: true, scrollSerial: 22 });
    expect(created[0]).toMatchObject({
      definitionId: 'custom-spell-scroll', script: 'custom-spell-scroll', customSpellId: published.spellId,
    });
    expect(blank.amount).toBe(1);
  });

  it('lets an administrator scribe immediately without progression or supplies', () => {
    const { service } = serviceFixture();
    const published = service.publishDraft(adminState(), 1, validDraft()).draft;
    const state = adminState();
    state.mobile = { serial: 1 };
    state.ctx = {
      world: { items: new Map() },
      game: {
        inventory: { isInPack: () => false, findInPack: () => null },
        mobile: { giveItem: (_mob, data) => ({ serial: 99, ...data }) },
      },
    };
    expect(service.scribeDraft(state, 2, { id: published.id, sourceSerial: 0 }))
      .toMatchObject({ ok: true, scribed: true, scrollSerial: 99 });
  });
});
