// Extract Prof.txt → professions.json.
// Mirrors ClassicUO ProfessionLoader semantics.
//
// Prof.txt format (text key-value blocks; UTF-8 / Latin-1):
//
//   Begin
//     Name        2000           ; cliloc id of category title
//     TrueName    "Warrior"      ; English fallback
//     Type        Profession     ; or Category
//     TopLevel    True / False
//     DescNumber  4002           ; cliloc body
//     PicNumber   5500           ; gumpart icon
//     NameNumber  4002           ; alias of Name
//     GumpName    ""             ; optional
//     Children { Knight, Magician }
//     Skill { Swordsmanship 30 }
//     Skill { Tactics 30 }
//     Skill { Anatomy 30 }
//     Skill { Healing 10 }
//     Stat { Strength 45 }
//     Stat { Dexterity 35 }
//     Stat { Intelligence 10 }
//   End
//
// CUO normalises this into a tree (Profession with Children pointing
// at sub-Professions or being terminal). Our output:
//
//   { count, byId: { <name>: { name, trueName, type, isCategory,
//                              desc, pic, gump, parent,
//                              children: [name…],
//                              skills: [[id, value],…],
//                              stats:  [[id, value],…] } } }
//
// `id` for skills is the canonical SkillIndex (0..58). Stats: 0=Str
// 1=Dex 2=Int. Where a value can't be resolved we keep the raw string.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Canonical skill name → SkillIndex (mirrors apps/scripts/src/data/skills.json
// — we keep a local copy so the extractor doesn't bind to runtime data).
const SKILL_INDEX = {
  alchemy: 1, anatomy: 2, animallore: 3, itemid: 4, armslore: 5,
  parrying: 6, begging: 7, blacksmithy: 8, bowcraft: 9, peacemaking: 10,
  camping: 11, carpentry: 12, cartography: 13, cooking: 14, detectinghidden: 15,
  discordance: 16, evalint: 17, healing: 18, fishing: 19, forensicevaluation: 20,
  herding: 21, hiding: 22, provocation: 23, inscription: 24, lockpicking: 25,
  magery: 26, magicresist: 27, tactics: 28, snooping: 29, musicianship: 30,
  poisoning: 31, archery: 32, spiritspeak: 33, stealing: 34, tailoring: 35,
  taming: 36, tasteid: 37, tinkering: 38, tracking: 39, veterinary: 40,
  swordsmanship: 41, macefighting: 42, fencing: 43, wrestling: 44, lumberjacking: 45,
  mining: 46, meditation: 47, stealth: 48, removetrap: 49, necromancy: 50,
  focus: 51, chivalry: 52, bushido: 53, ninjitsu: 54, spellweaving: 55,
  mysticism: 56, imbuing: 57, throwing: 58,
};

function skillId(name) {
  const k = String(name || '').toLowerCase().replace(/[\s-]/g, '');
  return SKILL_INDEX[k] ?? null;
}

function statId(name) {
  const k = String(name || '').toLowerCase();
  if (k.startsWith('str')) return 0;
  if (k.startsWith('dex')) return 1;
  if (k.startsWith('int')) return 2;
  return null;
}

export function extractProfessions(srcDir, outDir) {
  const path = join(srcDir, 'Prof.txt');
  if (!existsSync(path)) return { count: 0, skipped: true };
  const txt = readFileSync(path, 'utf-8').replace(/^\uFEFF/, '');

  const byId = {};
  let curr = null;
  let pending = null; // 'children' | 'skill' | 'stat'

  const lines = txt.split(/\r?\n/);
  for (let raw of lines) {
    let line = raw.replace(/;[^\n]*$/, '').trim();
    if (!line) continue;

    if (/^begin$/i.test(line)) {
      curr = { skills: [], stats: [], children: [], rawSkills: [], rawStats: [] };
      continue;
    }
    if (/^end$/i.test(line)) {
      if (curr) {
        const key = (curr.trueName || curr.name || `__${Object.keys(byId).length}`).trim();
        byId[key] = curr;
      }
      curr = null;
      continue;
    }
    if (!curr) continue;

    // Block scope (Children / Skill / Stat) — Prof.txt uses `{ … }`
    // either inline or multi-line.
    if (pending) {
      if (line.includes('}')) {
        pending = null;
        line = line.replace(/}/, '').trim();
        if (!line) continue;
      }
      _consumeListLine(curr, pending, line);
      continue;
    }

    const m = line.match(/^(\w+)\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let rest = m[2].trim();
    // Strip leading `=` if present.
    rest = rest.replace(/^=\s*/, '');
    // Strip surrounding quotes.
    rest = rest.replace(/^"(.*)"$/, '$1');

    if (key === 'children' || key === 'skill' || key === 'stat') {
      if (rest.startsWith('{') && rest.includes('}')) {
        // Inline block: `Skill { Swordsmanship 30 }`
        const inner = rest.replace(/^\{/, '').replace(/}.*$/, '').trim();
        _consumeListLine(curr, key, inner);
      } else if (rest.startsWith('{')) {
        pending = key;
        const inner = rest.replace(/^\{/, '').trim();
        if (inner) _consumeListLine(curr, key, inner);
      } else {
        // Some Prof.txt blocks use bare `Skill Swordsmanship 30`.
        _consumeListLine(curr, key, rest);
      }
      continue;
    }

    switch (key) {
      case 'name':       curr.name = rest; break;
      case 'truename':   curr.trueName = rest; break;
      case 'type':       curr.type = rest; curr.isCategory = /category/i.test(rest); break;
      case 'toplevel':   curr.topLevel = /true/i.test(rest); break;
      case 'descnumber': curr.desc = parseInt(rest, 10) || 0; break;
      case 'picnumber':  curr.pic = parseInt(rest, 10) || 0; break;
      case 'namenumber': curr.nameNumber = parseInt(rest, 10) || 0; break;
      case 'gumpname':   curr.gumpName = rest; break;
      default:           /* unknown key — keep raw */ break;
    }
  }

  // Resolve names → ids where possible.
  for (const key in byId) {
    const p = byId[key];
    p.skills = p.rawSkills.map(([name, val]) => [skillId(name), val, name]).filter((e) => e[0] != null);
    p.stats  = p.rawStats.map(([name, val]) => [statId(name), val, name]).filter((e) => e[0] != null);
    delete p.rawSkills; delete p.rawStats;
  }

  writeFileSync(join(outDir, 'professions.json'), JSON.stringify({
    count: Object.keys(byId).length,
    byId,
  }, null, 2));
  return { count: Object.keys(byId).length };
}

function _consumeListLine(curr, kind, line) {
  const parts = line.split(/\s+/).filter(Boolean);
  if (kind === 'children') {
    for (const c of parts) {
      const clean = c.replace(/[,{}]/g, '').trim();
      if (clean) curr.children.push(clean);
    }
    return;
  }
  if (kind === 'skill') {
    // "<skillName> <value>"
    if (parts.length >= 2) {
      const name = parts[0].replace(/[,{}]/g, '');
      const val = parseInt(parts[1], 10) || 0;
      curr.rawSkills.push([name, val]);
    }
    return;
  }
  if (kind === 'stat') {
    if (parts.length >= 2) {
      const name = parts[0].replace(/[,{}]/g, '');
      const val = parseInt(parts[1], 10) || 0;
      curr.rawStats.push([name, val]);
    }
    return;
  }
}
