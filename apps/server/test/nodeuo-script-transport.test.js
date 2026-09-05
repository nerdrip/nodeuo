import { describe, expect, it, vi } from 'vitest';
import registerBuild from '../../scripts/src/commands/admin/build.js';
import registerBoat from '../../scripts/src/commands/economy/boat.js';

function commandRegistry() {
  const commands = new Map();
  return {
    commands,
    api: { register: (definition) => commands.set(definition.name, definition), unregister: vi.fn() },
  };
}

describe('scripted NodeUO v2 transport', () => {
  it('sends build previews as JSON without the legacy extended packet', () => {
    const registry = commandRegistry();
    const nodeUOSend = vi.fn(() => true);
    const state = {
      nodeUOJsonTransport: true, mobile: { map: 1 },
      supportsNodeUO: () => true, send: vi.fn(), sendSystemMessage: vi.fn(),
    };
    registerBuild({
      commands: registry.api, items: {}, targeting: { request: vi.fn() },
      protocol: {},
      nodeUO: { features: { WorldEditing: 'world.editing' }, send: nodeUOSend },
    });

    registry.commands.get('build').run({ state }, ['0x123,0x44']);

    expect(nodeUOSend).toHaveBeenCalledWith(state, expect.objectContaining({
      feature: 'world.editing', payload: { operation: 'preview', itemId: 0x123, hue: 0x44 },
    }));
    expect(state.send).not.toHaveBeenCalled();
  });

  it('sends naval previews as JSON without the legacy extended packet', () => {
    const registry = commandRegistry();
    const nodeUOSend = vi.fn(() => true);
    const cannon = { serial: 201, x: 51, y: 50 };
    const boat = { serial: 100, x: 50, y: 50, z: 0, map: 1,
      boat: { cannons: [cannon.serial] } };
    const sender = { serial: 1, _boardedBoat: boat.serial, x: 50, y: 50, map: 1 };
    const state = {
      nodeUOJsonTransport: true, supportsNodeUO: () => true,
      send: vi.fn(), sendSystemMessage: vi.fn(),
    };
    registerBoat({
      commands: registry.api, items: {}, landProvider: {},
      world: { items: new Map([[boat.serial, boat], [cannon.serial, cannon]]) },
      protocol: {},
      systems: { cannons: { cannonProfile: () => ({
        facing: 'N', range: 12, stage: 'primed', cooldownRemainingMs: 0, kind: 'light',
      }) } },
      nodeUO: { features: { NavalPreview: 'naval.preview' },
        messages: { Naval: { ShowRange: 1, HideRange: 2 } }, send: nodeUOSend },
    });

    registry.commands.get('boat').run({ state, sender, args: ['range'] });

    expect(nodeUOSend).toHaveBeenCalledWith(state, expect.objectContaining({
      feature: 'naval.preview',
      payload: expect.objectContaining({ eventKind: 1,
        data: expect.objectContaining({ boatSerial: boat.serial }) }),
    }));
    expect(state.send).not.toHaveBeenCalled();
  });
});
