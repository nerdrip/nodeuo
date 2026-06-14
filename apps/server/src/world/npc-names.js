// NPC name pool — picks a random first-name from the per-race/per-gender
// pool extracted from ServUO's Data/names.xml (see tools/extractors/extract-names.mjs
// and apps/scripts/src/data/config/npc-names.json).
//
// USAGE
//   import { pickNameForMob } from './world/npc-names.js';
//   const name = pickNameForMob(mob);            // generic auto: human male/female by body 400/401
//   const name = pickNameForMob(mob, { race: 'elf', gender: 'male' });
//
// Behaviour:
//   - body 400 → human male, 401 → human female
//   - body 605 → elf male, 606 → elf female (Mondain's Legacy)
//   - body 666/667 → gargoyle male/female (Stygian Abyss)
//   - body 183/184/185/186 → tokuno male/female fallback
//   - non-humanoid bodies: returns null (caller keeps cfg.name —
//     "a giant rat", "an ancient dragon", etc.)
//   - explicit opts win over body inference
//
// Determinism:
//   - Default uses Math.random.
//   - Pass opts.seed (uint32) for a stable pick keyed on the mob's serial;
//     this lets a spawned mob keep the same name across save/load even if
//     the persisted name field is missing for whatever reason (defense in
//     depth — persistence already round-trips the name).

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const POOL_PATH = path.resolve(HERE, '../../../scripts/src/data/config/npc-names.json');

let POOL = null;
function loadPool() {
  if (POOL) return POOL;
  try { POOL = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8')); }
  catch (e) {
    console.warn('[npc-names] pool load failed:', e.message);
    POOL = { human: { male: [], female: [] } };
  }
  return POOL;
}

const HUMAN_MALE   = new Set([400]);
const HUMAN_FEMALE = new Set([401]);
const ELF_MALE     = new Set([605]);
const ELF_FEMALE   = new Set([606]);
const GARG_MALE    = new Set([666]);
const GARG_FEMALE  = new Set([667]);

/** mulberry32 — small, fast, well-distributed PRNG keyed on a uint32. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/** @returns {{race:'human'|'elf'|'gargoyle'|'tokuno'|null, gender:'male'|'female'|null}} */
export function inferRace(body) {
  if (HUMAN_MALE.has(body))   return { race: 'human',    gender: 'male' };
  if (HUMAN_FEMALE.has(body)) return { race: 'human',    gender: 'female' };
  if (ELF_MALE.has(body))     return { race: 'elf',      gender: 'male' };
  if (ELF_FEMALE.has(body))   return { race: 'elf',      gender: 'female' };
  if (GARG_MALE.has(body))    return { race: 'gargoyle', gender: 'male' };
  if (GARG_FEMALE.has(body))  return { race: 'gargoyle', gender: 'female' };
  return { race: null, gender: null };
}

/**
 * Pick a name from a named pool (race + gender) or null when no pool fits.
 * @param {string} race  'human' | 'elf' | 'gargoyle' | 'tokuno' | string (monster key)
 * @param {string} gender  'male' | 'female'
 * @param {() => number} [rng]
 */
export function pickFromPool(race, gender, rng = Math.random) {
  const pool = loadPool();
  let arr = null;
  if (race === 'monster') arr = null;
  else if (pool[race]?.[gender]) arr = pool[race][gender];
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(rng() * arr.length)];
}

/** Pick a name for a monster archetype (centaur, daemon, lizardman, …).
 *  Returns null when the monster has no named pool. */
export function pickMonsterName(monsterKey, rng = Math.random) {
  const pool = loadPool();
  const arr = pool.monster?.[monsterKey];
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Pick a name for the freshly-spawned mob. Returns `null` when there is
 * no pool that fits (caller keeps whatever `cfg.name` was, e.g. "a giant
 * rat" or an authored unique like "Lord British").
 *
 * @param {object} mob       has at least `.body`
 * @param {object} [opts]
 * @param {'human'|'elf'|'gargoyle'|'tokuno'} [opts.race]
 * @param {'male'|'female'}                   [opts.gender]
 * @param {string} [opts.monster]    monster pool key (e.g. 'daemon')
 * @param {number} [opts.seed]       uint32 seed (stable picks)
 */
export function pickNameForMob(mob, opts = {}) {
  const rng = (typeof opts.seed === 'number') ? mulberry32(opts.seed) : Math.random;
  if (opts.monster) {
    return pickMonsterName(opts.monster, rng);
  }
  if (opts.race && opts.gender) {
    return pickFromPool(opts.race, opts.gender, rng);
  }
  const { race, gender } = inferRace(mob?.body | 0);
  if (race && gender) return pickFromPool(race, gender, rng);
  return null;
}

/** Test hook — drop the cached pool so the next pickFromPool re-reads it. */
export function _resetPoolForTests() { POOL = null; }
