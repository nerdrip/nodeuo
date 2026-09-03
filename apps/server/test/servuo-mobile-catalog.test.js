import { describe, expect, it, vi } from 'vitest';
import registerServUOMobileCatalog from '../../scripts/src/npcs/00-servuo-mobile-catalog.js';

function registry(seed = []) {
  const map = new Map(seed.map((row) => [row.kind, row]));
  return {
    get: (kind) => map.get(kind),
    register: (row) => map.set(row.kind, row),
    unregister: (kind) => map.delete(kind),
    map,
  };
}

describe('generated ServUO mobile runtime catalogue', () => {
  it('fills missing classes while preserving authored definitions', () => {
    const authoredDragon = { kind: 'dragon', name: 'authored dragon', body: 59 };
    const monsters = registry([authoredDragon]);
    const npcs = registry();
    const dispose = registerServUOMobileCatalog({ monsters, npcs, log: vi.fn() });
    expect(monsters.get('dragon')).toBe(authoredDragon);
    expect(monsters.get('vorpal-bunny')).toMatchObject({ servuoClass: 'VorpalBunny', body: 0xCD });
    expect(npcs.get('impresario')).toMatchObject({ servuoClass: 'Impresario', role: 'npc' });
    expect(monsters.map.size).toBeGreaterThan(800);
    expect(npcs.map.size).toBeGreaterThan(400);
    dispose();
    expect(monsters.get('dragon')).toBe(authoredDragon);
    expect(monsters.get('vorpal-bunny')).toBeUndefined();
    expect(npcs.get('impresario')).toBeUndefined();
  });
});
