// Sample quest catalogue + `[quests`/`[questaccept`/`[questturn` commands.
// Hooks into killMobile via the corpse module so kills auto-advance any
// matching kill objective.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { questsSystem } from './_quests.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

function readJsonFallback() {
  const file = path.join(HERE, 'data', 'world', 'quests-extracted.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function deliverQuestReward(api, mob, reward = {}) {
  if (!api.game?.inventory?.findBackpack?.(mob)) return false;
  if ((reward.gold ?? 0) > 0) {
    api.game?.mobile?.giveItem?.(mob, {
      itemId: 0x0EED,
      amount: reward.gold,
      name: 'gold',
    }, { randomGrid: true });
  }
  if (Array.isArray(reward.items)) {
    for (const r of reward.items) {
      const tpl = api.templates?.get?.(r.template);
      if (!tpl) continue;
      api.game?.mobile?.giveItem?.(mob, {
        itemId: tpl.itemId,
        amount: r.amount ?? 1,
        name: tpl.label ?? r.template,
      }, { randomGrid: true });
    }
  }
  return true;
}

const QUESTS = [
  {
    id: 'rats-in-the-cellar',
    name: 'Rats in the Cellar',
    giver: 'Innkeeper',
    description: 'The innkeeper begs you to clear out the rats in the basement.',
    objectives: [{ kind: 'kill', target: 'rat', count: 5, description: 'Slay 5 rats' }],
    reward: { gold: 200 },
    dialog: {
      intro: {
        text: 'Friend! Rats in my cellar — they\'re ruining the cheese stocks. Will you help?',
        options: [
          { reply: 'How many rats?',     goto: 'how_many' },
          { reply: 'What\'s the pay?',   goto: 'pay' },
          { reply: 'I\'ll do it.',       accept: true, goto: 'accepted' },
          { reply: 'Not interested.',    exit: true },
        ],
      },
      how_many: {
        text: 'Five, at least. Maybe more if they breed before you finish.',
        options: [
          { reply: 'I\'ll handle it.', accept: true, goto: 'accepted' },
          { reply: 'Maybe later.',     exit: true },
        ],
      },
      pay: {
        text: 'Two hundred gold pieces. Plus a free room for the night, on the house.',
        options: [
          { reply: 'Deal.',         accept: true, goto: 'accepted' },
          { reply: 'Too cheap.',    exit: true },
        ],
      },
      accepted: {
        text: 'Bless ye! Cellar door\'s round the back. Mind the broken stair.',
        options: [{ reply: 'Goodbye.', exit: true }],
      },
      in_progress: {
        text: 'Still rats down there, eh? They breed fast. Five at minimum, remember.',
        options: [{ reply: 'I\'m on it.', exit: true }],
      },
      completed: {
        text: 'You\'ve done it! Take your purse, friend. Drink some ale on me!',
        options: [{ reply: 'Take the reward.', complete: true, goto: 'done' }],
      },
      done: {
        text: 'Spread the word — the inn\'s as clean as old Tom\'s teeth!',
        options: [{ reply: 'Goodbye.', exit: true }],
      },
    },
  },
  {
    id: 'chop-chop',
    name: 'Chop Chop',
    giver: 'Carpenter',
    description: 'A carpenter needs lumber for a contract.',
    objectives: [{ kind: 'gather', target: 'log', count: 25, description: 'Bring 25 logs' }],
    reward: { gold: 350, items: [{ template: 'hatchet', amount: 1 }] },
  },
  {
    id: 'orc-bane',
    name: 'Orc Bane',
    giver: 'Captain of the Guard',
    description: 'Orcs have been raiding the caravans. Make them think twice.',
    objectives: [{ kind: 'kill', target: 'orc', count: 10, description: 'Defeat 10 orcs' }],
    reward: { gold: 600 },
    dialog: {
      intro: {
        text: 'Adventurer! Orc raids on the trade roads have crippled supply lines. The Guard is stretched thin. Will you help?',
        options: [
          { reply: 'Where are they camped?', goto: 'where' },
          { reply: 'How many?',              goto: 'count' },
          { reply: 'I\'ll fight them.',      accept: true, goto: 'accepted' },
          { reply: 'Pay a soldier instead.', exit: true },
        ],
      },
      where: {
        text: 'North of Britain, in the forest beyond the East Bridge. They\'ve dug fortifications — be quick or be careful.',
        options: [
          { reply: 'Understood.',  accept: true, goto: 'accepted' },
          { reply: 'I\'ll think.', exit: true },
        ],
      },
      count: {
        text: 'Slay ten — that should send a message to the warlord. Crowley\'s scouts have counted at least thirty in the camp.',
        options: [
          { reply: 'Ten it is.',     accept: true, goto: 'accepted' },
          { reply: 'Too dangerous.', exit: true },
        ],
      },
      accepted: {
        text: 'For Britannia. Strike hard, return swiftly.',
        options: [{ reply: 'For Britannia.', exit: true }],
      },
      in_progress: {
        text: 'Are they reduced to ten less than before? Crowley needs reports.',
        options: [{ reply: 'Working on it.', exit: true }],
      },
      completed: {
        text: 'Ten orcs less in this world! You\'ve earned this purse and the Guard\'s respect.',
        options: [{ reply: 'Claim reward.', complete: true, goto: 'done' }],
      },
      done: {
        text: 'You\'re welcome at the Guard barracks any time, friend.',
        options: [{ reply: 'Honor.', exit: true }],
      },
    },
  },
  {
    id: 'first-bite',
    name: 'A First Bite',
    giver: 'Fisher',
    description: 'A local fisher hands you their spare pole and asks for fish.',
    objectives: [{ kind: 'gather', target: 'raw-fish', count: 10, description: 'Catch 10 fish' }],
    reward: { gold: 150, items: [{ template: 'fishing-pole', amount: 1 }] },
  },
  {
    id: 'lich-hunter',
    name: 'Lich Hunter',
    giver: 'Necromancer',
    description: 'A wandering necromancer wants a lich head.',
    objectives: [{ kind: 'kill', target: 'lich', count: 1, description: 'Defeat 1 lich' }],
    reward: { gold: 1500, items: [{ template: 'reagent-grave-dust', amount: 20 }] },
    dialog: {
      intro: {
        text: 'A lich, traveller. Their phylactery binds essence I require. Bring me the body — I\'ll handle the rest.',
        options: [
          { reply: 'Why a lich?',     goto: 'why' },
          { reply: 'What\'s in it for me?', goto: 'pay' },
          { reply: 'Where are they?', goto: 'where' },
          { reply: 'I\'ll hunt one.', accept: true, goto: 'accepted' },
          { reply: 'Necromancy?  No.', exit: true },
        ],
      },
      why: {
        text: 'My research demands the residue of an unbound soul. The lich\'s bones still ring with magic. I cannot conjure such material; it must be taken.',
        options: [
          { reply: 'Fine.', accept: true, goto: 'accepted' },
          { reply: 'No.',   exit: true },
        ],
      },
      pay: {
        text: 'Fifteen hundred gold and twenty doses of grave dust — worth more than the gold to a witch with skill.',
        options: [
          { reply: 'Acceptable.', accept: true, goto: 'accepted' },
          { reply: 'Pass.',       exit: true },
        ],
      },
      where: {
        text: 'Deceit\'s lower halls. Crypts beneath the Yew abbey. Wherever the dead refuse the grave.',
        options: [
          { reply: 'I\'ll find one.', accept: true, goto: 'accepted' },
          { reply: 'Maybe later.',    exit: true },
        ],
      },
      accepted: {
        text: 'Burn the body if you can\'t carry it. Ash holds the residue too. Return to me when it\'s done.',
        options: [{ reply: 'Understood.', exit: true }],
      },
      in_progress: {
        text: 'Patience, hunter. Liches don\'t walk willingly to the slaughter.',
        options: [{ reply: 'Soon.', exit: true }],
      },
      completed: {
        text: 'Ahh — the energies are pure. Take your gold and the dust. May we trade again.',
        options: [{ reply: 'Claim reward.', complete: true, goto: 'done' }],
      },
      done: {
        text: 'The shadows whisper of you now. Be careful what answers.',
        options: [{ reply: 'Goodbye.', exit: true }],
      },
    },
  },
  // ============ Bulk-port: Britannia town quest tier ============
  {
    id: 'milkmaid-trouble',
    name: "The Milkmaid's Trouble",
    giver: 'Milkmaid',
    description: 'The milkmaid has lost three cows to wolves.',
    objectives: [{ kind: 'kill', target: 'wolf', count: 3, description: 'Slay 3 wolves' }],
    reward: { gold: 150, items: [{ template: 'raw-ribs', amount: 5 }] },
  },
  {
    id: 'mage-apprentice',
    name: "The Mage's Apprentice",
    giver: 'Magincia Mage',
    description: 'A Moonglow mage requires reagents for a divination.',
    objectives: [
      { kind: 'gather', target: 'reagent-mandrake',  count: 5, description: 'Bring 5 mandrake' },
      { kind: 'gather', target: 'reagent-nightshade', count: 5, description: 'Bring 5 nightshade' },
    ],
    reward: { gold: 250, items: [{ template: 'scroll', amount: 5 }] },
  },
  {
    id: 'crypt-cleansing',
    name: 'Crypt Cleansing',
    giver: 'Yew Cleric',
    description: 'The Yew crypt has been overrun with the restless dead.',
    objectives: [
      { kind: 'kill', target: 'skeleton', count: 8, description: 'Slay 8 skeletons' },
      { kind: 'kill', target: 'zombie',   count: 4, description: 'Slay 4 zombies' },
    ],
    reward: { gold: 800, items: [{ template: 'metal-shield', amount: 1 }] },
  },
  {
    id: 'minoc-mining',
    name: 'Minoc Mining Contract',
    giver: 'Minoc Foreman',
    description: 'A Minoc foreman needs ore for the smelting forge.',
    objectives: [{ kind: 'gather', target: 'iron-ore', count: 30, description: 'Mine 30 iron ore' }],
    reward: { gold: 400 },
  },
  {
    id: 'trinsic-paladin-trial',
    name: "Trial of the Paladin",
    giver: 'Trinsic Paladin',
    description: 'Prove your virtue by clearing the brigand camp.',
    objectives: [{ kind: 'kill', target: 'brigand', count: 12, description: 'Slay 12 brigands' }],
    reward: { gold: 1000, items: [{ template: 'broadsword', amount: 1 }] },
  },
  {
    id: 'dragon-slayer',
    name: 'Slayer of Dragons',
    giver: 'Captain of the Guard',
    description: 'Britannia bleeds. The dragon Nyrak terrorises Destard.',
    objectives: [{ kind: 'kill', target: 'dragon', count: 1, description: 'Slay one dragon' }],
    reward: { gold: 5000, items: [{ template: 'dragon-scale', amount: 10 }] },
    dialog: {
      intro: {
        text: 'You\'ve heard the rumours. A dragon — Nyrak — has claimed Destard. Three hunters have not returned. The Guard cannot spare more.',
        options: [
          { reply: 'Tell me of Nyrak.', goto: 'history' },
          { reply: 'What\'s the bounty?', goto: 'bounty' },
          { reply: 'I will face it.',  accept: true, goto: 'accepted' },
          { reply: 'I\'m not ready.',  exit: true },
        ],
      },
      history: {
        text: 'A red wyrm older than the Sosarian Wars. He sleeps for decades, then wakes to feast. We last drove him into Destard\'s lower halls a hundred years ago.',
        options: [
          { reply: 'I\'ll slay him.',   accept: true, goto: 'accepted' },
          { reply: 'I need to think.',  exit: true },
        ],
      },
      bounty: {
        text: 'Five thousand gold pieces. Ten dragon scales — the smiths beg for them. And the gratitude of the Crown.',
        options: [
          { reply: 'Done.',     accept: true, goto: 'accepted' },
          { reply: 'Too risky.', exit: true },
        ],
      },
      accepted: {
        text: 'May the Virtues guide your blade. Destard lies south of Britain, beyond the Bone Pass. Bring spells if you have them.',
        options: [{ reply: 'I will return.', exit: true }],
      },
      in_progress: {
        text: 'You live yet, but Nyrak still breathes. The Crown waits, hero.',
        options: [{ reply: 'Soon.', exit: true }],
      },
      completed: {
        text: 'You — Nyrak slain? By the Avatar! Take the bounty, hero. Britannia owes you a debt that cannot be paid in gold.',
        options: [{ reply: 'Claim reward.', complete: true, goto: 'done' }],
      },
      done: {
        text: 'Songs will tell of this for generations. Walk in light, slayer.',
        options: [{ reply: 'Honor.', exit: true }],
      },
    },
  },
  {
    id: 'daemon-dispel',
    name: 'Daemon Dispel',
    giver: 'High Mage',
    description: 'A daemon has slipped through the gates of Hythloth.',
    objectives: [{ kind: 'kill', target: 'daemon', count: 2, description: 'Banish 2 daemons' }],
    reward: { gold: 2500, items: [{ template: 'reagent-sulfurous-ash', amount: 25 }] },
  },
  {
    id: 'troll-removal',
    name: 'Troll Removal',
    giver: 'Britain Bridge Toll',
    description: 'Trolls under the bridge have been hassling travellers.',
    objectives: [{ kind: 'kill', target: 'troll', count: 6, description: 'Defeat 6 trolls' }],
    reward: { gold: 500 },
  },
  {
    id: 'spider-eyes',
    name: 'Spider Silk for the Tailor',
    giver: 'Trinsic Tailor',
    description: 'A tailor needs silk to weave robes for visiting nobles.',
    objectives: [{ kind: 'gather', target: 'reagent-spider-silk', count: 20, description: 'Bring 20 silk' }],
    reward: { gold: 300, items: [{ template: 'cloth', amount: 5 }] },
  },
  {
    id: 'bone-quota',
    name: 'Bone Quota',
    giver: 'Apothecary',
    description: 'The apothecary grinds bones for cure poultices.',
    objectives: [{ kind: 'gather', target: 'bone', count: 25, description: 'Collect 25 bones' }],
    reward: { gold: 350, items: [{ template: 'bandage', amount: 10 }] },
  },
  {
    id: 'orc-warlord',
    name: 'Slay the Orc Warlord',
    giver: 'Britain Marshal',
    description: 'An orc warlord coordinates the raids. End his reign.',
    objectives: [{ kind: 'kill', target: 'orc-lord', count: 1, description: 'Slay the orc lord' }],
    reward: { gold: 2000, items: [{ template: 'cutlass', amount: 1 }] },
  },
  {
    id: 'sea-witch',
    name: 'The Sea Witch',
    giver: 'Skara Brae Fisherman',
    description: 'A sea serpent has been raiding fishing boats off Skara Brae.',
    objectives: [{ kind: 'kill', target: 'sea-serpent', count: 2, description: 'Slay 2 sea serpents' }],
    reward: { gold: 1200, items: [{ template: 'leather', amount: 15 }] },
  },
];

/**
 * Convert a `quests-extracted.json` entry to our `QuestDef` shape.
 * Keeps only the fields the runtime actually uses (id, name, description,
 * objectives, reward). Skip when the entry has no objectives — those
 * extracted classes are usually base-class shells with no concrete quest.
 *
 * Naming convention:
 *   id   = camel→kebab of class name (FooQuest → foo-quest)
 *   name = strip "Quest" suffix, insert spaces between camel boundaries
 *   description = "Cliloc #${descCliloc}" (the runtime can resolve later)
 *
 * Objectives:
 *   ObtainObjective(typeof(X), "label", N)  → { kind:'gather', target:type, count:N }
 *   SlayObjective  (typeof(X), …)           → { kind:'kill',   target:type, count:N }
 *   KillObjective                           → 'kill'
 *   anything else: 'gather' fallback (still data-faithful)
 */
function classToQuestId(cls) {
  return cls.replace(/Quest$/, '')
            .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
            .toLowerCase();
}
function classToQuestName(cls) {
  return cls.replace(/Quest$/, '')
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .trim();
}
function objKindFromCsName(kind) {
  if (/Slay|Kill/i.test(kind)) return 'kill';
  return 'gather';
}
function fromExtractedEntry(e) {
  if (!e?.class) return null;
  if (!e.objectives?.length) return null;
  const objectives = e.objectives.map((o) => ({
    kind: objKindFromCsName(o.kind),
    target: (o.label ?? o.type ?? '').toString().toLowerCase().replace(/\s+/g, '-'),
    count: o.qty ?? 1,
    description: o.label ? o.label : `${objKindFromCsName(o.kind)} ${o.qty ?? 1} ${o.type}`,
  }));
  return {
    id: classToQuestId(e.class),
    name: classToQuestName(e.class),
    giver: e.base?.replace(/Quest$/, '') || 'NPC',
    description: e.description ? `Cliloc #${e.description}` : 'A task awaits.',
    objectives,
    reward: { items: e.rewards?.map((r) => ({ template: r.type.toLowerCase(), amount: r.qty })) ?? [] },
    extracted: true,        // marker so the runtime can prefer authored
  };
}

export default function register(api) {
  if (!api.commands) return () => {};
  const quests = questsSystem(api);
  if (!quests) {
    api.log?.('quests: quests system unavailable');
    return () => {};
  }
  for (const q of QUESTS) quests.registerQuest(q);

  // Wave 7 follow-up: register quests-extracted.json (~154 entries) as
  // a fallback. We never overwrite an authored quest — only fill gaps.
  // The data file is optional; absence is fine.
  try {
    const extracted = readJsonFallback();
    if (Array.isArray(extracted)) {
      const authoredIds = new Set(QUESTS.map((q) => q.id));
      let added = 0;
      for (const e of extracted) {
        const qd = fromExtractedEntry(e);
        if (!qd) continue;
        if (authoredIds.has(qd.id)) continue;
        try { quests.registerQuest(qd); added++; }
        catch { /* duplicate or malformed — skip */ }
      }
      api.log?.(`quests: registered ${added} extracted quest(s) as fallback`);
    }
  } catch (e) {
    api.log?.(`quests: extracted-fallback load failed: ${e.message}`);
  }

  api.commands.register({
    name: 'quests',
    help: '[quests — list available quests.',
    access: 'Player',
    run(ctx) {
      const lines = quests.allQuests().map((q) => {
        const taken = (ctx.sender.activeQuests ?? []).some((a) => a.id === q.id);
        return `  ${q.id}${taken ? ' [active]' : ''} — ${q.name}`;
      });
      ctx.state.sendSystemMessage(['Available quests:', ...lines].join('\n'));
    },
  });

  api.commands.register({
    name: 'questaccept',
    help: '[questaccept <id> — accept a quest.',
    access: 'Player',
    run(ctx) {
      const id = String(ctx.args[0] ?? '');
      if (!quests.acceptQuest(ctx.sender, id)) {
        ctx.state.sendSystemMessage('Cannot accept that quest (unknown id or already active).');
        return;
      }
      ctx.state.sendSystemMessage(`Quest accepted: ${id}`);
    },
  });

  api.commands.register({
    name: 'questabandon',
    help: '[questabandon <id> — drop a quest.',
    access: 'Player',
    run(ctx) {
      const id = String(ctx.args[0] ?? '');
      if (quests.abandonQuest(ctx.sender, id)) {
        ctx.state.sendSystemMessage(`Quest abandoned: ${id}`);
      }
    },
  });

  api.commands.register({
    name: 'questprogress',
    help: '[questprogress — show your active quests and progress.',
    access: 'Player',
    run(ctx) {
      const list = ctx.sender.activeQuests ?? [];
      if (list.length === 0) {
        ctx.state.sendSystemMessage('No active quests.');
        return;
      }
      const lines = list.flatMap((q) => {
        const def = quests.allQuests().find((d) => d.id === q.id);
        if (!def) return [`  ${q.id} (unknown)`];
        return [
          `  ${def.name}:`,
          ...def.objectives.map((obj, i) =>
            `    [${q.progress[i] ?? 0}/${obj.count}] ${obj.description}`,
          ),
        ];
      });
      ctx.state.sendSystemMessage(['Active quests:', ...lines].join('\n'));
    },
  });

  api.commands.register({
    name: 'questturn',
    help: '[questturn <id> — claim reward for a completed quest.',
    access: 'Player',
    run(ctx) {
      const id = String(ctx.args[0] ?? '');
      const list = ctx.sender.activeQuests ?? [];
      const q = list.find((a) => a.id === id);
      const def = q && quests.allQuests().find((d) => d.id === id);
      if (!q || !def) { ctx.state.sendSystemMessage('Quest not active.'); return; }
      const done = def.objectives.every((obj, i) => (q.progress[i] ?? 0) >= obj.count);
      if (!done) { ctx.state.sendSystemMessage('Objectives are not yet complete.'); return; }
      if (!api.game?.inventory?.findBackpack?.(ctx.sender)) {
        ctx.state.sendSystemMessage('You have no backpack for the quest reward.');
        return;
      }
      const reward = quests.completeQuest(ctx.sender, id);
      if (!reward) return;
      deliverQuestReward(api, ctx.sender, reward);
      ctx.state.sendSystemMessage(`Quest complete: ${def.name}. Reward delivered.`);
    },
  });

  // Wire kill events into quest progress via the kill-hook chain in
  // corpse.js. Previously this script tried to do
  // `api.corpse.killMobile = wrapper` but ES module exports are
  // read-only — the assignment threw at script init and dropped the
  // ENTIRE quests module. Hook chain mirror of templates.addUseItemHook.
  api.corpse?.addKillHook?.((world, victim, killer) => {
    // BUGFIX #3 (PHASE AH): killing another player makes `victim.kind ===
    // undefined`, which used to slip through and produce empty progress
    // notices on PvE quests. Require victim to be a non-client mobile
    // with a kind tag so PvP kills never advance PvE quests.
    if (killer?.client && victim?.kind && !victim.client) {
      const reports = quests.notifyEvent(killer, { kind: 'kill', target: victim.kind });
      for (const r of reports) {
        killer.client.sendSystemMessage?.(
          r.completed ? `Quest "${r.name}" — objectives complete! Use [questturn ${r.id} to claim.`
                       : `Quest "${r.name}" — progress made.`,
        );
      }
    }
  });

  // ============ Dialog tree commands ============
  // [questtalk <id>            → show current node's text + numbered options
  // [questchoose <id> <node> <n> → select option N (zero-indexed)
  //
  // Players use the chat to advance through a quest dialog. The dialog
  // state lives on `player._questDialog = { questId, nodeId }` so the
  // player only needs to type [questchoose <n> after the first [questtalk.

  api.commands.register({
    name: 'questtalk',
    help: '[questtalk <id> — open dialog with the quest giver.',
    access: 'Player',
    run(ctx) {
      const id = String(ctx.args[0] ?? '');
      const def = quests.getQuest(id);
      if (!def) { ctx.state.sendSystemMessage(`Unknown quest "${id}".`); return; }
      const node = quests.getDialogNode(ctx.sender, id);
      if (!node) {
        ctx.state.sendSystemMessage(`That quest has no dialog. Use [questaccept ${id} directly.`);
        return;
      }
      ctx.sender._questDialog = { questId: id, nodeId: node._route ?? 'intro' };
      const lines = [`[${def.name}] ${node.text}`];
      (node.options ?? []).forEach((o, i) => lines.push(`  ${i + 1}. ${o.reply}`));
      lines.push(`Reply with [questchoose ${id} <number>.`);
      ctx.state.sendSystemMessage(lines.join('\n'));
    },
  });

  api.commands.register({
    name: 'questchoose',
    help: '[questchoose <id> <n> — pick the Nth dialog option.',
    access: 'Player',
    run(ctx) {
      const id = String(ctx.args[0] ?? '');
      const idx = parseInt(ctx.args[1], 10) - 1;
      const dlg = ctx.sender._questDialog;
      const nodeId = (dlg?.questId === id) ? dlg.nodeId : 'intro';
      const result = quests.chooseDialogOption(ctx.sender, id, nodeId, idx);
      if (!result) { ctx.state.sendSystemMessage('No such option.'); return; }
      if (result.action === 'exit') {
        ctx.sender._questDialog = null;
        ctx.state.sendSystemMessage('You step away.');
        return;
      }
      if (result.action === 'accept') {
        ctx.state.sendSystemMessage(`Quest accepted: ${id}.`);
      }
      if (result.action === 'duplicate') {
        ctx.state.sendSystemMessage('You\'ve already taken that quest.');
      }
      if (result.action === 'incomplete') {
        ctx.state.sendSystemMessage('You haven\'t finished the work yet.');
      }
      if (result.action === 'complete') {
        ctx.state.sendSystemMessage(`Quest complete! Reward: ${result.reward?.gold ?? 0} gold.`);
        if (!deliverQuestReward(api, ctx.sender, result.reward)) {
          ctx.state.sendSystemMessage('You have no backpack for the quest reward.');
        }
      }
      const def = quests.getQuest(id);
      const next = result.next ? def?.dialog?.[result.next] : null;
      if (!next) { ctx.sender._questDialog = null; return; }
      ctx.sender._questDialog = { questId: id, nodeId: result.next };
      const lines = [`[${def.name}] ${next.text}`];
      (next.options ?? []).forEach((o, i) => lines.push(`  ${i + 1}. ${o.reply}`));
      lines.push(`Reply with [questchoose ${id} <number>.`);
      ctx.state.sendSystemMessage(lines.join('\n'));
    },
  });

  return () => {
    api.commands.unregister('quests');
    api.commands.unregister('questaccept');
    api.commands.unregister('questabandon');
    api.commands.unregister('questprogress');
    api.commands.unregister('questturn');
    api.commands.unregister('questtalk');
    api.commands.unregister('questchoose');
    // No kill-hook unregister; corpse.clearKillHooks would nuke OTHER
    // scripts' hooks too. The hook is idempotent on hot reload — old
    // closure becomes garbage when register() returns; new closure is
    // pushed by the next register() call. Reload with care; restart
    // the server if you need a clean kill-hook chain.
  };
}
