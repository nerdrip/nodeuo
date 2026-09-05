import inspector from 'node:inspector';
import { channel } from 'node:diagnostics_channel';
import { monitorEventLoopDelay, PerformanceObserver, performance } from 'node:perf_hooks';
import { getHeapSpaceStatistics, getHeapStatistics } from 'node:v8';

/** Zero-dependency observability boundary. OpenTelemetry/diagnostics agents can
 * subscribe without the game server importing or configuring a vendor SDK. */
export const runtimeTelemetryChannels = Object.freeze({
  sample: channel('nodeuo.runtime.sample'),
  system: channel('nodeuo.runtime.system'),
  profile: channel('nodeuo.runtime.cpu-profile'),
});

export class BoundedSampleWindow {
  constructor(capacity = 2048) {
    this.capacity = Math.max(32, capacity | 0);
    this.values = new Float64Array(this.capacity);
    this.index = 0;
    this.count = 0;
    this.total = 0;
    this.max = 0;
  }

  observe(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return false;
    const replacing = this.count === this.capacity;
    const previous = replacing ? this.values[this.index] : 0;
    if (replacing) this.total -= previous;
    this.values[this.index] = number;
    this.index = (this.index + 1) % this.capacity;
    this.count = Math.min(this.capacity, this.count + 1);
    this.total += number;
    if (replacing && previous === this.max && number < previous) {
      let nextMax = number;
      for (let i = 0; i < this.count; i++) nextMax = Math.max(nextMax, this.values[i]);
      this.max = nextMax;
    } else this.max = Math.max(this.max, number);
    return true;
  }

  snapshot() {
    const sorted = Array.from(this.values.subarray(0, this.count)).sort((a, b) => a - b);
    const at = (fraction) => sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
      : 0;
    const round = (value) => Number(value.toFixed(3));
    return {
      samples: this.count,
      p50: round(at(.5)), p95: round(at(.95)), p99: round(at(.99)),
      average: round(this.count ? this.total / Math.max(1, this.count) : 0),
      max: round(this.max),
    };
  }
}

function post(session, method, params = {}) {
  return new Promise((resolve, reject) => session.post(method, params,
    (error, result) => error ? reject(error) : resolve(result)));
}

export class RuntimeProfiler {
  constructor({ sampleIntervalMs = 1000, maxSystems = 256 } = {}) {
    this.sampleIntervalMs = Math.max(100, sampleIntervalMs | 0);
    this.maxSystems = Math.max(16, maxSystems | 0);
    this.systems = new Map();
    this.eventLoop = new BoundedSampleWindow(2048);
    this.gc = new BoundedSampleWindow(1024);
    this.utilization = new BoundedSampleWindow(2048);
    this.memory = [];
    this.cpuProfiles = [];
    this.heap = null;
    this._delay = null;
    this._gcObserver = null;
    this._timer = null;
    this._lastElu = performance.eventLoopUtilization();
    this._capturing = null;
    this._lastAutoCaptureAt = 0;
    this.autoCapture = process.env.UO_AUTO_CPU_PROFILE === '1';
    this.autoCaptureP99Ms = Math.max(10, Number(process.env.UO_AUTO_CPU_PROFILE_P99_MS ?? 100));
    this.autoCaptureDurationMs = Math.max(100, Math.min(10_000,
      Number(process.env.UO_AUTO_CPU_PROFILE_DURATION_MS ?? 1000)));
  }

  start(scheduler = null) {
    if (this._timer) return () => this.stop();
    try {
      this._delay = monitorEventLoopDelay({ resolution: 20 });
      this._delay.enable();
    } catch { this._delay = null; }
    try {
      this._gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) this.gc.observe(entry.duration);
      });
      this._gcObserver.observe({ entryTypes: ['gc'] });
    } catch { this._gcObserver = null; }
    const sample = () => this.sample();
    this._timer = scheduler?.every
      ? scheduler.every('runtime-profiler', this.sampleIntervalMs, sample)
      : setInterval(sample, this.sampleIntervalMs);
    this._timer?.unref?.();
    return () => this.stop();
  }

  stop() {
    if (typeof this._timer?.cancel === 'function') this._timer.cancel();
    else if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._delay?.disable?.();
    this._delay = null;
    this._gcObserver?.disconnect?.();
    this._gcObserver = null;
  }

  record(name, durationMs) {
    const key = String(name || 'unknown');
    let samples = this.systems.get(key);
    if (!samples) {
      if (this.systems.size >= this.maxSystems) return false;
      samples = new BoundedSampleWindow(1024);
      this.systems.set(key, samples);
    }
    const observed = samples.observe(durationMs);
    if (observed && runtimeTelemetryChannels.system.hasSubscribers) {
      runtimeTelemetryChannels.system.publish({ name: key, durationMs: Number(durationMs), at: Date.now() });
    }
    return observed;
  }

  sample() {
    if (this._delay) {
      const p99 = Number(this._delay.percentile(99)) / 1e6;
      this.eventLoop.observe(p99);
      this._delay.reset();
    }
    const elu = performance.eventLoopUtilization(this._lastElu);
    this._lastElu = performance.eventLoopUtilization();
    this.utilization.observe(Math.max(0, Math.min(1, elu.utilization)) * 100);
    const usage = process.memoryUsage();
    const heap = getHeapStatistics();
    this.heap = {
      heapSizeLimit: heap.heap_size_limit,
      totalAvailableSize: heap.total_available_size,
      mallocedMemory: heap.malloced_memory,
      peakMallocedMemory: heap.peak_malloced_memory,
      spaces: getHeapSpaceStatistics().map((space) => ({
        name: space.space_name, size: space.space_size,
        used: space.space_used_size, available: space.space_available_size,
      })),
    };
    this.memory.push({
      at: Date.now(), rss: usage.rss, heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal, external: usage.external,
    });
    if (this.memory.length > 300) this.memory.splice(0, this.memory.length - 300);
    const eventLoop = this.eventLoop.snapshot();
    if (runtimeTelemetryChannels.sample.hasSubscribers) runtimeTelemetryChannels.sample.publish({
      at: this.memory.at(-1)?.at ?? Date.now(), eventLoopP99Ms: eventLoop.p99,
      eventLoopUtilizationPercent: Number((Math.max(0, Math.min(1, elu.utilization)) * 100).toFixed(3)),
      gcP99Ms: this.gc.snapshot().p99, rssBytes: usage.rss, heapUsedBytes: usage.heapUsed,
    });
    if (this.autoCapture && eventLoop.samples >= 5 && eventLoop.p99 >= this.autoCaptureP99Ms
        && Date.now() - this._lastAutoCaptureAt >= 5 * 60_000) {
      this._lastAutoCaptureAt = Date.now();
      this.captureCpuProfile({ durationMs: this.autoCaptureDurationMs, reason: 'event-loop-p99' })
        .catch(() => { /* diagnostics must never terminate gameplay */ });
    }
  }

  async captureCpuProfile({ durationMs = 1000, reason = 'manual' } = {}) {
    if (this._capturing) return this._capturing;
    const duration = Math.max(25, Math.min(30_000, Number(durationMs) || 1000));
    this._capturing = (async () => {
      const session = new inspector.Session();
      session.connect();
      const startedAt = Date.now();
      try {
        await post(session, 'Profiler.enable');
        await post(session, 'Profiler.start');
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, duration);
          timer.unref?.();
        });
        const { profile } = await post(session, 'Profiler.stop');
        const row = {
          id: `cpu-${startedAt.toString(36)}`,
          startedAt, durationMs: Date.now() - startedAt,
          reason: String(reason).slice(0, 80), profile,
        };
        this.cpuProfiles.push(row);
        if (this.cpuProfiles.length > 3) this.cpuProfiles.shift();
        if (runtimeTelemetryChannels.profile.hasSubscribers) runtimeTelemetryChannels.profile.publish({
          id: row.id, startedAt: row.startedAt, durationMs: row.durationMs,
          reason: row.reason, nodes: profile?.nodes?.length ?? 0,
        });
        return row;
      } finally {
        try { await post(session, 'Profiler.disable'); } catch { /* already stopped */ }
        session.disconnect();
      }
    })().finally(() => { this._capturing = null; });
    return this._capturing;
  }

  snapshot() {
    const lastMemory = this.memory[this.memory.length - 1] ?? null;
    const firstMemory = this.memory[0] ?? lastMemory;
    const minutes = firstMemory && lastMemory ? Math.max(1 / 60, (lastMemory.at - firstMemory.at) / 60_000) : 1;
    return {
      eventLoop: this.eventLoop.snapshot(),
      eventLoopUtilizationPercent: this.utilization.snapshot(),
      gcPauseMs: this.gc.snapshot(),
      memory: lastMemory ? { ...lastMemory,
        rssSlopeBytesPerMinute: Math.round((lastMemory.rss - firstMemory.rss) / minutes),
        heapSlopeBytesPerMinute: Math.round((lastMemory.heapUsed - firstMemory.heapUsed) / minutes) } : null,
      heap: this.heap,
      systems: [...this.systems].map(([name, samples]) => ({ name, ...samples.snapshot() }))
        .sort((a, b) => b.p99 - a.p99 || b.average - a.average),
      cpuProfiles: this.cpuProfiles.map(({ profile, ...metadata }) => ({
        ...metadata, nodes: profile?.nodes?.length ?? 0,
      })),
      capturing: !!this._capturing,
    };
  }

  profile(id) { return this.cpuProfiles.find((row) => row.id === String(id)) ?? null; }
}

export const runtimeProfiler = new RuntimeProfiler();
