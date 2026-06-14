// UseItemQueue — serialised dispatch of 0x06 UseReq packets.
// Mirrors ClassicUO Game/Managers/UseItemQueue.cs.
//
// Why a queue: actions like bandaging a teammate, drinking a heal/cure
// potion, and using a fishing rod each fire 0x06 + a target prompt and
// take ~250 ms to complete on the server. If the user spam-clicks two
// potions, both 0x06 fly off back-to-back — the second wins, the first
// is dropped silently. Queueing flattens this: one in flight, the rest
// waiting on a server ack OR a small fixed cooldown.
//
// API:
//   useItemQueue.enqueue(serial)        — append a use request
//   useItemQueue.cancel()               — drop everything pending
//   useItemQueue.tick(now)              — call once per frame
//
// We pump items off the queue when:
//   - last 0x06 was at least `MIN_DELAY_MS` ago, AND
//   - no target prompt is waiting (targetManager.active === false)
//
// Server may reject the use (item gone, out of range) — we don't need
// special handling; the next item simply tries on its turn.

import { net } from '../net/net-client.js';
import { buildUseReq } from '../net/outgoing.js';
import { targetManager } from './target-manager.js';

const MIN_DELAY_MS = 200;

class UseItemQueue {
  constructor() {
    /** @type {number[]} item serials waiting to be used. */
    this._queue = [];
    this._head = 0;
    this._lastSentAt = 0;
  }

  enqueue(serial) {
    if (!serial) return;
    this._queue.push(serial >>> 0);
  }

  cancel() {
    this._queue.length = 0;
    this._head = 0;
  }

  size() { return Math.max(0, this._queue.length - this._head); }

  _compact() {
    if (this._head <= 0) return;
    if (this._head >= this._queue.length) {
      this._queue.length = 0;
      this._head = 0;
    } else if (this._head > 32 && this._head * 2 > this._queue.length) {
      this._queue.splice(0, this._head);
      this._head = 0;
    }
  }

  tick(now = performance.now()) {
    if (this.size() === 0) { this._compact(); return; }
    // The field is `active` (boolean) — `activePrompt` never existed,
    // so the gate was effectively always falsy and queued use-reqs
    // fired through active target prompts. That stacked phantom 0x6C
    // callbacks on the server, leaving the player with a "live" target
    // cursor whose backend was already cleaned up.
    if (targetManager?.active) return;
    if (now - this._lastSentAt < MIN_DELAY_MS) return;
    const serial = this._queue[this._head++];
    this._compact();
    try { net.send(buildUseReq(serial)); } catch { /* socket closed */ }
    this._lastSentAt = now;
  }
}

export const useItemQueue = new UseItemQueue();
