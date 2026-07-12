import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeUOCapability, NodeUOSpellComposerMessage } from '@uo/protocol';
import {
  SpellComposerService,
  validateSpellDraft,
  validateSpellForPublication,
} from '../src/systems/spells/composer.js';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function validDraft(overrides = {}) {
  return {
    name: 'Arc Flash', school: 'custom', target: 'mobile', mana: 12,
    range: 10, castTimeMs: 750, cooldownMs: 1500,
    effect: { type: 'damage', amount: 20, element: 'energy', graphic: 0x36BD, hue: 0 },
    area: { shape: 'circle', radius: 3 },
    sequence: [
      { atMs: 500, kind: 'sound', sound: 0x0207 },
      { atMs: 0, kind: 'visual', graphic: 0x36BD, hue: 0x47E },
    ],
    ...overrides,
  };
}

describe('visual spell composer drafts', () => {
  it('rejects unknown components and strips client-controlled code fields', () => {
    expect(validateSpellDraft(validDraft({ effect: { type: 'run-javascript' } })).ok).toBe(false);
    const result = validateSpellDraft({ ...validDraft(), source: 'process.exit()', effect: {
      ...validDraft().effect, callback: 'eval()', amount: 99_999,
    } });
    expect(result.ok).toBe(true);
    expect(result.draft).not.toHaveProperty('source');
    expect(result.draft.effect).not.toHaveProperty('callback');
    expect(result.draft.effect.amount).toBe(1000);
    expect(result.draft.area).toEqual({ shape: 'circle', radius: 3, angle: 0 });
    expect(result.draft.sequence.map((cue) => cue.atMs)).toEqual([0, 500]);
  });

  it('does not open on a standard UO transport', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-spells-')); dirs.push(dir);
    const service = new SpellComposerService(dir);
    const sent = [];
    expect(service.open({ send: (pkt) => sent.push(pkt), supportsNodeUO: () => false })).toBe(false);
    expect(sent).toEqual([]);
  });

  it('opens, validates and persists an inert draft over the negotiated channel', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-spells-')); dirs.push(dir);
    const service = new SpellComposerService(dir);
    const sent = [];
    const state = {
      supportsNodeUO: (cap) => cap === NodeUOCapability.SpellComposer,
      send: (pkt) => sent.push(pkt),
    };
    expect(service.open(state)).toBe(true);
    expect(sent[0][5]).toBe(NodeUOSpellComposerMessage.Open);

    const result = service.acceptDraft(state, 7, validDraft());
    expect(result.ok).toBe(true);
    expect(sent[1][5]).toBe(NodeUOSpellComposerMessage.Result);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'custom-spells.json'), 'utf8')).spells)
      .toEqual([expect.objectContaining({ id: 'custom:arc-flash', name: 'Arc Flash' })]);
  });

  it('requires a balanced draft before publication and persists the published flag', () => {
    const weakCost = validDraft({ mana: 1, cooldownMs: 0, castTimeMs: 0 });
    expect(validateSpellForPublication(weakCost)).toMatchObject({ ok: false });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-spells-')); dirs.push(dir);
    const service = new SpellComposerService(dir);
    const sent = [];
    const balanced = validDraft({ mana: 30, cooldownMs: 2500, castTimeMs: 750 });
    const result = service.publishDraft({ send: (pkt) => sent.push(pkt) }, 9, balanced);
    expect(result.ok).toBe(true);
    expect(result.draft.published).toBe(true);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'custom-spells.json'), 'utf8'));
    expect(saved.spells[0]).toMatchObject({ name: 'Arc Flash', published: true });
  });
});
