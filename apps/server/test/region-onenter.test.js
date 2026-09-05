import { afterEach, describe, expect, it, vi } from 'vitest';
import { _clearRegionHooks, onEnterRegion, updateRegion } from '../src/systems/region-onenter.js';

afterEach(_clearRegionHooks);

describe('region hook fan-out', () => {
  it('keeps multiple script listeners and removes only the disposed listener', () => {
    const first = vi.fn();
    const second = vi.fn();
    const disposeFirst = onEnterRegion('Britain', first);
    onEnterRegion('Britain', second);
    const one = {};
    updateRegion(one, () => 'Britain');
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

    disposeFirst();
    const two = {};
    updateRegion(two, () => 'Britain');
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
  });
});
