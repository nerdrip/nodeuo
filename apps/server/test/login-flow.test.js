// Integration test: start the server, connect a test WebSocket client, and
// drive it through the full login flow, verifying each server response.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import {
  PacketWriter,
  huffmanDecompress,
} from '@uo/protocol';

import { config as serverConfig } from '../src/config.js';
import { World } from '../src/world/world.js';
import { NetState } from '../src/net/net-state.js';
import { AuthKeyRegistry } from '../src/net/auth.js';
import { buildHandlers } from '../src/net/handlers.js';
import { CommandRegistry } from '../src/net/commands.js';
import { AccountDB } from '../src/net/accounts.js';
import fsSync from 'node:fs';
import os from 'node:os';
import pathMod from 'node:path';

let server, wss, port;

beforeAll(async () => {
  // Fresh per-test config overrides (avoid mutating module-level config).
  const cfg = { ...serverConfig, port: 0, logPackets: false, huffmanOutgoing: true, devAutoAccept: true };
  const world = new World();
  const authKeys = new AuthKeyRegistry();
  const handlers = buildHandlers();
  const commands = new CommandRegistry();
  const accountDir = fsSync.mkdtempSync(pathMod.join(os.tmpdir(), 'uo-login-'));
  const accounts = new AccountDB(accountDir);

  server = http.createServer();
  wss = new WebSocketServer({ server, path: '/game' });
  let id = 0;
  wss.on('connection', (ws) => new NetState(ws, { world, authKeys, accounts, config: cfg, handlers, commands, id: ++id }));

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

afterAll(() => {
  wss.close();
  server.close();
});

/** Collect inbound packets, decompressing Huffman when applicable.
 *  Server-side compression is gated on stage (CharList / InWorld only)
 *  per ServUO/CUO convention — login responses (0xA8 ServerList,
 *  0x8C Relay) are RAW and game-phase responses (0xB9 features, 0xA9
 *  CharList, etc.) are compressed. We track the inbound mode here:
 *  start in raw, flip to Huffman the first time the raw bytes don't
 *  parse as a known opcode. Once flipped we stay in Huffman mode for
 *  the rest of the connection.
 *  @returns {{ packets: Uint8Array[] }} expose `packets` so the
 *    legacy `incoming` alias keeps working in tests. */
function makeCollector(ws) {
  let decompressBuf = new Uint8Array(0);
  let huffmanMode = false;
  /** @type {Uint8Array[]} */
  const out = [];
  ws.on('message', (data) => {
    const bytes = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer, data.byteOffset ?? 0, data.byteLength ?? data.length);
    let plain;
    if (huffmanMode) {
      try { plain = huffmanDecompress(bytes); } catch { plain = bytes; }
    } else if (OUTGOING_SIZES[bytes[0]] !== undefined) {
      // Raw byte 0 is a known opcode — login phase, no Huffman.
      plain = bytes;
    } else {
      // Unknown raw opcode — first compressed frame, switch mode.
      try { plain = huffmanDecompress(bytes); huffmanMode = true; }
      catch { plain = bytes; }
    }
    const merged = new Uint8Array(decompressBuf.length + plain.length);
    merged.set(decompressBuf);
    merged.set(plain, decompressBuf.length);
    // For framing we'd need an OUTgoing opcode table; instead, read opcode by
    // opcode using a minimal table of the ones we expect in this test.
    let off = 0;
    while (off < merged.length) {
      const op = merged[off];
      const size = OUTGOING_SIZES[op];
      if (size === undefined) break;
      let total = size;
      if (size === 0) {
        if (merged.length - off < 3) break;
        total = (merged[off + 1] << 8) | merged[off + 2];
      }
      if (merged.length - off < total) break;
      out.push(merged.subarray(off, off + total));
      off += total;
    }
    decompressBuf = merged.subarray(off);
  });
  return out;
}

// Outgoing packet sizes the collector needs to know to frame the stream.
// 0 = variable-length (length read from bytes 1-2 after the opcode).
// IMPORTANT: any opcode the server might emit during the test MUST be
// listed here — when the framer hits an unknown opcode it `break`s and
// every subsequent packet stays stuck in the decompress buffer forever
// (the test then times out on the next waitFor with no useful error).
// Recurring failure mode in this file's history: someone adds a new
// outgoing packet to the login / movement path, doesn't update this
// table, and the test goes flaky. Keep the table generous — it's
// cheaper to over-list than to debug the silent stall again.
const OUTGOING_SIZES = {
  0x15: 9,    // CharacterLocale (Stage 1)
  0x17: 0,    // HealthbarColor (poison/yellow)
  0x1B: 37,   // LoginConfirm
  0x20: 19,   // MobileUpdate
  0x21: 8,    // MovementRej — server snaps client back when step blocked
  0x22: 3,    // MovementAck
  0x4F: 2,    // OverallLightLevel
  0x55: 1,    // LoginComplete
  0x65: 4,    // Weather (kind+intensity+temp)
  0x6E: 14,   // CharacterAnim
  0x77: 17,   // MobileMoving
  0x78: 0,    // MobileIncoming
  0x82: 2,    // LoginReject
  0x8C: 11,   // PlayServerAck
  0xA1: 9,    // HealthUpdate
  0xA2: 9,    // ManaUpdate    — pushed alongside 0xA1 since this batch
  0xA3: 9,    // StaminaUpdate — so the HealthBar fills on first login
  0xA8: 0,    // ServerList
  0xA9: 0,    // CharacterList
  0xAE: 0,    // UnicodeMessage
  0xB9: 5,    // SupportedFeatures
  0xBD: 0,    // ClientVersionReq
  0xBC: 3,    // SeasonChange
  0xBF: 0,    // Extended (subop family)
  0xC1: 0,    // CLILOC localized message
  0xDD: 0,    // CompressedGump
};

async function waitFor(arr, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = arr.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

function buildLoginSeed(seed = 0x12345678) {
  const w = new PacketWriter(21);
  w.writeU8(0xEF);
  w.writeU32(seed);
  w.writeU32(7); w.writeU32(0); w.writeU32(99); w.writeU32(0); // version quad
  return w.bytes();
}
function buildAccountLogin(user, pass) {
  const w = new PacketWriter(62);
  w.writeU8(0x80);
  w.writeAsciiFixed(user, 30);
  w.writeAsciiFixed(pass, 30);
  w.writeU8(0);
  return w.bytes();
}
function buildPlayServer(idx = 0) {
  const w = new PacketWriter(3);
  w.writeU8(0xA0); w.writeU16(idx); return w.bytes();
}
function buildGameLogin(authKey, user) {
  const w = new PacketWriter(65);
  w.writeU8(0x91);
  w.writeU32(authKey);
  w.writeAsciiFixed(user, 30);
  w.writeAsciiFixed('', 30);
  return w.bytes();
}
function buildPlayCharacter(slot = 0) {
  // 0x5D is 73 bytes total (1 opcode + 72 payload). We only care that the
  // name field (30 bytes starting after the 4-byte pattern) is readable by the
  // server; the rest can be zero-filled.
  const w = new PacketWriter(73);
  w.writeU8(0x5D);
  w.writeU32(0xEDEDEDED); // pattern1
  w.writeAsciiFixed('', 30);
  w.writeZero(73 - (1 + 4 + 30)); // pad to exactly 73 bytes, with slot ignored
  void slot;
  return w.bytes();
}

describe('login flow', () => {
  it('drives the full login handshake', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/game`);
    ws.binaryType = 'arraybuffer';
    const incoming = makeCollector(ws);
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });

    ws.send(buildLoginSeed());
    ws.send(buildAccountLogin('alice', 'pw'));

    // Expect 0xA8 server list.
    const list = await waitFor(incoming, (p) => p[0] === 0xA8);
    expect(list.length).toBeGreaterThan(5);

    ws.send(buildPlayServer(0));

    // Expect 0x8C relay.
    const relay = await waitFor(incoming, (p) => p[0] === 0x8C);
    const authKey = new DataView(relay.buffer, relay.byteOffset, relay.byteLength).getUint32(7, false);
    expect(authKey).not.toBe(0);

    // Same-socket game login (no reconnect).
    ws.send(buildGameLogin(authKey, 'alice'));

    await waitFor(incoming, (p) => p[0] === 0xB9); // features
    const charList = await waitFor(incoming, (p) => p[0] === 0xA9);
    expect(charList.length).toBeGreaterThan(10);

    ws.send(buildPlayCharacter(0));

    const confirm = await waitFor(incoming, (p) => p[0] === 0x1B);
    expect(confirm.length).toBe(37);
    await waitFor(incoming, (p) => p[0] === 0x55); // login complete
    const versionReq = await waitFor(incoming, (p) => p[0] === 0xBD);
    expect(Array.from(versionReq)).toEqual([0xBD, 0x00, 0x03]);

    // This connection did not negotiate the NodeUO JSON WebSocket
    // subprotocol. Its binary stream remains ordinary UO traffic.
    await new Promise((r) => setTimeout(r, 25));

    // Receive a movement round-trip. The test only proves the server
    // processed the 0x02 — it can legitimately respond with EITHER
    // 0x22 (MovementAck) when the tile is walkable, OR 0x21
    // (MovementRej) when walkability says no. Trinsic Gate's southern
    // tile is sometimes blocked by the gatehouse wall (depends on
    // which decoration / static-art slot landed in the test env's
    // tiledata.json); locking the test to 0x22 made it flaky.
    // Either response carries the original sequence byte at offset 1.
    const move = new PacketWriter(7);
    move.writeU8(0x02); move.writeU8(0x04 /* S */); move.writeU8(1); move.writeU32(0);
    ws.send(move.bytes());
    const ack = await waitFor(incoming, (p) => p[0] === 0x22 || p[0] === 0x21);
    expect(ack[1]).toBe(1); // sequence echoed

    ws.close();
    await new Promise((r) => ws.once('close', r));
  });
});
