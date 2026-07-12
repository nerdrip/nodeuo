// Heritage / lore quest pack — 5 additional 3-stage chains drawn from
// ServUO `Scripts/Quests/`. Each chain follows the same shape as
// haven-heritage.js: stages [], questOf(mob), `[<slug>-start/-status/
// -advance` commands. We share `register` via a small factory so the
// payload stays declarative.
//
// Quest sources (ServUO):
//   • Hawkwind          → Quests/Hawkwind*.cs            ('hawk')
//   • Eodon has its canonical, expanded implementation in quests/eodon.js.
//   • Tomb of Kings     → Quests/SA/TombOfKings.cs        ('tomb')
//   • Uzeraan Turmoil   → Quests/UzeraanTurmoil*.cs      ('uzeraan')
//   • Dark Tides        → Quests/DarkTides/*.cs          ('darktides')

function makeQuest(api, slug, label, stages) {
  function questOf(mob) {
    mob.quests ??= {};
    mob.quests[slug] ??= { stage: 0, started: false };
    return mob.quests[slug];
  }

  api.commands.register({
    name: `${slug}-start`,
    help: `[${slug}-start — begin the ${label} chain.`,
    access: 'Player',
    run(ctx) {
      const q = questOf(ctx.sender);
      if (q.started) {
        ctx.state.sendSystemMessage(`Stage ${q.stage + 1}: ${stages[q.stage].title}`);
        return;
      }
      q.started = true; q.stage = 0;
      ctx.state.sendSystemMessage(`Quest accepted: ${stages[0].title}`);
      ctx.state.sendSystemMessage(stages[0].summary);
    },
  });

  api.commands.register({
    name: `${slug}-status`,
    help: `[${slug}-status — ${label} progress.`,
    access: 'Player',
    run(ctx) {
      const q = questOf(ctx.sender);
      if (!q.started) {
        ctx.state.sendSystemMessage(`You have not started the ${label} chain.`);
        return;
      }
      const s = stages[q.stage];
      if (!s) {
        ctx.state.sendSystemMessage(`${label}: completed.`);
        return;
      }
      ctx.state.sendSystemMessage(`Stage ${q.stage + 1}/${stages.length}: ${s.title}`);
      ctx.state.sendSystemMessage(s.summary);
      for (const obj of s.objectives) {
        const mark = obj.done ? '[X]' : '[ ]';
        const detail = obj.count ? `${obj.have ?? 0}/${obj.count}` : (obj.npc ?? obj.target ?? '');
        ctx.state.sendSystemMessage(`  ${mark} ${obj.kind} ${detail}`);
      }
    },
  });

  api.commands.register({
    name: `${slug}-advance`,
    help: `[${slug}-advance <idx> — admin tick.`,
    access: 'Admin',
    run(ctx, args) {
      const q = questOf(ctx.sender);
      const stage = stages[q.stage];
      if (!stage) { ctx.state.sendSystemMessage('Already complete.'); return; }
      const obj = stage.objectives[parseInt(args?.[0] ?? '0', 10)];
      if (!obj) { ctx.state.sendSystemMessage('Bad index.'); return; }
      if (obj.count) obj.have = Math.min(obj.count, (obj.have | 0) + 1);
      if (!obj.count || obj.have >= obj.count) obj.done = true;
      if (stage.objectives.every((o) => o.done)) {
        // Award rewards.
        if (stage.reward?.tokens && api.systems?.points?.award) {
          try { api.systems.points.award(ctx.sender, 'heritage', stage.reward.tokens); }
          catch { /* points-system optional */ }
        }
        if (Array.isArray(stage.reward?.items) && api.templates?.give) {
          for (const tpl of stage.reward.items) {
            try { api.templates.give(api.world, ctx.sender, tpl, 1); }
            catch { /* missing template — ignore */ }
          }
        }
        q.stage++;
        ctx.state.sendSystemMessage(
          q.stage >= stages.length
            ? `${label} complete!`
            : `Stage advanced. Next: ${stages[q.stage].title}`,
        );
      } else {
        ctx.state.sendSystemMessage(`Objective progress: ${obj.have ?? '+'}/${obj.count ?? '*'}.`);
      }
    },
  });

  return [`${slug}-start`, `${slug}-status`, `${slug}-advance`];
}

const HAWKWIND_STAGES = [
  {
    id: 'hawk-1-vision', title: 'The Time-Lord Speaks',
    summary: 'Hawkwind sends a vision — meet him at the Time Tower.',
    objectives: [{ kind: 'talk-to', npc: 'hawkwind', done: false }],
    reward: { tokens: 50 },
  },
  {
    id: 'hawk-2-runes', title: 'Runes of Foresight',
    summary: 'Collect 3 prophecy runes scattered across Britannia.',
    objectives: [{ kind: 'collect', resource: 'prophecy-rune', count: 3, have: 0, done: false }],
    reward: { tokens: 100 },
  },
  {
    id: 'hawk-3-confront', title: 'Confront the Shadowlord',
    summary: 'Slay the Shadow of Hatred and report back to Hawkwind.',
    objectives: [
      { kind: 'kill', target: 'shadow-of-hatred', count: 1, have: 0, done: false },
      { kind: 'turn-in', npc: 'hawkwind', done: false },
    ],
    reward: { items: ['hawkwind-cloak'], tokens: 300 },
  },
];

const TOMB_STAGES = [
  {
    id: 'tomb-1-seal', title: 'The Sealed Tomb',
    summary: 'Find the entrance to the Tomb of Kings beneath Royal City.',
    objectives: [{ kind: 'reach', target: 'tomb-entrance', done: false }],
    reward: { tokens: 50 },
  },
  {
    id: 'tomb-2-keys', title: 'The Three Keys',
    summary: 'Recover the keys of fire, water, and air from each guardian.',
    objectives: [{ kind: 'collect', resource: 'tomb-key', count: 3, have: 0, done: false }],
    reward: { tokens: 200 },
  },
  {
    id: 'tomb-3-king', title: 'The Slumbering King',
    summary: 'Defeat the awakened Lich King.',
    objectives: [{ kind: 'kill', target: 'lich-king', count: 1, have: 0, done: false }],
    reward: { items: ['crown-of-kings'], tokens: 500 },
  },
];

const UZERAAN_STAGES = [
  {
    id: 'uzer-1-summons', title: 'Uzeraan Summons',
    summary: 'Heed Uzeraan\'s call at his manor in Haven.',
    objectives: [{ kind: 'talk-to', npc: 'uzeraan', done: false }],
    reward: { tokens: 30 },
  },
  {
    id: 'uzer-2-zealots', title: 'Zealots of the Inner Demon',
    summary: 'Slay 6 zealots threatening the village.',
    objectives: [{ kind: 'kill', target: 'zealot', count: 6, have: 0, done: false }],
    reward: { tokens: 100 },
  },
  {
    id: 'uzer-3-leader', title: 'The Inner Demon',
    summary: 'Confront the cult leader in the catacombs.',
    objectives: [
      { kind: 'kill', target: 'inner-demon', count: 1, have: 0, done: false },
      { kind: 'turn-in', npc: 'uzeraan', done: false },
    ],
    reward: { items: ['uzeraan-robe'], tokens: 250 },
  },
];

const DARKTIDES_STAGES = [
  {
    id: 'dark-1-call', title: 'A Call from the Sea',
    summary: 'Speak with Lord Casca about the necromantic sightings.',
    objectives: [{ kind: 'talk-to', npc: 'lord-casca', done: false }],
    reward: { tokens: 50 },
  },
  {
    id: 'dark-2-bones', title: 'Bones from the Deep',
    summary: 'Recover 4 abyssal bones from the haunted shoreline.',
    objectives: [{ kind: 'collect', resource: 'abyssal-bone', count: 4, have: 0, done: false }],
    reward: { tokens: 120 },
  },
  {
    id: 'dark-3-leviathan', title: 'The Tide Leviathan',
    summary: 'Slay the Leviathan and return its heart.',
    objectives: [
      { kind: 'kill', target: 'tide-leviathan', count: 1, have: 0, done: false },
      { kind: 'turn-in', npc: 'lord-casca', done: false },
    ],
    reward: { items: ['leviathan-amulet'], tokens: 350 },
  },
];

export default function register(api) {
  if (!api.commands) return () => {};
  const all = [];
  all.push(...makeQuest(api, 'hawk',     'Hawkwind',         HAWKWIND_STAGES));
  all.push(...makeQuest(api, 'tomb',     'Tomb of Kings',    TOMB_STAGES));
  all.push(...makeQuest(api, 'uzeraan',  'Uzeraan Turmoil',  UZERAAN_STAGES));
  all.push(...makeQuest(api, 'darktides','Dark Tides',       DARKTIDES_STAGES));
  return () => { for (const cmd of all) api.commands.unregister(cmd); };
}
