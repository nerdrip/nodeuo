import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandRegistry } from '../src/net/commands.js';
import {
  auditSnapshot, packet, protocolSnapshot, scanWorldIntegrity, verifySaveDirectory,
} from '../src/systems/operational-diagnostics.js';
import { World } from '../src/world/world.js';

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

  it('verifies readable save snapshots and tracks command outcomes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-ops-'));
    fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({ version: 3, mobiles: [], items: [] }));
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
