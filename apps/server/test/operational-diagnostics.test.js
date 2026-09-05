import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandRegistry } from '../src/net/commands.js';
import {
  auditSnapshot, compatibilityNotice, compatibilitySnapshot, connectionClosed, connectionOpened, packet, protocolSnapshot, recordTick, runtimeSnapshot,
  serviceLevelSnapshot,
  scanWorldIntegrity, structuredEvent, structuredSnapshot, verifySaveDirectory,
} from '../src/systems/operational-diagnostics.js';
import { World } from '../src/world/world.js';
import { saveWorldSync } from '../src/world/persistence.js';

describe('operational diagnostics', () => {
  it('aggregates opcode metrics without retaining packet payloads', () => {
    const before = protocolSnapshot();
    packet('rx', 0x02, 7, 1.5);
    packet('tx', 0x22, 3);
    const after = protocolSnapshot();
    expect(after.rxPackets).toBe(before.rxPackets + 1);
    expect(after.txPackets).toBe(before.txPackets + 1);
    expect(after.rxOpcodes.find((entry) => entry.opcode === 0x02)).toMatchObject({ bytes: 7 });
    expect(JSON.stringify(after)).not.toContain('payload');
  });

  it('keeps a bounded metadata-only packet ring for an inspected session', () => {
    const state = { id: 987654, stage: 'inWorld', accountName: 'operator', mobile: { serial: 0x1234 },
      ws: { bufferedAmount: 7 }, nodeUOJsonTransport: false, roundTripMs: 12.5 };
    connectionOpened(state);
    for (let i = 0; i < 300; i++) packet('rx', i & 0xff, 7, 0.25, false, state);
    const session = compatibilitySnapshot().sessions.find((entry) => entry.id === state.id);
    expect(session).toMatchObject({ mobileSerial: 0x1234, pingMs: 12.5, rxPackets: 300, pendingBytes: 7 });
    expect(session.packets).toHaveLength(256);
    expect(session.packets.at(-1)).toMatchObject({ direction: 'rx', bytes: 7, error: false });
    expect(JSON.stringify(session.packets)).not.toContain('payload');
    connectionClosed(state, 'test complete');
  });

  it('reports shown and cooldown-suppressed compatibility notices by feature', () => {
    const before = compatibilitySnapshot().notices;
    compatibilityNotice('ui.rich-gumps/banker', true);
    compatibilityNotice('ui.rich-gumps/banker', false);
    const after = compatibilitySnapshot().notices;
    expect(after.shown).toBe(before.shown + 1);
    expect(after.suppressed).toBe(before.suppressed + 1);
    expect(after.byFeature['ui.rich-gumps/banker']).toMatchObject({ shown: 1, suppressed: 1 });
  });

  it('finds orphan parents, stale reverse indexes and boat attachments', () => {
    const world = new World();
    const item = world.createItem({ itemId: 1, x: 1, y: 1, z: 0, map: 1, parent: 0x12345678 });
    const boat = world.createItem({ itemId: 2, x: 1, y: 1, z: 0, map: 1 });
    boat.boat = { planks: [0x4000ffff], cannons: [] };
    world._childrenByParent.set(0x1111, new Set([0x4000eeee]));
    const report = scanWorldIntegrity(world);
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.kind)).toEqual(expect.arrayContaining(['orphan-item', 'boat-attachment', 'child-index']));
    expect(item.serial).toBeTruthy();
  });

  it('accepts contained items without world coordinates', () => {
    const world = new World();
    const player = world.createMobile({ x: 1, y: 1, z: 0, map: 1 });
    const backpack = world.createItem({ itemId: 0x0E75, parent: player.serial, layer: 21 });
    world.createItem({ itemId: 0x0EED, parent: backpack.serial });
    const report = scanWorldIntegrity(world);
    expect(report.issues.filter((issue) => issue.kind === 'invalid-position')).toEqual([]);
  });

  it('aggregates scheduler latency and structured events', () => {
    recordTick('combat', 4.5);
    recordTick('combat', 55);
    const row = runtimeSnapshot().ticks.find((entry) => entry.name === 'combat');
    expect(row).toMatchObject({ calls: 2, slow: 1, maxMs: 55, averageMs: 29.75 });
    expect(serviceLevelSnapshot().metrics.tickDuration.totalObservations).toBeGreaterThanOrEqual(2);
    structuredEvent('test.ready', { value: 3 });
    expect(structuredSnapshot(1)[0]).toMatchObject({ event: 'test.ready', value: 3 });
  });

  it('verifies readable save snapshots and tracks command outcomes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-ops-'));
    saveWorldSync(new World(), dir);
    expect(verifySaveDirectory(dir)).toMatchObject({ ok: true });

    const commands = new CommandRegistry();
    commands.register({ name: 'ok', access: 'Player', run: () => {} });
    commands.register({ name: 'fail', access: 'Player', run: async () => { throw new Error('boom'); } });
    const ctx = { state: { account: { accessLevel: 'Player' }, accountName: 'tester' } };
    commands.dispatch('ok', ctx);
    commands.dispatch('fail', ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const usage = commands.usageSnapshot();
    expect(usage.commands.find((entry) => entry.name === 'ok')).toMatchObject({ calls: 1, errors: 0 });
    expect(usage.commands.find((entry) => entry.name === 'fail')).toMatchObject({ calls: 1, errors: 1 });
    expect(auditSnapshot(10).some((entry) => entry.kind === 'command.error')).toBe(true);
  });
});
