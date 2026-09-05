import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { World } from '../src/world/world.js';
import {
  GameSystemRuntime, loadGameSystemCatalog, validateGameSystemCatalog,
} from '../src/systems/game-systems.js';
import { registerGameSystemRoutes } from '../src/admin/game-system-routes.js';
import registerActivities from '../../scripts/src/commands/system/activities.js';

const tempDirs = [];
const here = path.dirname(fileURLToPath(import.meta.url));
const shippedCatalog = path.resolve(here, '../../scripts/src/data/config/game-systems.json');
const shippedSkills = path.resolve(here, '../../scripts/src/data/config/skills.json');

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(definition = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-game-systems-'));
  tempDirs.push(root);
  const sourceFile = path.join(root, 'systems.json');
  const catalog = [{
    id: 'test-adventure', name: 'Test Adventure', category: 'pve', archetype: 'campaign',
    summary: 'A deterministic complete test loop.', difficulty: 1, skill: 'Tactics',
    durationMinutes: 10, cooldownSeconds: 0, staminaCost: 0,
    party: { min: 1, max: 8, teams: 1 }, reward: { gold: 100, tokens: 5, title: 'Tester' },
    clientMode: 'hybrid', stages: [
      { name: 'Discover', goal: 2, event: 'activity:action', actions: ['engage'] },
      { name: 'Challenge', goal: 2, event: 'activity:action', actions: ['engage'] },
      { name: 'Resolve', goal: 2, event: 'activity:action', actions: ['engage'] },
    ], ...definition,
  }];
  fs.writeFileSync(sourceFile, JSON.stringify(catalog));
  const world = new World();
  const messages = [];
  const mobile = world.createMobile({ name: 'Alice', str: 100, dex: 100, int: 100, stam: 100, gold: 0, skills: { Tactics: 100 } });
  mobile.isPlayer = true;
  mobile.client = { sendSystemMessage: (message) => messages.push(message) };
  const published = [];
  const runtime = new GameSystemRuntime({ world, sourceFile, random: () => 0,
    publish: (_state, payload) => { published.push(payload); return true; } });
  return { root, sourceFile, world, mobile, runtime, messages, published };
}

describe('data-driven game systems', () => {
  it('ships 100 unique, validated, independently playable definitions', () => {
    const parsed = JSON.parse(fs.readFileSync(shippedCatalog, 'utf8'));
    const validated = validateGameSystemCatalog(parsed, { expectedCount: 100 });
    expect(validated.ok).toBe(true);
    expect(validated.definitions).toHaveLength(100);
    expect(new Set(validated.definitions.map((row) => row.id)).size).toBe(100);
    expect(validated.definitions.every((row) => row.stages.length >= 3
      && row.party.max >= row.party.min && row.reward.gold + row.reward.tokens > 0)).toBe(true);
    expect(parsed.every((row) => Number.isInteger(row.version)
      && row.entry && row.availability && row.antiExploit
      && row.reward?.items?.length > 0 && row.reward?.unlocks?.length > 0
      && row.stages.every((stage) => stage && typeof stage === 'object'
        && stage.id && stage.description && stage.event && stage.skill
        && Array.isArray(stage.actions) && typeof stage.allowManual === 'boolean'
        && Array.isArray(stage.targetKinds) && Array.isArray(stage.sourceKinds)
        && Array.isArray(stage.regions) && Array.isArray(stage.maps)
        && stage.nextStageByAction && typeof stage.nextStageByAction === 'object'))).toBe(true);
    expect(new Set(parsed.flatMap((row) => row.reward.items.map((item) => item.id))).size).toBe(100);
    const stageByName = new Map(parsed.flatMap((row) => row.stages.map((stage) => [stage.name, stage])));
    expect(stageByName.get('Warn the threatened settlement')).toMatchObject({ event: 'speech', allowManual: false });
    expect(stageByName.get('Decode the hunt clues')).toMatchObject({ event: 'activity:action', allowManual: true });
    expect(stageByName.get('Prepare anti-titan equipment')).toMatchObject({ event: 'activity:action', allowManual: true });
    expect(stageByName.get('Choose an account legacy reward')).toMatchObject({ event: 'activity:action', allowManual: true });
    const skillNames = new Set(JSON.parse(fs.readFileSync(shippedSkills, 'utf8')).map((row) => row.name));
    expect(validated.definitions.every((row) => skillNames.has(row.skill)
      && row.stages.every((stage) => skillNames.has(stage.skill)))).toBe(true);
    expect(loadGameSystemCatalog(shippedCatalog).definitions).toHaveLength(100);
  });

  it('runs join, checked contributions, stage completion, reward and participant updates', () => {
    const { runtime, mobile, published, messages } = fixture();
    const joined = runtime.join(mobile, 'test-adventure');
    expect(joined).toMatchObject({ ok: true, instance: { stageIndex: 0, status: 'active' } });
    const id = joined.instance.id;
    expect(runtime.act(mobile, id, 'engage')).toMatchObject({ ok: true, success: true });
    expect(runtime.act(mobile, id, 'engage')).toMatchObject({ ok: true, success: true });
    const completed = runtime.act(mobile, id, 'engage');
    expect(completed.instance).toMatchObject({ status: 'completed', stageIndex: 3 });
    expect(mobile.gold).toBe(100);
    expect(mobile.gameSystems).toMatchObject({ tokens: 5, completions: { 'test-adventure': 1 }, titles: ['Tester'] });
    expect(published.some((row) => row.reason === 'progress')).toBe(true);
    expect(messages.some((row) => row.includes('completed'))).toBe(true);
    runtime.dispose();
  });

  it('indexes real world events and restores live instances without retaining cooldowns', () => {
    const { runtime, world, mobile, sourceFile } = fixture({
      stages: [
        { name: 'Hunt one', goal: 1, event: 'mobile:killed', actions: ['engage'] },
        { name: 'Hunt two', goal: 1, event: 'mobile:killed', actions: ['engage'] },
        { name: 'Hunt three', goal: 1, event: 'mobile:killed', actions: ['engage'] },
      ],
    });
    runtime.join(mobile, 'test-adventure');
    expect(world.events.emit('mobile:killed', { killer: mobile, victim: { serial: 99 } })).toBe(1);
    expect(runtime.activeForSystem('test-adventure').stageIndex).toBe(1);
    const snapshot = runtime.serialize();
    runtime.dispose();

    world._persistedGameSystems = snapshot;
    const restored = new GameSystemRuntime({ world, sourceFile, random: () => 0 });
    expect(restored.activeForSystem('test-adventure')).toMatchObject({ stageIndex: 1, progress: 0 });
    expect(restored.playerSnapshot(mobile).instances).toHaveLength(1);
    restored.dispose();
  });

  it('uses event amounts and permits a fresh run after a completed instance', () => {
    const { runtime, world, mobile } = fixture({
      stages: [
        { name: 'Gather', goal: 5, event: 'craft:completed', actions: ['gather'] },
        { name: 'Shape', goal: 1, event: 'activity:action', actions: ['shape'] },
        { name: 'Finish', goal: 1, event: 'activity:action', actions: ['finish'] },
      ],
    });
    const first = runtime.join(mobile, 'test-adventure').instance;
    expect(world.events.emit('craft:completed', { crafter: mobile, amount: 5 })).toBe(1);
    expect(runtime.activeForSystem('test-adventure')).toMatchObject({ stageIndex: 1, progress: 0 });
    expect(runtime.act(mobile, first.id, 'shape').instance.stageIndex).toBe(2);
    expect(runtime.act(mobile, first.id, 'finish').instance.status).toBe('completed');
    expect(runtime.playerSnapshot(mobile).instances).toHaveLength(0);
    const second = runtime.join(mobile, 'test-adventure').instance;
    expect(second.id).not.toBe(first.id);
    expect(runtime.act(mobile, 'test-adventure', 'gather')).toMatchObject({ ok: true, success: true });
    runtime.dispose();
  });

  it('resolves named catalog skills through the canonical numeric skill registry', () => {
    const { runtime, mobile } = fixture();
    mobile.skills = { 28: 100 };
    runtime.skills = { find: (name) => name === 'Tactics' ? { id: 28 } : null };
    const joined = runtime.join(mobile, 'test-adventure').instance;
    expect(runtime.act(mobile, joined.id, 'engage', { amount: 10 })).toMatchObject({ contribution: 24, tactic: 'execute' });
    runtime.dispose();
  });

  it('gives ordered manual actions distinct tactical effects', () => {
    const { runtime, mobile } = fixture({
      stages: [
        { name: 'Tactics one', goal: 1_000, event: 'activity:action', actions: ['execute', 'support', 'prepare'] },
        { name: 'Tactics two', goal: 1_000, event: 'activity:action', actions: ['execute', 'support', 'prepare'] },
        { name: 'Tactics three', goal: 1_000, event: 'activity:action', actions: ['execute', 'support', 'prepare'] },
      ],
    });
    const id = runtime.join(mobile, 'test-adventure').instance.id;
    expect(runtime.act(mobile, id, 'prepare', { amount: 10 })).toMatchObject({
      ok: true, tactic: 'prepare', contribution: 10, staminaCost: 0,
      instance: { participants: [{ focus: 2, streak: 1 }] },
    });
    expect(runtime.act(mobile, id, 'support', { amount: 10 })).toMatchObject({
      ok: true, tactic: 'support', contribution: 16,
      instance: { momentum: 2, participants: [{ focus: 2, streak: 2 }] },
    });
    expect(runtime.act(mobile, id, 'execute', { amount: 10 })).toMatchObject({
      ok: true, tactic: 'execute', contribution: 25,
      instance: { momentum: 2, participants: [{ focus: 0, streak: 3 }] },
    });
    runtime.dispose();
  });

  it('does not trust a client-supplied manual contribution amount', () => {
    const { runtime, mobile } = fixture({
      stages: [
        { name: 'One', goal: 100, event: 'activity:action', actions: ['go'] },
        { name: 'Two', goal: 100, event: 'activity:action', actions: ['go'] },
        { name: 'Three', goal: 100, event: 'activity:action', actions: ['go'] },
      ],
    });
    const id = runtime.join(mobile, 'test-adventure').instance.id;
    expect(runtime.handleRequest({ mobile }, {
      operation: 'action', instanceId: id, actionId: 'go', amount: 100_000,
    })).toMatchObject({ ok: true, contribution: 2, instance: { progress: 2 } });
    runtime.dispose();
  });

  it('fails a malformed specialized stage cycle without trapping the server loop', () => {
    const loopingStages = ['one', 'two', 'three'].map((id) => ({
      id, name: id, goal: 1, event: 'activity:action', actions: ['publish'],
      nextStageByAction: { publish: id },
    }));
    const { runtime, mobile } = fixture({
      id: 'chronicle-replays', name: 'Chronicle Replays', stages: loopingStages,
    });
    const joined = runtime.join(mobile, 'chronicle-replays').instance;
    const live = runtime.instances.get(joined.id);
    live.modeState.timeline.push({ at: 1, event: 'test' });
    expect(runtime.special(mobile, joined.id, 'select-event', { cursor: 0 })).toMatchObject({ ok: true });
    expect(runtime.special(mobile, joined.id, 'bookmark', { label: 'loop' })).toMatchObject({ ok: true });

    expect(runtime.special(mobile, joined.id, 'publish')).toMatchObject({
      ok: false, error: expect.stringContaining('terminal state'), instance: { status: 'failed' },
    });
    expect(runtime.telemetrySnapshot('chronicle-replays').rows[0]).toMatchObject({ invalidTransitions: 1, failed: 1 });
    runtime.dispose();
  });

  it('routes explicitly scoped world events to only the requested activity', () => {
    const { runtime, mobile, sourceFile } = fixture({
      stages: [
        { name: 'One', goal: 10, event: 'mobile:killed', actions: ['go'] },
        { name: 'Two', goal: 10, event: 'mobile:killed', actions: ['go'] },
        { name: 'Three', goal: 10, event: 'mobile:killed', actions: ['go'] },
      ],
    });
    const catalog = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    catalog.push({ ...catalog[0], id: 'second-adventure', name: 'Second Adventure' });
    fs.writeFileSync(sourceFile, JSON.stringify(catalog));
    runtime.reloadCatalog();
    runtime.join(mobile, 'test-adventure');
    runtime.join(mobile, 'second-adventure');

    expect(runtime.recordEvent('mobile:killed', {
      killer: mobile, victim: { serial: 901 }, amount: 4, gameSystemId: 'second-adventure',
    })).toBe(1);
    expect(runtime.activeForSystem('test-adventure').progress).toBe(0);
    expect(runtime.activeForSystem('second-adventure').progress).toBe(4);
    runtime.dispose();
  });

  it('settles a unique competitive team winner from authoritative contributions', () => {
    const { runtime, world, mobile } = fixture({
      archetype: 'pvp', party: { min: 2, max: 2, teams: 2 },
      stages: [
        { name: 'One', goal: 1, event: 'activity:action', actions: ['go'] },
        { name: 'Two', goal: 1, event: 'activity:action', actions: ['go'] },
        { name: 'Three', goal: 1, event: 'activity:action', actions: ['go'] },
      ],
    });
    const bob = world.createMobile({ name: 'Bob', stam: 100 }); bob.isPlayer = true;
    const first = runtime.join(mobile, 'test-adventure').instance;
    runtime.join(bob, 'test-adventure');
    runtime.act(mobile, first.id, 'go'); runtime.act(mobile, first.id, 'go');
    const completed = runtime.act(mobile, first.id, 'go').instance;

    expect(completed).toMatchObject({ status: 'completed', teamScores: [6, 0], winnerTeam: 1 });
    runtime.dispose();
  });

  it('does not consume the activity deadline while an instance is paused', () => {
    const { runtime, mobile } = fixture();
    let clock = 1_000;
    runtime.now = () => clock;
    const instance = runtime.join(mobile, 'test-adventure').instance;
    const originalDeadline = instance.endsAt;
    clock = 2_000;
    expect(runtime.transition(instance.id, 'paused').instance.status).toBe('paused');
    clock = 7_000;
    const resumed = runtime.transition(instance.id, 'active').instance;
    expect(resumed.endsAt).toBe(originalDeadline + 5_000);
    runtime.dispose();
  });

  it('presents an explicit Classic fallback while opening the negotiated NodeUO workbench', () => {
    const { runtime, mobile } = fixture({ clientMode: 'enhanced' });
    const sentGumps = [];
    const sentJson = [];
    let command;
    const api = {
      systems: { gameSystems: runtime },
      commands: { register: (entry) => { command = entry; }, unregister: () => {} },
      gumps: { send: (_state, gump, callback) => sentGumps.push({ gump, callback }) },
      nodeUO: {
        features: { GameSystems: 'game.systems' },
        send: (_state, payload) => { sentJson.push(payload); return true; },
      },
    };
    registerActivities(api);
    const classicState = { mobile, supportsNodeUO: () => false, sendSystemMessage: () => {} };
    command.run({ state: classicState, sender: mobile, args: ['test-adventure'] });
    expect(sentGumps).toHaveLength(1);
    expect(sentGumps[0].gump.texts).toContain('This system requires the NodeUO client. You can continue playing without it.');
    expect(sentGumps[0].gump.texts).not.toContain('Join / start');

    const enhancedState = { mobile, supportsNodeUO: (feature) => feature === 'game.systems', sendSystemMessage: () => {} };
    command.run({ state: enhancedState, sender: mobile, args: [] });
    expect(sentJson).toHaveLength(1);
    expect(sentJson[0]).toMatchObject({ feature: 'game.systems', payload: { operation: 'open' } });
    runtime.dispose();
  });

  it('assigns balanced competitive teams and protects enhanced-only activities from Classic sessions', () => {
    const { runtime, world, mobile } = fixture({ archetype: 'pvp', clientMode: 'enhanced', party: { min: 2, max: 2, teams: 2 } });
    expect(runtime.join(mobile, 'test-adventure')).toMatchObject({ ok: false, requiresNodeUO: true });
    const aliceRun = runtime.join(mobile, 'test-adventure', { allowEnhanced: true }).instance;
    expect(aliceRun).toMatchObject({ status: 'recruiting', participants: [{ team: 1 }] });
    const bob = world.createMobile({ name: 'Bob', stam: 100 }); bob.isPlayer = true;
    const activeRun = runtime.join(bob, 'test-adventure', { allowEnhanced: true }).instance;
    expect(activeRun.status).toBe('active');
    expect(activeRun.participants.find((row) => row.serial === bob.serial).team).toBe(2);
    const carol = world.createMobile({ name: 'Carol', stam: 100 }); carol.isPlayer = true;
    const parallelRun = runtime.join(carol, 'test-adventure', { allowEnhanced: true }).instance;
    expect(parallelRun).toMatchObject({ status: 'recruiting', participants: [{ team: 1 }] });
    expect(parallelRun.id).not.toBe(activeRun.id);
    expect(runtime.leave(bob, activeRun.id).instance.status).toBe('recruiting');
    runtime.dispose();
  });

  it('validates malformed authoring instead of loading partial placeholders', () => {
    expect(validateGameSystemCatalog([{ id: 'Bad ID', name: '', summary: '', stages: [] }])).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.stringContaining('invalid id'),
        expect.stringContaining('name is required'),
        expect.stringContaining('at least three playable stages'),
      ]),
    });
  });

  it('exposes catalog, lifecycle, and read-only balance simulation to the admin panel', () => {
    const { runtime } = fixture();
    const routes = [];
    registerGameSystemRoutes(routes, { sharedCtx: { systems: { gameSystems: runtime } } });
    const route = (method, routePath) => routes.find((entry) => entry.method === method && entry.path === routePath);
    expect(route('GET', '/api/game-systems/catalog').run({ query: new URLSearchParams() }).systems).toHaveLength(1);
    const started = route('POST', '/api/game-systems/instances').run({ body: { systemId: 'test-adventure' } });
    expect(started).toMatchObject({ ok: true, instance: { status: 'active' } });
    expect(route('POST', '/api/game-systems/simulate').run({ body: { systemId: 'test-adventure', skill: 70 } }))
      .toMatchObject({ ok: true, dryRun: true, skill: 70, reward: { gold: 100, tokens: 5 } });
    expect(route('POST', '/api/game-systems/instances/:id/transition').run({
      params: { id: started.instance.id }, body: { status: 'paused' },
    })).toMatchObject({ ok: true, instance: { status: 'paused' } });
    runtime.dispose();
  });

  it('keeps immutable rules for live runs while a newer catalog version is reloaded', () => {
    const { runtime, mobile, sourceFile } = fixture();
    const joined = runtime.join(mobile, 'test-adventure').instance;
    const changed = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    changed[0].version = 2;
    changed[0].stages[0].goal = 200;
    fs.writeFileSync(sourceFile, JSON.stringify(changed));
    expect(runtime.reloadCatalog()).toMatchObject({ ok: true, revision: 2 });
    expect(runtime.definition('test-adventure').version).toBe(2);
    expect(runtime.definition('test-adventure').stages[0].goal).toBe(200);
    expect(runtime.act(mobile, joined.id, 'engage').instance).toMatchObject({ definitionVersion: 1, stageIndex: 1, progress: 0 });
    expect(runtime.act(mobile, joined.id, 'engage').instance.stageIndex).toBe(2);
    runtime.dispose();
  });

  it('enforces entry, account, rate, target and participation anti-exploit rules', () => {
    const { runtime, world, mobile } = fixture({
      entry: { gold: 25, tokens: 0 },
      antiExploit: { maxActionsPerMinute: 1, maxEventContribution: 2, minParticipationPercent: 100,
        requireUniqueEventTarget: true, accountWide: true },
      stages: [
        { name: 'Hunt', goal: 4, event: 'mobile:killed', actions: ['hunt'], allowManual: false },
        { name: 'Shape', goal: 1, event: 'activity:action', actions: ['shape'] },
        { name: 'Finish', goal: 1, event: 'activity:action', actions: ['finish'] },
      ],
    });
    expect(runtime.join(mobile, 'test-adventure')).toMatchObject({ ok: false, error: expect.stringContaining('Entry requires') });
    mobile.gold = 25;
    mobile.account = { username: 'shared' };
    const joined = runtime.join(mobile, 'test-adventure').instance;
    expect(mobile.gold).toBe(0);
    expect(runtime.act(mobile, joined.id, 'hunt')).toMatchObject({ ok: false, error: expect.stringContaining('world event') });
    expect(runtime.recordEvent('mobile:killed', { killer: mobile, amount: 10 })).toBe(0);
    const victim = { serial: 900, kind: 'orc' };
    expect(world.events.emit('mobile:killed', { killer: mobile, victim, amount: 10 })).toBe(1);
    expect(runtime.instances.get(joined.id).progress).toBe(2);
    expect(world.events.emit('mobile:killed', { killer: mobile, victim, amount: 10 })).toBe(1);
    expect(runtime.instances.get(joined.id).progress).toBe(2);
    const sibling = world.createMobile({ name: 'Sibling', stam: 100 }); sibling.isPlayer = true;
    sibling.account = { username: 'shared' };
    expect(runtime.join(sibling, 'test-adventure')).toMatchObject({ ok: false });
    expect(runtime.telemetrySnapshot('test-adventure').rows[0]).toMatchObject({ invalidEvents: 1, duplicateEvents: 1, progress: 2 });
    runtime.dispose();
  });

  it('runs the enhanced card game as a server-authoritative turn engine', () => {
    const { runtime, world, mobile } = fixture({ id: 'collectible-card-game', clientMode: 'enhanced',
      party: { min: 2, max: 2, teams: 2 } });
    const bob = world.createMobile({ name: 'Bob', stam: 100 }); bob.isPlayer = true;
    const first = runtime.join(mobile, 'collectible-card-game', { allowEnhanced: true }).instance;
    runtime.join(bob, 'collectible-card-game', { allowEnhanced: true });
    expect(runtime.special(mobile, first.id, 'ready')).toMatchObject({ ok: true });
    const ready = runtime.special(bob, first.id, 'ready');
    expect(ready).toMatchObject({ ok: true, specialState: { kind: 'card-game', round: 1 } });
    const active = runtime.instances.get(first.id);
    const turnSerial = Number(active.modeState.turn);
    const turnMobile = turnSerial === mobile.serial ? mobile : bob;
    expect(runtime.special(turnMobile, first.id, 'play-card', { handIndex: 0 })).toMatchObject({ ok: true });
    runtime.dispose();
  });

  it('delivers configured reward items to the backpack and never rewards twice', () => {
    const { runtime, world, mobile } = fixture({
      reward: { gold: 100, tokens: 5, items: [{ id: 'test-sigil', name: 'Test Sigil', artId: 0x14f0, chancePermille: 1000 }] },
      stages: [
        { name: 'One', goal: 1, event: 'activity:action', actions: ['go'] },
        { name: 'Two', goal: 1, event: 'activity:action', actions: ['go'] },
        { name: 'Three', goal: 1, event: 'activity:action', actions: ['go'] },
      ],
    });
    const pack = world.createItem({ artId: 0x0e75, x: 0, y: 0, z: 0, map: 1, parent: mobile.serial, container: true });
    mobile.backpack = pack;
    const id = runtime.join(mobile, 'test-adventure').instance.id;
    runtime.act(mobile, id, 'go'); runtime.act(mobile, id, 'go'); runtime.act(mobile, id, 'go');
    expect([...world.items.values()].filter((item) => item.parent === pack.serial && item.name === 'Test Sigil')).toHaveLength(1);
    runtime.transition(id, 'completed');
    expect([...world.items.values()].filter((item) => item.parent === pack.serial && item.name === 'Test Sigil')).toHaveLength(1);
    runtime.dispose();
  });

  it('persists account-wide completion limits across characters and restarts', () => {
    const { runtime, world, mobile, sourceFile } = fixture({
      antiExploit: { dailyCompletionLimit: 1, completionCooldownMinutes: 60, accountWide: true },
      stages: [
        { name: 'One', goal: 1, event: 'activity:action', actions: ['go'] },
        { name: 'Two', goal: 1, event: 'activity:action', actions: ['go'] },
        { name: 'Three', goal: 1, event: 'activity:action', actions: ['go'] },
      ],
    });
    mobile.accountName = 'shared-account';
    const first = runtime.join(mobile, 'test-adventure').instance.id;
    runtime.act(mobile, first, 'go'); runtime.act(mobile, first, 'go'); runtime.act(mobile, first, 'go');
    const sibling = world.createMobile({ name: 'Sibling', stam: 100 });
    sibling.isPlayer = true; sibling.accountName = 'shared-account';
    expect(runtime.join(sibling, 'test-adventure')).toMatchObject({ ok: false,
      error: expect.stringContaining('account-wide') });
    const snapshot = runtime.serialize();
    runtime.dispose();
    world._persistedGameSystems = snapshot;
    const restored = new GameSystemRuntime({ world, sourceFile, random: () => 0 });
    expect(restored.join(sibling, 'test-adventure')).toMatchObject({ ok: false,
      error: expect.stringContaining('account-wide') });
    restored.dispose();
  });

  it('blocks account alts from opening a parallel run when the first run is full', () => {
    const { runtime, world, mobile } = fixture({
      party: { min: 1, max: 1, teams: 1 },
      antiExploit: { accountWide: true },
    });
    mobile.accountName = 'shared-account';
    expect(runtime.join(mobile, 'test-adventure')).toMatchObject({ ok: true });
    const sibling = world.createMobile({ name: 'Sibling', stam: 100 });
    sibling.isPlayer = true; sibling.accountName = 'shared-account';

    expect(runtime.join(sibling, 'test-adventure')).toMatchObject({
      ok: false, error: expect.stringContaining('one character per account'),
    });
    expect([...runtime.instances.values()]).toHaveLength(1);
    runtime.dispose();
  });

  it('preserves account progression limits during an ordinary world wipe', () => {
    const { runtime, world, mobile } = fixture({
      antiExploit: { dailyCompletionLimit: 1, accountWide: true },
      stages: [
        { name: 'One', goal: 1, event: 'activity:action', actions: ['go'] },
        { name: 'Two', goal: 1, event: 'activity:action', actions: ['go'] },
        { name: 'Three', goal: 1, event: 'activity:action', actions: ['go'] },
      ],
    });
    mobile.accountName = 'shared-account';
    const id = runtime.join(mobile, 'test-adventure').instance.id;
    runtime.act(mobile, id, 'go'); runtime.act(mobile, id, 'go'); runtime.act(mobile, id, 'go');
    runtime.reset({ preserveProfiles: true });
    const sibling = world.createMobile({ name: 'Sibling', stam: 100 });
    sibling.isPlayer = true; sibling.accountName = 'shared-account';

    expect(runtime.join(sibling, 'test-adventure')).toMatchObject({
      ok: false, error: expect.stringContaining('account-wide daily'),
    });
    runtime.dispose();
  });

  it('defers a reward when the item factory returns no item', () => {
    const { runtime, world, mobile } = fixture({
      reward: { gold: 0, tokens: 1, items: [{ id: 'factory-deferred', name: 'Factory Deferred', artId: 0x14f0, chancePermille: 1000 }] },
      stages: [
        { name: 'One', goal: 1, event: 'activity:action', actions: ['go'] },
        { name: 'Two', goal: 1, event: 'activity:action', actions: ['go'] },
        { name: 'Three', goal: 1, event: 'activity:action', actions: ['go'] },
      ],
    });
    const pack = world.createItem({ artId: 0x0e75, x: 0, y: 0, z: 0, map: 1, parent: mobile.serial, container: true });
    mobile.backpack = pack;
    const originalCreateItem = world.createItem.bind(world);
    world.createItem = () => null;
    const id = runtime.join(mobile, 'test-adventure').instance.id;
    runtime.act(mobile, id, 'go'); runtime.act(mobile, id, 'go'); runtime.act(mobile, id, 'go');
    world.createItem = originalCreateItem;

    expect(mobile.gameSystems.pendingRewards).toHaveLength(1);
    expect(runtime.claimPendingRewards(mobile)).toMatchObject({ claimed: 1, remaining: 0 });
    runtime.dispose();
  });

  it('delivers a deferred item automatically after a backpack becomes available', () => {
    const { runtime, world, mobile } = fixture({
      reward: { gold: 0, tokens: 1, items: [{ id: 'deferred', name: 'Deferred Sigil', artId: 0x14f0, chancePermille: 1000 }] },
      stages: [
        { name: 'One', goal: 1, event: 'activity:action', actions: ['go'] },
        { name: 'Two', goal: 1, event: 'activity:action', actions: ['go'] },
        { name: 'Three', goal: 1, event: 'activity:action', actions: ['go'] },
      ],
    });
    const id = runtime.join(mobile, 'test-adventure').instance.id;
    runtime.act(mobile, id, 'go'); runtime.act(mobile, id, 'go'); runtime.act(mobile, id, 'go');
    expect(mobile.gameSystems.pendingRewards).toHaveLength(1);
    const pack = world.createItem({ artId: 0x0e75, x: 0, y: 0, z: 0, map: 1, parent: mobile.serial, container: true });
    mobile.backpack = pack;
    expect(runtime.playerSnapshot(mobile).profile.pendingRewards).toHaveLength(0);
    expect([...world.items.values()].filter((item) => item.parent === pack.serial && item.name === 'Deferred Sigil')).toHaveLength(1);
    runtime.playerSnapshot(mobile);
    expect([...world.items.values()].filter((item) => item.parent === pack.serial && item.name === 'Deferred Sigil')).toHaveLength(1);
    runtime.dispose();
  });
});
