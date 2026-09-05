// PHASE LA / BUGFIX #140 — pre-template useItem hook chain.
// Boat + door scripts can't monkey-patch `templates.useItem` (read-only
// ES module export); instead they register hooks via addUseItemHook.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  useItem, addUseItemHook, clearUseItemHooks,
} from '../src/world/templates.js';

describe('useItem hook chain (PHASE LA / #140)', () => {
  beforeEach(() => clearUseItemHooks());

  it('runs hooks in registration order until one returns truthy', () => {
    const calls = [];
    addUseItemHook((_w, _item) => { calls.push('hook1'); return false; });
    addUseItemHook((_w, item) => { calls.push('hook2'); return item.takeMe; });
    addUseItemHook((_w, _item) => { calls.push('hook3'); return false; });
    const result = useItem(null, { takeMe: true }, null);
    expect(calls).toEqual(['hook1', 'hook2']);  // hook3 skipped
    expect(result).toBe(true);
  });

  it('falls through to template lookup when no hook returns truthy', () => {
    addUseItemHook(() => false);
    const result = useItem(null, { itemId: 0 }, { client: null });
    expect(result).toBe(false);  // no template registered for 0
  });

  it('catches hook exceptions without aborting the chain', () => {
    let secondRan = false;
    addUseItemHook(() => { throw new Error('boom'); });
    addUseItemHook(() => { secondRan = true; return false; });
    expect(() => useItem(null, {}, null)).not.toThrow();
    expect(secondRan).toBe(true);
  });
});
