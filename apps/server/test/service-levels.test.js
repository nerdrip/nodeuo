import { describe, expect, it } from 'vitest';
import { RollingServiceMetric, ServiceLevelRegistry } from '../src/systems/service-levels.js';

describe('rolling service levels', () => {
  it('keeps a bounded time window and reports exact percentiles', () => {
    const metric = new RollingServiceMetric('tick', {
      unit: 'ms', target: 20, critical: 60, objective: 0.9, windowMs: 1_000,
    }, { maxSamples: 64 });
    for (let i = 1; i <= 100; i++) metric.observe(i, i * 10);

    const snapshot = metric.snapshot(1_000);
    expect(snapshot.samples).toBe(64);
    expect(snapshot).toMatchObject({ p50: 68, p95: 97, p99: 100, max: 100, status: 'critical' });
    expect(snapshot.totalObservations).toBe(100);
    expect(snapshot.burnRate).toBeGreaterThan(1);

    expect(metric.snapshot(3_000).samples).toBe(0);
  });

  it('calculates error-budget burn without retaining invalid samples', () => {
    const metric = new RollingServiceMetric('packet', {
      unit: 'ms', target: 10, critical: 100, objective: 0.9, windowMs: 60_000,
    });
    for (let i = 0; i < 90; i++) metric.observe(5, 1_000 + i);
    for (let i = 0; i < 10; i++) metric.observe(20, 2_000 + i);
    expect(metric.observe(Number.NaN)).toBe(false);
    const snapshot = metric.snapshot(3_000);
    expect(snapshot).toMatchObject({ samples: 100, violations: 10, violationRate: 0.1, burnRate: 1 });
    expect(snapshot.errorBudgetRemaining).toBe(0);
    expect(snapshot.rejectedObservations).toBe(1);
  });

  it('reconfigures known policies and returns the worst aggregate state', () => {
    const registry = new ServiceLevelRegistry({
      fast: { target: 10, critical: 50, objective: 0.9, windowMs: 60_000 },
      slow: { target: 100, critical: 500, objective: 0.9, windowMs: 60_000 },
    }, { maxSamples: 64 });
    registry.configure({ fast: { target: 5, critical: 20, objective: 0.95 } });
    for (let i = 0; i < 10; i++) {
      registry.observe('fast', 25, 1_000 + i);
      registry.observe('slow', 10, 1_000 + i);
    }
    const snapshot = registry.snapshot(2_000);
    expect(snapshot.status).toBe('critical');
    expect(snapshot.metrics.fast).toMatchObject({ target: 5, critical: 20, objective: 0.95 });
    expect(snapshot.metrics.slow.status).toBe('healthy');
    expect(registry.pressure()).toBe('critical');
    expect(registry.observe('missing', 1)).toBe(false);
  });

  it('reads current pressure without building a percentile snapshot', () => {
    const metric = new RollingServiceMetric('loop', {
      target: 10, critical: 30, objective: 0.99, windowMs: 60_000,
    });
    expect(metric.pressure()).toBe('warming');
    metric.observe(12, 1_000);
    expect(metric.pressure()).toBe('degraded');
    metric.observe(31, 2_000);
    expect(metric.pressure()).toBe('critical');
    metric.observe(5, 3_000);
    expect(metric.pressure()).toBe('healthy');
  });
});
