import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EconomyTransactionLedger } from '../src/systems/economy/transaction-ledger.js';
import { World } from '../src/world/world.js';

const created = [];
afterEach(() => { for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('economy transaction ledger', () => {
  it('accepts only balanced postings and verifies its hash chain', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-ledger-')); created.push(root);
    const ledger = new EconomyTransactionLedger(path.join(root, 'economy.ndjson'));
    expect(ledger.record([{ account: 'a', delta: -5 }, { account: 'b', delta: 4 }]).ok).toBe(false);
    expect(ledger.record([{ account: 'a', delta: -5 }, { account: 'b', delta: 5 }]).ok).toBe(true);
    expect(ledger.verify()).toMatchObject({ ok: true, checked: 1 });
    ledger.flush();
    expect(new EconomyTransactionLedger(path.join(root, 'economy.ndjson')).verify().ok).toBe(true);
    fs.appendFileSync(path.join(root, 'economy.ndjson'), `${JSON.stringify({
      version: 1, sequence: 2, id: 'tampered', at: Date.now(), kind: 'transfer', actor: null,
      reference: null, postings: [{ account: 'a', delta: -1, asset: 'gold' },
        { account: 'b', delta: 1, asset: 'gold' }], metadata: null,
      previousHash: '0'.repeat(64), hash: 'f'.repeat(64),
    })}\n`);
    const corrupted = new EconomyTransactionLedger(path.join(root, 'economy.ndjson'));
    expect(corrupted.verify().ok).toBe(false);
    expect(corrupted.snapshot().anomalies).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid-hash-chain' }),
    ]));
  });

  it('observes gold creation, movement and amount changes without patching gameplay scripts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-ledger-')); created.push(root);
    const world = new World();
    world.mobiles.set(1, { serial: 1, accountName: 'alice', gold: 0 });
    world.mobiles.set(2, { serial: 2, accountName: 'bob', gold: 0 });
    const ledger = new EconomyTransactionLedger(path.join(root, 'economy.ndjson')).attach(world);
    world.items.set(10, { serial: 10, itemId: 0x0eed, amount: 50, parent: 1 });
    ledger.observeItem(10);
    world.items.get(10).parent = 2; ledger.observeItem(10);
    world.items.get(10).amount = 75; ledger.observeItem(10);
    expect(ledger.records).toHaveLength(3);
    expect(ledger.records[1].postings).toEqual(expect.arrayContaining([
      { account: 'mobile:alice', delta: -50, asset: 'gold' },
      { account: 'mobile:bob', delta: 50, asset: 'gold' },
    ]));
    ledger.close();
  });
});
