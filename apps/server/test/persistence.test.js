import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import { snapshotWorld, restoreWorld, saveWorldSync, loadWorldSync } from '../src/world/persistence.js';
import { migrateSnapshot, planSnapshotMigration } from '../src/world/persistence-migrations.js';

describe('world persistence', () => {
  it('round-trips CreateWorld and runtime XmlSpawner restoration markers', () => {
    const w1 = new World();
    w1._createWorldDone = true;
    w1._createWorldVersion = 3;
    w1._xmlSpawnersApplied.add('xml-1-100-200-7');
    w1._treasureChestsApplied.add('xml-treasure-1-101-201-3-8');

    const w2 = new World();
    restoreWorld(w2, JSON.parse(JSON.stringify(snapshotWorld(w1))));

    expect(w2._createWorldDone).toBe(true);
    expect(w2._createWorldVersion).toBe(3);
    expect([...w2._xmlSpawnersApplied]).toEqual(['xml-1-100-200-7']);
    expect([...w2._treasureChestsApplied]).toEqual(['xml-treasure-1-101-201-3-8']);
  });

  it('round-trips an explicitly clean CreateWorld gate', () => {
    const source = new World();
    source._createWorldDone = false;
    source._createWorldVersion = 0;
    const restored = new World();
    restoreWorld(restored, JSON.parse(JSON.stringify(snapshotWorld(source))));
    expect(restored._createWorldDone).toBe(false);
    expect(restored._createWorldVersion).toBe(0);
  });

  it('round-trips game-system world state and personal progression', () => {
    const source = new World();
    const player = source.createMobile({ name: 'Adventurer' });
    player.gameSystems = { tokens: 25, completions: { 'regional-invasions': 2 }, titles: ['Defender'], lastPlayedAt: 123 };
    source._gameSystemRuntime = { serialize: () => ({ version: 1, nextInstanceId: 8, instances: [{ id: 'regional-invasions:a:1' }], history: [] }) };
    const restored = new World();
    restoreWorld(restored, JSON.parse(JSON.stringify(snapshotWorld(source))));
    expect(restored.mobiles.get(player.serial)?.gameSystems).toEqual(player.gameSystems);
    expect(restored._persistedGameSystems).toMatchObject({ version: 1, nextInstanceId: 8,
      instances: [{ id: 'regional-invasions:a:1' }] });
  });

  it('snapshot + restore round-trips mobiles and items', () => {
    const w1 = new World();
    const mob = w1.createMobile({ name: 'Alice' });
    mob.x = 100; mob.y = 200; mob.z = 5;
    mob.spellcraft = {
      version: 1, xp: 225, discoveries: ['element:fire', 'node:heal'], lastPracticeAt: 12345,
    };
    const torch = createItem(w1, { itemId: 0x0F0B, x: 101, y: 200, z: 5 });
    const sword = createItem(w1, { itemId: 0x13B9, hue: 0x0058, x: 102, y: 200, z: 5 });
    const fragment = createItem(w1, {
      definitionId: 'arcane-fragment-fire', itemId: 0x1F2D,
      spellcraftUnlock: 'element:fire', spellcraftXp: 75,
      x: 103, y: 200, z: 5,
    });
    const pedestal = createItem(w1, {
      definitionId: 'arcane-schema-pedestal', itemId: 0x1223,
      schemaOwnerAccount: 'alice', schemaSpellId: 10020, schemaSpellName: 'Night House',
      schemaCharge: 275, schemaActive: true, schemaTargetSerial: torch.serial,
      schemaNextRunAt: 123456,
      x: 104, y: 200, z: 5,
    });

    const snap = snapshotWorld(w1);
    expect(snap.version).toBe(1);
    expect(snap.mobiles).toHaveLength(1);
    expect(snap.items).toHaveLength(4);

    // Round-trip via JSON.
    const json = JSON.parse(JSON.stringify(snap));

    const w2 = new World();
    restoreWorld(w2, json);

    expect(w2.mobiles.size).toBe(1);
    expect(w2.items.size).toBe(4);
    const restoredMob = w2.mobiles.get(mob.serial);
    expect(restoredMob.name).toBe('Alice');
    expect(restoredMob.x).toBe(100);
    expect(restoredMob.client).toBeNull();
    expect(restoredMob.spellcraft).toEqual(mob.spellcraft);
    expect(w2.items.get(torch.serial).itemId).toBe(0x0F0B);
    expect(w2.items.get(sword.serial).hue).toBe(0x0058);
    expect(w2.items.get(fragment.serial)).toMatchObject({
      spellcraftUnlock: 'element:fire', spellcraftXp: 75,
    });
    expect(w2.items.get(pedestal.serial)).toMatchObject({
      schemaOwnerAccount: 'alice', schemaSpellId: 10020, schemaSpellName: 'Night House',
      schemaCharge: 275, schemaActive: true, schemaTargetSerial: torch.serial,
      schemaNextRunAt: 123456,
    });

    // Serial allocator must not reuse existing serials.
    const newMob = w2.createMobile({ name: 'Bob' });
    expect(newMob.serial).toBeGreaterThan(mob.serial);
    const newItem = createItem(w2, { itemId: 1, x: 0, y: 0, z: 0 });
    expect(newItem.serial).toBeGreaterThan(sword.serial);
  });

  it('rejects unknown save version', () => {
    const w = new World();
    expect(() => restoreWorld(w, { version: 99, mobiles: [], items: [] }))
      .toThrow(/unsupported save version/);
  });

  it('dry-runs and applies legacy migrations with an explicit rollback plan', () => {
    const legacy = { version: 0, mobiles: null, items: null };
    const dry = migrateSnapshot(legacy, { dryRun: true });
    expect(dry.snapshot).toBe(legacy);
    expect(dry.plan).toMatchObject({ ok: true, from: 0, target: 1 });
    expect(dry.plan.rollback).toMatchObject({ strategy: 'restore-backup', backupRequired: true });

    const applied = migrateSnapshot(legacy);
    expect(applied.snapshot).toMatchObject({ version: 1, mobiles: [], items: [] });
    expect(planSnapshotMigration({ version: 99 })).toMatchObject({ ok: false, reason: 'newer-than-runtime' });
  });

  it('round-trips durable door state without serialising timer handles', () => {
    const w1 = new World();
    const door = createItem(w1, { itemId: 0x0676, x: 99, y: 101, z: 0, map: 1, movable: false });
    door.script = 'door';
    door.door = {
      closedId: 0x0675, openId: 0x0676, isOpen: true, facing: 'south',
      closedX: 100, closedY: 100, closedZ: 0,
      linkSerial: 0x40001234, secret: true, revealed: true,
      portcullis: false, keyId: 77, locked: true,
      _closeTimer: { intentionally: 'not serialisable' },
    };

    const w2 = new World();
    restoreWorld(w2, JSON.parse(JSON.stringify(snapshotWorld(w1))));
    expect(w2.items.get(door.serial).door).toEqual({
      closedId: 0x0675, openId: 0x0676, isOpen: true, facing: 'south',
      closedX: 100, closedY: 100, closedZ: 0,
      linkSerial: 0x40001234, secret: true, revealed: true,
      portcullis: false, keyId: 77, locked: true,
    });
  });

  it('drops items whose parent serial does not resolve to any mobile or item', () => {
    // Regression for S-04. Saves used to silently lose items whose parent
    // pointed at a purged container; the load path must at least drop those
    // items to the ground so the player can recover them.
    const w = new World();
    const mob = w.createMobile({ name: 'Ghost' });
    mob.x = 10; mob.y = 20; mob.z = 0;
    const orphan = createItem(w, { itemId: 0x1B76, x: 0, y: 0, z: 0 });
    orphan.parent = 0x7F123456; // nonexistent parent serial
    orphan.layer = 21;
    orphan.gridX = 5; orphan.gridY = 5;

    const snap = JSON.parse(JSON.stringify(snapshotWorld(w)));
    const w2 = new World();
    restoreWorld(w2, snap);

    const restored = w2.items.get(orphan.serial);
    expect(restored).toBeDefined();
    expect(restored.parent).toBeNull();
    expect(restored.layer).toBe(0);
    expect(restored.gridX).toBeUndefined();
  });

  it('rejects mobiles and items whose serials fall outside their valid range', () => {
    // Regression for S-04. Without this, a save hand-edited to contain an
    // item serial inside the mobile range (or vice versa) corrupted world
    // lookups that rely on isItemSerial / isMobileSerial dispatch.
    const w = new World();
    restoreWorld(w, {
      version: 1,
      mobiles: [
        { serial: 0x80000001, name: 'OutOfRange', x: 0, y: 0, z: 0 }, // > 0x3FFFFFFF
        { serial: 0x00000002, name: 'Valid',      x: 0, y: 0, z: 0 },
      ],
      items: [
        { serial: 0x00000003, itemId: 0x0F0B,     x: 0, y: 0, z: 0 }, // in mobile range
        { serial: 0x40000004, itemId: 0x0F0B,     x: 0, y: 0, z: 0 },
      ],
      serials: { nextMobile: 1, nextItem: 0x40000000 },
    });

    expect(w.mobiles.size).toBe(1);
    expect(w.mobiles.has(0x00000002)).toBe(true);
    expect(w.items.size).toBe(1);
    expect(w.items.has(0x40000004)).toBe(true);
  });

  it('recovers the last committed SQLite transaction after an interrupted write', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-save-chaos-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const first = new World();
      first.createMobile({ name: 'Committed', x: 10, y: 20, z: 0, map: 1 });
      saveWorldSync(first, dir);
      const db = new DatabaseSync(path.join(dir, 'world.sqlite'));
      db.exec('BEGIN IMMEDIATE; DELETE FROM entities;');
      // Closing with an open transaction models a process dying before
      // COMMIT. SQLite rolls it back when the database is opened again.
      db.close();

      const recovered = new World();
      expect(loadWorldSync(recovered, dir)).toBe(true);
      expect([...recovered.mobiles.values()].map((mob) => mob.name)).toContain('Committed');
    } finally {
      warn.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
