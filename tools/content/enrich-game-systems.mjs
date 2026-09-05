#!/usr/bin/env node
// One-time/idempotent catalog normalizer. The shipped JSON intentionally
// contains every production rule explicitly so the admin editor shows the
// actual behavior instead of loader-only defaults.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = path.join(root, 'apps/scripts/src/data/config/game-systems.json');
const rows = JSON.parse(fs.readFileSync(target, 'utf8'));

// Classify the leading intent rather than matching arbitrary substrings.
// The older broad regex treated `reward` as war, `warn` as war and every
// stage mentioning a boss as a kill. A false bridge is dangerous because an
// unrelated world event could then advance the activity. Unknown verbs stay
// on the explicit, rate-limited activity action path.
const combat = /^(defeat|kill|slay|fight|survive|hold|defend|repel|assault|battle|bring down|take the enemy|break (the )?(boss|enemy|titan|outer wards|opposing defense|walls))/i;
const craft = /^(craft|build|rebuild|forge|cook|produce|brew|weave|construct|repair|restore (port|critical|public)|create|compose|complete the themed build)/i;
const trade = /^(deliver|trade|sell|buy|donate|supply|ship|move goods|turn in)/i;
const explore = /^(discover|explore|scout|map|travel|enter|find|survey|locate|excavate|navigate|track|reach|establish survey)/i;
const speech = /^(talk|interview|persuade|report|collect .*rumors?|question|present .*accusation|record .*verdict|negotiate|perform|publish|warn)/i;
const art = [0x14f0, 0x1869, 0x1f14, 0x2aaa, 0x0eed, 0x1f2d, 0x0f0e, 0x0fc4];

function slug(value) {
  return String(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 56);
}

function eventFor(name, archetype) {
  if (craft.test(name)) return 'craft:completed';
  if (trade.test(name)) return 'bod:turnedIn';
  if (explore.test(name)) return 'region:enter';
  if (speech.test(name)) return 'speech';
  if (combat.test(name)) return archetype === 'pvp' ? 'combat:damage' : 'mobile:killed';
  return 'activity:action';
}

function actionsFor(name, event) {
  const primary = slug(name).split('-').slice(0, 2).join('-') || 'attempt';
  if (event !== 'activity:action') return [primary, 'inspect-status'];
  return [...new Set([primary, 'assist', 'review'])];
}

for (const [systemIndex, row] of rows.entries()) {
  row.version ??= 1;
  row.entry ??= { gold: 0, tokens: 0 };
  row.availability ??= {
    maps: [], regions: [], daysOfWeek: [], startHourUtc: 0, endHourUtc: 24,
    minAccountAgeDays: 0, requiredCompletions: {},
  };
  row.antiExploit ??= {
    completionCooldownMinutes: Math.max(5, row.difficulty * 5),
    dailyCompletionLimit: ['raid', 'campaign'].includes(row.archetype) ? 3 : 10,
    maxActionsPerMinute: 30,
    maxEventContribution: Math.max(25, row.difficulty * 20),
    minParticipationPercent: row.party?.min > 1 ? 10 : 5,
    requireUniqueEventTarget: ['raid', 'hunt', 'campaign', 'exploration', 'expedition'].includes(row.archetype),
    accountWide: true,
  };
  row.reward ??= {
    gold: row.difficulty * 150,
    tokens: row.difficulty * 5,
    title: row.difficulty >= 7 ? `${row.name} Veteran` : '',
    reputation: row.difficulty * 2,
    unlocks: [`${row.id}-completed`],
    items: [{
      id: `${row.id}-sigil`, name: `${row.name} Sigil`,
      artId: art[systemIndex % art.length], hue: 1101 + (systemIndex % 80),
      amount: 1, chancePermille: row.difficulty >= 7 ? 350 : 200, accountBound: true,
    }],
  };
  row.stages = row.stages.map((stage, stageIndex) => {
    const generated = typeof stage === 'string'
      || String(stage?.description ?? '').includes('Progress is validated by the authoritative');
    if (!generated) return stage;
    const name = typeof stage === 'string' ? stage : stage.name;
    const event = eventFor(name, row.archetype);
    return {
      ...(typeof stage === 'object' ? stage : {}),
      id: stage?.id ?? `${slug(name)}-${stageIndex + 1}`.slice(0, 64),
      name,
      description: `${name}. Progress is validated by the authoritative ${event} event bridge.`,
      goal: stage?.goal ?? Math.max(10, row.difficulty * 8 + stageIndex * 6),
      event,
      skill: stage?.skill ?? row.skill,
      actions: actionsFor(name, event),
      allowManual: event === 'activity:action',
      targetKinds: stage?.targetKinds ?? [], sourceKinds: stage?.sourceKinds ?? [],
      regions: stage?.regions ?? [], maps: stage?.maps ?? [],
      uniqueTargets: event === 'mobile:killed' || event === 'region:enter' ? Math.max(3, row.difficulty) : 0,
      contributionCap: stage?.contributionCap ?? Math.max(10, row.difficulty * 12),
      nextStageByAction: stage?.nextStageByAction ?? {},
    };
  });
}

fs.writeFileSync(target, `${JSON.stringify(rows, null, 2)}\n`);
console.log(`Normalized ${rows.length} game systems in ${path.relative(root, target)}.`);
