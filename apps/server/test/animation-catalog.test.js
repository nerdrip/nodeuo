import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { animationBodySnapshot, animationFramePng, validateMonsterAnimations } from '../src/admin/animation-catalog.js';

describe('mobile animation catalog', () => {
  it('validates body/action/direction/frame coverage from the shipped atlas', () => {
    const rat = animationBodySnapshot(0x00D7);
    expect(rat.resolved).toBe(0x00D7);
    expect(rat.info?.type).toBe('MONSTER');
    expect(rat.actions.length).toBeGreaterThan(5);
    expect(rat.errors.filter((error) => error.includes('atlas bounds'))).toEqual([]);
  }, 30_000);

  it('reports missing bodies instead of silently substituting another creature', () => {
    const missing = animationBodySnapshot(0x7FFF);
    expect(missing.ok).toBe(false);
    expect(missing.errors[0]).toContain('absent');
  });

  it('extracts an actual preview frame as PNG', async () => {
    const png = await animationFramePng(0x00D7, 0, 0, 0);
    expect(png).toBeInstanceOf(Buffer);
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  }, 15_000);

  it('resolves a renderable body and semantic animation set for every shipped monster', () => {
    const rows = JSON.parse(fs.readFileSync(
      new URL('../../scripts/src/data/config/monsters.json', import.meta.url),
      'utf8',
    ));
    const byKind = new Map(rows.map((entry) => [entry.definitionId, entry]));
    const report = validateMonsterAnimations({
      kinds: () => [...byKind.keys()],
      get: (kind) => byKind.get(kind),
    });
    expect(report.total).toBeGreaterThan(750);
    expect(report.results.filter((entry) => !entry.ok)).toEqual([]);
  });

  it('uses explicit same-family fallbacks and keeps a valid original when an alias target is absent', () => {
    expect(animationBodySnapshot(52)).toMatchObject({ ok: true, resolved: 51, resolvedVia: 'fallback' });
    // Re-extracted modern clients contain body 307 directly. Exact source is
    // preferable to the historical Body.def alias that mapped it to gorilla.
    expect(animationBodySnapshot(307)).toMatchObject({ ok: true, resolved: 307, resolvedVia: 'exact-source' });
  });

  it('keeps canonical Bodyconv mount art instead of obsolete Body.def aliases', () => {
    expect(animationBodySnapshot(0x031A)).toMatchObject({
      ok: true, resolved: 0x031A, resolvedVia: 'exact-source',
    });
    expect(animationBodySnapshot(0x0317)).toMatchObject({
      ok: true, resolved: 0x0317, resolvedVia: 'exact-source',
    });
  });
});
