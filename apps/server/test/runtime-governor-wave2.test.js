import { describe, it, expect, vi } from 'vitest';
import {
  CoalescingWorkQueue, RevisionCache, PhaseWatchdog, LifecycleRegistry,
  commandRegistryAudit, fuzzySuggestions, HealthState, AdaptiveBudget,
  TypedSpatialRegistry, TransactionJournal, DeterministicRuntime, StartupProfiler,
  buildServerQualityReport, serverQualityReportMarkdown,
} from '../src/systems/runtime-governor.js';
import { SectorIndex } from '../src/world/sectors.js';
import { Spawner } from '../src/spawner.js';
import { World } from '../src/world/world.js';

describe('wave 2 runtime governor', () => {
  it('coalesces work, preserves priority and rotates sectors', () => {
    let time = 0;
    const queue = new CoalescingWorkQueue({ budgetMs: 10, now: () => (time += 0.1) });
    const seen = [];
    queue.enqueue('prefetch', () => seen.push('prefetch'), { priority: 3, sector: 'a' });
    queue.enqueue('player', () => seen.push('old'), { priority: 0, sector: 'a' });
    queue.enqueue('player', () => seen.push('new'), { priority: 0, sector: 'b' });
    queue.drain(10);
    expect(seen).toEqual(['new', 'prefetch']);
    expect(queue.snapshot()).toMatchObject({ coalesced: 1, completed: 2, pending: 0 });
  });

  it('invalidates revision cache and bounds its LRU', () => {
    const cache = new RevisionCache({ max: 16 });
    cache.set('x', 1, [1]);
    expect(cache.get('x', 1)).toEqual([1]);
    expect(cache.get('x', 2)).toBeUndefined();
    for (let i = 0; i < 30; i++) cache.set(`k${i}`, 1, i);
    expect(cache.snapshot().size).toBe(16);
    expect(cache.snapshot().evictions).toBeGreaterThan(0);
  });

  it('records phase histograms, slow callbacks and skipped jobs', () => {
    const watchdog = new PhaseWatchdog({ slowMs: 10 });
    watchdog.record('ai', 55); watchdog.record('ai', 2); watchdog.skip('spawner', 3);
    const snapshot = watchdog.snapshot();
    expect(snapshot.phases.find((row) => row.name === 'ai')).toMatchObject({ calls: 2, maxMs: 55 });
    expect(snapshot.phases.find((row) => row.name === 'spawner').skipped).toBe(3);
    expect(snapshot.slow).toHaveLength(1);
  });

  it('owns lifecycle resources and rolls them back after activation failure', async () => {
    const lifecycle = new LifecycleRegistry();
    const disposed = vi.fn();
    const result = await lifecycle.transaction('script:a', async () => ({ rollback: disposed }), async (_staged, own) => {
      own(disposed, 'timer');
      throw new Error('boom');
    });
    expect(result.ok).toBe(false);
    expect(disposed).toHaveBeenCalledTimes(2);
    expect(lifecycle.stats().owners).toBe(0);
  });

  it('audits commands, suggests typos and separates live from ready', () => {
    const audit = commandRegistryAudit([{ name: 'save', access: 'Admin', help: 'save world' }]);
    expect(audit.ok).toBe(true);
    expect(fuzzySuggestions('saev', ['save', 'reload'])[0].name).toBe('save');
    const health = new HealthState(); health.set('scripts', false, 'loading');
    expect(health.snapshot()).toMatchObject({ live: true, ready: false });
    health.set('scripts', true); expect(health.snapshot().ready).toBe(true);
    expect(health.beginShutdown()).toBe(true); expect(health.beginShutdown()).toBe(false);
    expect(health.snapshot().ready).toBe(false);
  });

  it('adapts subsystem budgets and indexes typed spatial resources', () => {
    const budget = new AdaptiveBudget({ base: 100, min: 10, targetTickMs: 10 });
    for (let i = 0; i < 20; i++) budget.observe(30);
    expect(budget.current).toBeLessThan(100);
    for (let i = 0; i < 40; i++) budget.observe(1);
    expect(budget.current).toBeGreaterThan(10);
    const spatial = new TypedSpatialRegistry();
    spatial.add('door', 1, { map: 1, x: 10, y: 10 }, { id: 1 });
    spatial.add('teleport', 2, { map: 1, x: 12, y: 10 }, { id: 2 });
    expect([...spatial.near('door', { map: 1, x: 9, y: 9 }, 4)]).toEqual([{ id: 1 }]);
    expect(spatial.validate()).toMatchObject({ ok: true, types: { door: 1, teleport: 1 } });
  });

  it('records correlated transactions and deterministic clock/RNG snapshots', () => {
    const journal = new TransactionJournal();
    const tx = journal.begin('craft', { actor: 10 });
    journal.item(tx, 100, 'create'); journal.item(tx, 100, 'create'); journal.event(tx, 'consume', { amount: 2 });
    journal.rollback(tx, 'simulated failure');
    expect(journal.snapshot()).toMatchObject({ active: 0, duplicates: 1, rollbacks: 1 });
    const runtime = new DeterministicRuntime(123, 1000); const snapshot = runtime.snapshot();
    const roll = runtime.random(); runtime.advance(25); runtime.restore(snapshot);
    expect(runtime.random()).toBe(roll); expect(runtime.now()).toBe(1000);
    const startup = new StartupProfiler(); startup.measure('sync', () => 1);
    expect(startup.snapshot().phases[0].name).toBe('sync');
  });
});

describe('wave 2 spatial indexes', () => {
  it('tracks tile membership, revisions and repairs drift', () => {
    const sectors = new SectorIndex();
    const world = { mobiles: new Map(), items: new Map() };
    const item = { serial: 0x40000001, x: 10, y: 20, map: 1, parent: 0 };
    world.items.set(item.serial, item); sectors.addItem(item);
    const revision = sectors.revision;
    expect([...sectors.itemSerialsAt(1, 10, 20)]).toEqual([item.serial]);
    item.x = 11; sectors.moveItem(item);
    expect([...sectors.itemSerialsAt(1, 10, 20)]).toEqual([]);
    expect([...sectors.itemSerialsAt(1, 11, 20)]).toEqual([item.serial]);
    expect(sectors.revision).toBe(revision, 'same-sector movement keeps candidate revision stable');
    sectors._itAt.set(item.serial, 123);
    expect(sectors.validate(world).ok).toBe(false);
    expect(sectors.validate(world, { repair: true }).repaired).toBe(true);
    expect(sectors.validate(world).ok).toBe(true);
  });

  it('indexes spawners and keeps huge regions in the global bucket', () => {
    const world = new World();
    const spawner = new Spawner(world, () => null);
    spawner.add({ id: 'local', map: 1, rect: { x1: 8, y1: 8, x2: 16, y2: 16 }, maxCount: 1, respawnMs: [1, 1], kinds: ['rat'] });
    spawner.add({ id: 'global', map: 1, rect: { x1: 0, y1: 0, x2: 7167, y2: 4095 }, maxCount: 1, respawnMs: [1, 1], kinds: ['rat'] });
    expect([...spawner.groupsNear(1, 10, 10)].map((group) => group.id).sort()).toEqual(['global', 'local']);
    expect(spawner.validateIndex().ok).toBe(true);
    spawner.remove('local');
    expect([...spawner.groupsNear(1, 10, 10)].map((group) => group.id)).toEqual(['global']);
  });

  it('builds a machine-readable quality report', () => {
    const world = new World();
    const report = buildServerQualityReport({ world, commands: [{ name: 'save', access: 'Admin', help: 'save' }] });
    expect(report).toHaveProperty('health');
    expect(report).toHaveProperty('queues.visibility');
    expect(report.sectors).toHaveProperty('revision');
    expect(report).toHaveProperty('budgets.visibility');
    expect(serverQualityReportMarkdown(report)).toContain('NodeUO server quality report');
  });
});
