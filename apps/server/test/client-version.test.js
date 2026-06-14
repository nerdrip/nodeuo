import { describe, it, expect } from 'vitest';
import { PacketWriter } from '@uo/protocol';
import { buildHandlers } from '../src/net/handlers.js';

function clientVersionPacket(version) {
  const text = String(version ?? '');
  const total = 1 + 2 + text.length + 1;
  const w = new PacketWriter(total);
  w.writeU8(0xBD);
  w.writeU16(total);
  w.writeAsciiNull(text);
  return w.bytes();
}

describe('client version packet table gates', () => {
  it('uses 15-byte DropReq for modern clients', () => {
    const state = {};
    buildHandlers()[0xBD](state, clientVersionPacket('7.0.95.0'));
    expect(state.clientVersionString).toBe('7.0.95.0');
    expect(state.dropReqSize).toBe(15);
  });

  it('uses 14-byte DropReq before client 6.0.1.7', () => {
    const state = {};
    buildHandlers()[0xBD](state, clientVersionPacket('5.0.9.1'));
    expect(state.clientVersionString).toBe('5.0.9.1');
    expect(state.dropReqSize).toBe(14);
  });
});
