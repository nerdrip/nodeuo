// PHASE CX — virtue accrual + bugfix #66 regression: resurrectMobile
// must include the player's worn equipment in the broadcast so other
// observers see them dressed, not naked.

import { describe, it, expect, beforeEach } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import { killMobile, resurrectMobile } from '../src/corpse.js';
import {
  awardVirtue, valorForKill, rankAt, VIRTUES, pushVirtues,
} from '../src/systems/rewards/virtues.js';

describe('virtues system (PHASE CX)', () => {
  it('awardVirtue mutates mob.virtues + caps at 20000', () => {
    const mob = {};
    awardVirtue(mob, 'compassion', 1500);
    expect(mob.virtues.compassion).toBe(1500);
    awardVirtue(mob, 'compassion', 100000);
    expect(mob.virtues.compassion).toBe(20000);    // capped
  });

  it('rankAt picks the highest threshold met', () => {
    expect(rankAt(0)).toBeNull();
    expect(rankAt(4000)?.name).toBe('Follower');
    expect(rankAt(10000)?.name).toBe('Seeker');
    expect(rankAt(19999)?.name).toBe('Seeker');
    expect(rankAt(20000)?.name).toBe('Knight');
  });

  it('VIRTUES exports 8 canonical virtues', () => {
    expect(VIRTUES.length).toBe(8);
    expect(VIRTUES).toContain('compassion');
    expect(VIRTUES).toContain('valor');
    expect(VIRTUES).toContain('honor');
  });

  it('valorForKill uses HP fallback when no explicit value', () => {
    expect(valorForKill({ hp: 30 })).toBe(0);
    expect(valorForKill({ hp: 100 })).toBe(10);
    expect(valorForKill({ hp: 250 })).toBe(50);
    expect(valorForKill({ hp: 600 })).toBe(200);
    expect(valorForKill({ hp: 2000 })).toBe(1500);
    expect(valorForKill({ valor: 999 })).toBe(999); // explicit override wins
  });

  it('rejects unknown virtue keys silently (no state change)', () => {
    const mob = {};
    awardVirtue(mob, 'wisdom', 100);
    expect(mob.virtues).toBeUndefined();
  });

  it('pushVirtues sends a typed JSON snapshot to an enhanced client', () => {
    const sent = [];
    const mob = {
      client: { nodeUOJsonTransport: true, nodeUOFeatures: new Map([['character.virtues', 1]]),
        sendNodeUOMessage: (message) => { sent.push(message); return true; }, supportsNodeUO: () => true },
      virtues: { compassion: 4500, valor: 1000 },
    };
    pushVirtues(mob);
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ feature: 'character.virtues',
      payload: { compassion: 4500, valor: 1000 } });
  });

  it('pushVirtues is a no-op on NPCs without a client', () => {
    expect(() => pushVirtues({ virtues: { valor: 100 } })).not.toThrow();
  });

  it('does not send private virtue state to a classic UO client', () => {
    const sent = [];
    pushVirtues({
      client: { send: (b) => sent.push(b), supportsNodeUO: () => false },
      virtues: { valor: 5000 },
    });
    expect(sent).toEqual([]);
  });

  it('awardVirtue auto-pushes the new state to the client', () => {
    const sent = [];
    const mob = {
      client: {
        nodeUOJsonTransport: true, nodeUOFeatures: new Map([['character.virtues', 1]]),
        sendNodeUOMessage: (message) => { sent.push(message); return true; },
        sendSystemMessage: () => {}, supportsNodeUO: () => true,
      },
    };
    awardVirtue(mob, 'compassion', 5000);
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ feature: 'character.virtues', payload: { compassion: 5000 } });
  });
});

describe('killMobile awards Valor virtue (PHASE CX)', () => {
  /** @type {World} */ let w;

  beforeEach(() => {
    w = new World();
  });

  it('awards Valor to player killer of a high-HP creature', () => {
    const player = w.createMobile({ name: 'hero', body: 0x190, x: 10, y: 10, z: 0, map: 1 });
    player.client = { send: () => {}, sendSystemMessage: () => {} };
    const dragon = w.createMobile({
      name: 'a dragon', body: 0x0C, x: 11, y: 10, z: 0, map: 1, hp: 600, hpMax: 600, kind: 'dragon',
    });
    // No monsters getter wired — falls back to HP-based valor (200 at 600 hp).
    killMobile(w, dragon, player);
    expect(player.virtues?.valor).toBeGreaterThan(0);
  });

  it('does NOT award Valor for killing another player', () => {
    const a = w.createMobile({ name: 'a', body: 0x190, x: 0, y: 0, z: 0, map: 1, hp: 50, hpMax: 50 });
    const b = w.createMobile({ name: 'b', body: 0x190, x: 1, y: 0, z: 0, map: 1, hp: 50, hpMax: 50 });
    a.client = { send: () => {}, sendSystemMessage: () => {} };
    b.client = { send: () => {}, sendSystemMessage: () => {} };
    killMobile(w, b, a);
    expect(a.virtues?.valor).toBeFalsy();
  });
});

describe('BUGFIX #66 — resurrectMobile broadcasts worn equipment', () => {
  it('mobileIncoming after resurrect contains worn items, not empty', () => {
    const w = new World();
    const player = w.createMobile({
      name: 'hero', body: 0x190, x: 10, y: 10, z: 0, map: 1,
      hp: 50, hpMax: 50,
    });
    const observerSent = [];
    player.client = { send: () => {}, sendSystemMessage: () => {} };
    const observer = w.createMobile({
      name: 'witness', body: 0x190, x: 12, y: 10, z: 0, map: 1,
    });
    observer.client = { send: (b) => observerSent.push(b) };

    // Simulate "ghost player about to be revived with gear still on" —
    // we skip killMobile (which moves equipment to the corpse) and
    // flag ghost manually so the resurrect path's broadcast can be
    // exercised in isolation. The bug's PR text describes it as
    // "naked observer view AFTER res": that happens in shrines that
    // re-equip post-revive, which the broadcast must include.
    createItem(w, {
      itemId: 0x0A12, x: 0, y: 0, z: 0, map: 1,
      parent: player.serial, layer: 1,
    });
    player.ghost = true;
    player.body = 0x192;        // male ghost
    player.hp = 0;
    observerSent.length = 0;
    resurrectMobile(w, player);

    const incoming = observerSent.find((b) => b[0] === 0x78);
    expect(incoming).toBeTruthy();
    // Empty-equipment 0x78 is 23 bytes (header + 4-byte zero terminator).
    // One piece of equipment adds ≥7 bytes. Anything > 25 = gear shipped.
    expect(incoming.length).toBeGreaterThan(25);
  });
});
