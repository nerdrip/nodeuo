// ServUO P1 quest helper parity.
//
// The generated quest loader covers BaseQuest classes that live under
// Scripts/Quests, while many ServUO quest chains split behavior into
// tiny Conversation/Objective/QuestItem classes. This module maps those
// helper classes into our graph-based quest conversation API and data
// registries so the chains are discoverable and scriptable without
// carrying the C# inheritance tree across.

export const SERVUO_P1_QUEST_HELPER_CLASSES = Object.freeze([
  'DontOfferConversation',
  'AcceptConversation',
  'DuringKillQueensConversation',
  'EndConversation',
  'End2Conversation',
  'KillQueensObjective',
  'DiscordObjective',
  'PeacemakingObjective',
  'FriendshipMug',
  'BrassRing',
  'Dierdre',
  'Jason',
  'Kevin',
  'Maribel',
  'Nelson',
  'Walton',
  'DeclineConversation',
  'GabrielAutographConversation',
  'GabrielNoSheetMusicConversation',
  'NoSheetMusicConversation',
  'GetSheetMusicConversation',
  'GabrielSheetMusicConversation',
  'GabrielIgnoreConversation',
  'ElwoodDuringAutograph1Conversation',
  'ElwoodDuringAutograph2Conversation',
  'ElwoodDuringAutograph3Conversation',
  'TomasToysConversation',
  'TomasDuringCollectingConversation',
  'ElwoodDuringToys1Conversation',
  'ElwoodDuringToys2Conversation',
  'ElwoodDuringToys3Conversation',
  'FullEndConversation',
  'FindAlbertaObjective',
  'FindGabrielObjective',
  'FindSheetMusicObjective',
  'FindTomasObjective',
  'MakeRoomObjective',
  'ReanimateMaabusConversation',
  'MaabasConversation',
  'VaultOfSecretsConversation',
  'RadarConversation',
  'FindCrystalCaveObjective',
  'FindMaabusTombObjective',
  'FindVaultOfSecretsObjective',
  'SpeakCavePasswordObjective',
  'FindBankObjective',
  'UsingAnimalLoreQuest',
  'TeachingSomethingNewQuest',
  'Kane',
  'EnterCaveConversation',
  'GainInnInformationConversation',
  'SearchForSwordConversation',
  'LostSwordConversation',
  'EarnGiftsConversation',
  'EarnLessGiftsConversation',
  'EnterCaveObjective',
  'GainInnInformationObjective',
  'SearchForSwordObjective',
  'TimeForLegendsObjective',
  'TimeForLegendsQuest',
  'UnabridgedAtlasOfEodon',
  'KotlPowerCore',
  'Carroll',
  'Bront',
  'Eriathwen',
  'EllieRafkin',
  'Foxx',
  'TigerCub',
  'Trapper',
  'Poacher',
  'LavaRockDisplay',
  'FirstTrialKillConversation',
  'SecondTrialAttackConversation',
  'ThirdTrialKillConversation',
  'FirstTrialKillObjective',
  'SecondTrialAttackObjective',
  'ThirdTrialKillObjective',
  'JackLoanShark',
  'QuestContext',
  'SutekIngredientInfo',
  'QuestOfSingularity',
  'SpecialEndConversation',
  'NestArea',
  'StudyNestsObjective',
  'StudyOfSolenQuest',
  'TakeCareConversation',
  'FirstKillObjective',
  'SecondKillObjective',
  'ThirdKillObjective',
  'Bexil',
  'Grubbix',
  'CrystalLotusPuzzle',
  'PuzzleTile',
  'SchmendrickConversation',
  'DryadConversation',
  'FewReagentsConversation',
  'FindSchmendrickObjective',
  'FindDryadObjective',
  'MurderConversation',
  'RecipeConversation',
  'HagDuringIngredientsConversation',
  'RecentlyFinishedConversation',
  'FindZeefzorpulObjective',
  'FindIngredientObjective',
]);

const ITEM_TEMPLATES = [
  item('friendship-mug', 'Friendship Mug', 0x0995, ['FriendshipMug']),
  item('brass-ring', 'Brass Ring', 0x108A, ['BrassRing']),
  item('unabridged-atlas-of-eodon', 'Unabridged Atlas of Eodon', 0x0FBE, ['UnabridgedAtlasOfEodon']),
  item('kotl-power-core', 'Kotl Power Core', 0x1F19, ['KotlPowerCore']),
  item('lava-rock-display', 'Lava Rock Display', 0x1363, ['LavaRockDisplay']),
  item('crystal-lotus-puzzle', 'Crystal Lotus Puzzle', 0x2A7E, ['CrystalLotusPuzzle']),
  item('puzzle-tile', 'Puzzle Tile', 0x0515, ['PuzzleTile']),
  item('sutek-ingredient-info', 'Sutek Ingredient Notes', 0x14EF, ['SutekIngredientInfo']),
];

const NPC_TEMPLATES = [
  npc('dierdre', 'Dierdre', ['Dierdre']),
  npc('jason', 'Jason', ['Jason']),
  npc('kevin', 'Kevin', ['Kevin']),
  npc('maribel', 'Maribel', ['Maribel']),
  npc('nelson', 'Nelson', ['Nelson']),
  npc('walton', 'Walton', ['Walton']),
  npc('carroll', 'Carroll', ['Carroll']),
  npc('bront', 'Bront', ['Bront']),
  npc('eriathwen', 'Eriathwen', ['Eriathwen']),
  npc('ellie-rafkin', 'Ellie Rafkin', ['EllieRafkin']),
  npc('foxx', 'Foxx', ['Foxx']),
  npc('jack-loan-shark', 'Jack Loan Shark', ['JackLoanShark']),
  npc('bexil', 'Bexil', ['Bexil']),
  npc('grubbix', 'Grubbix', ['Grubbix']),
];

const MONSTER_TEMPLATES = [
  {
    kind: 'tiger-cub',
    name: 'a tiger cub',
    body: 0x00D6,
    hp: 35,
    hpMax: 35,
    str: 35,
    dex: 60,
    int: 20,
    dmgMin: 3,
    dmgMax: 7,
    notoriety: 1,
    tamable: true,
    tameable: true,
    servuoClass: 'TigerCub',
    servuoClasses: ['TigerCub'],
  },
  {
    kind: 'trapper',
    name: 'a trapper',
    body: 0x0190,
    hp: 120,
    hpMax: 120,
    str: 120,
    dex: 100,
    int: 40,
    dmgMin: 6,
    dmgMax: 14,
    notoriety: 5,
    aggroRange: 8,
    attackInterval: 1700,
    outfit: 'bandit',
    servuoClass: 'Trapper',
    servuoClasses: ['Trapper'],
  },
  {
    kind: 'poacher',
    name: 'a poacher',
    body: 0x0190,
    hp: 110,
    hpMax: 110,
    str: 110,
    dex: 110,
    int: 40,
    dmgMin: 6,
    dmgMax: 13,
    notoriety: 5,
    aggroRange: 8,
    attackInterval: 1600,
    outfit: 'bandit',
    servuoClass: 'Poacher',
    servuoClasses: ['Poacher'],
  },
];

const QUESTS = [
  quest('time-for-legends', 'TimeForLegendsQuest', 'hawkwind', [
    { type: 'talk', keyword: 'eodon', servuoClass: 'TimeForLegendsObjective' },
  ], [{ type: 'item', itemType: 'unabridged-atlas-of-eodon' }]),
  quest('using-animal-lore', 'UsingAnimalLoreQuest', 'animal-trainer', [
    { type: 'talk', keyword: 'animal lore' },
  ], [{ type: 'skill', skillId: 2, amount: 5, cap: 50 }]),
  quest('teaching-something-new', 'TeachingSomethingNewQuest', 'animal-trainer', [
    { type: 'talk', keyword: 'training' },
  ], [{ type: 'gold', amount: 250 }]),
  quest('quest-of-singularity', 'QuestOfSingularity', 'singularity-quester', [
    { type: 'collect', itemType: 'kotl-power-core', count: 1 },
  ], [{ type: 'item', itemType: 'kotl-power-core' }]),
  quest('study-of-solen', 'StudyOfSolenQuest', 'solen-naturalist', [
    { type: 'talk', keyword: 'nest', servuoClass: 'StudyNestsObjective' },
  ], [{ type: 'gold', amount: 500 }]),
];

const CONVERSATION_TREES = [
  conversation('ambitious-solen-queen', [
    'DontOfferConversation',
    'AcceptConversation',
    'DuringKillQueensConversation',
    'EndConversation',
    'End2Conversation',
    'KillQueensObjective',
  ]),
  conversation('collector', [
    'DontOfferConversation',
    'DeclineConversation',
    'AcceptConversation',
    'GabrielAutographConversation',
    'GabrielNoSheetMusicConversation',
    'NoSheetMusicConversation',
    'GetSheetMusicConversation',
    'GabrielSheetMusicConversation',
    'GabrielIgnoreConversation',
    'ElwoodDuringAutograph1Conversation',
    'ElwoodDuringAutograph2Conversation',
    'ElwoodDuringAutograph3Conversation',
    'TomasToysConversation',
    'TomasDuringCollectingConversation',
    'ElwoodDuringToys1Conversation',
    'ElwoodDuringToys2Conversation',
    'ElwoodDuringToys3Conversation',
    'EndConversation',
    'FullEndConversation',
    'FindAlbertaObjective',
    'FindGabrielObjective',
    'FindSheetMusicObjective',
    'FindTomasObjective',
    'MakeRoomObjective',
  ]),
  conversation('dark-tides', [
    'AcceptConversation',
    'ReanimateMaabusConversation',
    'MaabasConversation',
    'VaultOfSecretsConversation',
    'RadarConversation',
    'FindCrystalCaveObjective',
    'FindMaabusTombObjective',
    'FindVaultOfSecretsObjective',
    'SpeakCavePasswordObjective',
    'FindBankObjective',
  ]),
  conversation('eminos-undertaking', [
    'AcceptConversation',
    'RadarConversation',
    'EnterCaveConversation',
    'GainInnInformationConversation',
    'SearchForSwordConversation',
    'LostSwordConversation',
    'EarnGiftsConversation',
    'EarnLessGiftsConversation',
    'EnterCaveObjective',
    'GainInnInformationObjective',
    'SearchForSwordObjective',
  ]),
  conversation('haochis-trials', [
    'AcceptConversation',
    'RadarConversation',
    'FirstTrialKillConversation',
    'SecondTrialAttackConversation',
    'ThirdTrialKillConversation',
    'LostSwordConversation',
    'EndConversation',
    'FirstTrialKillObjective',
    'SecondTrialAttackObjective',
    'ThirdTrialKillObjective',
  ]),
  conversation('solen-matriarch', [
    'DontOfferConversation',
    'AcceptConversation',
    'EndConversation',
  ]),
  conversation('study-of-solen-hive', [
    'DontOfferConversation',
    'AcceptConversation',
    'EndConversation',
    'SpecialEndConversation',
    'NestArea',
    'StudyNestsObjective',
    'StudyOfSolenQuest',
  ]),
  conversation('terrible-hatchlings', [
    'AcceptConversation',
    'TakeCareConversation',
    'EndConversation',
    'FirstKillObjective',
    'SecondKillObjective',
    'ThirdKillObjective',
  ]),
  conversation('uzeraan-turmoil', [
    'AcceptConversation',
    'SchmendrickConversation',
    'DryadConversation',
    'RadarConversation',
    'FewReagentsConversation',
    'FindSchmendrickObjective',
    'FindDryadObjective',
  ]),
  conversation('witch-apprentice', [
    'DontOfferConversation',
    'AcceptConversation',
    'MurderConversation',
    'RecipeConversation',
    'HagDuringIngredientsConversation',
    'EndConversation',
    'RecentlyFinishedConversation',
    'FindZeefzorpulObjective',
    'FindIngredientObjective',
  ]),
  conversation('the-summoning', ['AcceptConversation']),
];

function item(name, label, itemId, classes) {
  return {
    name,
    label,
    itemId,
    weight: 1,
    questItem: true,
    servuoClass: classes[0],
    servuoClasses: classes,
  };
}

function npc(kind, name, classes) {
  return {
    kind,
    name,
    body: 0x0190,
    hp: 100,
    notoriety: 1,
    behavior: 'wander',
    outfit: 'peasant',
    vocation: 'quest',
    keywords: ['quest', 'help'],
    servuoClass: classes[0],
    servuoClasses: classes,
  };
}

function quest(id, servuoClass, giverKind, objectives, rewards) {
  return {
    id,
    title: titleOf(servuoClass),
    description: `${titleOf(servuoClass)} (${servuoClass})`,
    giverKind,
    objectives,
    rewards,
    servuoClass,
    servuoClasses: [servuoClass, ...objectives.map((o) => o.servuoClass).filter(Boolean)],
    sourcePath: 'templates/ServUO/Scripts/Quests',
  };
}

function titleOf(className) {
  return String(className)
    .replace(/Quest$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
}

function conversation(id, classes) {
  const nodes = classes.map((cls, idx) => ({
    id: cls,
    text: titleOf(cls),
    choices: idx < classes.length - 1 ? [{ key: 'continue', text: 'Continue', next: classes[idx + 1] }] : [],
    nextDefault: idx < classes.length - 1 ? classes[idx + 1] : undefined,
    terminal: idx === classes.length - 1,
    servuoClass: cls,
  }));
  return {
    id,
    entry: classes[0],
    servuoClasses: classes,
    nodes,
  };
}

function mergeClasses(prev, next) {
  return [...new Set([
    prev?.servuoClass,
    ...(prev?.servuoClasses ?? []),
    next?.servuoClass,
    ...(next?.servuoClasses ?? []),
  ].filter(Boolean))];
}

function upsertRegistry(disposers, registry, tmpl) {
  if (!registry?.register || !registry?.get) return;
  const prev = registry.get(tmpl.kind);
  const next = { ...(prev ?? {}), ...tmpl, servuoClasses: mergeClasses(prev, tmpl) };
  registry.register(next);
  disposers.push(() => {
    if (prev) registry.register(prev);
    else registry.unregister?.(tmpl.kind);
  });
}

function upsertTemplate(disposers, templates, tmpl) {
  if (!templates?.registerTemplate) return;
  const prev = templates.getTemplate?.(tmpl.name);
  templates.registerTemplate(tmpl);
  disposers.push(() => {
    if (prev) templates.registerTemplate(prev);
    else templates.unregisterTemplate?.(tmpl.name);
  });
}

function registerQuest(api, def) {
  const ml = api.mlQuests ?? api.systems?.mlQuests;
  if (ml?.getQuest?.(def.id)) return false;
  try {
    ml?.registerQuest?.(def);
    return true;
  } catch {
    return false;
  }
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  const disposers = [];
  for (const t of ITEM_TEMPLATES) upsertTemplate(disposers, api.templates, t);
  for (const n of NPC_TEMPLATES) upsertRegistry(disposers, api.npcs, n);
  for (const m of MONSTER_TEMPLATES) upsertRegistry(disposers, api.monsters, m);

  let quests = 0;
  for (const q of QUESTS) if (registerQuest(api, q)) quests++;

  const conv = api.systems?.questConversation ?? api.questConversation;
  if (conv?.registerConversation) {
    for (const tree of CONVERSATION_TREES) conv.registerConversation(tree.id, tree);
  }

  api.log?.(`servuo-p1-quest-parity: ${ITEM_TEMPLATES.length} items, ${NPC_TEMPLATES.length} NPCs, ${MONSTER_TEMPLATES.length} monsters, ${quests} quests, ${CONVERSATION_TREES.length} conversations`);
  return () => {
    for (const d of disposers.reverse()) {
      try { d(); } catch {}
    }
  };
}
