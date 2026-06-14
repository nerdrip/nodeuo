// FAZA CM — bugfix #55: combat.damage must broadcast 0xA1 healthUpdate
// to nearby observers, not just to the victim. Without this, overhead
// health bars and dragged-out status bars on other players' screens
// stayed stale until the next mobileMoving packet (which doesn't
// carry HP), giving "ghost full bar on dying mob" visuals.

import { describe, it, expect, beforeEach } from 'vitest';
import { combat, buildScriptCombatApi } from '../src/net/handlers.js';
import { World } from '../src/world/world.js';

describe('combat.damage broadcast (bugfix #55)', () => {
  /** @type {World} */ let world;
  /** @type {any} */ let victim;
  /** @type {any} */ let attacker;
  /** @type {any[]} */ let viewerSent;
  /** @type {any[]} */ let victimSent;

  beforeEach(() => {
    world = new World();
    victim = world.createMobile({
      name: 'Victim', body: 0x0190, x: 100, y: 100, z: 0, map: 1,
      hp: 80, hpMax: 100,
    });
    victim.client = { send: (b) => victimSent.push(b) };
    attacker = world.createMobile({
      name: 'Attacker', body: 0x0190, x: 101, y: 100, z: 0, map: 1,
    });
    victimSent = [];
    viewerSent = [];
    const viewer = world.createMobile({
      name: 'Witness', body: 0x0190, x: 102, y: 100, z: 0, map: 1,
    });
    viewer.client = { send: (b) => viewerSent.push(b) };
  });

  it('sends 0x0B damage AND 0xA1 healthUpdate to nearby observers', () => {
    combat.damage(world, victim, 15);
    // Observer should receive both packets.
    const damageOpcodes = viewerSent.map((b) => b[0]);
    expect(damageOpcodes).toContain(0x0B);
    expect(damageOpcodes).toContain(0xA1);
    // Victim still receives the healthUpdate too (their own HUD).
    const victimOpcodes = victimSent.map((b) => b[0]);
    expect(victimOpcodes).toContain(0xA1);
  });

  it('the broadcast healthUpdate carries the post-damage HP', () => {
    combat.damage(world, victim, 30);
    const hpPacket = viewerSent.find((b) => b[0] === 0xA1);
    expect(hpPacket).toBeTruthy();
    // 0xA1: op(1) + serial(4) + max(2) + cur(2)
    const max = (hpPacket[5] << 8) | hpPacket[6];
    const cur = (hpPacket[7] << 8) | hpPacket[8];
    expect(max).toBe(100);
    expect(cur).toBe(50);    // 80 - 30
  });

  it('accepts options-object attacker and preserves damage type metadata', () => {
    const events = [];
    world.events.on('combat:damage', (payload) => events.push(payload));

    combat.damage(world, victim, 10, {
      attacker,
      damageType: { fire: 100 },
    });

    expect(victim.hp).toBe(70);
    expect(victim.damageEntries?.[0]?.attackerSerial).toBe(attacker.serial >>> 0);
    expect(victim._lastDamageType).toEqual({ fire: 100 });
    expect(victim._lastDamageTypeName).toBe('fire');
    expect(events[0]).toMatchObject({
      victim,
      attacker,
      amount: 10,
      damageTypeName: 'fire',
    });
  });

  it('accepts object-form damage specs used by script commands', () => {
    combat.damage(world, {
      source: attacker,
      target: victim,
      amount: 20,
      type: 'phys',
    });

    expect(victim.hp).toBe(60);
    expect(victim.damageEntries?.[0]?.attackerSerial).toBe(attacker.serial >>> 0);
    expect(victim._lastDamageTypeName).toBe('physical');
  });

  it('script combat wrapper supplies the default world for shorthand calls', () => {
    const apiCombat = buildScriptCombatApi(world, combat);

    apiCombat.damage(victim, 7, {
      source: attacker,
      damageType: { energy: 100 },
    });

    expect(victim.hp).toBe(73);
    expect(victim.damageEntries?.[0]?.attackerSerial).toBe(attacker.serial >>> 0);
    expect(victim._lastDamageTypeName).toBe('energy');
  });

  it('knocks mounted players off their mount when damage drops them below 20% HP', () => {
    const pet = world.createMobile({
      name: 'Horse', body: 0x00C8, x: 99, y: 100, z: 0, map: 1,
    });
    pet.mounted = true;
    victim.body = 0x00E2;
    victim.mountedFrom = pet.serial;
    victim.mountedOriginalBody = 0x0190;
    victim.hp = 30;

    combat.damage(world, victim, 15, attacker);

    expect(victim.hp).toBe(15);
    expect(victim.body).toBe(0x0190);
    expect(victim.mountedFrom).toBeUndefined();
    expect(victim._dismountedUntil).toBeGreaterThan(Date.now());
    expect(pet.mounted).toBeUndefined();
    expect(pet.x).toBe(victim.x);
    expect(pet.y).toBe(victim.y);
    expect(viewerSent.some((b) => b[0] === 0x77)).toBe(true);
  });
});
