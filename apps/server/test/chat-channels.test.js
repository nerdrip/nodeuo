import { describe, it, expect, beforeEach } from 'vitest';
import * as ch from '../src/chat-channels.js';

function makeMob(serial, name) {
  const sent = [];
  return {
    serial, name,
    received: sent,
    client: {
      send(pkt) { sent.push(pkt); },
      account: null,
    },
  };
}

describe('chat-channels', () => {
  beforeEach(() => ch.clearAll());

  it('default channels are present', () => {
    const list = ch.list();
    expect(list.find((c) => c.name === 'General')).toBeTruthy();
    expect(list.find((c) => c.name === 'Trade')).toBeTruthy();
  });

  it('join/leave round-trip', () => {
    const m = makeMob(1, 'Alice');
    expect(ch.join('General', m)).toBe(true);
    expect(ch.isMember('General', m)).toBe(true);
    expect(ch.leave('General', m)).toBe(true);
    expect(ch.isMember('General', m)).toBe(false);
  });

  it('broadcast skips sender, hits other members', () => {
    const a = makeMob(1, 'Alice');
    const b = makeMob(2, 'Bob');
    const c = makeMob(3, 'Carol');
    ch.join('General', a); ch.join('General', b); ch.join('General', c);
    const stub = new Uint8Array([1, 2, 3]);
    const count = ch.broadcast('General', a, () => stub);
    expect(count).toBe(2);
    expect(a.received.length).toBe(0);
    expect(b.received.length).toBe(1);
    expect(c.received.length).toBe(1);
  });

  it('broadcast refuses non-members', () => {
    const m = makeMob(1, 'Alice');
    const count = ch.broadcast('General', m, () => new Uint8Array(0));
    expect(count).toBe(0);
  });

  it('leaveAll drops mob from every channel', () => {
    const m = makeMob(1, 'Alice');
    ch.join('General', m); ch.join('Trade', m); ch.join('Help', m);
    ch.leaveAll(m);
    expect(ch.isMember('General', m)).toBe(false);
    expect(ch.isMember('Trade', m)).toBe(false);
    expect(ch.isMember('Help', m)).toBe(false);
  });
});
