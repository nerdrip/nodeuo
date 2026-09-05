import os from 'node:os';
import { AsyncResource } from 'node:async_hooks';
import { Worker } from 'node:worker_threads';

function abortError(reason = 'worker task cancelled') {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  error.name = 'AbortError';
  return error;
}

/** Bounded reusable worker pool. Jobs use `{ id, payload }` messages and
 * workers reply with `{ id, ok, result|error }`. A timed-out job recycles its
 * worker so CPU work cannot continue invisibly after cancellation. */
export class WorkerTaskPool {
  constructor(workerUrl, {
    size = Math.max(1, Math.min(4, os.availableParallelism?.() ?? os.cpus().length - 1)),
    maxQueue = 128,
    defaultTimeoutMs = 15_000,
    name = 'worker',
  } = {}) {
    this.workerUrl = workerUrl;
    this.size = Math.max(1, Math.min(16, size | 0));
    this.maxQueue = Math.max(this.size, maxQueue | 0);
    this.defaultTimeoutMs = Math.max(250, Math.min(120_000, defaultTimeoutMs | 0));
    this.name = String(name).slice(0, 48);
    this.queue = [];
    this.queueHead = 0;
    this.slots = new Set();
    this.nextId = 0;
    this.closed = false;
    this.stats = { submitted: 0, completed: 0, failed: 0, cancelled: 0,
      timedOut: 0, rejected: 0, workerRestarts: 0, maxQueued: 0 };
  }

  _spawn() {
    if (this.closed) return null;
    const worker = new Worker(this.workerUrl);
    worker.unref?.();
    const slot = { worker, job: null, retiring: false };
    this.slots.add(slot);
    worker.on('message', (message) => {
      if (!slot.job || String(message?.id) !== slot.job.id) return;
      // Workers may publish cheap, structured progress snapshots before the
      // terminal response. Keeping this in the pool avoids one-off worker
      // protocols in admin features and lets callers expose cancellation and
      // progress without moving CPU/IO work back onto the shard event loop.
      if (message?.progress != null && message?.ok == null) {
        try { slot.job.onProgress?.(message.progress); } catch { /* observer */ }
        return;
      }
      const job = slot.job;
      slot.job = null;
      this._finish(job, message?.ok ? null : Object.assign(
        new Error(message?.error ?? `${this.name} task failed`),
        { code: message?.code, before: message?.before },
      ), message?.result);
      this._drain();
    });
    worker.on('error', (error) => this._retire(slot, error));
    worker.on('exit', (code) => {
      if (!slot.retiring) this._retire(slot, new Error(`${this.name} worker exited with code ${code}`));
      else this.slots.delete(slot);
    });
    return slot;
  }

  _finish(job, error, result) {
    clearTimeout(job.timer);
    job.signal?.removeEventListener?.('abort', job.onAbort);
    if (job.settled) return;
    job.settled = true;
    if (error) {
      this.stats.failed++;
      job.resource.runInAsyncScope(job.reject, null, error);
    } else {
      this.stats.completed++;
      job.resource.runInAsyncScope(job.resolve, null, result);
    }
    job.resource.emitDestroy();
  }

  _retire(slot, error) {
    if (slot.retiring) return;
    slot.retiring = true;
    this.slots.delete(slot);
    if (slot.job) {
      const job = slot.job; slot.job = null;
      this._finish(job, error ?? new Error(`${this.name} worker stopped`));
    }
    this.stats.workerRestarts++;
    slot.worker.terminate().catch(() => {});
    this._drain();
  }

  _drain() {
    if (this.closed) return;
    while (this.queueHead < this.queue.length) {
      let slot = [...this.slots].find((entry) => !entry.job && !entry.retiring);
      if (!slot && this.slots.size < this.size) slot = this._spawn();
      if (!slot) break;
      const job = this.queue[this.queueHead++];
      if (job.settled) continue;
      slot.job = job;
      job.slot = slot;
      try { slot.worker.postMessage({ id: job.id, payload: job.payload }); }
      catch (error) { this._retire(slot, error); }
    }
    if (this.queueHead >= this.queue.length) {
      this.queue.length = 0;
      this.queueHead = 0;
    } else if (this.queueHead >= 256 && this.queueHead * 2 >= this.queue.length) {
      this.queue = this.queue.slice(this.queueHead);
      this.queueHead = 0;
    }
  }

  run(payload, { timeoutMs = this.defaultTimeoutMs, signal, onProgress } = {}) {
    if (this.closed) return Promise.reject(new Error(`${this.name} pool is closed`));
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    if (this.queue.length - this.queueHead >= this.maxQueue) {
      this.stats.rejected++;
      const error = new Error(`${this.name} worker queue is full`);
      error.code = 'OVERLOADED';
      return Promise.reject(error);
    }
    this.stats.submitted++;
    return new Promise((resolve, reject) => {
      const id = `${this.name}.${++this.nextId}`;
      const job = { id, payload, resolve, reject, signal, onProgress, timer: null, slot: null, settled: false,
        resource: new AsyncResource(`NodeUOWorkerTask:${this.name}`) };
      const cancel = (reason, timedOut = false) => {
        if (job.settled) return;
        if (timedOut) this.stats.timedOut++;
        else this.stats.cancelled++;
        const slot = job.slot;
        this._finish(job, abortError(reason));
        if (slot) this._retire(slot);
      };
      job.onAbort = () => cancel(signal.reason ?? 'worker task cancelled');
      signal?.addEventListener?.('abort', job.onAbort, { once: true });
      job.timer = setTimeout(() => cancel(`${this.name} task timed out`, true),
        Math.max(250, Math.min(120_000, Number(timeoutMs) | 0 || this.defaultTimeoutMs)));
      job.timer.unref?.();
      this.queue.push(job);
      this.stats.maxQueued = Math.max(this.stats.maxQueued, this.queue.length - this.queueHead);
      this._drain();
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.queue.slice(this.queueHead)) this._finish(job, abortError('worker pool closed'));
    this.queue.length = 0;
    this.queueHead = 0;
    const workers = [...this.slots];
    this.slots.clear();
    await Promise.allSettled(workers.map((slot) => {
      slot.retiring = true;
      if (slot.job) this._finish(slot.job, abortError('worker pool closed'));
      return slot.worker.terminate();
    }));
  }

  snapshot() {
    return { name: this.name, size: this.size, workers: this.slots.size,
      busy: [...this.slots].filter((slot) => !!slot.job).length,
      queued: this.queue.length - this.queueHead, maxQueue: this.maxQueue, ...this.stats };
  }
}
