// Parse UO's body / animation configuration files. Mirrors the
// `LoadBodyConv()` / `LoadBody()` / `LoadMobTypes()` blocks in
// ClassicUO.Assets/AnimationsLoader.cs.
//
// Output:
//   bodyConv  Map<bodyId, { fileIndex: 0..4, indexInFile: number }>
//   bodyAlias Map<aliasBodyId, { trueBody: number, hue: number }>
//   mobTypes  Map<bodyId, { type: 'MONSTER'|'ANIMAL'|'SEA'|'HUMAN'|'EQUIPMENT', flags: number }>

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function loadBodyConfig(srcDir) {
  const bodyConv = new Map();
  const bodyAlias = new Map();
  const mobTypes = new Map();
  /** body type -> Map<itemID, { animBody, gump, hue }> */
  const equipConv = new Map();
  /** body id (alive) -> { corpseBody, corpseHue } */
  const corpseConv = new Map();

  // ----- Bodyconv.def — `<index> <anim2> <anim3> <anim4> <anim5>`
  // Mirrors CUO `ProcessBodyConvDef`: walk all 4 cols and the LAST
  // non-(-1) wins (because `_bodyConvInfos[index] = ...` is overwritten
  // on each iteration). Earlier we took the FIRST non-(-1) which gave
  // wrong file routing for bodies present in multiple files.
  const bcPath = pickFile(srcDir, ['Bodyconv.def', 'bodyconv.def']);
  if (bcPath) {
    for (const line of textLines(bcPath)) {
      const t = line.split(/[\s\t]+/).filter(Boolean);
      if (t.length < 6) continue;
      const id = +t[0];
      if (Number.isNaN(id)) continue;
      const cols = [+t[1], +t[2], +t[3], +t[4]]; // anim2..anim5
      // Last non-(-1) wins.
      let fileIndex = -1, indexInFile = -1;
      for (let i = 0; i < 4; i++) {
        if (cols[i] >= 0) { fileIndex = i + 1; indexInFile = cols[i]; }
      }
      if (fileIndex < 0) continue;
      bodyConv.set(id, { fileIndex, indexInFile });
    }
  }

  // ----- Body.def — `<aliasBody> {<trueBody>} <hue>`
  const bPath = pickFile(srcDir, ['Body.def', 'body.def']);
  if (bPath) {
    for (const line of textLines(bPath)) {
      const m = /^\s*(\d+)\s*\{\s*(\d+)\s*\}\s*(\d+)/.exec(line);
      if (!m) continue;
      bodyAlias.set(+m[1], { trueBody: +m[2], hue: +m[3] });
    }
  }

  // ----- mobtypes.txt
  const mtPath = pickFile(srcDir, ['mobtypes.txt', 'Mobtypes.txt']);
  if (mtPath) {
    for (const line of textLines(mtPath)) {
      const t = line.split(/[\s\t]+/).filter(Boolean);
      if (t.length < 2) continue;
      const id = +t[0];
      const type = t[1];
      const flags = +t[2] || 0;
      if (Number.isNaN(id)) continue;
      mobTypes.set(id, { type, flags });
    }
  }

  // ----- Equipconv.def — `<bodyType> <itemID> <convertToID> <gumpID> <hue>`
  const ecPath = pickFile(srcDir, ['Equipconv.def', 'equipconv.def']);
  if (ecPath) {
    for (const line of textLines(ecPath)) {
      const t = line.split(/[\s\t]+/).filter(Boolean);
      if (t.length < 5) continue;
      const bodyType = +t[0];
      const itemID   = +t[1];
      const animBody = +t[2];
      const gump     = +t[3];
      const hue      = +t[4];
      if (Number.isNaN(bodyType) || Number.isNaN(itemID)) continue;
      let m = equipConv.get(bodyType);
      if (!m) { m = new Map(); equipConv.set(bodyType, m); }
      m.set(itemID, { animBody, gump, hue });
    }
  }

  // ----- Corpse.def — `<aliveBody> {<corpseBody>} <corpseHue>`
  const cPath = pickFile(srcDir, ['Corpse.def', 'corpse.def']);
  if (cPath) {
    for (const line of textLines(cPath)) {
      const m = /^\s*(\d+)\s*\{\s*(\d+)\s*\}\s*(-?\d+)/.exec(line);
      if (!m) continue;
      corpseConv.set(+m[1], { corpseBody: +m[2], corpseHue: +m[3] });
    }
  }

  return { bodyConv, bodyAlias, mobTypes, equipConv, corpseConv };
}

function pickFile(dir, names) {
  for (const n of names) {
    const p = join(dir, n);
    if (existsSync(p)) return p;
  }
  return null;
}

function* textLines(path) {
  const txt = readFileSync(path, 'utf-8');
  for (let line of txt.split(/\r?\n/)) {
    const idx = line.indexOf('#');
    if (idx >= 0) line = line.slice(0, idx);
    line = line.trim();
    if (!line) continue;
    yield line;
  }
}

// ---------------------------------------------------------------------------
// CUO `CalculateOffset` port. Each anim*.idx file is a single contiguous
// table laid out as [monsters | animals | humans] with fixed strides per
// group:
//   - High (Monster, SeaMonster):  body * 110  entries  (22 actions × 5 dirs)
//   - Low  (Animal):              (body-200) * 65 + 22000 entries (13 × 5)
//   - People (Human, Equipment):  (body-400) * 175 + 35000 entries (35 × 5)
// The earlier extractor used a uniform `body * stride` formula which
// landed on the wrong rows for bodies ≥ 200 (animals) and ≥ 400 (humans).
// Player body 400 was reading at byte 70000*12 instead of 35000*12,
// which is why every player avatar rendered blank or as a clothing
// fragment from a higher body id.

/** Group identifier used by CUO. */
export const GROUP = {
  High: 'High',
  Low: 'Low',
  People: 'People',
};

/** Compute the IDX entry index of (body, action 0, dir 0) for a group. */
export function groupBaseIndex(body, group) {
  switch (group) {
    case GROUP.People: return (body - 400) * 175 + 35000;
    case GROUP.Low:    return (body - 200) * 65 + 22000;
    case GROUP.High:   return body * 110;
    default:           return body * 110;
  }
}

/** Action count for a group (CUO `<Group>AnimationGroup.AnimationCount`). */
export function groupActionCount(group) {
  switch (group) {
    case GROUP.People: return 35;
    case GROUP.Low:    return 13;
    case GROUP.High:   return 22;
    default:           return 22;
  }
}

/** CUO `CalculateTypeByGraphic` — file-aware fallback when mobtypes is silent. */
export function calculateTypeByGraphic(graphic, fileIndex = 0) {
  if (fileIndex === 1) {
    // anim2.mul: <200 = Monster, ≥200 = Animal
    return graphic < 200 ? GROUP.High : GROUP.Low;
  }
  if (fileIndex === 2) {
    // anim3.mul: <300 = Animal, <400 = Monster, ≥400 = Human
    if (graphic < 300) return GROUP.Low;
    if (graphic < 400) return GROUP.High;
    return GROUP.People;
  }
  // anim.mul / anim4.mul / anim5.mul: <200 Monster, <400 Animal, ≥400 Human
  if (graphic < 200) return GROUP.High;
  if (graphic < 400) return GROUP.Low;
  return GROUP.People;
}

/** Map mobtypes string → CUO group. */
export function groupForMobType(type) {
  switch (type) {
    case 'HUMAN':     return GROUP.People;
    case 'EQUIPMENT': return GROUP.People; // Equipment animates with People frames
    case 'ANIMAL':    return GROUP.Low;
    case 'MONSTER':   return GROUP.High;
    case 'SEA':
    case 'SEAMONSTER': return GROUP.High;  // SeaMonster offset = High
    default:          return null;
  }
}

/** Pick the anim file that holds this body. CUO defaults to file 0
 *  (anim.mul) for everything that doesn't have an explicit Bodyconv.def
 *  override — including HUMAN / EQUIPMENT bodies. The earlier heuristic
 *  routed every HUMAN to file 4 (anim5.mul) which is for late-expansion
 *  bodies; player body 400 lives in anim.mul and was never extracted. */
export function pickAnimFile(body, bodyConv /*, mobTypes */) {
  const conv = bodyConv.get(body);
  if (conv) return conv.fileIndex;
  return 0;
}

/** Resolve `(body, fileIndex, action, dir)` → idx index within the chosen
 *  anim file. Mirrors CUO `GetIndices` + `CalculateOffset`. */
export function resolveIdxIndex(body, fileIndex, action, direction, bodyConv, mobTypes) {
  // bodyConv override may swap the body id used for the offset math.
  // CUO: `body = bodyConvInfo.Graphic; fileIndex = bodyConvInfo.FileIndex`.
  const conv = bodyConv.get(body);
  let realBody = body;
  if (conv) {
    if (conv.fileIndex !== fileIndex) return -1;  // not the file we asked for
    realBody = conv.indexInFile;
  }
  // Determine the animation group: mobtypes.txt entry first (keyed by
  // ORIGINAL body id, before bodyConv redirect — matches CUO ordering),
  // else fall back to per-file body-range inference.
  const mt = mobTypes.get(body)?.type;
  const group = groupForMobType(mt) ?? calculateTypeByGraphic(realBody, fileIndex);
  const baseEntry = groupBaseIndex(realBody, group);
  if (baseEntry < 0) return -1;
  const maxAction = groupActionCount(group);
  if (action >= maxAction) return -1;
  return baseEntry + action * 5 + direction;
}

/** @deprecated retained only for legacy diag scripts. */
export function getStride(fileIndex, mobType) {
  const group = groupForMobType(mobType) ?? calculateTypeByGraphic(0, fileIndex);
  return groupActionCount(group) * 5;
}
