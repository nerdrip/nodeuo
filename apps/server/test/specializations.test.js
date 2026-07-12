import { describe, expect, it } from 'vitest';
import {
  allocate, availablePoints, castTimeMs, manaCost, milestonePoints,
  modifyDamage, open, reset, snapshot,
} from '../src/systems/specializations.js';
import { NodeUOCapability, NodeUOSpecializationMessage } from '@uo/protocol';

function skilledMob() {
  return { hp: 100, hpMax: 100, skills: { 26: 100, 41: 100 } };
}

describe('specializations', () => {
  it('earns durable milestone points and enforces prerequisites', () => {
    const mob = skilledMob();
    expect(milestonePoints(mob)).toBe(4);
    expect(allocate(mob, 'battle-precision').ok).toBe(false);
    expect(allocate(mob, 'iron-constitution').ok).toBe(true);
    expect(allocate(mob, 'battle-precision').ok).toBe(true);
    expect(availablePoints(mob)).toBe(2);
  });

  it('applies combat and spell modifiers from server-owned state', () => {
    const attacker = skilledMob();
    const defender = skilledMob();
    allocate(attacker, 'mana-flow');
    allocate(attacker, 'focused-casting');
    allocate(defender, 'iron-constitution');
    expect(manaCost(attacker, 20)).toBe(19);
    expect(castTimeMs(attacker, 1000)).toBe(920);
    expect(modifyDamage(100, attacker, defender)).toBe(96);
  });

  it('resets allocations without revoking earned points', () => {
    const mob = skilledMob();
    allocate(mob, 'pathfinder');
    expect(reset(mob)).toBe(1);
    expect(snapshot(mob).state).toMatchObject({ earned: 4, spent: 0, available: 4, allocations: {} });
  });

  it('never emits the private UI packet without negotiated capability', () => {
    const sent = [];
    const classic = { mobile: skilledMob(), supportsNodeUO: () => false, send: (packet) => sent.push(packet) };
    expect(open(classic, 7)).toBe(false);
    expect(sent).toHaveLength(0);

    const rich = {
      mobile: skilledMob(),
      supportsNodeUO: (cap) => cap === NodeUOCapability.Specializations,
      send: (packet) => sent.push(packet),
    };
    expect(open(rich, 7)).toBe(true);
    expect(sent[0][5]).toBe(NodeUOSpecializationMessage.Open);
  });
});
