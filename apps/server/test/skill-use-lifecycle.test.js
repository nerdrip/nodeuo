import { describe, expect, it, vi } from 'vitest';
import {
  attachSkillTarget,
  beginSkillUse,
  completeSkillUse,
  interruptSkillUse,
  skillUseSnapshot,
} from '../src/systems/skill-use.js';

function state() {
  return {
    mobile: { serial: 1, hp: 50, skills: { 36: 80 } },
    targetCallbacks: new Map(),
    sendSystemMessage: vi.fn(),
  };
}

describe('skill use lifecycle', () => {
  it('enforces availability and the shared anti-spam delay', () => {
    const client = state();
    expect(beginSkillUse(client, 36, 'tame', 1000).ok).toBe(true);
    completeSkillUse(client);
    expect(beginSkillUse(client, 36, 'tame', 1200)).toMatchObject({ ok: false, reason: 'cooldown' });
    expect(beginSkillUse(client, 36, 'tame', 1600).ok).toBe(true);
  });

  it('owns and clears the target cursor when interrupted', () => {
    const client = state();
    const started = beginSkillUse(client, 36, 'tame', 1000);
    const timer = setTimeout(() => {}, 10_000);
    timer.unref?.();
    client.targetCallbacks.set(7, { timer });
    expect(attachSkillTarget(client, 7)).toBe(started.use.id);
    expect(interruptSkillUse(client, 'movement')).toBe(true);
    expect(client.targetCallbacks.has(7)).toBe(false);
    expect(client._activeSkillUse).toBeNull();
  });

  it('publishes non-sensitive aggregate telemetry', () => {
    const rows = skillUseSnapshot(36);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ skillId: 36, attempts: expect.any(Number) }));
    expect(rows[0]).not.toHaveProperty('account');
  });
});
