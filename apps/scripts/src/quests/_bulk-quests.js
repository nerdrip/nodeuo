// Bulk quest pack — registers quest definitions through the existing
// `systems/quests/mlquests.js` engine (`api.mlQuests.registerQuest`). Each
// quest is a record with the framework's 5 objective types (`slay`,
// `collect`, `escort`, `deliver`, `talk`). All objectives in a record are
// required; separate records can form ordered chains through `requires`.
//
// Mirrors ServUO `Scripts/Quests/UzeraanTurmoil/`, `DarkTides/`,
// `EminosUndertaking/`, `HaochisTrials/`, `Eodon/`, `Collector/`,
// `CloakOfHumility/`, `SolenMatriarch/`, `AmbitiousSolenQueen/`,
// `StudyOfTheSolenHive/`, `Bard Mastery Quests/`.

const QUESTS = [
  // ---------- Tutorial / starter chains -----------------------------
  {
    id: 'uzeraan-turmoil',
    title: "Uzeraan's Turmoil",
    description: 'Help Uzeraan put down the orc raid on Old Haven.',
    giverKind: 'Uzeraan',
    objectives: [
      { type: 'slay', kind: 'orc-bomber', count: 5 },
      { type: 'collect', itemType: 'glowing-crystal', count: 1 },
      { type: 'talk', keyword: 'thank you' },
    ],
    rewards: [
      { type: 'gold', amount: 250 },
      { type: 'item', itemType: 'blessed-bag-of-rewards' },
      { type: 'fame', amount: 100 },
    ],
    unique: true,
  },
  {
    id: 'dark-tides',
    title: 'Dark Tides',
    description: 'Help Morganna cleanse the corrupted shore.',
    giverKind: 'Morganna',
    objectives: [
      { type: 'slay', kind: 'lich-lord', count: 1 },
      { type: 'collect', itemType: 'plague-cure', count: 3 },
    ],
    rewards: [
      { type: 'gold', amount: 250 },
      { type: 'skill', skillId: 16, points: 5 },
    ],
    unique: true,
  },
  {
    id: 'eminos-undertaking',
    title: "Emino's Undertaking",
    description: 'Reclaim the Honor Sword from the Tokuno outcasts.',
    giverKind: 'Emino',
    objectives: [
      { type: 'slay', kind: 'outcast', count: 10 },
      { type: 'collect', itemType: 'honor-sword', count: 1 },
    ],
    rewards: [
      { type: 'gold', amount: 300 },
      { type: 'item', itemType: 'samurai-do-armor' },
    ],
    unique: true,
  },
  {
    id: 'haochis-trials',
    title: "Haochi's Trials",
    description: 'Prove your discipline, courage, and honor.',
    giverKind: 'Haochi',
    objectives: [
      { type: 'slay', kind: 'oni',        count: 5 },
      { type: 'slay', kind: 'fan-dancer', count: 5 },
      { type: 'talk', keyword: 'honor' },
    ],
    rewards: [
      { type: 'gold', amount: 500 },
      { type: 'item', itemType: 'haochis-blessing' },
    ],
    unique: true,
  },

  // ---------- Bard Mastery (one quest per spell) --------------------
  ...['Despair', 'Inspire', 'Invigorate', 'Perseverance', 'Resilience', 'Tribulation'].map((spell) => ({
    id: `bard-mastery-${spell.toLowerCase()}`,
    title: `Bard Mastery: ${spell}`,
    description: `Learn the ${spell} bard mastery.`,
    giverKind: 'BardMaster',
    objectives: [
      { type: 'collect', itemType: `ancient-score-${spell.toLowerCase()}`, count: 1 },
      { type: 'talk', keyword: spell.toLowerCase() },
    ],
    rewards: [
      { type: 'gold', amount: 200 },
      { type: 'mastery', school: 'bard', spell },
    ],
    unique: true,
  })),

  // ---------- Eodon ------------------------------------------------
  {
    id: 'eodon-tribesfolk',
    title: 'The Tribes of Eodon',
    description: 'Aid the seven tribes against the Myrmidex incursion.',
    giverKind: 'TribalShaman',
    objectives: [
      { type: 'slay', kind: 'myrmidex',      count: 25 },
      { type: 'collect', itemType: 'sacred-stone', count: 4 },
    ],
    rewards: [
      { type: 'gold', amount: 750 },
      { type: 'item', itemType: 'eodon-headdress' },
      { type: 'fame', amount: 250 },
    ],
    unique: true,
  },

  // ---------- Collector / community --------------------------------
  {
    id: 'britain-library-collector',
    title: 'A Donation for the Library',
    description: 'Bring rare tomes to the librarian for a donation token.',
    giverKind: 'Librarian',
    objectives: [{ type: 'collect', itemType: 'rare-tome', count: 5 }],
    rewards: [{ type: 'item', itemType: 'library-donation-token' }],
    unique: false,
  },
  {
    id: 'magincia-mint-collector',
    title: 'Restock the Mint',
    description: 'Donate iron ingots to the Magincia mint.',
    giverKind: 'MintMaster',
    objectives: [{ type: 'collect', itemType: 'iron-ingot', count: 1000 }],
    rewards: [{ type: 'item', itemType: 'mint-donation-cloak' }],
    unique: false,
  },

  // ---------- Cloak of Humility / Virtue ---------------------------
  {
    id: 'cloak-of-humility',
    title: 'The Cloak of Humility',
    description: 'Aid those in need to earn the virtue cloak.',
    giverKind: 'Naturalist',
    objectives: [{ type: 'talk', keyword: 'humble' }],
    rewards: [
      { type: 'item', itemType: 'cloak-of-humility' },
      { type: 'virtue', virtue: 'humility', amount: 100 },
    ],
    unique: true,
  },

  // ---------- Solen Hive (3 sub-quests) ----------------------------
  {
    id: 'solen-matriarch',
    title: 'The Solen Matriarch',
    description: 'Slay 8 Black Solen Workers.',
    giverKind: 'RedSolenQueen',
    objectives: [{ type: 'slay', kind: 'BlackSolenWorker', count: 8 }],
    rewards: [{ type: 'item', itemType: 'solen-favor-token' }, { type: 'gold', amount: 500 }],
    unique: false,
  },
  {
    id: 'ambitious-solen-queen',
    title: 'The Ambitious Solen Queen',
    description: 'Slay 8 Red Solen Workers.',
    giverKind: 'BlackSolenQueen',
    objectives: [{ type: 'slay', kind: 'RedSolenWorker', count: 8 }],
    rewards: [{ type: 'item', itemType: 'solen-favor-token' }, { type: 'gold', amount: 500 }],
    unique: false,
  },
  {
    id: 'study-of-the-solen-hive',
    title: 'Study of the Solen Hive',
    description: 'Collect 3 Solen Eggs for the Naturalist.',
    giverKind: 'SolenNaturalist',
    objectives: [{ type: 'collect', itemType: 'solen-egg', count: 3 }],
    rewards: [{ type: 'item', itemType: 'solen-research-notes' }, { type: 'gold', amount: 250 }],
    unique: false,
  },

  // ---------- Mad Scientist + Heartwood (single-stage rep) -----------
  {
    id: 'heartwood-mad-scientist',
    title: 'The Mad Scientist',
    description: 'Acquire 5 alchemy reagents for the alchemist.',
    giverKind: 'MadAlchemist',
    objectives: [{ type: 'collect', itemType: 'mandrake-root', count: 5 }],
    rewards: [{ type: 'item', itemType: 'heartwood-trinket' }],
    unique: false,
  },
  {
    id: 'heartwood-tree-friend',
    title: 'A Friend to the Trees',
    description: 'Plant 3 saplings around the Heartwood.',
    giverKind: 'TreeKeeper',
    objectives: [{ type: 'collect', itemType: 'sapling', count: 3 }],
    rewards: [{ type: 'item', itemType: 'heartwood-cape' }],
    unique: false,
  },

  // ---------- Witch Apprentice + others ----------------------------
  {
    id: 'witch-apprentice',
    title: 'The Witch Apprentice',
    description: 'Help Sherry track down the lost potion.',
    giverKind: 'WitchSherry',
    objectives: [
      { type: 'collect', itemType: 'lost-potion', count: 1 },
      { type: 'talk', keyword: 'apprentice' },
    ],
    rewards: [{ type: 'gold', amount: 300 }, { type: 'item', itemType: 'witch-hat' }],
    unique: true,
  },
  {
    id: 'discovering-animal-training',
    title: 'Discovering Animal Training',
    description: 'Tame your first animal.',
    giverKind: 'AnimalTrainer',
    objectives: [{ type: 'talk', keyword: 'trained' }],
    rewards: [{ type: 'gold', amount: 100 }, { type: 'skill', skillId: 35, points: 5 }],
    unique: true,
  },
  {
    id: 'terrible-hatchlings',
    title: 'The Terrible Hatchlings',
    description: 'Slay 5 dragon hatchlings menacing the village.',
    giverKind: 'WorriedFarmer',
    objectives: [{ type: 'slay', kind: 'dragon-hatchling', count: 5 }],
    rewards: [{ type: 'gold', amount: 400 }, { type: 'fame', amount: 100 }],
    unique: false,
  },
  // ---------- Ritual / summoning / Exodus chain (parity 2026-05-16) ---
  {
    id: 'the-summoning',
    title: 'The Summoning',
    description: 'Aid the Mage Council in performing a sealed summoning ritual.',
    giverKind: 'ArchmageAcolyte',
    objectives: [
      { type: 'collect', itemType: 'soul-shard',     count: 3 },
      { type: 'collect', itemType: 'pristine-mandrake', count: 5 },
      { type: 'slay',    kind: 'summoned-fiend',    count: 1 },
    ],
    rewards: [
      { type: 'gold',  amount: 500 },
      { type: 'item',  itemType: 'mage-summon-token' },
      { type: 'fame',  amount: 200 },
    ],
    unique: true,
  },
  {
    id: 'the-ritual',
    title: 'The Ritual',
    description: 'Restore four broken altar tiles to break the curse on the inner sanctum.',
    giverKind: 'Hierophant',
    objectives: [
      { type: 'collect', itemType: 'altar-shard',  count: 4 },
      { type: 'talk',    keyword: 'place the shards' },
    ],
    rewards: [
      { type: 'gold',  amount: 600 },
      { type: 'item',  itemType: 'sanctified-amulet' },
      { type: 'skill', skillId: 24, points: 3 },     // Inscription
    ],
    unique: true,
  },
  {
    id: 'exodus-encounter',
    title: 'The Exodus Encounter',
    description: 'Penetrate Exodus\' clockwork fortress and disable the heart core.',
    giverKind: 'CovenantRunner',
    objectives: [
      { type: 'slay',    kind: 'exodus-minion',   count: 8 },
      { type: 'collect', itemType: 'exodus-key',  count: 1 },
      { type: 'slay',    kind: 'exodus',          count: 1 },
    ],
    rewards: [
      { type: 'gold',  amount: 5000 },
      { type: 'item',  itemType: 'major-artifact' },
      { type: 'fame',  amount: 1000 },
    ],
    unique: true,
  },
  {
    id: 'tiered-percelem-1',
    title: 'Percelem\'s First Trial',
    description: 'Prove your prowess by completing Percelem\'s first contract.',
    giverKind: 'Percelem',
    objectives: [{ type: 'slay', kind: 'lizardman', count: 12 }],
    rewards: [{ type: 'gold', amount: 200 }, { type: 'fame', amount: 50 }],
    unique: false,
    chain: 'percelem',
  },
  {
    id: 'tiered-percelem-2',
    title: 'Percelem\'s Second Trial',
    description: 'Continue Percelem\'s contract chain. Mid-tier marauders this time.',
    giverKind: 'Percelem',
    objectives: [{ type: 'slay', kind: 'orc-mage', count: 10 }],
    rewards: [{ type: 'gold', amount: 350 }, { type: 'fame', amount: 75 }],
    unique: false,
    chain: 'percelem', requires: 'tiered-percelem-1',
  },
  {
    id: 'tiered-percelem-3',
    title: 'Percelem\'s Final Trial',
    description: 'Percelem\'s last contract: clear a dragon brood from the hills.',
    giverKind: 'Percelem',
    objectives: [{ type: 'slay', kind: 'dragon', count: 1 }],
    rewards: [
      { type: 'gold',  amount: 1200 },
      { type: 'item',  itemType: 'percelem-token' },
      { type: 'fame',  amount: 200 },
    ],
    unique: true,
    chain: 'percelem', requires: 'tiered-percelem-2',
  },
  // ---------- Bard Mastery chain (Sir Berran / Felean / Hareus) ------
  {
    id: 'bard-mastery-berran',
    title: 'Sir Berran\'s Lessons',
    description: 'Train your provocation against the wild beasts of the Yew forest.',
    giverKind: 'SirBerran',
    objectives: [
      { type: 'slay', kind: 'forest-bear', count: 5 },
      { type: 'talk', keyword: 'mastery' },
    ],
    rewards: [
      { type: 'gold',  amount: 400 },
      { type: 'skill', skillId: 23, points: 3 },      // Provocation
    ],
    unique: true,
  },
  {
    id: 'bard-mastery-felean',
    title: 'Sir Felean\'s Lessons',
    description: 'Discord the beasts of Despise to weaken them before slaying.',
    giverKind: 'SirFelean',
    objectives: [
      { type: 'slay', kind: 'troll', count: 4 },
      { type: 'talk', keyword: 'discord' },
    ],
    rewards: [
      { type: 'gold',  amount: 500 },
      { type: 'skill', skillId: 16, points: 3 },      // Discordance
    ],
    unique: true,
  },
  {
    id: 'bard-mastery-hareus',
    title: 'Sir Hareus\'s Lessons',
    description: 'Use peacemaking to settle the unrest at the noble estate.',
    giverKind: 'SirHareus',
    objectives: [
      { type: 'slay', kind: 'rebel-noble', count: 3 },
      { type: 'talk', keyword: 'peace' },
    ],
    rewards: [
      { type: 'gold',  amount: 500 },
      { type: 'skill', skillId: 22, points: 3 },      // Peacemaking
    ],
    unique: true,
  },
];

export default function register(api) {
  const reg = api.mlQuests?.registerQuest ?? api.systems?.mlQuests?.registerQuest;
  if (!reg) {
    api.log('quests/_bulk-quests: api.mlQuests.registerQuest unavailable; skipping');
    return () => {};
  }
  const registered = [];
  for (const q of QUESTS) {
    try { reg(q); registered.push(q.id); }
    catch (e) {
      // Quest already registered (hot-reload race) — ignore.
      if (!String(e?.message ?? '').includes('Duplicate')) {
        api.log(`quests/_bulk-quests: failed ${q.id}: ${e.message}`);
      }
    }
  }
  const removeKillHook = api.corpse?.addKillHook?.((_world, victim, killer) => {
    if (!killer?.client || victim?.client || !victim?.kind) return;
    const advanced = api.mlQuests?.trackKill?.(killer, victim.kind)
      ?? api.systems?.mlQuests?.trackKill?.(killer, victim.kind)
      ?? [];
    for (const row of advanced) {
      if (row.q?.completed) {
        killer.client.sendSystemMessage?.(`Quest objective complete: ${row.def?.title ?? row.q.id}.`);
      }
    }
  });
  api.log(`quests/_bulk-quests: registered ${registered.length} quest definitions`);
  return () => {
    removeKillHook?.();
    const unregister = api.mlQuests?.unregisterQuest ?? api.systems?.mlQuests?.unregisterQuest;
    for (const id of registered) unregister?.(id);
  };
}
