import { describe, it, expect } from 'vitest';
import { reforge, tierFor, listTools, listOptions, powerOf } from '../src/systems/runic-reforging.js';

function makeItem(over = {}) {
  return { serial: 0xdead, name: 'sword', itemId: 0x13B6, ...over };
}
function makeMob(serial = 1) {
  return { serial, skills: { 8: 100 } };
}

describe('runic-reforging', () => {
  it('tierFor recognises canonical metal names', () => {
    expect(tierFor('verite hammer').key).toBe('verite');
    expect(tierFor('Valorite Tongs').key).toBe('valorite');
    expect(tierFor('shadow iron')).not.toBeNull();
    expect(tierFor('mithril')).toBeNull();
  });

  it('listTools/listOptions are populated', () => {
    expect(listTools().length).toBeGreaterThan(8);
    expect(listOptions()).toContain('powerful');
    expect(listOptions()).toContain('fundamental');
  });

  it('reforge attaches _magicProps and itemPower', () => {
    const m = makeMob();
    const item = makeItem();
    const res = reforge(m, item, 'verite', 'fundamental', () => 0.5);
    expect(res.ok).toBe(true);
    expect(item._magicProps?.length).toBeGreaterThan(0);
    expect(item._reforged).toBe(true);
    expect(item._reforgeTier).toBe('verite');
    expect(['Minor','Lesser','Greater','Major','LesserArtifact','GreaterArtifact'])
      .toContain(item._itemPower);
  });

  it('refuses to reforge already-magical item', () => {
    const m = makeMob();
    const item = makeItem({ _magicProps: [{ attribute: 'Strength', intensity: 5 }] });
    const res = reforge(m, item, 'verite', 'powerful');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('already-magical');
  });

  it('refuses unknown tool', () => {
    const m = makeMob();
    const item = makeItem();
    const res = reforge(m, item, 'mithril', 'powerful');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unknown-tool');
  });

  it('refuses if crafterSerial mismatch', () => {
    const m = makeMob(1);
    const item = makeItem({ crafterSerial: 999 });
    const res = reforge(m, item, 'verite', 'powerful');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not-crafter');
  });

  it('higher tier yields higher prop count + budget', () => {
    // Run several rolls each to amortise RNG variance — assert
    // average prop count for valorite > dull copper.
    const runs = 30;
    let lo = 0, hi = 0;
    let rngSeed = 1;
    const rng = () => { rngSeed = (rngSeed * 9301 + 49297) % 233280; return rngSeed / 233280; };
    for (let i = 0; i < runs; i++) {
      const a = reforge(makeMob(), makeItem(), 'dull copper', 'fundamental', rng);
      const b = reforge(makeMob(), makeItem(), 'valorite',    'fundamental', rng);
      if (a.ok) lo += a.props.length;
      if (b.ok) hi += b.props.length;
    }
    expect(hi).toBeGreaterThan(lo);
  });

  it('powerOf returns null for un-reforged items', () => {
    expect(powerOf({})).toBeNull();
    expect(powerOf({ _itemPower: 'Major' })).toBe('Major');
  });
});
