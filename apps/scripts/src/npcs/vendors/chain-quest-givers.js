// Quest-chain NPC bindings — when a player double-clicks a quest-giver
// (Uzeraan / Mardoth / Sandra / Emino / etc.), the matching chain from
// data/world/quest-chains.json is offered or its current stage status shown.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const CHAINS_DATA = path.resolve(HERE, '../../data/world/quest-chains.json');

let CHAINS = {};
try { CHAINS = JSON.parse(fs.readFileSync(CHAINS_DATA, 'utf8')); } catch { /* optional */ }

// Map NPC name → chain ID. Built from the chain.giver field.
const NPC_TO_CHAIN = {};
for (const [id, def] of Object.entries(CHAINS)) {
  NPC_TO_CHAIN[def.giver] = id;
  // Also bind common aliases (Sage Humbolt for chain stages, etc.)
}

// Pretty NPC name → quest-giver tag (the canonical key used in JSON).
// Mirrors what scripts/npcs/templates/regional-npcs.js + townspeople.js
// register. Add aliases here as new chain givers are introduced.
const NAME_TO_GIVER = {
  'Uzeraan':                    'uzeraan',
  'Sandra':                     'sandra-of-trinsic',
  'Old Joh':                    'old-joh',
  'Emino':                      'emino',
  'Daimyo Tao':                 'daimyo-tao',
  'Sir Berran':                 'sir-berran',
  'Felean':                     'felean',
  'Hareus':                     'hareus',
  'Dr. Voltz':                  'dr-voltz',
  'Old Witch Hilde':            'old-witch-hilde',
  'Antiquarian Linus':          'antiquarian-linus',
  'Salty Pete':                 'salty-pete',
  'Elder Celcamoine':           'elder-celcamoine',
  'Elder Treefellow':           'elder-treefellow',
  'Wandering Naturalist':       'wandering-naturalist',
  'Stable Master Merivin':      'stable-master-merivin',
  'Wanderer of Virtues':        'wanderer-of-virtues',
  'High Mage Apollo':           'high-mage-apollo',
  'Scholar of Solen':           'scholar-of-solen',
  'Necromancer Mardoth':        'necromancer-mardoth',
};

export default function register(api) {
  if (!api.events) return () => {};

  function handler(ev) {
    const player = ev.player ?? ev.sender;
    const npc = ev.target;
    if (!player?.client || !npc) return;
    const giverTag = NAME_TO_GIVER[npc.name];
    if (!giverTag) return;
    const chainId = NPC_TO_CHAIN[giverTag];
    if (!chainId) return;
    const def = CHAINS[chainId];
    const sys = api.systems?.questChains;
    const prog = sys?.status?.(player, chainId);
    const lines = [`${npc.name}: "${def.intro}"`];
    if (!prog) {
      lines.push(`  → Use [chain start ${chainId} to accept.`);
    } else if (prog.completed) {
      lines.push('  "You have already proven yourself in this trial."');
    } else {
      const stage = def.stages[prog.stage];
      lines.push(`  Active stage: ${stage?.title ?? '?'}`);
      lines.push(`  Use [chain status ${chainId} for objectives.`);
    }
    for (const l of lines) player.client.sendSystemMessage(l);
  }

  api.events.on?.('mob:doubleclick', handler);
  api.events.on?.('mobile:doubleclick', handler);

  return () => {
    api.events.off?.('mob:doubleclick', handler);
    api.events.off?.('mobile:doubleclick', handler);
  };
}
