import { describe, expect, it } from 'vitest';
import { animationBodySnapshot, animationFramePng } from '../src/admin/animation-catalog.js';

describe('mobile animation catalog', () => {
  it('validates body/action/direction/frame coverage from the shipped atlas', () => {
    const rat = animationBodySnapshot(0x00D7);
    expect(rat.resolved).toBe(0x00D7);
    expect(rat.info?.type).toBe('MONSTER');
    expect(rat.actions.length).toBeGreaterThan(5);
    expect(rat.errors.filter((error) => error.includes('atlas bounds'))).toEqual([]);
  });

  it('reports missing bodies instead of silently substituting another creature', () => {
    const missing = animationBodySnapshot(0x7FFF);
    expect(missing.ok).toBe(false);
    expect(missing.errors[0]).toContain('absent');
  });

  it('extracts an actual preview frame as PNG', async () => {
    const png = await animationFramePng(0x00D7, 0, 0, 0);
    expect(png).toBeInstanceOf(Buffer);
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
});
