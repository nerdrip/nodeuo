import { expect, it } from 'vitest';
import { ProtocolCostTracker } from '../src/systems/protocol-costs.js';
import { GlobalTrafficGovernor } from '../src/systems/global-traffic-governor.js';

it('protocol costs stay feature-scoped and retain bounded time history', () => {
  const tracker = new ProtocolCostTracker({ bucketMs: 1000, historyBuckets: 6 });
  tracker.record('world.delta', 'inbound', { bytes: 10, ms: 2, now: 1000 });
  tracker.record('world.delta', 'outbound', { bytes: 20, ms: 3, outcome: 'dropped', now: 2001 });
  const snapshot = tracker.snapshot({ historyLimit: 6 });
  expect(snapshot.features[0].bytesIn).toBe(10);
  expect(snapshot.features[0].bytesOut).toBe(20);
  expect(snapshot.features[0].dropped).toBe(1);
  expect(snapshot.history.length).toBeLessThanOrEqual(6);
});

it('global traffic governor reserves critical traffic and sheds loss-tolerant work', () => {
  const governor = new GlobalTrafficGovernor({ bytesPerSecond: 64 * 1024, burstSeconds: 1 });
  expect(governor.admit('a', 64 * 1024, { trafficClass: 'state' })).toBe('allow');
  expect(governor.admit('b', 1024, { trafficClass: 'state', delivery: 'loss-tolerant' })).toBe('drop');
  expect(governor.admit('b', 1024, { trafficClass: 'critical' })).toBe('allow');
});
