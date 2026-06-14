// SkillMod / StatMod / ResistanceMod — temporary modifier stacks.
//
// Mirrors ServUO `Server/Mobile.cs` SkillMod/StatMod and the modifier
// list that hangs off every Mobile. Each modifier:
//   - has a unique `name` (the same name re-applied REPLACES the old
//     entry; that's how Bless re-cast on a target works in ServUO)
//   - either lasts forever (`durationMs: 0`) or expires after a timeout
//   - is `relative` (added to base) or `absolute` (overrides base when active)
//
// Helpers below let callers:
//   - addSkillMod(mob, { name, skillId, offset, relative, durationMs })
//   - addStatMod(mob, { name, stat, offset, relative, durationMs })
//   - addResistanceMod(mob, { name, kind, offset, durationMs })
//   - effectiveSkill(mob, skillId)
//   - effectiveStat(mob, stat)            // stat ∈ {'str','dex','int'}
//   - effectiveResist(mob, kind)
//   - tickModifiers(mob, now=Date.now())  — drop expired entries
//
// Modifiers are stored on `mob._skillMods / _statMods / _resistMods`
// (lazily initialised). Expiry is lazy (checked on read + on tick) so we
// don't need a per-mod timer.

import { normalizeSkillValue } from '../combat-formulas.js';

/** @typedef {{name:string, offset:number, relative:boolean, expiresAt:number}} ModEntry */

function arr(mob, key) {
  if (!mob[key]) mob[key] = new Map();
  return mob[key];
}

function expired(m, now) { return m.expiresAt > 0 && m.expiresAt <= now; }

/** Generic add — replace existing entry with same `name`. */
function addMod(map, key, entry) {
  map.set(key + '|' + entry.name, entry);
}

/** Walk modifiers under (key prefix). Returns
 *    { abs: <number|null>, rel: <number> }
 *  where `abs` is the highest absolute override (or null if none),
 *  and `rel` is the sum of relative offsets. Caller decides how to
 *  combine with base — typically `abs ?? (base + rel)`. */
function reduceMods(map, key, now) {
  let rel = 0;
  let abs = null;
  if (!map) return { abs, rel };
  for (const [k, m] of map) {
    if (!k.startsWith(key + '|')) continue;
    if (expired(m, now)) continue;
    if (m.relative) rel += m.offset;
    else if (abs === null || m.offset > abs) abs = m.offset;
  }
  return { abs, rel };
}

// ---- Skills ---------------------------------------------------------------

export function addSkillMod(mob, { name, skillId, offset, relative = true, durationMs = 0 }) {
  const map = arr(mob, '_skillMods');
  addMod(map, String(skillId | 0), {
    name, offset: offset | 0, relative,
    expiresAt: durationMs > 0 ? Date.now() + durationMs : 0,
  });
}

export function removeSkillMod(mob, name, skillId) {
  if (!mob._skillMods) return;
  mob._skillMods.delete(String(skillId | 0) + '|' + name);
}

/** Effective skill value: absolute override if any, else base + relative sum. */
export function effectiveSkill(mob, skillId, now = Date.now()) {
  const skills = mob?.skills ?? {};
  const base = normalizeSkillValue(skills[skillId] ?? skills[String(skillId)] ?? 0);
  const { abs, rel } = reduceMods(mob._skillMods, String(skillId | 0), now);
  return abs !== null ? abs : base + rel;
}

// ---- Stats (str/dex/int) --------------------------------------------------

export function addStatMod(mob, { name, stat, offset, relative = true, durationMs = 0 }) {
  const map = arr(mob, '_statMods');
  addMod(map, String(stat), {
    name, offset: offset | 0, relative,
    expiresAt: durationMs > 0 ? Date.now() + durationMs : 0,
  });
}

export function removeStatMod(mob, name, stat) {
  if (!mob._statMods) return;
  mob._statMods.delete(String(stat) + '|' + name);
}

export function effectiveStat(mob, stat, now = Date.now()) {
  const base = (mob[stat] ?? 0) | 0;
  const { abs, rel } = reduceMods(mob._statMods, String(stat), now);
  return abs !== null ? abs : base + rel;
}

// ---- Resistances ----------------------------------------------------------
// Kinds: 'fire','cold','poison','energy','physical'.

export function addResistanceMod(mob, { name, kind, offset, durationMs = 0 }) {
  const map = arr(mob, '_resistMods');
  addMod(map, String(kind), {
    name, offset: offset | 0, relative: true,
    expiresAt: durationMs > 0 ? Date.now() + durationMs : 0,
  });
}

export function removeResistanceMod(mob, name, kind) {
  if (!mob._resistMods) return;
  mob._resistMods.delete(String(kind) + '|' + name);
}

export function effectiveResist(mob, kind, now = Date.now()) {
  const base = (mob[`${kind}Resist`] ?? 0) | 0;
  const { abs, rel } = reduceMods(mob._resistMods, String(kind), now);
  return abs !== null ? abs : base + rel;
}

// ---- Tick / cleanup -------------------------------------------------------

/** Drop expired entries across all three lists. Cheap to call from a
 *  1-second world tick — for inactive mobs all three maps are empty. */
export function tickModifiers(mob, now = Date.now()) {
  for (const key of ['_skillMods', '_statMods', '_resistMods']) {
    const map = mob[key];
    if (!map || map.size === 0) continue;
    for (const [k, m] of map) {
      if (expired(m, now)) map.delete(k);
    }
  }
}
