// Quest-giver dialogue trees — registered through the
// `quest-conversation` engine. Each `kind` matches an NPC kind we
// spawn (Uzeraan, Morganna, Emino, Haochi, BardMaster, etc.) so the
// runtime maps a click on the NPC → conversation.
//
// Designed to be data-only — every tree is a flat list of `nodes` with
// `id`, `text`, optional `choices` / `keywords`, optional onEnter.

export default function register(api) {
  const reg = api.systems?.questConversation?.registerConversation
    ?? api.questConversation?.registerConversation;
  if (!reg) {
    api.log?.('quests/_dialogues: questConversation engine missing');
    return () => {};
  }

  // ---------------------------------------------------------------------
  //  Helper to grant the quest when the player picks "accept".
  // ---------------------------------------------------------------------
  function grantQuest(ctx, questId) {
    const offer = api.systems?.mlQuests?.offer ?? api.mlQuests?.offer;
    if (!offer) return;
    try { offer(ctx.playerState.mobile ?? ctx.playerState, questId); }
    catch { /* ignore */ }
  }

  // =====================================================================
  //  Uzeraan — Haven tutorial Human starter
  // =====================================================================
  reg('Uzeraan', {
    entry: 'greet',
    nodes: [
      { id: 'greet',
        text: "Welcome to Haven, traveler. Dark times have come upon us — orcs raid the eastern shore, and the Mana Crystal has been stolen. Will you help me?",
        choices: [
          { key: 'accept', text: 'I will help.', next: 'accepted' },
          { key: 'decline', text: 'Not today.',  next: 'farewell' },
          { key: 'orcs',    text: 'Tell me about the orcs.', next: 'lore-orcs' },
        ],
      },
      { id: 'accepted',
        text: "May the Virtues guide you. Slay five Orc Bombers and bring me the Glowing Crystal from the trove.",
        onEnter: (ctx) => grantQuest(ctx, 'uzeraan-turmoil'),
        terminal: true,
      },
      { id: 'farewell',
        text: "Then walk in peace. Return when you have a stout heart.",
        terminal: true,
      },
      { id: 'lore-orcs',
        text: "They came from the moors when the new moon turned blood-red. Their shaman-priest Goug-Khan leads them. Do not engage him alone.",
        nextDefault: 'greet',
      },
    ],
  });

  // =====================================================================
  //  Morganna — Necromancer trainer (Dark Tides)
  // =====================================================================
  reg('Morganna', {
    entry: 'greet',
    nodes: [
      { id: 'greet',
        text: "Hush, child. The plague spreads. The Lich Lord stirs in his tomb. Tell me — do you know fear?",
        choices: [
          { key: 'accept',  text: 'I will face the lich.', next: 'accepted' },
          { key: 'decline', text: 'I will not.',           next: 'farewell' },
          { key: 'plague',  text: 'What is this plague?',   next: 'lore-plague' },
          { key: 'lich',    text: 'Tell me about the lich.', next: 'lore-lich' },
        ],
      },
      { id: 'accepted',
        text: "Then take this — three vials of plague cure. Cleanse the village wells, then descend to the catacombs.",
        onEnter: (ctx) => grantQuest(ctx, 'dark-tides'),
        terminal: true,
      },
      { id: 'farewell',
        text: "The shadows will remember your refusal.",
        terminal: true,
      },
      { id: 'lore-plague',
        text: "Born of dark magic. The wells run black, and the dead walk by night.",
        nextDefault: 'greet',
      },
      { id: 'lore-lich',
        text: "He was once a paladin. Now he is what we fight against. His phylactery is hidden in the deep crypt.",
        nextDefault: 'greet',
      },
    ],
  });

  // =====================================================================
  //  Emino — Samurai Empire tutorial
  // =====================================================================
  reg('Emino', {
    entry: 'greet',
    nodes: [
      { id: 'greet',
        text: "Bow, gaijin. The Honor Sword has been stolen by outcasts. Will you reclaim it for my house?",
        choices: [
          { key: 'accept',   text: 'I shall.', next: 'accepted' },
          { key: 'decline',  text: 'I cannot.', next: 'farewell' },
          { key: 'sword',    text: 'Tell me of the sword.', next: 'lore-sword' },
          { key: 'outcasts', text: 'Who are the outcasts?', next: 'lore-outcasts' },
        ],
      },
      { id: 'accepted',
        text: "Slay ten of them, then bring me the Honor Sword. Do not dishonor my house.",
        onEnter: (ctx) => grantQuest(ctx, 'eminos-undertaking'),
        terminal: true,
      },
      { id: 'farewell',
        text: "Then leave. The sword will return on the back of a worthier hand.",
        terminal: true,
      },
      { id: 'lore-sword',
        text: "Forged a thousand years ago by Master Hidenobu. It cuts iron as if it were paper.",
        nextDefault: 'greet',
      },
      { id: 'lore-outcasts',
        text: "Samurai who broke their bushido. Dishonored, exiled, and now bandits.",
        nextDefault: 'greet',
      },
    ],
  });

  // =====================================================================
  //  Haochi — Bushido master (Haochi's Trials)
  // =====================================================================
  reg('Haochi', {
    entry: 'greet',
    nodes: [
      { id: 'greet',
        text: "You wish to walk the Way of the Warrior? You must complete three trials: Discipline, Courage, Honor.",
        choices: [
          { key: 'accept',  text: 'I am ready.',  next: 'accepted' },
          { key: 'decline', text: 'Not yet.',      next: 'farewell' },
          { key: 'trials',  text: 'What trials?',  next: 'lore-trials' },
        ],
      },
      { id: 'accepted',
        text: "Slay five Oni for Discipline. Slay five Fan Dancers for Courage. Then visit the Shrine of Honor.",
        onEnter: (ctx) => grantQuest(ctx, 'haochis-trials'),
        terminal: true,
      },
      { id: 'farewell',
        text: "Return when your blade is sharp.",
        terminal: true,
      },
      { id: 'lore-trials',
        text: "Discipline: master your fear. Courage: face what you fear. Honor: do not strike a fallen foe.",
        nextDefault: 'greet',
      },
    ],
  });

  // =====================================================================
  //  Bard Master — generic mastery quest giver
  // =====================================================================
  reg('BardMaster', {
    entry: 'greet',
    nodes: [
      { id: 'greet',
        text: "Have you come to learn a Mastery? Each is taught by a different score. Which calls to you?",
        choices: [
          { key: 'inspire',     text: 'Inspire',     next: 'q-inspire' },
          { key: 'invigorate',  text: 'Invigorate',  next: 'q-invigorate' },
          { key: 'resilience',  text: 'Resilience',  next: 'q-resilience' },
          { key: 'perseverance',text: 'Perseverance',next: 'q-perseverance' },
          { key: 'tribulation', text: 'Tribulation', next: 'q-tribulation' },
          { key: 'despair',     text: 'Despair',     next: 'q-despair' },
        ],
      },
      ...['inspire','invigorate','resilience','perseverance','tribulation','despair'].map((s) => ({
        id: `q-${s}`,
        text: `Find the Ancient Score of ${s.charAt(0).toUpperCase()+s.slice(1)} hidden in the Heartwood library. Return with it and play the piece for me.`,
        onEnter: (ctx) => grantQuest(ctx, `bard-mastery-${s}`),
        terminal: true,
      })),
    ],
  });

  // =====================================================================
  //  Tribal Shaman — Eodon main quest
  // =====================================================================
  reg('TribalShaman', {
    entry: 'greet',
    nodes: [
      { id: 'greet',
        text: "Stranger from the gate. The Myrmidex devour our valley. Will you stand with the Seven Tribes?",
        choices: [
          { key: 'accept',   text: 'I will fight.',     next: 'accepted' },
          { key: 'decline',  text: 'I cannot help.',     next: 'farewell' },
          { key: 'tribes',   text: 'Tell me of the tribes.', next: 'lore-tribes' },
          { key: 'myrmidex', text: 'What are the Myrmidex?', next: 'lore-myrmidex' },
        ],
      },
      { id: 'accepted',
        text: "Slay twenty-five of their swarm and recover the four Sacred Stones.",
        onEnter: (ctx) => grantQuest(ctx, 'eodon-tribesfolk'),
        terminal: true,
      },
      { id: 'farewell',
        text: "Then the Myrmidex will reach your moonstone next. Walk on.",
        terminal: true,
      },
      { id: 'lore-tribes',
        text: "Barako, Uraban, Jukari, Sakkhra, Kurak, Upa, Tigersclaw — seven peoples, seven gods.",
        nextDefault: 'greet',
      },
      { id: 'lore-myrmidex',
        text: "Insectoid swarmers from beneath the volcano. Their queen lays a thousand eggs each moon.",
        nextDefault: 'greet',
      },
    ],
  });

  // =====================================================================
  //  Librarian — Britain Library collector
  // =====================================================================
  reg('Librarian', {
    entry: 'greet',
    nodes: [
      { id: 'greet',
        text: "Welcome to the Library of Britain. We seek rare tomes — bring five, and you shall be honored.",
        choices: [
          { key: 'donate', text: 'I will gather them.', next: 'accepted' },
          { key: 'leave',  text: 'Maybe later.',         next: 'farewell' },
        ],
      },
      { id: 'accepted',
        text: "Search the dungeons for forgotten books. Return here when you have five.",
        onEnter: (ctx) => grantQuest(ctx, 'britain-library-collector'),
        terminal: true,
      },
      { id: 'farewell', text: "The shelves wait patiently.", terminal: true },
    ],
  });

  // =====================================================================
  //  Mint Master — Magincia Mint collector
  // =====================================================================
  reg('MintMaster', {
    entry: 'greet',
    nodes: [
      { id: 'greet',
        text: "The mint runs low. Donate a thousand iron ingots and you shall wear the cloak of generosity.",
        choices: [
          { key: 'donate', text: 'I will help.', next: 'accepted' },
          { key: 'leave',  text: 'Another day.',  next: 'farewell' },
        ],
      },
      { id: 'accepted',
        text: "Bring 1000 iron ingots — drop them in the chest beside me.",
        onEnter: (ctx) => grantQuest(ctx, 'magincia-mint-collector'),
        terminal: true,
      },
      { id: 'farewell', text: "The forges wait.", terminal: true },
    ],
  });

  // =====================================================================
  //  Naturalist — Cloak of Humility virtue quest
  // =====================================================================
  reg('Naturalist', {
    entry: 'greet',
    nodes: [
      { id: 'greet',
        text: "Few seek the path of Humility. It is found not by power, but by service. Will you walk it?",
        choices: [
          { key: 'accept',  text: 'Show me the path.', next: 'accepted' },
          { key: 'decline', text: 'I am not ready.',    next: 'farewell' },
        ],
      },
      { id: 'accepted',
        text: "Speak the word 'humble' before me when you have served five strangers in need.",
        onEnter: (ctx) => grantQuest(ctx, 'cloak-of-humility'),
        keywords: ['humble'],
        nextDefault: 'finish',
      },
      { id: 'finish',
        text: "You wear the lessons of those you helped. Take this cloak. Wear it without pride.",
        terminal: true,
      },
      { id: 'farewell', text: "Walk well. The path waits.", terminal: true },
    ],
  });

  api.log?.('quests/_dialogues: registered 8 conversation trees');
  return () => {};
}
