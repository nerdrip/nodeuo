import { describe, expect, it } from 'vitest';
import { NodeUODelivery } from '@uo/nodeuo-protocol';
import { ConnectionBandwidthBudget } from '../src/net/connection-bandwidth.js';

describe('ConnectionBandwidthBudget', () => {
  it('protects reliable traffic and sheds bounded cosmetic traffic', () => {
    const budget = new ConnectionBandwidthBudget({
      bytesPerSecond: 64 * 1024, burstBytes: 64 * 1024, criticalReserveBytes: 4096,
    });
    const at = performance.now();
    expect(budget.admit(64 * 1024, { trafficClass: 'state', delivery: NodeUODelivery.Latest }, at)).toBe('allow');
    expect(budget.admit(512, { trafficClass: 'cosmetic', delivery: NodeUODelivery.LossTolerant }, at)).toBe('drop');
    expect(budget.admit(512, { trafficClass: 'state', delivery: NodeUODelivery.Latest }, at)).toBe('defer');
    expect(budget.admit(512, { trafficClass: 'critical', delivery: NodeUODelivery.Reliable }, at)).toBe('allow');
    expect(budget.admit(4096, { trafficClass: 'state', delivery: NodeUODelivery.Reliable }, at)).toBe('defer');
    expect(budget.snapshot()).toMatchObject({ droppedBytes: 512, deferredBytes: 4608, borrowedBytes: 512 });
  });

  it('admits an atomic frame larger than the burst only from a full bucket', () => {
    const budget = new ConnectionBandwidthBudget({
      bytesPerSecond: 64 * 1024, burstBytes: 64 * 1024, criticalReserveBytes: 4096,
    });
    const at = performance.now();
    expect(budget.admit(96 * 1024, { trafficClass: 'state', delivery: NodeUODelivery.Reliable }, at))
      .toBe('allow');
    expect(budget.admit(96 * 1024, { trafficClass: 'state', delivery: NodeUODelivery.Reliable }, at))
      .toBe('defer');
  });
});
