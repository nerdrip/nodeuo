// AuthKeyRegistry — short-lived (30 second TTL) one-time auth keys issued by
// 0x8C PlayServerAck and consumed by 0x91 GameLogin.

export class AuthKeyRegistry {
  constructor(ttlMs = 30_000) {
    /** @type {Map<number, { account: string, expires: number }>} */
    this.byKey = new Map();
    this.ttlMs = ttlMs;
  }

  issue(account) {
    const key = (Math.random() * 0xFFFFFFFF) >>> 0;
    this.byKey.set(key, { account, expires: Date.now() + this.ttlMs });
    return key;
  }

  /**
   * Consume a key. Returns the account on success, null on miss/expiry.
   * @param {number} key
   */
  consume(key) {
    const entry = this.byKey.get(key);
    if (!entry) return null;
    this.byKey.delete(key);
    if (entry.expires < Date.now()) return null;
    return entry.account;
  }

  sweep() {
    const now = Date.now();
    for (const [k, v] of this.byKey) {
      if (v.expires < now) this.byKey.delete(k);
    }
  }
}
