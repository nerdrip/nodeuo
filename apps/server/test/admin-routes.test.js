import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHandlers } from '../src/admin/routes.js';

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(extraCtx = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-admin-routes-'));
  tempDirs.push(root);
  const scriptsDir = path.join(root, 'scripts');
  fs.mkdirSync(path.join(scriptsDir, 'data', 'config'), { recursive: true });
  const groups = new Map();
  const spawner = {
    groups,
    add(group) { groups.set(group.id, group); return group; },
    remove(id) { groups.delete(id); },
  };
  const admin = { username: 'admin', accessLevel: 'Admin', banned: false, characters: [] };
  const other = { username: 'other', accessLevel: 'GM', banned: false, characters: [] };
  const accounts = {
    accounts: new Map([['admin', admin], ['other', other]]),
    saveSync() {},
  };
  const world = { mobiles: new Map(), items: new Map() };
  const handlers = buildHandlers({
    sharedCtx: { world, spawner, ...extraCtx },
    scriptRuntime: null,
    scriptsDir,
    saveDir: root,
    persistence: null,
    accounts,
  });
  const route = (method, routePath) => handlers.find((h) => h.method === method && h.path === routePath);
  return { root, scriptsDir, spawner, accounts, world, route };
}

describe('admin route safety and editor behavior', () => {
  it('blocks self-demotion and self-deletion using the string session account', async () => {
    const { route } = fixture();
    const session = { account: 'admin' };

    expect(await route('PATCH', '/api/accounts/:name').run({
      params: { name: 'admin' }, body: { accessLevel: 'Player' }, session,
    })).toEqual({ error: 'cannot change your own accessLevel' });
    expect(await route('DELETE', '/api/accounts/:name').run({
      params: { name: 'admin' }, session,
    })).toEqual({ error: 'cannot delete your own account' });
  });

  it('keeps Felucca map 0 and normalizes reversed spawner rectangles', async () => {
    const { route, spawner } = fixture();
    const result = await route('POST', '/api/spawners').run({ body: {
      id: 'felucca-orcs', map: 0,
      rect: { x1: 20, y1: 40, x2: 10, y2: 30 },
      kinds: ['orc'], maxCount: 3, respawnMs: [30_000, 60_000],
    } });

    expect(result).toEqual({ ok: true, id: 'felucca-orcs' });
    expect(spawner.groups.get('felucca-orcs')).toMatchObject({
      map: 0,
      rect: { x1: 10, y1: 30, x2: 20, y2: 40 },
    });
  });

  it('supports advanced spawner authoring, deterministic preview, diagnostics and bulk changes', async () => {
    const { route, spawner } = fixture();
    await route('POST', '/api/spawners').run({ body: {
      id: 'advanced-a', map: 1, rect: { x1: 10, y1: 20, x2: 12, y2: 22 },
      kinds: [['orc', 3], ['ettin', 1]], maxCount: 4, respawnMs: [10_000, 20_000],
      enabled: true, team: 7, homeRange: 12, roaming: 'home',
      schedule: { days: [1, 2, 2, 9], startHour: 18, endHour: 23 },
      regionConditions: { region: 'Britain', minPlayers: 1, maxPlayers: 12 },
    } });
    expect(spawner.groups.get('advanced-a')).toMatchObject({
      enabled: true, team: 7, homeRange: 12, roaming: 'home',
      schedule: { days: [1, 2], startHour: 18, endHour: 23 },
      regionConditions: { region: 'Britain', minPlayers: 1, maxPlayers: 12 },
    });

    const preview = await route('POST', '/api/spawners/simulate').run({ body: {
      id: 'preview', map: 1, rect: { x1: 0, y1: 0, x2: 1, y2: 1 }, maxCount: 1,
      respawnMs: [1000, 2000], kinds: [['orc', 3], ['ettin', 1]], rolls: 4000, seed: 42,
    } });
    expect(preview.ok).toBe(true);
    expect(preview.simulation.outcomes.reduce((sum, item) => sum + item.count, 0)).toBe(4000);
    expect(preview.simulation.outcomes[0].actualPct).toBeGreaterThan(70);

    spawner.groups.set('advanced-b', { ...spawner.groups.get('advanced-a'), id: 'advanced-b', spawnedSerials: new Set() });
    const diagnostics = await route('GET', '/api/spawners/diagnostics').run({});
    expect(diagnostics.duplicatePairs).toContainEqual(expect.objectContaining({ a: 'advanced-a', b: 'advanced-b' }));
    const bulk = await route('POST', '/api/spawners/bulk').run({ body: { ids: ['advanced-a', 'advanced-b'], action: 'move', dx: 5, dy: -2, map: 3 } });
    expect(bulk).toMatchObject({ ok: true, changed: 2 });
    expect(spawner.groups.get('advanced-a')).toMatchObject({ map: 3, rect: { x1: 15, y1: 18, x2: 17, y2: 20 } });
    await route('POST', '/api/spawners/bulk').run({ body: { ids: ['advanced-a'], action: 'disable' } });
    expect(spawner.groups.get('advanced-a').enabled).toBe(false);
  });

  it('plans and applies snapshot migrations with rollback, then manages feature rollout', async () => {
    const { root, route } = fixture();
    fs.writeFileSync(path.join(root, 'players.json'), JSON.stringify({ mobiles: [{ serial: 1 }], items: [] }), 'utf8');
    const plan = await route('GET', '/api/migrations/plan').run({ query: new URLSearchParams({ file: 'players.json' }) });
    expect(plan).toMatchObject({ file: 'players.json', dryRun: true, from: 0, target: 1 });
    expect(plan.steps).toHaveLength(1);
    const applied = await route('POST', '/api/migrations/apply').run({ body: { file: 'players.json' } });
    expect(applied).toMatchObject({ ok: true, restartRequired: true });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'players.json'), 'utf8')).version).toBe(1);
    expect(fs.existsSync(path.join(root, applied.backup))).toBe(true);
    const verified = await route('POST', '/api/backups/verify').run({ body: { name: applied.backup } });
    expect(verified).toMatchObject({ ok: true, version: 0 });

    const flag = await route('PUT', '/api/feature-flags').run({ body: {
      name: 'composer.visual-v2', enabled: true, nodeUOOnly: true,
      rollout: { percent: 25, accounts: ['admin', 'admin'], shards: ['dev'] },
    } });
    expect(flag).toMatchObject({ ok: true, flag: { enabled: true, percent: 25, nodeUOOnly: true, accounts: ['admin'] } });
    expect((await route('GET', '/api/feature-flags').run({})).flags['composer.visual-v2']).toBeTruthy();
  });

  it('treats an empty migration directory as a valid up-to-date state', async () => {
    const { route } = fixture();
    const plan = await route('GET', '/api/migrations/plan').run({ query: new URLSearchParams() });
    expect(plan).toMatchObject({ available: false, dryRun: true, ok: true, from: 1, target: 1, steps: [] });
  });

  it('validates spell lifecycle in a side-effect-free server sandbox', async () => {
    const liveSpell = { id: 42, name: 'Test Flame', school: 'magery', mana: 12, minSkill: 300, delayMs: 900, requiresTarget: true };
    const { route } = fixture({ systems: { spells: { allSpells: () => [liveSpell] } } });
    const result = await route('POST', '/api/studio/sandbox/spell').run({ body: { spell: {
      id: 42, name: 'Test Flame', words: 'Vas Flam', mana: 12, castTimeMs: 900, requiresTarget: true, target: 'mobile', effect: 'fireball',
    } } });
    expect(result).toMatchObject({ ok: true, safe: true, executed: false, matchedRuntime: { id: 42 }, errors: [] });
    expect(result.lifecycle.map((step) => step.stage)).toEqual(['incantation', 'cast-delay', 'target', 'resource-debit', 'effect']);
    const invalid = await route('POST', '/api/studio/sandbox/spell').run({ body: { spell: { requiresTarget: true } } });
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.map((error) => error.field)).toEqual(expect.arrayContaining(['words', 'mana', 'target']));
  });

  it('reports map, table and API performance budgets together', async () => {
    const { route } = fixture();
    const session = { account: 'admin' };
    await route('POST', '/api/operations/client-metrics').run({ session, body: { view: '/editor', mapChunkMs: 240, tableRows: 720 } });
    const report = await route('GET', '/api/operations/budgets').run({});
    expect(report.client).toContainEqual(expect.objectContaining({ account: 'admin', mapChunkMs: 240, tableRows: 720 }));
    expect(report.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'map:admin', budget: 180 }),
      expect.objectContaining({ metric: 'table:admin', budget: 500 }),
    ]));
  });

  it('inspects, follows and safely mutates live entities', async () => {
    const { route, world } = fixture();
    const mob = { serial: 0x101, name: 'rat', body: 0xd7, hue: 0, x: 10, y: 20, z: 0, map: 1, hp: 10, hpMax: 10 };
    world.mobiles.set(mob.serial, mob);
    const context = await route('GET', '/api/live/entity/:serial').run({ params: { serial: '0x101' } });
    expect(context).toMatchObject({ type: 'mobile', entity: { name: 'rat', x: 10, y: 20 } });
    const moved = await route('POST', '/api/live/mutate').run({ body: { serial: '0x101', action: 'move', x: 30, y: 40, z: 5, map: 2 } });
    expect(moved).toMatchObject({ ok: true, action: 'move', after: { x: 30, y: 40, z: 5, map: 2 } });
    const hued = await route('POST', '/api/live/mutate').run({ body: { serial: '0x101', action: 'hue', hue: 77 } });
    expect(hued.after.hue).toBe(77);
  });

  it('prevents a stale data-editor tab from overwriting a newer file', async () => {
    const { scriptsDir, route } = fixture();
    const file = path.join(scriptsDir, 'data', 'config', 'sample.json');
    fs.writeFileSync(file, '{"value":1}', 'utf8');
    const query = new URLSearchParams({ path: 'config/sample.json' });
    const read = await route('GET', '/api/data-tree/file').run({ query });

    fs.writeFileSync(file, '{"value":2}', 'utf8');
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(file, future, future);
    const result = await route('PUT', '/api/data-tree/file').run({
      query,
      body: { data: { value: 3 }, expectedMtime: read.mtime },
    });

    expect(result).toMatchObject({ conflict: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ value: 2 });
  });

  it('uses the sector index for runtime statics instead of rescanning every world item per tile', async () => {
    const { route, world } = fixture();
    const item = { serial: 0x40000001, itemId: 0x1234, x: 100, y: 200, z: 5, map: 1, parent: null };
    world.items.set(item.serial, item);
    world.items.values = () => { throw new Error('full item scan used'); };
    world.sectors = {
      itemsIndexed: () => 1,
      itemSerialsAt: (_facet, x, y) => x === 100 && y === 200 ? new Set([item.serial]) : new Set(),
    };

    const result = await route('GET', '/api/statics/slice').run({
      query: new URLSearchParams({ facet: '1', x: '100', y: '200', w: '1', h: '1' }),
    });
    expect(result.cells['0|0']).toContainEqual(expect.objectContaining({
      tileId: 0x1234, serial: '0x40000001', source: 'item',
    }));
  });

  it('decodes baked statics through one rectangle query when supported', async () => {
    const staticsInRect = vi.fn(() => [
      { x: 101, y: 202, tileId: 0x2222, z: 7, hue: 4 },
    ]);
    const { route } = fixture({ landProvider: { staticsInRect } });
    const result = await route('GET', '/api/statics/slice').run({
      query: new URLSearchParams({ facet: '1', x: '100', y: '200', w: '4', h: '4' }),
    });

    expect(staticsInRect).toHaveBeenCalledOnce();
    expect(staticsInRect).toHaveBeenCalledWith(1, 100, 200, 4, 4);
    expect(result.cells['1|2']).toContainEqual(expect.objectContaining({
      tileId: 0x2222, source: 'static', z: 7,
    }));
  });

  it('paginates and categorizes the complete static-art catalogue', async () => {
    const { route } = fixture();
    const first = await route('GET', '/api/tiles/search').run({
      query: new URLSearchParams({ kind: 'static', category: 'lighting', limit: '5', offset: '0' }),
    });
    const second = await route('GET', '/api/tiles/search').run({
      query: new URLSearchParams({ kind: 'static', category: 'lighting', limit: '5', offset: '5' }),
    });

    expect(first.total).toBeGreaterThan(5);
    expect(first.matches).toHaveLength(5);
    expect(first.matches.every((tile) => tile.category === 'lighting')).toBe(true);
    expect(second.matches[0]?.id).not.toBe(first.matches[0]?.id);
  });
});
