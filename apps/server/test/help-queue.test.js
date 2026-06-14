import { describe, it, expect, beforeEach } from 'vitest';
import * as q from '../src/help-queue.js';

describe('help-queue', () => {
  beforeEach(() => q.clearAll());

  it('enqueue + listOpen returns the new entry', () => {
    const id = q.enqueue({ sender: 'alice', text: 'help me', category: 1 });
    expect(id).toBeGreaterThan(0);
    const list = q.listOpen();
    expect(list.length).toBe(1);
    expect(list[0].sender).toBe('alice');
    expect(list[0].text).toBe('help me');
  });

  it('claim sets claimedBy', () => {
    const id = q.enqueue({ sender: 'alice', text: 'stuck' });
    const claimed = q.claim(id, 'GM Bob');
    expect(claimed.claimedBy).toBe('GM Bob');
  });

  it('resolve drops from listOpen', () => {
    const id = q.enqueue({ sender: 'alice', text: 'fixed' });
    expect(q.resolve(id)).toBe(true);
    expect(q.listOpen().length).toBe(0);
  });

  it('caps text length at 1024', () => {
    const id = q.enqueue({ sender: 'alice', text: 'x'.repeat(2000) });
    expect(q.get(id).text.length).toBe(1024);
  });
});
