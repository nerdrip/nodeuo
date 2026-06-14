// Walker — client-side anti-cheat token tracking + step queue. Mirrors
// ClassicUO `Game/Managers/WalkerManager.cs`.
//
// What it does (and why we need it):
//   1. Generates a monotonic 1..255 sequence number for every 0x02
//      MovementReq packet. Server uses the sequence to ack (0x22) or
//      reject (0x21). Without rotation, ServUO discards packets it
//      considers replays.
//   2. Maintains a 6-slot FastWalkStack of pseudo-random tokens. Each
//      0x02 consumes the top token; server-side it's compared against
//      the same stack (server seeds it via 0xBF subop 0x01/0x02). Out
//      of sync → server treats us as a speed-hacker.
//   3. Caps in-flight (un-acked) movement packets at MAX_STEP_COUNT=5.
//      Sending more makes the server resync and snap us back.
//   4. Exposes `enqueueStep` so PlayerMobile / mouse-walk can request a
//      walk; the manager handles flow control + token consumption.
//
// Design note: FastWalkStack is filled from server messages
// (`fastwalk:init` / `fastwalk:add`) — see net/handlers.js extended-
// command 0x01 / 0x02. We keep ZEROes initially; ServUO's default
// behaviour accepts a zero token (which is what CUO does too).

import { bus } from '../core/event-bus.js';

const MAX_STEP_COUNT = 5;
const FASTWALK_STACK_SIZE = 6;
// CUO `MovementSpeed.cs` canonical timings. These have to match the
// server's fast-walk gate exactly — too short and ServUO's anti-cheat
// rejects the steps with 0x21; too long and the player feels heavy.
const TURN_DELAY = 80;           // CUO Constants.TURN_DELAY
const WALK_DELAY = 400;          // CUO MovementSpeed.STEP_DELAY_WALK
const RUN_DELAY  = 200;          // CUO MovementSpeed.STEP_DELAY_RUN
// CUO `MovementSpeed.cs:9-12` — mounted players move 2× faster. Without
// these the client throttled mounted runs at 200 ms but the server
// expected 100 ms steps; every burst of mounted movement collided with
// stale `_lastStepAt` and the next 0x22 ack arrived early, triggering
// 0x21 reject thrash. Marcin: "mounted run feels jerky".
const MOUNT_WALK_DELAY = 200;    // CUO MovementSpeed.STEP_DELAY_MOUNT_WALK
const MOUNT_RUN_DELAY  = 100;    // CUO MovementSpeed.STEP_DELAY_MOUNT_RUN

// Per-tile-kind movement multiplier. UO server treats "swimming" as
// 2× walk delay (you can't run in water), CUO mirrors this in
// `MovementSpeed.cs::IsSwimming`. Lava in revamped facets is even
// slower (3×) — we cap at 2.5× to keep the player from rubber-banding.
const TERRAIN_MULT = {
  water: 2.0,
  lava:  2.5,
  swamp: 1.6,
};

export const movementStats = {
  reserved: 0,
  sent: 0,
  acks: 0,
  rejects: 0,
  localBlocks: 0,
  released: 0,
  staleResyncs: 0,
  resyncRequests: 0,
  pending: 0,
  maxPending: 0,
  lastAckLatencyMs: 0,
  avgAckLatencyMs: 0,
  lastRejectSeq: 0,
  lastRejectAt: 0,
  lastStallMs: 0,
  history: new Array(64),
  historyIndex: 0,
};

export function recordMovementTrace(kind, data = null, now = performance.now()) {
  const h = movementStats.history;
  h[movementStats.historyIndex & (h.length - 1)] = data
    ? { t: now, kind, ...data }
    : { t: now, kind };
  movementStats.historyIndex = (movementStats.historyIndex + 1) & 0xffff;
}

class Walker {
  constructor() {
    this._seq = 0;
    this._inFlight = 0;
    this._fastWalk = new Uint32Array(FASTWALK_STACK_SIZE);
    this._fwTop = 0;             // wraps mod FASTWALK_STACK_SIZE
    this._lastStepAt = 0;
    /** Set true when 0x21 reject arrives — caller must replay last
     *  authoritative position before further steps. */
    this.resyncRequested = false;
    bus.on('fastwalk:init', ({ keys }) => {
      // ServUO sends 6 keys at LoginComplete. We accept either an array
      // or a typed view.
      if (!keys) return;
      for (let i = 0; i < FASTWALK_STACK_SIZE && i < keys.length; i++) {
        this._fastWalk[i] = keys[i] >>> 0;
      }
      this._fwTop = 0;
    });
    bus.on('fastwalk:push', ({ key }) => {
      // Server adds one more token after consuming one. ServUO's
      // FastWalkStack pushes into the first empty (zero) slot — match
      // that, otherwise our consume-side LIFO scan finds tokens in a
      // different order than the server's check.
      const k = key >>> 0;
      for (let i = 0; i < FASTWALK_STACK_SIZE; i++) {
        if (this._fastWalk[i] === 0) { this._fastWalk[i] = k; return; }
      }
      // All six slots full — overwrite the oldest tracked slot.
      this._fastWalk[this._fwTop] = k;
      this._fwTop = (this._fwTop + 1) % FASTWALK_STACK_SIZE;
    });
  }

  /** True when the manager is allowed to emit another 0x02. */
  canStep(now = performance.now()) {
    if (this.resyncRequested) return false;
    // Client audit #3 #4 — stalled ack rescue. If any unacked step is
    // older than 3 s the network is wedged; auto-resync rather than
    // hard-blocking input forever. Mirrors `onRej` so the next
    // 0x77 self-update can re-prime `resyncRequested`.
    if (this._inFlight > 0
        && this._inFlightSinceMs
        && (now - this._inFlightSinceMs) > 3000) {
      const stalledFor = now - this._inFlightSinceMs;
      this._inFlight = 0;
      this._inFlightSinceMs = 0;
      this.resyncRequested = true;
      movementStats.staleResyncs++;
      movementStats.resyncRequests++;
      movementStats.lastStallMs = stalledFor;
      movementStats.pending = 0;
      recordMovementTrace('stall-resync', { ageMs: movementStats.lastStallMs | 0 }, now);
      // Throttle the chat-system notice — when the server is wedged
      // (WS dropped, server crashed, every step times out), canStep is
      // called every frame and the resync emit fired on each retry,
      // flooding the journal with hundreds of "Movement desync" lines
      // per minute. Cap to one notice per 10 s so the user sees the
      // signal once instead of a wall of noise.
      if (now - (this._lastDesyncMsgAt | 0) > 10_000) {
        bus.emit('chat:system', { text: 'Movement desync — resyncing.' });
        this._lastDesyncMsgAt = now;
      }
      // Client audit #5 #13 — actually send 0x22 so server re-streams
      // nearby state. Bare _inFlight clear was a half-fix.
      bus.emit('net:resync-request');
      return false;
    }
    if (this._inFlight >= MAX_STEP_COUNT) return false;
    if (now < this._lastStepAt) return false;
    return true;
  }

  /** Reserve the next sequence + fast-walk token for a 0x02.
   *  Returns null if rate-limited; otherwise `{ sequence, fastWalkKey, delayMs }`.
   *
   *  `run` advances the throttle timer faster (matches CUO Mobile.cs:RUN
   *  vs WALK delay table). `directionOnly` (no x/y change, just turn)
   *  uses TURN_DELAY (~100 ms) since the server doesn't path-check turns.
   *  `mounted` halves both walk + run delays — server's fast-walk gate
   *  applies the same multiplier (CUO MovementSpeed.cs). */
  reserve(run = false, directionOnly = false, now = performance.now(), mounted = false, terrain = null) {
    if (!this.canStep(now)) return null;
    // Sequence: rotate 1..255, skip 0 once we've sent the boot packet.
    let seq = (this._seq + 1) & 0xff;
    if (this._seq === 0) seq = 1;       // boot packet was 0; next = 1
    if (seq === 0) seq = 1;             // wrap from 255 → 1 (skip 0)
    this._seq = seq;
    // CUO `WalkerManager.GetValue` semantics: scan the stack and return
    // the first non-zero token, zeroing it on the way out. This is NOT
    // a round-robin — the prior `_fwTop`-cycling implementation drifted
    // out of sync with ServUO's FastWalkStack after the first
    // `fastwalk:push` because server inserts at GetValue's slot, not at
    // the round-robin head.
    let key = 0;
    for (let i = 0; i < FASTWALK_STACK_SIZE; i++) {
      if (this._fastWalk[i] !== 0) {
        key = this._fastWalk[i];
        this._fastWalk[i] = 0;
        break;
      }
    }
    this._inFlight++;
    movementStats.reserved++;
    movementStats.pending = this._inFlight;
    if (this._inFlight > movementStats.maxPending) movementStats.maxPending = this._inFlight;
    // Client audit #3 #4 — track when the oldest unacked step was sent so
    // canStep() can detect a >3 s ack stall and force a self-resync
    // instead of locking the player out indefinitely.
    if (!this._inFlightSinceMs || this._inFlight === 1) {
      this._inFlightSinceMs = now;
    }
    let delayMs;
    if (directionOnly) delayMs = TURN_DELAY;
    else if (mounted)  delayMs = run ? MOUNT_RUN_DELAY : MOUNT_WALK_DELAY;
    else               delayMs = run ? RUN_DELAY      : WALK_DELAY;
    // Terrain multiplier — swimming / lava / swamp slow the player down
    // even when mounted. CUO `MovementSpeed.cs::IsSwimming` does the same.
    if (terrain && !directionOnly) {
      const mult = TERRAIN_MULT[terrain];
      if (mult) delayMs = Math.round(delayMs * mult);
    }
    this._lastStepAt = now + delayMs;
    return { sequence: seq, fastWalkKey: key >>> 0, delayMs };
  }

  /** Roll back a reservation made by `reserve()` when the caller
   *  decided NOT to send the 0x02 (e.g. client-side walkability
   *  caught a wall locally and we want to spare the server-trip).
   *  Decrements `_inFlight` and rewinds `_seq` so the next genuine
   *  step uses the same sequence — the server hasn't seen this
   *  reservation, so reusing the number is safe. */
  releaseToTurn(reservation) {
    if (!reservation) return;
    if (this._inFlight > 0) this._inFlight--;
    if (this._inFlight === 0) this._inFlightSinceMs = 0;
    movementStats.released++;
    movementStats.pending = this._inFlight;
    // Rewind seq so the next reservation reuses this number — server
    // never saw it. Skip the rewind if a fresher reservation already
    // overtook this one (defensive: don't yank the future).
    if (this._seq === (reservation.sequence & 0xff)) {
      this._seq = (this._seq - 1) & 0xff;
      if (this._seq === 0) this._seq = 0;     // 0 sentinel stays 0
    }
    // Put the fast-walk key back at the head of the stack so it's
    // reused on the next real send — otherwise we'd burn tokens
    // every time the player taps W against a wall.
    if (reservation.fastWalkKey) {
      for (let i = 0; i < FASTWALK_STACK_SIZE; i++) {
        if (this._fastWalk[i] === 0) {
          this._fastWalk[i] = reservation.fastWalkKey;
          break;
        }
      }
    }
  }

  /** 0x22 MovementAck — server confirms a previously-sent step. */
  onAck() {
    if (this._inFlight > 0) this._inFlight--;
    if (this._inFlight === 0) this._inFlightSinceMs = 0;
    else this._inFlightSinceMs = performance.now();
    movementStats.acks++;
    movementStats.pending = this._inFlight;
  }

  /** 0x21 MovementRej — server snapped us back. Drain the in-flight
   *  counter, broadcast the snap-back position so GameScene auto-rewinds
   *  the player sprite, and clear queued predicted steps.  CUO does this
   *  in `WalkerManager.RejectMovement` → `Mobile.Position = rejPos`. */
  onRej(rejPayload = null) {
    this._inFlight = 0;
    this._inFlightSinceMs = 0;
    this.resyncRequested = true;
    movementStats.rejects++;
    movementStats.resyncRequests++;
    movementStats.pending = 0;
    movementStats.lastRejectSeq = rejPayload?.sequence | 0;
    movementStats.lastRejectAt = performance.now();
    recordMovementTrace('reject', rejPayload);
    if (rejPayload && typeof rejPayload === 'object') {
      bus.emit('walker:rewind', {
        x: rejPayload.x | 0, y: rejPayload.y | 0, z: rejPayload.z | 0,
        direction: rejPayload.direction & 0x07,
      });
    }
  }

  /** After the caller has applied a server resync, clear the flag so
   *  movement can resume. */
  clearResync() {
    this._inFlight = 0;
    this._inFlightSinceMs = 0;
    this.resyncRequested = false;
    movementStats.pending = 0;
    recordMovementTrace('clear-resync');
  }

  reset() {
    this._seq = 0;
    this._inFlight = 0;
    this._inFlightSinceMs = 0;
    this._fastWalk.fill(0);
    this._fwTop = 0;
    this._lastStepAt = 0;
    this.resyncRequested = false;
    movementStats.pending = 0;
    recordMovementTrace('reset');
  }
}

export const walker = new Walker();

// Bug-hunt #6 client B#14 — walker is a singleton; without an explicit
// reset on disconnect, an in-flight count survives a logout and the
// first 2 keypresses after relog get rate-limited as "stale in-flight
// steps from the previous session". Listen for net:close to clear.
bus.on?.('net:close', () => walker.reset());
