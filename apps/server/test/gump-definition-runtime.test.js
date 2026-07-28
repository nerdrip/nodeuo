import { describe, expect, it } from 'vitest';
import { compileGumpDefinition, configuredGump, interpolateGumpText } from '../../scripts/src/gumps/definition-runtime.js';
import { openConfiguredGump } from '../../scripts/src/gumps/server-gumps.js';

describe('data-driven gump definitions', () => {
  it('interpolates values and compiles visual controls to unchanged UO layout syntax', () => {
    const definition = {
      definitionId: 'test', x: 40, y: 50, width: 240, height: 160, noResize: true, noDispose: true,
      controls: [
        { type: 'panel', x: 0, y: 0, width: 240, height: 160, artId: 5054 },
        { type: 'label', x: 20, y: 20, hue: 1153, text: 'Hello {{player.name}}' },
        { type: 'textentry', x: 20, y: 50, width: 160, height: 20, entryId: 7, text: '{{initial}}' },
        { type: 'button', x: 20, y: 100, normalId: 4005, pressedId: 4007, buttonId: 9 },
      ],
    };
    const result = compileGumpDefinition(definition, { player: { name: 'Britannian' }, initial: 'ready' });

    expect(result).toMatchObject({ x: 40, y: 50, texts: ['Hello Britannian', 'ready'] });
    expect(result.layout).toContain('{ resizepic 0 0 5054 240 160 }');
    expect(result.layout).toContain('{ nodispose }');
    expect(result.layout).toContain('{ noresize }');
    expect(result.layout).toContain('{ text 20 20 1153 0 }');
    expect(result.layout).toContain('{ textentry 20 50 160 20 1152 7 1 }');
    expect(result.layout).toContain('{ button 20 100 4005 4007 1 0 9 }');
  });

  it('uses a configured record when present and keeps a fallback for compatibility', () => {
    const definitions = new Map([['hello', { controls: [{ type: 'label', x: 1, y: 2, text: '{{text}}' }] }]]);
    expect(configuredGump(definitions, 'hello', { text: 'Hi' }, { layout: 'fallback' }).texts).toEqual(['Hi']);
    expect(configuredGump(definitions, 'missing', {}, { layout: 'fallback' })).toEqual({ layout: 'fallback' });
    expect(interpolateGumpText('{{missing}}!', {})).toBe('!');
  });

  it('opens any authored definition through the generic standard-gump bridge', () => {
    const definitions = new Map([['welcome', {
      definitionId: 'welcome', x: 40, y: 50, width: 200, height: 100,
      controls: [{ type: 'label', x: 10, y: 12, text: 'Welcome {{player.name}}' }],
    }]]);
    const sent = [];
    const gumps = { send: (...args) => sent.push(args) };
    const state = { mobile: { name: 'Admin' } };
    const callback = () => {};

    expect(openConfiguredGump(gumps, state, definitions, 'welcome', { player: state.mobile }, callback)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe(state);
    expect(sent[0][1]).toMatchObject({ x: 40, y: 50, texts: ['Welcome Admin'] });
    expect(sent[0][2]).toBe(callback);
    expect(openConfiguredGump(gumps, state, definitions, 'missing')).toBe(false);
  });
});
