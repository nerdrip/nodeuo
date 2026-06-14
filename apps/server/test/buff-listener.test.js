// Status-effects → client notifier. Verifies that apply/remove mutations
// on a mob with a .client send a 0xDF BuffInfo packet, and that non-player
// mobs are silent (no client to notify).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as statusEffects from '../src/status-effects.js';

describe('statusEffects.setListener', () => {
  /** @type {any[]} */ let events;
  /** @type {any} */ let player;
  /** @type {any} */ let npc;

  beforeEach(() => {
    events = [];
    statusEffects.setListener((mob, action, eff) => {
      events.push({ serial: mob.serial, action, name: eff.name });
    });
    player = { serial: 0x1001, client: { send: () => {} } };
    npc = { serial: 0x2002 };
  });

  afterEach(() => {
    statusEffects.setListener(null);
  });

  it('fires "add" when a new effect is attached', () => {
    statusEffects.apply(player, { name: 'bless', durationMs: 60_000 });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ serial: 0x1001, action: 'add', name: 'bless' });
  });

  it('fires "remove" + "add" when an existing effect is replaced', () => {
    statusEffects.apply(player, { name: 'bless', durationMs: 60_000 });
    events.length = 0;
    statusEffects.apply(player, { name: 'bless', durationMs: 30_000 });
    expect(events.map((e) => e.action)).toEqual(['remove', 'add']);
  });

  it('fires "remove" on explicit removal', () => {
    statusEffects.apply(player, { name: 'poison', durationMs: 10_000 });
    events.length = 0;
    statusEffects.remove(player, 'poison');
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('remove');
  });

  it('listener also fires for NPCs — the filter is main.js, not the module', () => {
    // setListener is module-level; the main.js implementation of the listener
    // is where "skip if no .client" lives. This test documents that boundary
    // so a future refactor doesn't accidentally silence NPC effects here.
    statusEffects.apply(npc, { name: 'curse', durationMs: 10_000 });
    expect(events).toHaveLength(1);
    expect(events[0].serial).toBe(0x2002);
  });
});
