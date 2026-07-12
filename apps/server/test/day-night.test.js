import { describe, expect, it, vi } from 'vitest';
import { DayNightCycle } from '../src/day-night.js';

function makeCycle(options = {}) {
  const sent = [];
  const world = { mobiles: new Map([[1, { client: { send: (packet) => sent.push(packet) } }]]) };
  const cycle = new DayNightCycle(world, { cyclePeriodMs: 24_000, ...options });
  cycle._startedAt = 1_000;
  return { cycle, sent };
}

describe('DayNightCycle', () => {
  it('matches the ServUO day, dawn, dusk and night windows', () => {
    const { cycle } = makeCycle();
    const atHour = (hour) => 1_000 + hour * 1_000;
    expect(cycle.currentLevel(atHour(2))).toBe(12);
    expect(cycle.currentLevel(atHour(4))).toBe(12);
    expect(cycle.currentLevel(atHour(5))).toBe(6);
    expect(cycle.currentLevel(atHour(6))).toBe(0);
    expect(cycle.currentLevel(atHour(21))).toBe(0);
    expect(cycle.currentLevel(atHour(23))).toBe(6);
    expect(cycle.currentPhase(atHour(23))).toBe('dusk');
  });

  it('rotates weather even when rounded light has not changed', () => {
    const { cycle } = makeCycle();
    cycle._lastLevel = cycle.currentLevel();
    cycle._nextWeatherAt = 1;
    const broadcast = vi.fn();
    cycle.setWeatherBroadcaster(broadcast);
    vi.spyOn(Math, 'random').mockReturnValue(0.85);
    cycle.tick();
    expect(cycle.weatherKind).toBe(2);
    expect(cycle.weatherTemperature).toBe(-12);
    expect(broadcast).toHaveBeenCalledWith(2, expect.any(Number), -12);
    vi.restoreAllMocks();
  });

  it('persists manual light and signed weather temperature', () => {
    const { cycle } = makeCycle();
    cycle._forcedLevel = 17;
    cycle.weatherTemperature = -20;
    const restored = makeCycle().cycle;
    restored.deserialize(cycle.serialize());
    expect(restored.currentLevel()).toBe(17);
    expect(restored.weatherTemperature).toBe(-20);
  });
});
