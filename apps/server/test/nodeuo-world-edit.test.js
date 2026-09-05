import { describe, expect, it, vi } from 'vitest';
import { NodeUOJsonKind } from '@uo/nodeuo-protocol';
import { registerWorldEditRoutes } from '../src/admin/world-edit-routes.js';

describe('NodeUO world-edit transport boundary', () => {
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
});
