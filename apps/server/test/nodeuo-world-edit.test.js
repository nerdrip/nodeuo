import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeUOJsonKind } from '@uo/nodeuo-protocol';
import { registerWorldEditRoutes } from '../src/admin/world-edit-routes.js';

describe('NodeUO world-edit transport boundary', () => {
  const queryInt = (query, name, fallback, min, max) => {
    const value = Number(query.get(name));
    return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : fallback;
  };

  it('broadcasts JSON to v2 and sends no private bytes to classic peers', () => {
    const v2 = {
      nodeUOJsonTransport: true,
      nodeUOProtocol: { major: 2, minor: 0, json: true },
      nodeUOFeatures: new Map([['world.editing', 1]]),
      send: vi.fn(), sendNodeUOMessage: vi.fn(() => true),
      supportsNodeUO(capability) {
        return typeof capability === 'string' ? this.nodeUOFeatures.has(capability) : true;
      },
    };
    const classic = {
      nodeUOJsonTransport: false, send: vi.fn(),
      supportsNodeUO: () => true,
    };
    const world = { mobiles: new Map([
      [1, { map: 1, x: 100, y: 100, client: v2 }],
      [2, { map: 1, x: 101, y: 100, client: classic }],
    ]) };
    const mapProvider = {
      setLandTile: vi.fn(), saveEditsSync: vi.fn(() => ({ ok: true })), editCount: () => 1,
    };
    const routes = [];
    registerWorldEditRoutes(routes, {
      scriptsDir: process.cwd(), saveDir: process.cwd(), scriptRuntime: null,
      world, mapProvider, sharedCtx: {}, queryInt: () => 0,
      registerUndoableMutation: () => null,
    });
    const route = routes.find((entry) => entry.path === '/api/map/edit');

    const result = route.run({ body: {
      facet: 1, edits: [{ x: 100, y: 100, z: 4, tileId: 0x123 }],
    } });

    expect(result).toMatchObject({ ok: true, applied: 1, broadcast: 1 });
    expect(v2.send).not.toHaveBeenCalled();
    expect(v2.sendNodeUOMessage).toHaveBeenCalledWith(expect.objectContaining({
      feature: 'world.editing', kind: NodeUOJsonKind.Delta,
      payload: { operation: 'map-edits', facet: 1,
        edits: [{ facet: 1, x: 100, y: 100, z: 4, tileId: 0x123 }] },
    }));
    expect(classic.send).not.toHaveBeenCalled();
  });

  it('exposes the canonical multi bridge and places against an online owner', () => {
    const owner = { serial: 7, name: 'Builder', map: 1, client: {} };
    const place = vi.fn(() => ({ ok: true, multiId: 0x64, placed: 42, serial: 1001, houseId: 3 }));
    const registerUndoableMutation = vi.fn(() => 'undo-multi');
    const world = { mobiles: new Map([[7, owner]]), onlineMobiles: () => [owner] };
    const routes = [];
    registerWorldEditRoutes(routes, {
      scriptsDir: process.cwd(), saveDir: process.cwd(), scriptRuntime: null, world,
      mapProvider: {}, sharedCtx: { systems: { multiEditor: {
        catalog: () => [{ id: 0x64, name: 'Stone House', kind: 'house', tileCount: 42, bounds: [-3, -3, 3, 3] }],
        preview: () => [{ id: 1, x: 0, y: 0, z: 0, visible: true }], place,
      } } },
      queryInt: (query, name, fallback) => Number(query.get(name) ?? fallback),
      registerUndoableMutation,
    });
    const route = (method, routePath) => routes.find((entry) => entry.method === method && entry.path === routePath);
    expect(route('GET', '/api/world-editor/multis').run({ query: new URLSearchParams('kind=house&limit=20') }))
      .toMatchObject({ ok: true, total: 1, owners: [{ serial: 7, name: 'Builder' }] });
    expect(route('GET', '/api/world-editor/multis/:id').run({ params: { id: '100' } }))
      .toMatchObject({ ok: true, multiId: 100, tiles: [{ id: 1 }] });
    expect(route('POST', '/api/world-editor/multis/place').run({ body: {
      ownerSerial: 7, multiId: 0x64, facet: 1, x: 120, y: 130, z: 4,
    }, session: { account: 'admin' } })).toMatchObject({ ok: true, placed: 42, auditUndoId: 'undo-multi' });
    expect(place).toHaveBeenCalledWith(owner, expect.objectContaining({ multiId: 0x64, x: 120, y: 130, map: 1 }));
    expect(registerUndoableMutation).toHaveBeenCalledWith('admin', 'world-editor.multi-place', {
      multiId: 0x64, facet: 1, instanceId: 1001, houseId: 3,
    });
  });

  it('stores portable prefab elevations relative to the selected origin', () => {
    const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-prefab-'));
    try {
      const routes = [];
      const world = { items: new Map([[1, { serial: 1, parent: null, map: 1, x: 10, y: 20, z: 17, itemId: 100, hue: 5 }]]) };
      registerWorldEditRoutes(routes, {
        scriptsDir: process.cwd(), saveDir, scriptRuntime: null, world,
        mapProvider: { landAt: () => ({ tileId: 1, z: 7 }), staticsAt: () => [] }, sharedCtx: {},
        queryInt: (_query, _name, fallback) => fallback, registerUndoableMutation: () => null,
      });
      const save = routes.find((entry) => entry.path === '/api/statics/save-prefab');
      expect(save.run({ body: { facet: 1, x0: 10, y0: 20, x1: 11, y1: 21, name: 'tower' } }))
        .toMatchObject({ ok: true, tileCount: 1 });
      const get = routes.find((entry) => entry.path === '/api/statics/prefabs/:name');
      expect(get.run({ params: { name: 'tower' } })).toMatchObject({ ok: true, prefab: {
        version: 2, originZ: 7, tiles: [{ dx: 0, dy: 0, dz: 10, itemId: 100 }],
      } });
    } finally { fs.rmSync(saveDir, { recursive: true, force: true }); }
  });

  it('keeps local static ids aligned with tiledata names in palette search', () => {
    const routes = [];
    registerWorldEditRoutes(routes, {
      scriptsDir: process.cwd(), saveDir: process.cwd(), scriptRuntime: null,
      world: { items: new Map(), mobiles: new Map() }, mapProvider: {}, sharedCtx: {},
      queryInt, registerUndoableMutation: () => null,
    });

    const search = routes.find((entry) => entry.path === '/api/tiles/search');
    const result = search.run({ query: new URLSearchParams('kind=static&q=0x64&limit=10') });

    expect(result.matches).toContainEqual(expect.objectContaining({ id: 100, name: 'stone wall' }));
  });

  it('rejects an invalid land batch before mutation and restores overlays after persistence failure', () => {
    const edits = new Map([['1|10|20', { facet: 1, x: 10, y: 20, tileId: 9, z: 3 }]]);
    const mapProvider = {
      setLandTile: vi.fn((facet, x, y, tileId, z) => edits.set(`${facet}|${x}|${y}`, { facet, x, y, tileId, z })),
      clearLandTile: vi.fn((facet, x, y) => edits.delete(`${facet}|${x}|${y}`)),
      iterEdits: function* iterEdits() { yield* edits.values(); },
      saveEditsSync: vi.fn(() => ({ error: 'disk full' })), editCount: () => edits.size,
    };
    const routes = [];
    registerWorldEditRoutes(routes, {
      scriptsDir: process.cwd(), saveDir: process.cwd(), scriptRuntime: null,
      world: { items: new Map(), mobiles: new Map() }, mapProvider, sharedCtx: {},
      queryInt, registerUndoableMutation: () => null,
    });
    const edit = routes.find((entry) => entry.path === '/api/map/edit');

    expect(edit.run({ body: { facet: 1, edits: [
      { x: 10, y: 20, tileId: 11, z: 4 }, { x: -1, y: 20, tileId: 11, z: 4 },
    ] } })).toMatchObject({ error: expect.stringContaining('complete batch') });
    expect(mapProvider.setLandTile).not.toHaveBeenCalled();

    expect(edit.run({ body: { facet: 1, edits: [{ x: 10, y: 20, tileId: 11, z: 4 }] } }))
      .toMatchObject({ error: expect.stringContaining('rolled back'), rolledBack: 1 });
    expect(edits.get('1|10|20')).toMatchObject({ tileId: 9, z: 3 });
  });

  it('rolls an entire prefab import back when any item cannot be created', () => {
    const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-prefab-import-'));
    try {
      fs.mkdirSync(path.join(saveDir, 'prefabs'));
      fs.writeFileSync(path.join(saveDir, 'prefabs', 'tower.json'), JSON.stringify({
        version: 2, name: 'tower', tiles: [
          { dx: 0, dy: 0, dz: 0, itemId: 100, hue: 0, source: 'item' },
          { dx: 1, dy: 0, dz: 0, itemId: 101, hue: 0, source: 'item' },
        ],
      }));
      const world = { items: new Map(), mobiles: new Map(), onlineMobiles: () => [] };
      let nextSerial = 1;
      const destroyItem = vi.fn((_world, serial) => world.items.delete(serial));
      const createItem = vi.fn((_world, row) => {
        if (row.itemId === 101) throw new Error('fixture create failure');
        const item = { ...row, serial: nextSerial++ };
        world.items.set(item.serial, item);
        return item;
      });
      const routes = [];
      registerWorldEditRoutes(routes, {
        scriptsDir: process.cwd(), saveDir, scriptRuntime: null, world,
        mapProvider: { landAt: () => ({ tileId: 1, z: 0 }) },
        sharedCtx: { items: { createItem, destroyItem } },
        queryInt: (_query, _name, fallback) => fallback, registerUndoableMutation: () => null,
      });

      const result = routes.find((entry) => entry.path === '/api/statics/import-prefab').run({
        body: { name: 'tower', facet: 1, x: 100, y: 100, z: 0 },
      });

      expect(result).toMatchObject({ error: expect.stringContaining('rolled back'), rolledBack: 1, rollbackComplete: true });
      expect(destroyItem).toHaveBeenCalledOnce();
      expect(world.items.size).toBe(0);
    } finally { fs.rmSync(saveDir, { recursive: true, force: true }); }
  });
});
