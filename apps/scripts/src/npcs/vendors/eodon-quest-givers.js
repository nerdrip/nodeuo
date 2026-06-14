// Eodon quest-giver NPC bindings — when a player double-clicks one of
// the regional Eodon named NPCs (Chief Maklak / Sage Atokk / Lorrak),
// open a system-message dialogue offering the appropriate tribe's
// available chains.

import { EODON_CHAINS } from '../../quests/eodon.js';

// Maps NPC name → tribe id (matches eodon.js EODON_TRIBES).
const NPC_TO_TRIBE = {
  'Chief Maklak':  'barako',
  'Sage Atokk':    'sakkhra',
  'Lorrak':        'kurak',
};

export default function register(api) {
  if (!api.events) return () => {};

  function handler(ev) {
    const player = ev.player ?? ev.sender;
    const npc = ev.target;
    if (!player?.client || !npc) return;
    const tribe = NPC_TO_TRIBE[npc.name];
    if (!tribe) return;
    // List quests of this tribe that the player has NOT completed.
    const lines = [`${npc.name}: "Greetings, traveler."`];
    const done = player._eodonQuests ?? {};
    const offered = EODON_CHAINS.filter((c) => c.tribe === tribe);
    let hasAny = false;
    for (const q of offered) {
      const st = done[q.id];
      if (st?.completed && st?.turnedIn) continue;
      hasAny = true;
      if (!st) lines.push(`  Available: [eodon-accept ${q.id}  — ${q.title}`);
      else if (st.completed) lines.push(`  Turn in: [eodon-turnin ${q.id}`);
      else lines.push(`  In-progress: ${q.title} (${st.progress})`);
    }
    if (!hasAny) lines.push('  "There is nothing more for you here, brave one."');
    for (const ln of lines) player.client.sendSystemMessage(ln);
  }

  api.events.on?.('mob:doubleclick', handler);
  api.events.on?.('mobile:doubleclick', handler);

  return () => {
    api.events.off?.('mob:doubleclick', handler);
    api.events.off?.('mobile:doubleclick', handler);
  };
}
