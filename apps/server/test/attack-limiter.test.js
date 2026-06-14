// Tests for AccountAttackLimiter — sliding-window rate-limit.

import { describe, it, expect } from 'vitest';
import { AccountAttackLimiter } from '../src/net/attack-limiter.js';

describe('AccountAttackLimiter', () => {
  it('allows the first 3 attempts without a delay', () => {
    const a = new AccountAttackLimiter();
    expect(a.shouldThrottle('alice')).toBeNull();
    a.recordFailure('alice');
    expect(a.shouldThrottle('alice')).toBeNull();
    a.recordFailure('alice');
    expect(a.shouldThrottle('alice')).toBeNull();
    a.recordFailure('alice');
    // After 3 fails, the 4th attempt is the first to be throttled.
    const t = a.shouldThrottle('alice');
    expect(t).not.toBeNull();
    expect(t.delayMs).toBeGreaterThan(0);
  });

  it('caps delay at MAX_THROTTLE_MS', () => {
    const a = new AccountAttackLimiter();
    for (let i = 0; i < 50; i++) a.recordFailure('alice');
    const t = a.shouldThrottle('alice');
    expect(t).not.toBeNull();
    expect(t.delayMs).toBeLessThanOrEqual(15_000);
  });

  it('clears streak on success', () => {
    const a = new AccountAttackLimiter();
    for (let i = 0; i < 5; i++) a.recordFailure('alice');
    expect(a.shouldThrottle('alice')).not.toBeNull();
    a.recordSuccess('alice');
    expect(a.shouldThrottle('alice')).toBeNull();
    expect(a.failureCount('alice')).toBe(0);
  });

  it('isolates buckets per key (NAT scenario)', () => {
    const a = new AccountAttackLimiter();
    for (let i = 0; i < 5; i++) a.recordFailure('alice|1.2.3.4');
    expect(a.shouldThrottle('alice|1.2.3.4')).not.toBeNull();
    expect(a.shouldThrottle('bob|1.2.3.4')).toBeNull();
  });
});
