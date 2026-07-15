import { describe, expect, it, vi } from 'vitest';
import { buildHandlers, gumps } from '../src/net/handlers.js';
import {
  GUMP_LIMITS,
  allowHeavyGump,
  inspectGumpLayout,
  validateGumpDefinition,
} from '../src/net/gump-security.js';

function responsePacket({ serial, gumpId, buttonId = 0, switches = [], texts = [] }) {
  const bytes = 23 + switches.length * 4
    + texts.reduce((sum, entry) => sum + 4 + entry.text.length * 2, 0);
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  let o = 0;
  out[o++] = 0xB1;
  view.setUint16(o, bytes); o += 2;
  view.setUint32(o, serial >>> 0); o += 4;
  view.setUint32(o, gumpId >>> 0); o += 4;
  view.setUint32(o, buttonId >>> 0); o += 4;
  view.setUint32(o, switches.length); o += 4;
  for (const id of switches) { view.setUint32(o, id >>> 0); o += 4; }
  view.setUint32(o, texts.length); o += 4;
  for (const entry of texts) {
    view.setUint16(o, entry.entryId & 0xffff); o += 2;
    view.setUint16(o, entry.text.length); o += 2;
    for (const char of entry.text) { view.setUint16(o, char.charCodeAt(0)); o += 2; }
  }
  return out;
}

function state() {
  return { send: vi.fn(), mobile: { serial: 0x12345678 } };
}

describe('server gump security boundary', () => {
  it('extracts only response controls declared in a valid layout', () => {
    const metadata = inspectGumpLayout([
      '{ page 0 }',
      '{ button 10 10 1 2 1 0 77 }',
      '{ checkbox 10 30 3 4 0 88 }',
      '{ textentry 10 50 100 20 0 99 0 }',
    ].join(''));
    expect([...metadata.buttons]).toEqual([0, 77]);
    expect([...metadata.switches]).toEqual([88]);
    expect([...metadata.textEntries]).toEqual([99]);
  });

  it('binds a response to serial/type/control and consumes it exactly once', () => {
    const client = state();
    const callback = vi.fn();
    gumps.send(client, {
      gumpId: 0xCAFE,
      layout: '{ button 10 10 1 2 1 0 77 }{ checkbox 10 30 3 4 0 88 }{ textentry 10 50 100 20 0 99 0 }',
      texts: ['initial'],
    }, callback);
    const packet = responsePacket({
      serial: client.mobile.serial, gumpId: 0xCAFE, buttonId: 77,
      switches: [88], texts: [{ entryId: 99, text: 'safe' }],
    });
    buildHandlers()[0xB1](client, packet);
    buildHandlers()[0xB1](client, packet);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0].textEntries[0].text).toBe('safe');
  });

  it('rejects spoofed serials and undeclared response controls', () => {
    const client = state();
    const callback = vi.fn();
    gumps.send(client, { gumpId: 4, layout: '{ button 1 1 1 2 1 0 5 }' }, callback);
    buildHandlers()[0xB1](client, responsePacket({ serial: 9, gumpId: 4, buttonId: 5 }));
    buildHandlers()[0xB1](client, responsePacket({ serial: client.mobile.serial, gumpId: 4, buttonId: 6 }));
    expect(callback).not.toHaveBeenCalled();
    expect(client.activeGumps.has(4)).toBe(true);
  });

  it('expires stale dialogs and sends a real close packet', () => {
    const client = state();
    gumps.send(client, { gumpId: 8, lifetimeMs: 1000, layout: '{ button 1 1 1 2 1 0 2 }' }, vi.fn());
    client.activeGumps.get(8).expiresAt = Date.now() - 1;
    buildHandlers()[0xB1](client, responsePacket({ serial: client.mobile.serial, gumpId: 8, buttonId: 2 }));
    expect(client.activeGumps.has(8)).toBe(false);

    gumps.send(client, { gumpId: 9, layout: '{ button 1 1 1 2 1 0 2 }' }, vi.fn());
    expect(gumps.close(client, 9)).toBe(true);
    expect(client.send.mock.calls.at(-1)[0][0]).toBe(0xBF);
  });

  it('enforces layout, control and text limits before allocating a packet', () => {
    expect(() => validateGumpDefinition({ layout: 'x'.repeat(GUMP_LIMITS.layoutBytes + 1) })).toThrow(/layout exceeds/);
    expect(() => validateGumpDefinition({ layout: '{ text 0 0 0 0 }'.repeat(GUMP_LIMITS.controls + 1) })).toThrow(/controls/);
    expect(() => validateGumpDefinition({ layout: '{ page 0 }', texts: ['x'.repeat(GUMP_LIMITS.textChars + 1)] })).toThrow(/text exceeds/);
  });

  it('rate-limits only expensive outgoing dialogs per connection', () => {
    const client = state();
    const limits = { ...GUMP_LIMITS, heavyBytes: 100, heavyOpensPerWindow: 2, heavyOpenWindowMs: 1000 };
    expect(allowHeavyGump(client, 99, { now: 10, limits }).ok).toBe(true);
    expect(allowHeavyGump(client, 100, { now: 10, limits }).ok).toBe(true);
    expect(allowHeavyGump(client, 100, { now: 20, limits }).ok).toBe(true);
    const rejected = allowHeavyGump(client, 100, { now: 30, limits });
    expect(rejected.ok).toBe(false);
    expect(rejected.retryAfterMs).toBe(980);
    expect(allowHeavyGump(client, 100, { now: 1010, limits }).ok).toBe(true);
  });
});
