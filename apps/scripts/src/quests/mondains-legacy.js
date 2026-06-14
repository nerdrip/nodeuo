// Mondain's Legacy — multi-stage quest chain. Mirrors the structure of
// `templates/ServUO/Scripts/Quests/MondainsLegacy/`:
//
//   Stage 1: "The Twisted Weald"
//     Talk to Aelorn at Heartwood about the encroaching corruption.
//     Travel to the Twisted Weald and speak to Lady Yelena.
//
//   Stage 2: "Pixie Ambassador"
//     Yelena asks for proof — bring 5 Pixie Wings.
//     Reward: heartwood-shield, +250 quest tokens.
//
//   Stage 3: "Lord Oaks' Audience"
//     Yelena escorts player to Lord Oaks' grove.
//     Player witnesses Lord Oaks + Silvani.
//
//   Stage 4: "Heart of the Forest"
//     Lord Oaks sends player to slay 3 Treefellows in the Heart Wood.
//     Reward: ancient-greatsword, scroll of valor + 500 quest tokens.
//
//   Stage 5: "Bedlam Initiate"
//     A wraith summons player to Bedlam — investigate the asylum.
//     Reward: ML jewel set + access to Bedlam dungeon.
//
// Each stage hands out an "objective" record on the player which the
// quest UI reads. Completing all objectives flags the stage done and
// advances the chain.

const STAGES = [
  {
    id: 'ml-1-twisted-weald',
    title: 'The Twisted Weald',
    summary: 'Speak with Aelorn at Heartwood, then Lady Yelena at Twisted Weald.',
    objectives: [
      { kind: 'talk-to', npc: 'aelorn',     done: false },
      { kind: 'talk-to', npc: 'lady-yelena', done: false },
    ],
    reward: { tokens: 50 },
  },
  {
    id: 'ml-2-pixie-ambassador',
    title: 'Pixie Ambassador',
    summary: 'Bring 5 Pixie Wings to Lady Yelena.',
    objectives: [
      { kind: 'collect', resource: 'pixie-wing', count: 5, have: 0, done: false },
      { kind: 'turn-in', npc: 'lady-yelena', done: false },
    ],
    reward: { items: ['heartwood-shield'], tokens: 250 },
  },
  {
    id: 'ml-3-lord-oaks-audience',
    title: "Lord Oaks' Audience",
    summary: 'Travel with Yelena to the grove of Lord Oaks.',
    objectives: [
      { kind: 'escort', npc: 'lady-yelena', destination: 'oaks-grove', done: false },
      { kind: 'witness', target: 'lord-oaks', done: false },
    ],
    reward: { tokens: 100 },
  },
  {
    id: 'ml-4-heart-of-the-forest',
    title: 'Heart of the Forest',
    summary: 'Slay 3 Treefellows in the Heart Wood.',
    objectives: [
      { kind: 'slay', target: 'treefellow', count: 3, have: 0, done: false },
    ],
    reward: { items: ['ancient-greatsword', 'scroll-of-valor'], tokens: 500 },
  },
  {
    id: 'ml-5-bedlam-initiate',
    title: 'Bedlam Initiate',
    summary: 'Investigate Bedlam asylum and report your findings.',
    objectives: [
      { kind: 'visit', region: 'Bedlam', done: false },
      { kind: 'slay', target: 'pyromancer-wraith', count: 1, have: 0, done: false },
      { kind: 'turn-in', npc: 'wraith-elder', done: false },
    ],
    reward: { items: ['ml-jewel-set'], tokens: 1000 },
  },
];

export default function register(api) {
  if (!api.commands) return () => {};

  function questOf(mob) {
    mob.quests ??= {};
    mob.quests['mondains-legacy'] ??= { stage: 0, started: false };
    return mob.quests['mondains-legacy'];
  }

  api.commands.register({
    name: 'ml-start',
    help: '[ml-start — begin Mondain\'s Legacy quest chain.',
    access: 'Player',
    run(ctx) {
      const q = questOf(ctx.sender);
      if (q.started) {
        ctx.state.sendSystemMessage(`You're already on stage ${q.stage + 1}: ${STAGES[q.stage].title}`);
        return;
      }
      q.started = true;
      q.stage = 0;
      ctx.state.sendSystemMessage(`Quest accepted: ${STAGES[0].title}`);
      ctx.state.sendSystemMessage(STAGES[0].summary);
    },
  });

  api.commands.register({
    name: 'ml-status',
    help: '[ml-status — show quest progress.',
    access: 'Player',
    run(ctx) {
      const q = questOf(ctx.sender);
      if (!q.started) {
        ctx.state.sendSystemMessage('You have not started Mondain\'s Legacy.');
        return;
      }
      const stage = STAGES[q.stage];
      ctx.state.sendSystemMessage(`Stage ${q.stage + 1}/${STAGES.length}: ${stage.title}`);
      ctx.state.sendSystemMessage(stage.summary);
      for (const obj of stage.objectives) {
        const status = obj.done ? '[X]' : '[ ]';
        const detail = obj.count
          ? `${obj.have ?? 0}/${obj.count}`
          : obj.npc ?? obj.region ?? obj.target ?? '';
        ctx.state.sendSystemMessage(`  ${status} ${obj.kind} ${detail}`);
      }
    },
  });

  api.commands.register({
    name: 'ml-advance',
    help: '[ml-advance <objectiveIdx> — admin: tick an objective.',
    access: 'Admin',
    run(ctx) {
      const q = questOf(ctx.sender);
      const idx = Number(ctx.args[0] ?? 0) | 0;
      const stage = STAGES[q.stage];
      const obj = stage?.objectives?.[idx];
      if (!obj) {
        ctx.state.sendSystemMessage('Invalid objective index.');
        return;
      }
      if (obj.count) obj.have = Math.min(obj.count, (obj.have | 0) + 1);
      if (!obj.count || obj.have >= obj.count) obj.done = true;
      // All done?
      if (stage.objectives.every((o) => o.done)) {
        ctx.state.sendSystemMessage(`Stage complete: ${stage.title}!`);
        const reward = stage.reward;
        if (reward?.tokens) {
          ctx.sender.questTokens = (ctx.sender.questTokens | 0) + reward.tokens;
          ctx.state.sendSystemMessage(`+${reward.tokens} quest tokens.`);
        }
        if (reward?.items) {
          for (const itemKind of reward.items) {
            ctx.state.sendSystemMessage(`Reward item: ${itemKind}`);
          }
        }
        if (q.stage + 1 < STAGES.length) {
          q.stage++;
          ctx.state.sendSystemMessage(`Next: ${STAGES[q.stage].title}`);
        } else {
          ctx.state.sendSystemMessage('Mondain\'s Legacy complete!');
        }
      }
    },
  });

  return () => {
    api.commands.unregister('ml-start');
    api.commands.unregister('ml-status');
    api.commands.unregister('ml-advance');
  };
}

export { STAGES as ML_STAGES };
