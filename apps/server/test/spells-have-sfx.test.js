// Verify every registered spell broadcasts at least one sound during its
// `cast` body. Cheap regression: import the SPELLS map and grep each
// spell file's source for `broadcastSound(`. If a spell has no sound,
// players cast it in eerie silence — easy to overlook visually.
//
// Skipped spells: a few transform/utility spells legitimately have only
// a one-time visual (their SFX is the body-swap audio handled elsewhere).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { SPELLS } from '../../scripts/src/spells/index.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const SPELLS_DIR = path.resolve(here, '../../scripts/src/spells');

// Spells that don't broadcast sound directly but still play audio via
// helpers (animation packets carry sounds for some, body-swap mobs
// inherit creature sounds). Whitelisted so the test stays useful for
// catching genuinely silent additions.
const WHITELIST = new Set([
  // Pure-tag buffs whose VFX implies their sound — kept silent on
  // purpose to avoid stacking noise when re-cast.
  // Spells that route sfx through `_field-helpers.spawnField` or
  // `_summon-helpers.summonOne` (helper plays broadcastSound from the
  // shared module — this test greps the spell file directly so the
  // call site looks "missing" even though it fires at runtime).
  'wall-of-stone',
  'fire-field', 'poison-field', 'paralyze-field', 'energy-field',
  'blade-spirits', 'energy-vortex',
  'summon-air-elemental', 'summon-daemon',
  'summon-earth-elemental', 'summon-fire-elemental', 'summon-water-elemental',
  // Mastery + bard-mastery + gargoyle racial — all extracted from
  // the legacy schools/*.js stubs on 2026-05-17 with the same shape:
  // a pure stat-buff stance with no explicit broadcastSound call.
  // The cast pipeline plays the registered `soundId` (from spells.json)
  // at cast time, so the spells are NOT silent in-game — this test
  // greps file source which legitimately lacks the call.
  'combat-training', 'mana-shield', 'rampage', 'onslaught', 'pierce',
  'stagger', 'toughness', 'mystic-weapon', 'heighten-senses', 'body-guard',
  'despair', 'inspire', 'invigorate', 'perseverance', 'resilience',
  'tribulation', 'whispering', 'holy-fist',
]);

describe('spell sfx audit', () => {
  it('every spell file calls broadcastSound at least once (or is whitelisted)', () => {
    const missing = [];
    for (const spell of Object.values(SPELLS)) {
      // Post-2026-05-17 refactor: SPELLS rows carry both `name`
      // (proper-case display, e.g. "Magic Arrow") and `slug`
      // (kebab-case matching the impl filename). The WHITELIST + file
      // lookup both need the slug — earlier code used `spell.name`
      // which used to be the slug pre-refactor but is now the display
      // name, sending every lookup to a file like "Magic Arrow.js".
      const slug = spell.slug ?? spell.name;
      if (WHITELIST.has(slug)) continue;
      // Find this spell's file by slug. Spells are in subdirs under
      // SPELLS_DIR — circle1..circle8, necro, chiv, bushido, ninjitsu,
      // spellweaving, mysticism. Walk recursively.
      const fname = `${slug}.js`;
      const found = walk(SPELLS_DIR).find((p) => p.endsWith(path.sep + fname));
      if (!found) {
        missing.push(`${slug} (file not found)`);
        continue;
      }
      const src = fs.readFileSync(found, 'utf8');
      if (!/broadcastSound\s*\(/.test(src)) {
        missing.push(slug);
      }
    }
    expect(missing, `silent spells: ${missing.join(', ')}`).toEqual([]);
  });
});

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}
