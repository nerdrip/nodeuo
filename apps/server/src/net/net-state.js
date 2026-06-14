// NetState — per-connection state. Wraps a WebSocket, buffers inbound bytes,
// frames them into UO packets via @uo/protocol, and routes them to handlers.
//
// Outgoing packets are optionally Huffman-compressed (to match ServUO 1:1)
// before being sent as a binary WS frame. See config.huffmanOutgoing.
//
// One NetState may traverse multiple stages:
//   0 "loginSeed"       just connected, waiting for 0xEF seed
//   1 "accountLogin"    seed seen, waiting for 0x80
//   2 "awaitServerPick" server list sent, waiting for 0xA0
//   3 "gameLogin"       relay sent, awaiting fresh 0x91 with auth key
//   4 "charList"        0xA9 sent, awaiting 0x5D/0xF8
//   5 "inWorld"         logged in, accepting gameplay opcodes

import { frameIncoming, opcodeInfo, huffmanCompress, unicodeMessage, worldItemSA, removeEntity } from '@uo/protocol';
import * as chatChannels from '../chat-channels.js';

/** @enum {string} */
export const Stage = Object.freeze({
  LoginSeed: 'loginSeed',
  AccountLogin: 'accountLogin',
  AwaitServerPick: 'awaitServerPick',
  GameLogin: 'gameLogin',
  CharList: 'charList',
  InWorld: 'inWorld',
});

export class NetState {
  /**
   * @param {import('ws').WebSocket} ws
   * @param {object} ctx
   * @param {import('../world/world.js').World} ctx.world
   * @param {import('./auth.js').AuthKeyRegistry} ctx.authKeys
   * @param {import('../config.js').config} ctx.config
   * @param {import('./handlers.js').HandlerTable} ctx.handlers
   * @param {number} ctx.id  connection id (for logging)
   */
  constructor(ws, ctx) {
    this.ws = ws;
    this.ctx = ctx;
    this.id = ctx.id;
    this.stage = Stage.LoginSeed;
    /** Source IP (or `null` for in-process tests). Surfaced to handlers
     *  so AccountAttackLimiter can compose per-IP × per-account keys. */
    this.remoteAddress = ctx.remoteAddress ?? null;
    /** @type {string | null} */
    this.accountName = null;
    /** @type {import('./accounts.js').Account | null} */
    this.account = null;
    /** @type {number} */
    this.seed = 0;
    /** @type {string | null} */
    this.clientVersionString = null;
    /** @type {{ major:number, minor:number, revision:number, patch:number } | null} */
    this.clientVersion = null;
    /** DropReq is 15 bytes for >=6.0.1.7 clients, 14 bytes before that. */
    this.dropReqSize = 15;
    /** @type {import('../world/world.js').Mobile | null} */
    this.mobile = null;
    /** @type {import('../world/items.js').Item | null} */
    this.heldItem = null;
    /** Serials of containers this client currently has open — filters 0x25 updates. @type {Set<number>} */
    this.openContainers = new Set();
    /** @type {Uint8Array} */
    this._rx = new Uint8Array(0);
    this._closed = false;

    ws.binaryType = 'arraybuffer';
    ws.on('message', (data, isBinary) => {
      if (!isBinary && typeof data === 'string') return; // ignore text
      this._feed(new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer, data.byteOffset ?? 0, data.byteLength ?? data.length));
    });
    ws.on('close', (code, reason) => {
      // Capture WHY the WS closed. RFC 6455 close codes:
      //   1000 normal      1001 going-away   1002 protocol-error
      //   1006 abnormal    1008 policy-vio   1011 server-error
      // `1006` (abnormal closure) is the typical browser-side timeout
      // / network drop — user closed tab, OS suspended, ISP flap, etc.
      // Reason is a Buffer; toString gives any server-supplied detail.
      const reasonStr = reason && reason.length > 0
        ? (typeof reason === 'string' ? reason : reason.toString('utf8'))
        : '(none)';
      console.log(`[net#${this.id}] ws close code=${code} reason=${reasonStr}`);
      this._onClose();
    });
    ws.on('error', (err) => {
      // Always log WS errors — these point at protocol corruption,
      // payload-too-large, or socket-level failures that precede a close.
      console.warn(`[net#${this.id}] ws error: ${err?.message ?? err} (${err?.code ?? '?'})`);
    });
  }

  /**
   * Append bytes to the rx buffer and frame as many complete packets as possible.
   * @param {Uint8Array} chunk
   */
  _feed(chunk) {
    if (this._closed) return;
    // Append.
    let merged = new Uint8Array(this._rx.length + chunk.length);
    merged.set(this._rx);
    merged.set(chunk, this._rx.length);
    // Bug-hunt #11 #3 (DoS): cap accumulated unframed bytes. A malicious
    // client could open a variable-length packet header with size=0xFFFF
    // and never send the payload, pinning ~64KB per repeat forever.
    // 256 KB is comfortably larger than any single UO packet (largest
    // known is ~12 KB for full house customisation).
    const MAX_RX = 256 * 1024;
    if (merged.length > MAX_RX) {
      console.warn(`[net#${this.id}] rx overflow ${merged.length}B → forcing close`);
      this._rx = new Uint8Array(0);
      try { this.close?.(); } catch { /* ignore */ }
      return;
    }

    // Iterative framing — previously a recursive `this._feed(new Uint8Array(0))`
    // re-entered after every skipped byte, which on a structurally-drifted
    // buffer produced one stack frame + log line per junk byte. Hundreds of
    // unknown bytes (a 0x12 cast packet that lost its terminator can spawn
    // 4..7) burned the event loop and left the rest of the players unable
    // to move. The loop here drains the same buffer in one shot with a
    // cap on how many "skip 1" warnings we emit so log spam can't hang us.
    // Defensive prefix-drop: an in-world stream that starts with a
    // pre-login opcode (e.g. 0x00 CreateCharacter, declared 104 bytes)
    // is almost certainly drift from a prior packet leaving a stray
    // byte in `_rx`. The framer would happily consume 104 bytes as a
    // "valid" CreateCharacter, then trip on whatever opcode sits at
    // offset 104 — user report 2026-05-18 saw `Unknown 0x51 at rx[104]`
    // every login because a 0x00 leftover at offset 0 ate the next 3
    // MovementReqs and a Resynchronize as if they were one big char-
    // create blob. While `ingame === false` packets ARE valid at boot,
    // by the time `stage === InWorld` only `ingame === true` opcodes
    // should ever appear; drop any leading byte that mismatches the
    // stage and let the framer try again with the trailing bytes.
    const inWorld = this.stage === Stage.InWorld;
    while (inWorld && merged.length > 0) {
      const head = opcodeInfo(merged[0]);
      if (head && head.ingame === false) {
        merged = merged.subarray(1);
        continue;
      }
      // Defensive: 0x02 MovementReq is a hot drift bait — fixed 7
      // bytes, the canonical direction byte uses only the low 3 bits
      // (+ 0x80 run flag), so anything with `direction & 0x78` set
      // is garbage from a prior packet boundary. Eating the 7 bytes
      // as a MovementReq would gobble the first 6 bytes of the next
      // (real) packet — exactly the failure mode in the user's
      // 2026-05-19 log (`02 b1 00 25 ...` ate the 0xB1 GumpResponse
      // header). Drop the lone byte instead and let the next packet
      // frame cleanly. Requires the full header (≥2 bytes) to inspect.
      if (merged[0] === 0x02 && merged.length >= 2 && (merged[1] & 0x78) !== 0) {
        merged = merged.subarray(1);
        continue;
      }
      break;
    }
    if (merged.length === 0) { this._rx = merged; return; }
    let packets;
    let consumed;
    let skipBudget = 32;          // hard cap per _feed invocation
    while (true) {
      try {
        ({ packets, consumed } = frameIncoming(merged, { dropReqSize: this.dropReqSize }));
        break;                    // success — fall through to dispatch loop
      } catch (e) {
        const offRaw = (typeof e.offset === 'number' && e.offset >= 0) ? e.offset : -1;
        if (offRaw < 0) {
          console.warn(`[net#${this.id}] protocol error: ${e.message} — dropping connection`);
          this.close();
          return;
        }
        if (skipBudget-- <= 0) {
          // Drift is structural — kick rather than spend more CPU on it.
          console.warn(`[net#${this.id}] protocol drift exceeded skip budget; dropping connection`);
          this.close();
          return;
        }
        const start = Math.max(0, offRaw - 16);
        const end = Math.min(merged.length, offRaw + 32);
        const hex = Array.from(merged.subarray(start, end))
          .map((b, i) => ((start + i) === offRaw ? '>' : '') + b.toString(16).padStart(2, '0'))
          .join(' ');
        console.warn(
          `[net#${this.id}] protocol error: ${e.message} at rx[${offRaw}] of ${merged.length} bytes; window=${hex} — skipping 1 byte and continuing`,
        );
        // Drop everything UP TO and INCLUDING the bad byte and re-try
        // framing on the tail. The previous code dropped only the bytes
        // BEFORE the bad byte, so anything the framer had already
        // consumed leaked into the next attempt's buffer prefix and
        // routinely produced a second false error one byte later.
        merged = merged.subarray(offRaw + 1);
        if (merged.length === 0) { this._rx = merged; return; }
        // Same prefix-drop as before the framer call — a freshly-skipped
        // byte may expose a stale pre-login opcode that would otherwise
        // get consumed as a giant frame. Also re-apply the 0x02 drift
        // guard (see pre-frame check above) — once we've skipped a
        // garbage byte, the next byte might be another junk 0x02.
        while (inWorld && merged.length > 0) {
          const head = opcodeInfo(merged[0]);
          if (head && head.ingame === false) {
            merged = merged.subarray(1);
            continue;
          }
          if (merged[0] === 0x02 && merged.length >= 2 && (merged[1] & 0x78) !== 0) {
            merged = merged.subarray(1);
            continue;
          }
          break;
        }
        if (merged.length === 0) { this._rx = merged; return; }
      }
    }

    this._rx = merged.subarray(consumed);

    for (const pkt of packets) {
      const op = pkt[0];
      const info = opcodeInfo(op);
      if (this.ctx.config.logPackets) {
        console.log(`[net#${this.id}] << 0x${op.toString(16).padStart(2, '0')} ${info?.name ?? '?'} (${pkt.length} bytes) stage=${this.stage}`);
      }
      const handler = this.ctx.handlers[op];
      if (!handler) {
        // Unknown-but-registered opcode. Just log and skip.
        console.warn(`[net#${this.id}] no handler for 0x${op.toString(16)} (${info?.name})`);
        continue;
      }
      try {
        handler(this, pkt);
      } catch (e) {
        // Gameplay handlers can throw on edge-case data (mis-formed packets,
        // bugs in script-registered commands, etc.). Losing the entire
        // connection for any of those is too harsh — just log and keep
        // going so the player doesn't get kicked mid-command. If the
        // session is genuinely broken, subsequent ops will fail too.
        console.error(`[net#${this.id}] handler 0x${op.toString(16)} threw:`, e);
      }
    }
  }

  /**
   * Send a pre-built UO packet. Applies outgoing Huffman if enabled,
   * but ONLY for the game-phase stages (CharList / InWorld) — the
   * login-phase responses (0xA8 ServerList, 0x8C Relay) MUST go out
   * uncompressed per the canonical ServUO/CUO behaviour. ClassicUO
   * desktop only enables its Huffman decoder after sending 0x91
   * GameLogin; if our server compresses 0xA8 the desktop client sees
   * garbage and hangs on "Verifying Account…" forever (Marcin's
   * symptom). The browser client auto-probes either mode so it works
   * with both — desktop CUO can't.
   *
   * @param {Uint8Array} packet
   */
  send(packet) {
    if (this._closed || this.ws.readyState !== 1 /* OPEN */) return;
    if (this.ctx.config.logPackets) {
      console.log(`[net#${this.id}] >> 0x${packet[0].toString(16).padStart(2, '0')} (${packet.length} bytes) stage=${this.stage}`);
    }
    const inGamePhase = this.stage === Stage.CharList || this.stage === Stage.InWorld;
    const useHuffman = this.ctx.config.huffmanOutgoing && inGamePhase;
    const payload = useHuffman ? huffmanCompress(packet) : packet;
    this.ws.send(payload, { binary: true });
  }

  close(reason) {
    if (this._closed) return;
    this._closed = true;
    try { this.ws.close(1000, reason); } catch { /* ignore */ }
  }

  /** Convenience: push a system message to this client. Accepts an
   *  optional hue (defaults to the standard system grey via the
   *  protocol helper). Pass `0x59` for the blue skill-advance line
   *  ServUO/CUO render in the journal. */
  sendSystemMessage(text, hue) {
    if (hue == null) this.send(unicodeMessage({ text }));
    else this.send(unicodeMessage({ text, hue }));
  }

  /** Convenience: emit a 0xF3 WorldItemSA for an item. */
  sendItem(item) {
    // Propagate `item.movable` into the on-wire flags byte. The default
    // worldItemSA flag is 0x20 ("movable" in our protocol, despite a
    // misleading comment that calls 0x20 hidden). Without this branch
    // every door / sign / decoration was broadcast as movable, so the
    // client treated single-clicks on them as drag-pickups → 0x07 →
    // server rejected (item not movable) → "You cannot pick that up"
    // spam on every door click. Match the existing convention used by
    // `_onClose` (line 219) — 0x20 movable, 0x00 fixed.
    this.send(worldItemSA({
      serial: item.serial, itemId: item.itemId, hue: item.hue,
      amount: item.amount, x: item.x, y: item.y, z: item.z,
      flags: (item.movable === false) ? 0x00 : 0x20,
    }));
  }

  /** Convenience: emit 0x1D RemoveEntity for a serial. */
  sendRemove(serial) {
    this.send(removeEntity(serial));
  }

  _onClose() {
    if (this._closed) return;
    this._closed = true;
    if (this.mobile) {
      const mob = this.mobile;
      // If we disconnect with an item on the cursor, the item is in limbo:
      // pickup set parent=self mob and (for worn items) layer=0, so neither
      // equipmentFor() nor any container query would find it on next login.
      // Spit it out at the mobile's feet so the world stays consistent.
      // (Backpack lifted off the paperdoll then logout was the trigger for
      // "po zalogowaniu plecaczek znikl z paperdoll".)
      if (this.heldItem) {
        const it = this.heldItem;
        it.parent = null;
        it.x = mob.x; it.y = mob.y; it.z = mob.z;
        it.map = mob.map;
        it.gridX = 0; it.gridY = 0; it.gridLocation = 0;
        it.layer = 0;
        this.heldItem = null;
        const msg = worldItemSA({
          serial: it.serial, itemId: it.itemId, amount: it.amount,
          x: it.x, y: it.y, z: it.z, hue: it.hue,
          flags: (it.movable ?? true) ? 0x20 : 0x00,
        });
        // BUGFIX #65 (FAZA CW): visibility-gate. A logout on Felucca
        // doesn't need to ping every player in Trammel about the
        // backpack item drop.
        for (const other of this.ctx.world.mobiles.values()) {
          if (other === mob || !other.client) continue;
          if (other.map !== it.map) continue;
          if (Math.abs(other.x - it.x) > 18 || Math.abs(other.y - it.y) > 18) continue;
          other.client.send(msg);
        }
      }
      mob.client = null;
      this.ctx.world?.markMobileOffline?.(mob);
      // Auto-stable any unbonded pets following the disconnecting
      // master so they don't loiter as ghost followers (ServUO
      // releases unbonded pets on logout — we stable them so the
      // returning player can re-collect them). Bonded pets stamp
      // `_masterOfflineSince`; the AI tick uses that to "go home" /
      // despawn after 5 minutes of master absence.
      try {
        const stableModule = this.ctx?.systems?.petStable
                          ?? this.ctx?.handlers?.petStable;
        const stable = stableModule?.stable ?? stableModule;
        const now = Date.now();
        for (const candidate of this.ctx.world.mobiles.values()) {
          if (candidate === mob) continue;
          if (candidate.controlMaster !== mob.serial) continue;
          if (candidate.bonded) {
            candidate._masterOfflineSince = now;
            continue;
          }
          if (stable?.deposit) {
            const r = stable.deposit(null, mob, candidate);
            if (r?.ok) {
              // Hide the now-stabled pet from nearby clients.
              for (const other of this.ctx.world.mobiles.values()) {
                if (!other.client || other.map !== candidate.map) continue;
                if (Math.abs(other.x - candidate.x) > 18 || Math.abs(other.y - candidate.y) > 18) continue;
                other.client.sendRemove?.(candidate.serial);
              }
              // Remove from the world map so it doesn't tick AI.
              this.ctx.world.destroyMobile?.(candidate.serial);
            }
          }
        }
      } catch (e) {
        console.warn('[net] auto-stable on logout threw:', e?.message);
      }
      // Tell nearby clients to drop this mobile from their world view.
      // BUGFIX #65: visibility-gate.
      for (const other of this.ctx.world.mobiles.values()) {
        if (other === mob) continue;
        if (!other.client) continue;
        if (other.map !== mob.map) continue;
        if (Math.abs(other.x - mob.x) > 18 || Math.abs(other.y - mob.y) > 18) continue;
        other.client.sendRemove(mob.serial);
      }
      // Keep `mob` in `world.mobiles` so the next login on the same account
      // can rebind to it instead of spawning a duplicate. Removal would
      // recreate the "two admins, the old one stays standing" bug — the
      // server's account → mobile binding (set by `bringIntoWorld`) is the
      // only thing that lets a returning player reuse their character.
    }
    // Drop any in-flight interaction state so it can't leak or be replayed
    // against a reconnecting session. Without this, targetCallbacks /
    // activeGumps / activePrompts would accumulate on long-running shards
    // and, worse, a reconnecting player could inherit a dangling callback
    // from the previous login.
    this.targetCallbacks?.clear?.();
    this.activeGumps?.clear?.();
    this.activePrompts?.clear?.();
    this.openContainers?.clear?.();
    if (this.mobile) chatChannels.leaveAll(this.mobile);
    // Cancel any in-flight secure-trade session this NetState is part of.
    // Without this the partner's side stays open referencing a dead
    // NetState, items A reparented to a virtual container with
    // `map=0,x=0,y=0` linger past restart and the persistence orphan
    // sweep dumps them at facet 0 (0,0). `trade.cancel()` returns each
    // side's items to its mobile's inventory.
    try {
      const tradeApi = this.ctx?.handlers?.trade;
      if (tradeApi?.cancel) {
        const seen = new Set();
        for (const session of tradeApi._byContainer?.values?.() ?? []) {
          if (seen.has(session)) continue;
          seen.add(session);
          if (session.a === this || session.b === this) {
            try { tradeApi.cancel(session); }
            catch (e) { console.error('[net] trade cancel on disconnect threw:', e); }
          }
        }
      }
    } catch { /* trade module not wired */ }
    console.log(`[net#${this.id}] disconnected (stage=${this.stage}, account=${this.accountName})`);
  }
}
