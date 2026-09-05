import { describe, expect, it, vi } from 'vitest';
import { CORE_SIGILS, CORE_WORLD_BOSSES, registerCoreWorldEvents } from '../src/content/world-event-registry.js';
import * as sigils from '../src/systems/pvp/sigils.js';
import { World } from '../src/world/world.js';
import {
  deleteStandardSigils,
  registerStandardSigils,
} from '../../scripts/src/items/scripts/functional/sigil.js';

describe('core world event registry', () => {
  it('registers every authored boss and sigil once', () => {
    const worldBosses = { registerBoss: vi.fn() };
    const sigils = { registerSigil: vi.fn() };
    const result = registerCoreWorldEvents({ worldBosses, sigils });
    expect(result).toEqual({ bosses: CORE_WORLD_BOSSES.length, sigils: CORE_SIGILS.length });
    expect(worldBosses.registerBoss).toHaveBeenCalledTimes(CORE_WORLD_BOSSES.length);
    expect(sigils.registerSigil).toHaveBeenCalledTimes(CORE_SIGILS.length);
    expect(new Set(CORE_WORLD_BOSSES.map((entry) => entry.id)).size).toBe(CORE_WORLD_BOSSES.length);
    expect(new Set(CORE_SIGILS.map((entry) => entry.id)).size).toBe(CORE_SIGILS.length);
  });

  it('creates idempotent physical sigils and removes their runtime state', () => {
    sigils._resetForTest();
    const world = new World();
    const api = { world, systems: { sigils } };

    expect(registerStandardSigils(api)).toMatchObject({ added: 5, skipped: 0 });
    expect(world.items.size).toBe(5);
    expect([...world.items.values()].every((item) => item.script === 'sigil' && item._sigilTown)).toBe(true);
    expect(sigils.listSigils()).toHaveLength(5);
    expect(registerStandardSigils(api)).toMatchObject({ added: 0, skipped: 5 });

    expect(deleteStandardSigils(api)).toEqual({ removed: 5 });
    expect(world.items.size).toBe(0);
    expect(sigils.listSigils()).toHaveLength(0);
  });
});
