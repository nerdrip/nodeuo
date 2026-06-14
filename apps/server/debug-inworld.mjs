// Manual debug script: simulate a full login, then sit in-world for 10s and
// dump every inbound opcode + size. Reveals packets that break client framing.
import WebSocket from 'ws';
import { PacketWriter, huffmanDecompress } from '@uo/protocol';

const OUTGOING_SIZES = {
  0x0B: 7, 0x11: 0, 0x17: 0, 0x1B: 37, 0x1C: 0, 0x1D: 5, 0x20: 19, 0x21: 8,
  0x22: 3, 0x24: 9, 0x25: 21, 0x27: 2, 0x29: 2, 0x2C: 2, 0x2E: 15, 0x3A: 0,
  0x3C: 0, 0x4E: 6, 0x4F: 2, 0x54: 12, 0x55: 1, 0x6C: 19, 0x6E: 14, 0x6F: 0,
  0x70: 28, 0x72: 5, 0x73: 2, 0x74: 0, 0x77: 17, 0x78: 0, 0x82: 2, 0x88: 66,
  0x8C: 11, 0x9E: 0, 0xA1: 9, 0xA2: 9, 0xA3: 9, 0xA8: 0, 0xA9: 0, 0xAE: 0,
  0xB9: 5, 0xBC: 3, 0xBF: 0, 0xC0: 36, 0xE2: 10, 0xF3: 26,
};

const ws = new WebSocket('ws://127.0.0.1:2593/game');
ws.binaryType = 'arraybuffer';
let rx = new Uint8Array(0);

ws.on('open', () => {
  console.log('open');
  const seed = new PacketWriter(21);
  seed.writeU8(0xEF); seed.writeU32(0x12345678);
  seed.writeU32(7); seed.writeU32(0); seed.writeU32(99); seed.writeU32(0);
  ws.send(seed.bytes());
  const lg = new PacketWriter(62);
  lg.writeU8(0x80); lg.writeAsciiFixed('alice', 30); lg.writeAsciiFixed('pw', 30); lg.writeU8(0);
  ws.send(lg.bytes());
});

let stage = 'login';
let authKey = 0;

ws.on('message', (data) => {
  const bytes = new Uint8Array(data);
  const plain = huffmanDecompress(bytes);
  const merged = new Uint8Array(rx.length + plain.length);
  merged.set(rx); merged.set(plain, rx.length);
  rx = merged;
  drain();
});

function drain() {
  let off = 0;
  while (off < rx.length) {
    const op = rx[off];
    const size = OUTGOING_SIZES[op];
    if (size === undefined) {
      const win = Array.from(rx.subarray(Math.max(0, off - 4), Math.min(rx.length, off + 16)))
        .map((b) => b.toString(16).padStart(2, '0')).join(' ');
      console.error(`UNKNOWN OP 0x${op.toString(16)} at off=${off} of ${rx.length}; win=${win}`);
      process.exit(1);
    }
    let total = size;
    if (size === 0) {
      if (rx.length - off < 3) break;
      total = (rx[off + 1] << 8) | rx[off + 2];
      if (total < 3) {
        console.error(`BAD VAR LEN op=0x${op.toString(16)} len=${total}`);
        process.exit(1);
      }
    }
    if (rx.length - off < total) break;
    const pkt = rx.subarray(off, off + total);
    handle(op, pkt);
    off += total;
  }
  rx = rx.subarray(off);
}

function handle(op, pkt) {
  console.log(`<- 0x${op.toString(16).padStart(2, '0')} size=${pkt.length}`);
  if (op === 0xA8 && stage === 'login') {
    stage = 'selected';
    const w = new PacketWriter(3); w.writeU8(0xA0); w.writeU16(0);
    ws.send(w.bytes());
  } else if (op === 0x8C && stage === 'selected') {
    stage = 'relayed';
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    authKey = dv.getUint32(7, false);
    const w = new PacketWriter(65);
    w.writeU8(0x91); w.writeU32(authKey);
    w.writeAsciiFixed('alice', 30); w.writeAsciiFixed('', 30);
    ws.send(w.bytes());
  } else if (op === 0xA9 && stage === 'relayed') {
    stage = 'chose';
    const w = new PacketWriter(73);
    w.writeU8(0x5D); w.writeU32(0xEDEDEDED);
    w.writeAsciiFixed('', 30);
    w.writeZero(73 - (1 + 4 + 30));
    ws.send(w.bytes());
  } else if (op === 0x55) {
    console.log('*** login complete, sitting for 30s ***');
    setTimeout(() => {
      console.log('*** 30s elapsed cleanly ***');
      ws.close(); process.exit(0);
    }, 30000);
  }
}

ws.on('close', (code, reason) => {
  console.log(`close code=${code} reason=${reason}`);
  process.exit(2);
});
ws.on('error', (e) => console.error('error', e.message));
