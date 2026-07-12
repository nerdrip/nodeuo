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
