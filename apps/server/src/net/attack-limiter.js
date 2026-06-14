// AccountAttackLimiter — rate-limit auth packets per source.
//
// Port of ServUO `Scripts/Accounting/AccountAttackLimiter.cs`. The C#
// version tracks failed `0x80 AccountLogin` and `0x91 GameLogin` attempts
// per IP and inserts an artificial delay before processing the next one,
// scaling the delay up to ~15s after 7 failed attempts in 60s. We do the
// same idea adapted to JS: a per-key sliding bucket of timestamps. New
// attempts past the threshold get the `LoginThrottle` rejection so the
// login screen stays responsive (no socket close).
//
// Buckets are weak — empty entries are evicted on access. Consumers call
// `recordFailure(key)` after a credential mismatch / bad authKey and
// `recordSuccess(key)` to clear the streak when the player makes it past
// the gate. `shouldThrottle(key)` returns null when the request is OK,
// or { delayMs, attempts } when the caller should reject + delay.

const MAX_TRACK_MS = 60_000;       // forget attempts older than this
const FREE_ATTEMPTS = 3;           // first 3 attempts have zero delay
const THROTTLE_STEP_MS = 1_000;    // each subsequent attempt adds 1s
const MAX_THROTTLE_MS = 15_000;    // capped so sysadmin clients can recover

/** @typedef {{ts: number[]}} Bucket */

export class AccountAttackLimiter {
  constructor() {
    /** @type {Map<string, Bucket>} */
    this._buckets = new Map();
    // Periodic GC — bug-hunt 2026-05-12 A6. Without this, an attacker
    // generating 1M random IPs in X-Forwarded-For (or TCP source on
    // proxied shards) could leave 1M timestamp-array entries in the
    // map forever (evict-on-access never runs for keys nobody queries
    // a second time). Cheap walk every 5 min: any bucket whose live
    // window is empty gets deleted.
    this._gcTimer = setInterval(() => this._gc(), 5 * 60 * 1000);
    if (typeof this._gcTimer.unref === 'function') this._gcTimer.unref();
  }

  /** Drop any bucket whose live timestamp window has aged out. */
  _gc() {
    const cutoff = Date.now() - MAX_TRACK_MS;
    for (const [key, b] of this._buckets) {
      while (b.ts.length && b.ts[0] < cutoff) b.ts.shift();
      if (b.ts.length === 0) this._buckets.delete(key);
    }
  }
  /** Shutdown hook for tests / clean restart. */
  stop() {
    if (this._gcTimer) { clearInterval(this._gcTimer); this._gcTimer = null; }
  }

  /**
   * Returns null if the request should proceed, else a throttle directive.
   * Caller is responsible for sending the delayed reject + closing.
   * @param {string} key  ip / accountName / composite
   * @returns {{delayMs:number, attempts:number}|null}
   */
  shouldThrottle(key) {
    const b = this._touch(key);
    // `fails` = failures already recorded in the live window. The next
    // attempt about to be made is the (fails+1)-th; we throttle once the
    // streak meets/exceeds FREE_ATTEMPTS (so attempt #4 is the first one
    // that pays a delay).
    const fails = b.ts.length;
    if (fails < FREE_ATTEMPTS) return null;
    const overflow = fails - FREE_ATTEMPTS + 1;
    const delayMs = Math.min(MAX_THROTTLE_MS, overflow * THROTTLE_STEP_MS);
    return { delayMs, attempts: fails };
  }

  /** Record a failed auth attempt against this key. */
  recordFailure(key) {
    const b = this._touch(key);
    b.ts.push(Date.now());
  }

  /** Clear streak — called when the user successfully logs in. */
  recordSuccess(key) {
    this._buckets.delete(key);
  }

  /** Total live (unforgotten) failures for this key. */
  failureCount(key) {
    const b = this._buckets.get(key);
    if (!b) return 0;
    this._evict(b);
    if (b.ts.length === 0) {
      this._buckets.delete(key);
      return 0;
    }
    return b.ts.length;
  }

  _touch(key) {
    let b = this._buckets.get(key);
    if (!b) { b = { ts: [] }; this._buckets.set(key, b); }
    this._evict(b);
    return b;
  }

  _evict(b) {
    const cutoff = Date.now() - MAX_TRACK_MS;
    while (b.ts.length && b.ts[0] < cutoff) b.ts.shift();
  }
}

export const attackLimiter = new AccountAttackLimiter();
