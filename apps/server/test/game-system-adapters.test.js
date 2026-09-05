import { describe, expect, it, vi } from 'vitest';
import { GameSystemAdapterRegistry } from '../src/systems/game-system-adapters.js';

describe('game-system adapter boundary', () => {
  it('rejects definitions whose declared engine service is absent', () => {
    const registry = new GameSystemAdapterRegistry({});
    expect(registry.validate([{ id: 'raid', adapter: 'peerless' }])).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('engineSystems.peerless')],
    });
  });

  it('resolves stable aliases and invokes only the explicit lifecycle contract', () => {
    const hook = vi.fn(() => ({ ok: true, accepted: true }));
    const registry = new GameSystemAdapterRegistry({ itemRegistry: { gameSystemHook: hook } });
    const definition = { id: 'research-bestiary', adapter: 'worldCodex' };
    expect(registry.validate([definition])).toMatchObject({ ok: true, warnings: [] });
    expect(registry.lifecycle('completed', definition, { marker: 7 })).toMatchObject({
      ok: true, handled: true, accepted: true, serviceId: 'itemRegistry',
    });
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'completed', definition, serviceId: 'itemRegistry', marker: 7,
    }));
    expect(registry.diagnostics([definition])[0]).toMatchObject({
      id: 'worldCodex', serviceId: 'itemRegistry', available: true,
      optInLifecycle: true, calls: 1, handled: 1, failures: 0,
    });
  });

  it('does not guess or execute arbitrary methods on legacy services', () => {
    const dangerous = vi.fn();
    const registry = new GameSystemAdapterRegistry({ quests: { start: dangerous, complete: dangerous } });
    const definition = { id: 'campaign', adapter: 'quests' };
    expect(registry.validate([definition])).toMatchObject({ ok: true,
      warnings: [expect.stringContaining('no lifecycle hook')] });
    expect(registry.lifecycle('start', definition)).toMatchObject({ ok: true, handled: false });
    expect(dangerous).not.toHaveBeenCalled();
  });
});
