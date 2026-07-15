import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../src/world/world.js';
import { setItemParent } from '../src/world/items.js';
import { nearbyItems } from '../src/world/visibility.js';
import { regenTickBudgeted } from '../src/regen.js';
import { tickDecayBudgeted } from '../src/world/decay.js';
import { validateConfig } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('wave 2 architecture gates', () => {
  it('keeps full-world iteration out of visibility and movement hot paths', () => {
    for (const relative of ['src/world/visibility.js', 'src/world/movement.js']) {
      const body = fs.readFileSync(path.join(ROOT, relative), 'utf8');
      expect(body, relative).not.toMatch(/world\.(?:items|mobiles)\.values\(\)/);
    }
    const main = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
    expect(main).toMatch(/measureAsync\('tiledata',[\s\S]*preloadTileData/);
  });

  it('keeps item tile and typed indexes coherent through parent transitions', () => {
    const world = new World();
    const item = world.createItem({ itemId: 1, x: 20, y: 20, z: 0, map: 1, door: true });
    world.enableSpatialIndexes();
    expect([...world.sectors.itemSerialsAt(1, 20, 20)]).toContain(item.serial);
    expect([...world.spatialNear('door', item, 0)]).toContain(item);
    setItemParent(world, item, 0x1234);
    expect([...world.sectors.itemSerialsAt(1, 20, 20)]).not.toContain(item.serial);
    expect([...world.spatialNear('door', item, 0)]).not.toContain(item);
    setItemParent(world, item, null);
    expect([...nearbyItems(world, item, 1)]).toContain(item);
    expect(world.sectors.validate(world)).toMatchObject({ ok: true });
  });

  it('self-repairs missing and orphaned sector entries in a background-safe pass', () => {
    const world = new World();
    const mobile = world.createMobile({ x: 10, y: 10, map: 1 });
    world.sectors.removeMobile(mobile.serial);
    const result = world.sectors.validate(world, { repair: true });
    expect(result.ok).toBe(false);
    expect(result.repaired).toBe(true);
    expect(world.sectors.validate(world).ok).toBe(true);
  });

  it('distributes regen and decay work with bounded batch sizes', () => {
    const world = new World();
    for (let i = 0; i < 25; i++) world.createMobile({ x: i, y: i, map: 1, hp: 1, hpMax: 50 });
    for (let i = 0; i < 25; i++) world.createItem({ itemId: 1, x: i, y: i, z: 0, map: 1 });
    expect(regenTickBudgeted(world, 1000, 7).processed).toBe(7);
    expect(tickDecayBudgeted(world, Date.now(), 1000, 6).processed).toBe(6);
  });

  it('validates ports, listener collisions and exposed development auth', () => {
    expect(validateConfig({ host: '127.0.0.1', port: 2593, tcpPort: 2594, tcpHost: '127.0.0.1', shardName: 'test', devAutoAccept: false }).ok).toBe(true);
    expect(validateConfig({ host: '0.0.0.0', port: -1, tcpPort: -1, tcpHost: '0.0.0.0', shardName: '', devAutoAccept: true }).ok).toBe(false);
  });

  it('bounds a 100k item tile benchmark and exposes query telemetry', () => {
    const world = new World();
    for (let i = 0; i < 100_000; i++) world.createItem({ itemId: 1, x: i % 2048, y: (i * 31) % 2048, z: 0, map: i % 2 });
    const started = performance.now();
    let hits = 0;
    for (let i = 0; i < 1000; i++) hits += [...world.sectors.itemSerialsAt(i % 2, i % 2048, (i * 31) % 2048)].length;
    expect(hits).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(world.sectors.stats().queries.tileCalls).toBe(1000);
  }, 15_000);

  it('does not leak timers from a completed bounded pass', () => {
    vi.useFakeTimers();
    const world = new World();
    world.createMobile({ x: 1, y: 1, hp: 1, hpMax: 2 });
    regenTickBudgeted(world, 1000, 1);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
