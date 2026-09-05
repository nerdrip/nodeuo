// Inscription — complete spell-scroll recipe catalogue.
//
// The authored spell registry supplies names and stable spell ids, while the
// matrices below mirror ServUO DefInscription's recipe-only requirements.
// Magery, Necromancy and Mysticism have scroll items; Chivalry, Bushido,
// Ninjitsu and Spellweaving deliberately do not.

import { ALL as SPELLS } from '../spells/index.js';

const SKILL_INSCRIPTION = 24;
const BLANK_SCROLL = 0x0E34;
const MAGERY_SCROLL_BASE = 0x1F2D;
const NECRO_SCROLL_BASE = 0x2260;
const MYSTIC_SCROLL_BASE = 0x2D9E;

const R = Object.freeze({
  BP: 0x0F7A, BM: 0x0F7B, GA: 0x0F84, GI: 0x0F85,
  MR: 0x0F86, NS: 0x0F88, SA: 0x0F8C, SS: 0x0F8D,
  BW: 0x0F78, GD: 0x0F8F, DB: 0x0F7D, NC: 0x0F8E,
  PI: 0x0F8A, BO: 0x0F7E, DN: 0x0F80, FD: 0x0F81,
  DR: 0x4077,
});

// Indexed by Magery spell id - 1.
const MAGERY_REGS = [
  ['BM','NS'], ['GA','GI','MR'], ['NS','GI'], ['GA','GI','SS'], ['SA'], ['SS','SA'], ['GA','SS','SA'], ['GA','NS'],
  ['BM','MR'], ['NS','MR'], ['GA','GI'], ['NS','SS'], ['GA','SS','SA'], ['BM','SA'], ['GA','GI','SA'], ['NS','MR'],
  ['GA','MR'], ['BP'], ['BM','GA','SA'], ['NS'], ['BM','MR'], ['BM','MR'], ['BM','SA'], ['BM','GA'],
  ['GA','GI','MR'], ['GA','GI','MR','SA'], ['GA','NS','SA'], ['BP','SS','SA'], ['GA','SS','MR','GI'], ['MR','SA'], ['BP','SS','MR'], ['BP','BM','MR'],
  ['BP','NS','MR'], ['BP','GA','SS','SA'], ['BM','GA','NS'], ['GA','MR','SS'], ['BP','MR','NS','SA'], ['GA','MR','SS'], ['BP','NS','SS'], ['BM','MR','SS'],
  ['GA','MR','SA'], ['BP','NS'], ['BM','MR'], ['BM','NS'], ['BM','BP','MR'], ['GA','MR','NS','SA'], ['BP','GI','SS'], ['BM','SA'],
  ['BP','BM','MR','SA'], ['BP','MR','SS','SA'], ['SS','SA'], ['BP','MR','SA'], ['BP','BM','MR','SS'], ['BP','GA','MR','SA'], ['BM','MR','SA','SS'], ['BM','MR','SS'],
  ['BM','MR','GI','SA'], ['BP','BM','MR','NS'], ['BM','GA','GI'], ['BM','MR','SS'], ['BM','MR','SS','SA'], ['BM','MR','SS'], ['BM','MR','SS','SA'], ['BM','MR','SS'],
];

const MAGERY_MIN = [-250, -108, 35, 178, 321, 464, 607, 750];
const MAGERY_MANA = [4, 6, 9, 11, 14, 20, 40, 50];

const NECRO_MIN = [396,196,196,196,196,396,696,296,196,496,646,296,986,796,596,196,796];
const NECRO_REGS = [
  ['GD','DB'], ['DB'], ['BW','GD'], ['PI'], ['BW','NC'], ['BW','DB'],
  ['GD','DB','NC'], ['BW','DB','PI'], ['GD','PI'], ['NC'], ['DB','NC'],
  ['BW','GD','DB'], ['BW','NC','PI'], ['BW','GD','PI'], ['GD','NC','PI'],
  ['NC','PI'], ['NC','GD'],
];

const MYSTIC_MIN = [0,0,0,0,35,35,178,178,321,321,464,464,607,607,750,750];
const MYSTIC_MANA = [4,4,6,6,9,9,11,11,14,14,20,20,40,40,50,50];
const MYSTIC_REGS = [
  ['SA','BP'], ['BO','GA','GI','SS'], ['FD','GA','MR','SA'], ['SS','MR','SA'],
  ['SS','BP','NS'], ['SS','BM','MR','BO'], ['BO','BP','MR','NS'], ['BM','FD','GA'],
  ['SS','MR','GA','DR'], ['SS','NS','GI'], ['GI','GA','DR','MR'], ['GA','DR','SA','BM'],
  ['DN','DR','MR','NS','SA','DN'], ['DR','BP','MR','BM'], ['BM','NS','SA','MR'], ['DN','FD','DR','NS','MR'],
];

function ingredients(codes) {
  const counts = new Map([[BLANK_SCROLL, 1]]);
  for (const code of codes) counts.set(R[code], (counts.get(R[code]) ?? 0) + 1);
  return [...counts].map(([itemId, count]) => ({ itemId, count }));
}

function recipe(spell, index, school) {
  if (school === 'magery') {
    const circle = Math.max(1, Math.min(8, spell.circle | 0));
    return {
      id: 22_000 + spell.id, name: `${spell.name} Scroll`, category: `Circle ${circle}`,
      skillId: SKILL_INSCRIPTION, minSkill: MAGERY_MIN[circle - 1], maxSkill: MAGERY_MIN[circle - 1] + 500,
      outputItemId: MAGERY_SCROLL_BASE + spell.id - 1, outputCount: 1,
      inputs: ingredients(MAGERY_REGS[spell.id - 1]), manaCost: MAGERY_MANA[circle - 1],
      toolKind: 'inscribe', requiresSpell: spell.id, exceptionalChance: 0,
    };
  }
  if (school === 'necromancy') {
    return {
      // Keep the pre-audit 22101..22117 recipe ids stable so saved crafting
      // favourites and admin references continue to resolve after reload.
      id: 22_101 + index, name: `${spell.name} Scroll`, category: 'Necromancy',
      skillId: SKILL_INSCRIPTION, minSkill: NECRO_MIN[index], maxSkill: NECRO_MIN[index] + 10,
      outputItemId: NECRO_SCROLL_BASE + index, outputCount: 1,
      inputs: ingredients(NECRO_REGS[index]), manaCost: spell.mana | 0,
      toolKind: 'inscribe', requiresSpell: spell.id, exceptionalChance: 0,
    };
  }
  return {
    id: 22_200 + index, name: `${spell.name} Scroll`, category: 'Mysticism',
    skillId: SKILL_INSCRIPTION, minSkill: MYSTIC_MIN[index], maxSkill: MYSTIC_MIN[index] + 10,
    outputItemId: MYSTIC_SCROLL_BASE + index, outputCount: 1,
    inputs: ingredients(MYSTIC_REGS[index]), manaCost: MYSTIC_MANA[index],
    toolKind: 'inscribe', requiresSpell: spell.id, exceptionalChance: 0,
  };
}

function schoolSpells(school) {
  return SPELLS.filter((spell) => spell.school === school).sort((a, b) => a.id - b.id);
}

export default function register(api) {
  const sys = api.systems?.crafting;
  if (!sys?.registerRecipe) {
    api.log?.('crafting/inscription: engine missing, skipping');
    return () => {};
  }
  const definitions = [
    ...schoolSpells('magery').map((spell, index) => recipe(spell, index, 'magery')),
    ...schoolSpells('necromancy').map((spell, index) => recipe(spell, index, 'necromancy')),
    ...schoolSpells('mysticism').map((spell, index) => recipe(spell, index, 'mysticism')),
  ];
  let count = 0;
  const owned = [];
  for (const definition of definitions) {
    const registered = sys.registerRecipe(definition);
    if (registered !== false) {
      owned.push(registered ?? sys.getRecipe?.(definition.id) ?? definition);
      count++;
    }
  }
  api.log?.(`crafting/inscription: registered ${count} recipes`);
  return () => { for (const definition of owned) sys.unregisterRecipe?.(definition.id, definition); };
}
