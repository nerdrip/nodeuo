import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { World } from '../src/world/world.js';
import {
  exportWorldJsonSync,
  loadWorldSync,
  serializeItem,
  serializeMobile,
  serializeWorldMeta,
} from '../src/world/persistence.js';
import { createWorldMutationJournal } from '../src/world/mutation-journal.js';
import {
  createWorldDatabaseBackup,
  sqliteDiagnosticsSync,
  verifyWorldDatabaseSync,
} from '../src/world/sqlite-store.js';

const temporaryDirectories = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-sqlite-'));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('SQLite world persistence', () => {
  it('imports only characters and their item chains from the retired JSON world', () => {
    const dir = tempDir();
    const legacy = new World();
    const player = legacy.createMobile({ name: 'PlayerOne', x: 10, y: 20, z: 0, map: 1 });
    player.isPlayer = true;
    player.accountName = 'account-one';
    const backpack = legacy.createItem({ itemId: 0x0e75, parent: player.serial, layer: 21 });
    legacy.createItem({ itemId: 0x0eed, amount: 100, parent: backpack.serial });
    legacy.createMobile({ name: 'Discarded NPC', x: 11, y: 20, z: 0, map: 1 });
    legacy.createItem({ itemId: 1, x: 12, y: 20, z: 0, map: 1 });
    legacy._createWorldDone = true;
    legacy._createWorldVersion = 99;
    exportWorldJsonSync(legacy, dir);

    const restored = new World();
    expect(loadWorldSync(restored, dir)).toBe(true);
    expect([...restored.mobiles.values()].map((m) => m.name)).toEqual(['PlayerOne']);
    expect(restored.items.size).toBe(2);
    expect(restored._createWorldDone).not.toBe(true);
    expect(restored._createWorldVersion | 0).toBe(0);
    expect(sqliteDiagnosticsSync(dir)).toMatchObject({ mobiles: 1, items: 2, playerOwned: 3 });
  });

  it('commits only dirty entities through the worker and survives restart', async () => {
    const dir = tempDir();
    const world = new World();
    expect(loadWorldSync(world, dir)).toBe(false);
    const journal = createWorldMutationJournal(dir, {
      flushIntervalMs: 60_000,
      serializeMobile,
      serializeItem,
      serializeMeta: serializeWorldMeta,
    }).attach(world);

    const player = world.createMobile({ name: 'Incremental', x: 1, y: 2, z: 0, map: 1 });
    player.isPlayer = true;
    const item = world.createItem({ itemId: 0x0eed, amount: 10, parent: player.serial });
    const first = await journal.flushAllAsync();
    expect(first.rows).toBe(2);

    player.hp = 17;
    world.markMobileVitals(player);
    world.destroyItem(item.serial);
    const second = await journal.flushAllAsync();
    expect(second).toMatchObject({ rows: 1, removals: 1 });
    await journal.closeAsync();

    const restarted = new World();
    expect(loadWorldSync(restarted, dir)).toBe(true);
    expect(restarted.mobiles.get(player.serial)?.hp).toBe(17);
    expect(restarted.items.has(item.serial)).toBe(false);
    expect(verifyWorldDatabaseSync(dir)).toMatchObject({ ok: true, mobiles: 1, items: 0 });
  });

  it('creates an integrity-checked online backup without orphan sidecars', async () => {
    const dir = tempDir();
    const world = new World();
    loadWorldSync(world, dir);
    const target = path.join(dir, 'world.sqlite.backup.1');
    const result = await createWorldDatabaseBackup(dir, target);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(`${target}-wal`)).toBe(false);
    expect(fs.existsSync(`${target}-shm`)).toBe(false);
  });
});
