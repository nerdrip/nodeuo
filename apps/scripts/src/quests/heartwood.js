// Heartwood Quests — port of ServUO `Scripts/Quests/Heartwood/`.
// Elven settlement task chain unrelated to the ML main story (those
// already live in mondains-legacy.js). Three short flavour stages.
//
//   Stage 1: "Forest Patrol" — slay 5 corrupted dryads.
//   Stage 2: "Lily Gather"   — bring 4 night-blooming lilies.
//   Stage 3: "The Heartwood Charm" — return to Sarsmera for the reward.

const STAGES = [
  {
    id: 'hw-1-patrol',
    title: 'Forest Patrol',
    summary: 'Slay 5 corrupted dryads in the Heart Wood.',
    objectives: [
      { kind: 'slay', target: 'corrupted-dryad', count: 5, have: 0, done: false },
    ],
    reward: { tokens: 75 },
  },
  {
    id: 'hw-2-lilies',
    title: 'Lily Gather',
    summary: 'Bring 4 Night-Blooming Lilies to Lyriel.',
    objectives: [
      { kind: 'collect', resource: 'night-lily', count: 4, have: 0, done: false },
      { kind: 'turn-in', npc: 'lyriel', done: false },
    ],
    reward: { tokens: 150 },
  },
  {
    id: 'hw-3-charm',
    title: 'The Heartwood Charm',
    summary: 'Speak to Sarsmera at the Heartwood circle to receive the charm.',
    objectives: [
      { kind: 'turn-in', npc: 'sarsmera', done: false },
    ],
    reward: { items: ['heartwood-charm'], tokens: 350 },
  },
];

export default function register(api) {
  if (!api.commands) return () => {};

  function questOf(mob) {
    mob.quests ??= {};
    mob.quests['heartwood'] ??= { stage: 0, started: false };
    return mob.quests['heartwood'];
  }

  api.commands.register({
    name: 'hw-start',
    help: '[hw-start — begin the Heartwood Quests.',
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
    name: 'hw-status',
    help: '[hw-status — Heartwood quest progress.',
    access: 'Player',
    run(ctx) {
      const q = questOf(ctx.sender);
      if (!q.started) { ctx.state.sendSystemMessage('You have not started the Heartwood chain.'); return; }
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
    name: 'hw-advance',
    help: '[hw-advance <idx> — admin tick.',
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
          ctx.state.sendSystemMessage('Heartwood quest chain complete!');
        }
      }
    },
  });

  return () => {
    api.commands.unregister('hw-start');
    api.commands.unregister('hw-status');
    api.commands.unregister('hw-advance');
  };
}

export { STAGES as HW_STAGES };
