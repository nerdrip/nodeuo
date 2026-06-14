// FAZA CH — bugfix #50: party.accept() must remove the joiner from any
// pre-existing party before adding them to the new one. Plus the
// decline path notifies the leader so they know whether to wait or
// re-invite.

import { describe, it, expect, beforeEach } from 'vitest';
import { World } from '../src/world/world.js';
import { PartyRegistry } from '../src/party.js';

describe('PartyRegistry (FAZA CH)', () => {
  /** @type {World} */ let w;
  /** @type {PartyRegistry} */ let registry;
  /** @type {any} */ let alice;
  /** @type {any} */ let bob;
  /** @type {any} */ let carol;
  /** @type {Map<number, string[]>} */ let received;

  beforeEach(() => {
    w = new World();
    registry = new PartyRegistry(w);
    received = new Map();
    const makePlayer = (name) => {
      const m = w.createMobile({ name, body: 0x190, x: 0, y: 0, z: 0, map: 1 });
      const log = [];
      received.set(m.serial, log);
      m.client = {
        send: (b) => log.push(`pkt:${b[0]?.toString(16) ?? '?'}`),
        sendSystemMessage: (s) => log.push(`msg:${s}`),
      };
      return m;
    };
    alice = makePlayer('Alice');
    bob   = makePlayer('Bob');
    carol = makePlayer('Carol');
  });

  it('accept moves the joiner out of their previous party', () => {
    // Alice invites Bob; Bob accepts.
    registry.invite(alice.serial, bob.serial);
    registry.accept(bob.serial, alice.serial);
    const aliceParty = registry.partyOf(alice.serial);
    expect(aliceParty.members).toContain(bob.serial);

    // Now Carol invites Bob; Bob accepts. Bob must leave Alice's party.
    registry.invite(carol.serial, bob.serial);
    registry.accept(bob.serial, carol.serial);

    const carolParty = registry.partyOf(carol.serial);
    expect(carolParty.members).toContain(bob.serial);
    // Alice's party should no longer list Bob (or is disbanded).
    const aliceStill = registry.partyOf(alice.serial);
    if (aliceStill) {
      expect(aliceStill.members).not.toContain(bob.serial);
    }
    // Bob's _party points to Carol's party.
    expect(bob._party).toBe(carolParty);
  });

  it('decline notifies the leader so they know to re-invite', () => {
    registry.invite(alice.serial, bob.serial);
    received.get(alice.serial).length = 0;
    registry.decline(bob.serial, alice.serial);
    const aliceLog = received.get(alice.serial);
    const declineMsg = aliceLog.find((s) => /declined/i.test(s));
    expect(declineMsg).toBeTruthy();
    expect(declineMsg).toContain('Bob');
  });

  it('accept is idempotent — second accept doesn\'t duplicate the joiner', () => {
    registry.invite(alice.serial, bob.serial);
    registry.accept(bob.serial, alice.serial);
    // Pending was cleared by accept; second accept must not re-add bob.
    registry.accept(bob.serial, alice.serial);
    const party = registry.partyOf(alice.serial);
    const bobCount = party.members.filter((s) => s === bob.serial).length;
    expect(bobCount).toBe(1);
  });

  it('stores and clears the self CanLoot flag', () => {
    registry.invite(alice.serial, bob.serial);
    registry.accept(bob.serial, alice.serial);
    const party = registry.partyOf(alice.serial);

    expect(registry.setCanLoot(alice.serial, true)).toBe(true);
    expect(party.canLoot.get(alice.serial)).toBe(true);

    expect(registry.setCanLoot(alice.serial, false)).toBe(true);
    expect(party.canLoot.get(alice.serial)).toBe(false);

    registry.leave(alice.serial);
    expect(party.canLoot.has(alice.serial)).toBe(false);
  });
});
