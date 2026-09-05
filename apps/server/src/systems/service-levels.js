// Bounded rolling SLO metrics for the live server. Recording is O(1) and
// allocation-free after construction; percentile sorting only happens when
// an operator asks for a snapshot. This keeps observability off the hot path
// while still exposing p50/p95/p99 and error-budget burn in the admin panel.

export const DEFAULT_SERVICE_LEVEL_POLICIES = Object.freeze({
  eventLoopLag: Object.freeze({ unit: 'ms', target: 50, critical: 150, objective: 0.99, windowMs: 60_000 }),
  tickDuration: Object.freeze({ unit: 'ms', target: 25, critical: 50, objective: 0.99, windowMs: 60_000 }),
  packetHandler: Object.freeze({ unit: 'ms', target: 8, critical: 25, objective: 0.995, windowMs: 60_000 }),
  adminRequest: Object.freeze({ unit: 'ms', target: 250, critical: 1_000, objective: 0.99, windowMs: 60_000 }),
});

const STATUS_RANK = Object.freeze({ warming: 0, healthy: 1, degraded: 2, critical: 3 });

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function normalizePolicy(input = {}, fallback = {}) {
  const target = boundedNumber(input.target, fallback.target ?? 50, 0.01, 60_000);
  const critical = boundedNumber(input.critical, fallback.critical ?? target * 3, target, 120_000);
  return Object.freeze({
    unit: String(input.unit ?? fallback.unit ?? 'ms').slice(0, 16),
    target,
    critical,
    objective: boundedNumber(input.objective, fallback.objective ?? 0.99, 0.5, 0.99999),
    windowMs: boundedNumber(input.windowMs, fallback.windowMs ?? 60_000, 1_000, 15 * 60_000),
  });
}

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

export class RollingServiceMetric {
  constructor(name, policy, { maxSamples = 4096 } = {}) {
    this.name = String(name);
    this.policy = normalizePolicy(policy);
    this.maxSamples = Math.max(64, Math.min(65_536, maxSamples | 0));
    this._values = new Float64Array(this.maxSamples);
    this._times = new Float64Array(this.maxSamples);
    this._head = 0;
    this._count = 0;
    this.totalObservations = 0;
    this.rejectedObservations = 0;
  }

  configure(policy) {
    this.policy = normalizePolicy(policy, this.policy);
    return this.policy;
  }

  observe(value, at = Date.now()) {
    const number = Number(value);
    const timestamp = Number(at);
    if (!Number.isFinite(number) || number < 0 || !Number.isFinite(timestamp)) {
      this.rejectedObservations++;
      return false;
    }
    this._values[this._head] = number;
    this._times[this._head] = timestamp;
    this._head = (this._head + 1) % this.maxSamples;
    this._count = Math.min(this.maxSamples, this._count + 1);
    this.totalObservations++;
    return true;
  }

  pressure() {
    if (!this._count) return 'warming';
    const index = (this._head - 1 + this.maxSamples) % this.maxSamples;
    const value = this._values[index];
    if (value > this.policy.critical) return 'critical';
    if (value > this.policy.target) return 'degraded';
    return 'healthy';
  }

  _windowValues(now) {
    const cutoff = now - this.policy.windowMs;
    const values = [];
    for (let offset = 0; offset < this._count; offset++) {
      const index = (this._head - 1 - offset + this.maxSamples) % this.maxSamples;
      if (this._times[index] < cutoff) break;
      values.push(this._values[index]);
    }
    return values;
  }

  snapshot(now = Date.now()) {
    const values = this._windowValues(Number(now) || Date.now());
    const sorted = values.slice().sort((a, b) => a - b);
    const violations = values.reduce((count, value) => count + (value > this.policy.target ? 1 : 0), 0);
    const criticalViolations = values.reduce((count, value) => count + (value > this.policy.critical ? 1 : 0), 0);
    const violationRate = values.length ? violations / values.length : 0;
    const allowedFailureRate = Math.max(Number.EPSILON, 1 - this.policy.objective);
    const burnRate = violationRate / allowedFailureRate;
    const p50 = percentile(sorted, 0.5);
    const p95 = percentile(sorted, 0.95);
    const p99 = percentile(sorted, 0.99);
    const max = sorted.at(-1) ?? 0;
    let status = 'healthy';
    if (values.length < 8) status = 'warming';
    if (criticalViolations > 0 || p99 > this.policy.critical || burnRate >= 4) status = 'critical';
    else if (p95 > this.policy.target || burnRate > 1) status = 'degraded';
    const round = (value) => Number(value.toFixed(3));
    return {
      name: this.name,
      status,
      unit: this.policy.unit,
      target: this.policy.target,
      critical: this.policy.critical,
      objective: this.policy.objective,
      windowMs: this.policy.windowMs,
      samples: values.length,
      totalObservations: this.totalObservations,
      rejectedObservations: this.rejectedObservations,
      average: round(values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0),
      p50: round(p50), p95: round(p95), p99: round(p99), max: round(max),
      violations,
      criticalViolations,
      violationRate: round(violationRate),
      errorBudgetRemaining: round(Math.max(0, 1 - (violationRate / allowedFailureRate))),
      burnRate: round(burnRate),
    };
  }
}

export class ServiceLevelRegistry {
  constructor(policies = DEFAULT_SERVICE_LEVEL_POLICIES, options = {}) {
    this.metrics = new Map();
    for (const [name, policy] of Object.entries(policies)) {
      this.metrics.set(name, new RollingServiceMetric(name, policy, options));
    }
  }

  configure(policies = {}) {
    for (const [name, policy] of Object.entries(policies)) {
      const metric = this.metrics.get(name);
      if (metric) metric.configure(policy);
    }
    return this.policies();
  }

  policies() {
    return Object.fromEntries([...this.metrics].map(([name, metric]) => [name, { ...metric.policy }]));
  }

  observe(name, value, at) {
    return this.metrics.get(String(name))?.observe(value, at) ?? false;
  }

  pressure() {
    return [...this.metrics.values()].reduce((worst, metric) => {
      const status = metric.pressure();
      return STATUS_RANK[status] > STATUS_RANK[worst] ? status : worst;
    }, 'warming');
  }

  snapshot(now = Date.now()) {
    const metrics = [...this.metrics.values()].map((metric) => metric.snapshot(now));
    const status = metrics.reduce((worst, metric) =>
      STATUS_RANK[metric.status] > STATUS_RANK[worst] ? metric.status : worst, 'warming');
    return {
      status,
      generatedAt: new Date(now).toISOString(),
      metrics: Object.fromEntries(metrics.map((metric) => [metric.name, metric])),
    };
  }
}

export const runtimeServiceLevels = new ServiceLevelRegistry();
