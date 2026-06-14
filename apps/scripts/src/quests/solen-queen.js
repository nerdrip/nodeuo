// Ambitious Solen Queen quest line. Mirrors
// `templates/ServUO/Scripts/Quests/AmbitiousSolenQueen/`:
//
//   Stage 1: "Solen Diplomat"
//     Speak with Mar'Kuhl-Lyn (Red Solen) or Vir-Mahal (Black Solen).
//     Choose a side in the Solen war.
//
//   Stage 2: "Sapphire Crystals"
//     Recover 25 Sapphire crystals from the Hive.
//
//   Stage 3: "Slay the Other Queen"
//     Travel to the rival hive entrance and slay 3 Solen Warriors,
//     1 Solen Worker, and steal 1 Solen Egg.
//
//   Stage 4: "Coronation"
//     Return to your chosen Solen — receive a Solen Crown of Power
//     (skill-bonus talisman with +5 Magery / Wrestling / Anatomy).
//
// Reward path: Red side → +5 Magery talisman; Black side → +5 Wrestling.

const STAGES = [
  {
    id: 'solen-1-diplomat',
    title: 'Solen Diplomat',
    objectives: [
      { kind: 'talk-to', npc: 'solen-emissary', done: false },
      { kind: 'choose-side', sides: ['red', 'black'], chosen: null },
    ],
  },
  {
    id: 'solen-2-sapphire-crystals',
    title: 'Sapphire Crystals',
    objectives: [
      { kind: 'collect', resource: 'sapphire-crystal', count: 25, have: 0, done: false },
      { kind: 'turn-in', npc: 'solen-emissary', done: false },
    ],
    reward: { tokens: 200 },
  },
  {
    id: 'solen-3-rival-attack',
    title: 'Slay the Other Queen',
    objectives: [
      { kind: 'slay', target: 'solen-warrior', count: 3, have: 0, done: false },
      { kind: 'slay', target: 'solen-worker',  count: 1, have: 0, done: false },
      { kind: 'collect', resource: 'solen-egg', count: 1, have: 0, done: false },
    ],
    reward: { tokens: 500 },
  },
  {
    id: 'solen-4-coronation',
    title: 'Coronation',
    objectives: [{ kind: 'talk-to', npc: 'solen-queen', done: false }],
    reward: {
      items: ['solen-crown-of-power'],
      tokens: 1000,
    },
  },
];

export default function register(api) {
  if (!api.commands) return () => {};

  function questOf(mob) {
    mob.quests ??= {};
    mob.quests['solen-queen'] ??= { stage: 0, started: false };
    return mob.quests['solen-queen'];
  }

  api.commands.register({
    name: 'solen-start',
    help: '[solen-start — begin Ambitious Solen Queen quest.',
    access: 'Player',
    run(ctx) {
      const q = questOf(ctx.sender);
      if (q.started) {
        ctx.state.sendSystemMessage('You\'re already in service to the Solen.');
        return;
      }
      q.started = true;
      q.stage = 0;
      ctx.state.sendSystemMessage('Quest accepted: Solen Diplomat.');
      ctx.state.sendSystemMessage('Speak with the Solen emissary at the Hive entrance.');
    },
  });

  api.commands.register({
    name: 'solen-side',
    help: '[solen-side <red|black> — choose your Solen allegiance.',
    access: 'Player',
    run(ctx) {
      const q = questOf(ctx.sender);
      if (!q.started || q.stage !== 0) {
        ctx.state.sendSystemMessage('You must first speak with the emissary.');
        return;
      }
      const side = String(ctx.args[0] ?? '').toLowerCase();
      if (side !== 'red' && side !== 'black') {
        ctx.state.sendSystemMessage('Choose: red or black.');
        return;
      }
      const chooseObj = STAGES[0].objectives.find((o) => o.kind === 'choose-side');
      if (chooseObj) chooseObj.chosen = side;
      q.side = side;
      ctx.state.sendSystemMessage(`You have aligned with the ${side} Solen.`);
    },
  });

  api.commands.register({
    name: 'solen-status',
    help: '[solen-status — show Solen quest progress.',
    access: 'Player',
    run(ctx) {
      const q = questOf(ctx.sender);
      if (!q.started) {
        ctx.state.sendSystemMessage('You have not joined the Solen war.');
        return;
      }
      const stage = STAGES[q.stage];
      ctx.state.sendSystemMessage(`Stage ${q.stage + 1}/${STAGES.length}: ${stage.title}`);
      ctx.state.sendSystemMessage(`Side: ${q.side ?? '(none)'}`);
    },
  });

  return () => {
    api.commands.unregister('solen-start');
    api.commands.unregister('solen-side');
    api.commands.unregister('solen-status');
  };
}

export { STAGES as SOLEN_STAGES };
