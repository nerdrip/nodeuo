// PHASE DD — peerless altar registry + key-presentation flow.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerArena, getArena, listArenas, tryUnlock, validateUnlock, commitUnlock,
  isOnCooldown, markFinished, _resetArenasForTest,
} from '../src/systems/bosses/peerless.js';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';

describe('peerless arena registry (PHASE DD)', () => {
  beforeEach(() => _resetArenasForTest());

  it('registerArena + getArena + listArenas round-trip', () => {
    registerArena({
      name: 'travesty',
      requiredKeys: ['captain key', 'first mate key'],
      bossKind: 'travesty',
      spawnAt: { x: 100, y: 100, z: 0, map: 1 },
      teleportTo: { x: 95, y: 100, z: 0, map: 1 },
    });
    expect(getArena('travesty')).toBeTruthy();
    expect(listArenas()).toContain('travesty');
  });

  it('tryUnlock fails when keys are missing', () => {
    const w = new World();
    registerArena({
      name: 'mel',
      requiredKeys: ['fairy crown', 'ancient seed'],
      bossKind: 'lady-mel',
      spawnAt: { x: 0, y: 0, z: 0, map: 1 },
      teleportTo: { x: 0, y: 0, z: 0, map: 1 },
    });
    const altar = createItem(w, { itemId: 0x1F1A, x: 0, y: 0, z: 0, map: 1 });
    altar.arenaName = 'mel';
    // Drop only one of the two required keys.
    createItem(w, {
      itemId: 0x1086, name: 'fairy crown', parent: altar.serial,
      x: 0, y: 0, z: 0, map: 1,
    });
    const r = tryUnlock(w, altar);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('missing-keys:ancient seed');
  });

  it('tryUnlock consumes keys and returns the def on success', () => {
    const w = new World();
    registerArena({
      name: 'effusion',
      requiredKeys: ['shimmer key'],
      bossKind: 'effusion',
      spawnAt: { x: 0, y: 0, z: 0, map: 1 },
      teleportTo: { x: 0, y: 0, z: 0, map: 1 },
    });
    const altar = createItem(w, { itemId: 0x1F1A, x: 0, y: 0, z: 0, map: 1 });
    altar.arenaName = 'effusion';
    const key = createItem(w, {
      itemId: 0x1086, name: 'shimmer key', parent: altar.serial,
      x: 0, y: 0, z: 0, map: 1,
    });
    const r = tryUnlock(w, altar);
    expect(r.ok).toBe(true);
    expect(r.def.bossKind).toBe('effusion');
    // Key consumed.
    expect(w.items.has(key.serial)).toBe(false);
  });

  it('supports validate-then-commit so a failed boss spawn cannot eat offerings', () => {
    const w = new World();
    registerArena({
      name: 'transactional', requiredKeys: ['peerless key'], bossKind: 'boss',
      spawnAt: { x: 10, y: 10, z: 0, map: 1 },
      teleportTo: { x: 8, y: 10, z: 0, map: 1 },
    });
    const altar = createItem(w, { itemId: 1, x: 0, y: 0, z: 0, map: 1 });
    altar.arenaName = 'transactional';
    const key = createItem(w, { itemId: 2, name: 'peerless key', parent: altar.serial });

    const validation = validateUnlock(w, altar);
    expect(validation.ok).toBe(true);
    expect(w.items.has(key.serial)).toBe(true);
    expect(commitUnlock(w, validation)).toBe(true);
    expect(w.items.has(key.serial)).toBe(false);
    expect(commitUnlock(w, validation)).toBe(false);
  });

  it('cooldown blocks re-unlock until expiry', () => {
    registerArena({
      name: 'shimmer',
      requiredKeys: [],
      bossKind: 'effusion',
      spawnAt: { x: 0, y: 0, z: 0, map: 1 },
      teleportTo: { x: 0, y: 0, z: 0, map: 1 },
      cooldownMs: 1000,
    });
    expect(isOnCooldown('shimmer')).toBe(false);
    markFinished('shimmer', 1_000_000);
    // Inside cooldown window — pass `now` so we don't depend on
    // wall-clock time for the comparison.
    expect(isOnCooldown('shimmer', 1_000_500)).toBe(true);
    // Past the window.
    expect(isOnCooldown('shimmer', 1_002_000)).toBe(false);
  });

  it('returns no-arena-registered for unknown altar', () => {
    const w = new World();
    const altar = createItem(w, { itemId: 0x1F1A, x: 0, y: 0, z: 0, map: 1 });
    altar.arenaName = 'unregistered';
    const r = tryUnlock(w, altar);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-arena-registered');
  });
});
