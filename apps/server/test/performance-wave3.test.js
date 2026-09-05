import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { BoundedSampleWindow, RuntimeProfiler, runtimeTelemetryChannels } from '../src/systems/runtime-profiler.js';
import { PacketReplayRecorder } from '../src/systems/traffic-replay.js';
import { AdmissionController } from '../src/systems/load-shedding.js';
import { HotEntityStore } from '../src/world/hot-entity-store.js';
import { EntityDirty, InterestManager } from '../src/world/interest-management.js';
import { WorldMutationJournal } from '../src/world/mutation-journal.js';
import { World } from '../src/world/world.js';
import { loadWorldSync } from '../src/world/persistence.js';

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('performance wave 3 primitives', () => {
  it('keeps bounded samples and reports tail percentiles', () => {
    const samples = new BoundedSampleWindow(32);
    for (let value = 1; value <= 100; value++) samples.observe(value);
    const result = samples.snapshot();
    expect(result.samples).toBe(32);
    expect(result.p95).toBeGreaterThanOrEqual(95);
    expect(result.p99).toBe(100);
    expect(result.average).toBe(84.5);
    expect(result.max).toBe(100);
  });

  it('publishes opt-in diagnostics channels without a telemetry SDK on the hot path', () => {
    const rows = [];
    const listener = (row) => rows.push(row);
    runtimeTelemetryChannels.system.subscribe(listener);
    try {
      const profiler = new RuntimeProfiler();
      profiler.record('ai.tick', 4.25);
      expect(rows).toEqual([expect.objectContaining({ name: 'ai.tick', durationMs: 4.25 })]);
    } finally {
      runtimeTelemetryChannels.system.unsubscribe(listener);
    }
  });

  it('records replay payloads but permanently redacts login credentials', async () => {
    const recorder = new PacketReplayRecorder({ capacity: 128, capturePayloads: true });
    recorder.record('rx', Buffer.from([0x73, 0x42]), { id: 1, stage: 'inWorld' });
    recorder.record('rx', Buffer.from([0x80, 1, 2, 3]), { id: 1, stage: 'accountLogin' });
    const trace = recorder.exportTrace();
    expect(trace.entries[0].payload).toBe(Buffer.from([0x73, 0x42]).toString('base64'));
    expect(trace.entries[1].payload).toBeUndefined();
    const replayed = [];
    expect(await recorder.replay(trace, (packet) => replayed.push([...packet]))).toEqual({ replayed: 1 });
    expect(replayed).toEqual([[0x73, 0x42]]);
  });

  it('rejects overload and sheds only queued cosmetics', () => {
    const admission = new AdmissionController({ maxConnections: 1, rejectPressure: .9 });
    expect(admission.acquire('a')).toBe(true);
    expect(admission.acquire('b')).toBe(false);
    admission.release('a'); admission.setPressure(.95);
    expect(admission.acquire('b')).toBe(false);
    expect(admission.shouldDropCosmetic(600, 1000)).toBe(true);
  });

  it('keeps hot mobile fields dense across swap-removal', () => {
    const hot = new HotEntityStore(64);
    hot.upsert({ serial: 1, x: 10, y: 11, z: 2, map: 1, hp: 50 });
    hot.upsert({ serial: 2, x: 20, y: 21, z: 3, map: 2, hp: 40 });
    hot.remove(1);
    expect(hot.get(1)).toBeNull();
    expect(hot.get(2)).toMatchObject({ x: 20, y: 21, map: 2, hp: 40 });
    expect(hot.snapshot().size).toBe(1);
  });

  it('coalesces dirty masks before a bounded consumer pass', () => {
    const interest = new InterestManager({ maxDirty: 1024 });
    interest.mark(7, EntityDirty.Position, 'mobile');
    interest.mark(7, EntityDirty.Vitals, 'mobile');
    expect(interest.consume(1)).toEqual([expect.objectContaining({ serial: 7,
      mask: EntityDirty.Position | EntityDirty.Vitals })]);
    expect(interest.snapshot()).toMatchObject({ pending: 0, coalesced: 1 });
    interest.mark(7, EntityDirty.Removed, 'mobile');
    interest.consume(1);
    expect(interest.revision(7)).toBe(0);
  });

  it('recovers committed SQLite WAL upserts and removals', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-wal-')); tempDirs.push(dir);
    const world = new World();
    const journal = new WorldMutationJournal(dir, { enabled: true, flushIntervalMs: 60_000 });
    journal.attach(world);
    const first = world.createMobile({ name: 'first', x: 100, y: 100, map: 1 });
    first.x = 120; world.sectors.moveMobile(first);
    journal.flushSync();
    const second = world.createMobile({ name: 'second', x: 200, y: 200, map: 1 });
    journal.flushSync();
    world.removeMobile(first.serial);
    journal.flushSync();
    journal.close();

    const recovered = new World();
    expect(loadWorldSync(recovered, dir)).toBe(true);
    expect(recovered.mobiles.has(first.serial)).toBe(false);
    expect(recovered.mobiles.get(second.serial)?.name).toBe('second');

    const reader = new WorldMutationJournal(dir, { enabled: true, flushIntervalMs: 60_000 });
    reader.attach(recovered);
    recovered.removeMobile(second.serial);
    reader.flushSync(); reader.close();
    const afterRemoval = new World();
    expect(loadWorldSync(afterRemoval, dir)).toBe(false);
    expect(afterRemoval.mobiles.has(second.serial)).toBe(false);
  });

  it('coalesces dirty masks into one durable SQLite entity upsert', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-wal-delta-')); tempDirs.push(dir);
    const world = new World();
    const journal = new WorldMutationJournal(dir, { enabled: true, flushIntervalMs: 60_000 });
    journal.attach(world);
    const mob = world.createMobile({ name: 'delta', x: 10, y: 11, hp: 40, hpMax: 50 });
    journal.flushSync();
    mob.x = 12; mob.hp = 35;
    journal.queue(mob.serial, EntityDirty.Position, 'mobile');
    journal.queue(mob.serial, EntityDirty.Vitals, 'mobile');
    journal.flushSync(); journal.close();

    const db = new DatabaseSync(path.join(dir, 'world.sqlite'), { readOnly: true });
    const row = db.prepare('SELECT payload FROM entities WHERE serial = ?').get(mob.serial);
    db.close();
    expect(JSON.parse(row.payload)).toMatchObject({ serial: mob.serial, name: 'delta', x: 12, hp: 35, hpMax: 50 });
    expect(journal.snapshot()).toMatchObject({ written: 2, coalesced: 1 });
  });

  it('rebuilds item parent indexes while loading SQLite rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-wal-parent-')); tempDirs.push(dir);
    const world = new World();
    const journal = new WorldMutationJournal(dir, { enabled: true, flushIntervalMs: 60_000 });
    journal.attach(world);
    const parent = world.createItem({ itemId: 0x0e75, name: 'journal parent', x: 1, y: 1, z: 0, map: 1 });
    const item = world.createItem({ itemId: 0x0eed, name: 'journal child', parent: parent.serial });
    journal.flushSync(); journal.close();

    const recovered = new World();
    expect(loadWorldSync(recovered, dir)).toBe(true);
    expect(recovered.items.get(item.serial)?.parent).toBe(parent.serial);
    expect(recovered._childrenByParent.get(parent.serial)).toContain(item.serial);
  });
});
