import { describe, expect, it, vi } from 'vitest';
import { CORE_SIGILS, CORE_WORLD_BOSSES, registerCoreWorldEvents } from '../src/content/world-event-registry.js';

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
});
