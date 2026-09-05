import { describe, expect, it } from 'vitest';
import { SimulationReplayRecorder } from '../src/systems/simulation-replay.js';

describe('SimulationReplayRecorder', () => {
  it('captures ordered ticks, inputs, decisions and stable checkpoints', () => {
    const replay = new SimulationReplayRecorder({ capacity: 256, enabled: true, captureInputs: true });
    expect(replay.beginTick('ai', 100)).toBe(1);
    replay.input({ id: 7 }, Uint8Array.from([0x02, 1, 2]));
    replay.decision('ai', 10, 'target', { serial: 20, token: 'hidden' });
    replay.checkpoint('mob:10', { x: 4, y: 5 });
    const trace = replay.exportTrace();
    expect(trace.entries.map((entry) => entry.type)).toEqual(['tick', 'input', 'decision', 'checkpoint']);
    expect(trace.entries[1]).toMatchObject({ payload: 'AgEC', sessionId: '7' });
    expect(trace.entries[2].data.token).toBe('[REDACTED]');
    expect(trace.fingerprint).toMatch(/^fnv1a64:/);
  });

  it('never captures login payloads even in explicit input mode', () => {
    const replay = new SimulationReplayRecorder({ enabled: true, captureInputs: true });
    replay.input({ id: 1 }, Uint8Array.from([0x80, 1, 2, 3]));
    expect(replay.rows(1)[0]).toMatchObject({ opcode: 0x80, redacted: true });
    expect(replay.rows(1)[0]).not.toHaveProperty('payload');
  });
});
