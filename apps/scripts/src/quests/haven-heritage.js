// Haven Heritage Quests — port of ServUO `Scripts/Quests/Haven/`.
// New-Trammel starter island chain that gates Lord Avery's blessing on
// three small errands. Stage layout follows the ServUO Heritage Quest
// scripts collapsed to three stages so the test bot can run start →
// finish in under a minute.
//
//   Stage 1: "Find the Crystal"
//     Talk to Lord Avery, retrieve a Mana Crystal from a beach trove.
//   Stage 2: "Healer's Errand"
//     Bring a healing potion to the wounded knight at Old Haven Mill.
//   Stage 3: "The Blessing"
//     Return to Lord Avery for the Heritage Blessing reward.

const STAGES = [
  {
    id: 'haven-1-crystal',
    title: 'Find the Crystal',
    summary: 'Speak with Lord Avery, then retrieve the Mana Crystal from the beach trove.',
    objectives: [
      { kind: 'talk-to', npc: 'lord-avery', done: false },
      { kind: 'collect', resource: 'haven-mana-crystal', count: 1, have: 0, done: false },
    ],
    reward: { tokens: 25 },
  },
  {
    id: 'haven-2-healer',
    title: "Healer's Errand",
    summary: 'Bring a Greater Healing potion to Sir Galwen at Old Haven Mill.',
    objectives: [
      { kind: 'collect', resource: 'greater-heal-potion', count: 1, have: 0, done: false },
      { kind: 'turn-in', npc: 'sir-galwen', done: false },
    ],
    reward: { tokens: 50 },
  },
  {
    id: 'haven-3-blessing',
    title: 'The Heritage Blessing',
    summary: 'Return to Lord Avery and receive his blessing.',
    objectives: [
      { kind: 'turn-in', npc: 'lord-avery', done: false },
    ],
    reward: { items: ['heritage-blessing-bracelet'], tokens: 250 },
  },
];

export default function register(api) {
  if (!api.commands) return () => {};

  function questOf(mob) {
    mob.quests ??= {};
    mob.quests['haven-heritage'] ??= { stage: 0, started: false };
    return mob.quests['haven-heritage'];
  }

  api.commands.register({
    name: 'haven-start',
    help: '[haven-start — begin the Haven Heritage chain.',
    access: 'Player',
    run(ctx) {
      const q = questOf(ctx.sender);
      if (q.started) {
        ctx.state.sendSystemMessage(`Stage ${q.stage + 1}: ${STAGES[q.stage].title}`);
        return;
      }
      q.started = true; q.stage = 0;
      ctx.state.sendSystemMessage(`Quest accepted: ${STAGES[0].title}`);
      ctx.state.sendSystemMessage(STAGES[0].summary);
    },
  });

  api.commands.register({
    name: 'haven-status',
    help: '[haven-status — Haven Heritage progress.',
    access: 'Player',
    run(ctx) {
      const q = questOf(ctx.sender);
      if (!q.started) { ctx.state.sendSystemMessage('You have not started the Haven chain.'); return; }
      const s = STAGES[q.stage];
      ctx.state.sendSystemMessage(`Stage ${q.stage + 1}/${STAGES.length}: ${s.title}`);
      ctx.state.sendSystemMessage(s.summary);
      for (const obj of s.objectives) {
        const mark = obj.done ? '[X]' : '[ ]';
        const detail = obj.count ? `${obj.have ?? 0}/${obj.count}` : obj.npc ?? obj.target ?? '';
        ctx.state.sendSystemMessage(`  ${mark} ${obj.kind} ${detail}`);
      }
    },
  });

  api.commands.register({
    name: 'haven-advance',
    help: '[haven-advance <idx> — admin tick.',
    access: 'Admin',
    run(ctx, args) {
      const q = questOf(ctx.sender);
      const stage = STAGES[q.stage];
      const obj = stage?.objectives?.[parseInt(args?.[0] ?? '0', 10)];
      if (!obj) { ctx.state.sendSystemMessage('Bad index.'); return; }
      if (obj.count) obj.have = Math.min(obj.count, (obj.have | 0) + 1);
      if (!obj.count || obj.have >= obj.count) obj.done = true;
      if (stage.objectives.every((o) => o.done)) {
        ctx.state.sendSystemMessage(`Stage complete: ${stage.title}.`);
        const r = stage.reward;
        if (r?.tokens) ctx.sender.questTokens = (ctx.sender.questTokens | 0) + r.tokens;
        if (q.stage + 1 < STAGES.length) {
          q.stage++;
          ctx.state.sendSystemMessage(`Next: ${STAGES[q.stage].title}`);
        } else {
          ctx.state.sendSystemMessage('Haven Heritage complete!');
        }
      }
    },
  });

  return () => {
    api.commands.unregister('haven-start');
    api.commands.unregister('haven-status');
    api.commands.unregister('haven-advance');
  };
}

export { STAGES as HAVEN_STAGES };
