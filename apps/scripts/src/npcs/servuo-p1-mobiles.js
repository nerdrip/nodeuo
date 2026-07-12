// ServUO P1 mobile/NPC/quest parity pack.
//
// This file ports the high-priority gaps that were still showing as
// missing after the item/server pass: boss-side timers, Mondain quest
// givers living under Mobiles/NPCs, personal attendants, summon dummies,
// special satchels, and a few named/normal creatures that are not in the
// generated monster catalogue.

import { spawnNPC } from './vendors/_spawn.js';
import { mobileBySerial } from '../_entities.js';
import { createMobile, destroyMobileBySerial } from '../_mobiles.js';
import { sendToClientsNear, allMobiles } from '../_spatial.js';

export const SERVUO_P1_MOBILE_CLASSES = Object.freeze([
  'OppositionGroup',
  'FKEntry',
  'ExpirePolymorphTimer',
  'GazeTimer',
  'AddCloneCommands',
  'TeleportTimer',
  'CrimsonMeteorTimer',
  'StainedOoze',
  'EnragedColossus',
  'EnragedHart',
  'Eowmu',
  'ForgottenServant',
  'SolenHelper',
  'BunnyHole',
  'OverpopulationQuest',
  'NewLeadershipQuest',
  'ExAssassinsQuest',
  'CrimeAndPunishmentQuest',
  'HuteCoutureQuest',
  'AWorthyPropositionQuest',
  'KnowThineEnemyQuest',
  'SplitEndsQuest',
  'DustToDustQuest',
  'ArchSupportQuest',
  'AvengeTimer',
  'ChefsSatchel',
  'SmithsSatchel',
  'LumberjacksSatchel',
  'EgwexemWrit',
  'GuideHelper',
  'GuideVertex',
  'AttendantGuide',
  'AttendantMaleGuide',
  'AttendantFemaleGuide',
  'AttendantMaleHerald',
  'AttendantFemaleHerald',
  'HeraldSetAnnouncementTextEntry',
  'HeraldSetGreetingTextEntry',
  'AttendantStopEntry',
  'AttendantDismissEntry',
  'AttendantUseEntry',
  'CreepyCrawliesQuest',
  'VoraciousPlantsQuest',
  'GibberJabberQuest',
  'FrightmaresQuest',
  'MoltenReptilesQuest',
  'YeOldeGargishQuest',
  'EvilEyeQuest',
  'ThreeWishesQuest',
  'BigWormsQuest',
  'ItsGhastlyJobQuest',
  'TaleOfTailQuest',
  'SquishyQuest',
  'BigJobQuest',
  'WaitingToBeFilledQuest',
  'MusicToMyEarsQuest',
  'LastWordsQuest',
  'SBDryad',
  'CulinaryCrisisQuest',
  'GentleBladeQuest',
  'GrandpaCharley',
  'Curiosities',
  'AbandonShipEntry',
  'BulkOrderInfoEntry',
  'PendingConvert',
  'AbandonTimer',
  'SpeakPasswordEntry',
  'SomethingToWailAboutQuest',
  'RunawaysQuest',
  'ViciousPredatorQuest',
  'ScribingArcaneKnowledgeQuest',
  'WalkingSilentlyQuest',
  'KodarsRescueQuest',
  'Kodar',
  'Dermott',
  'Lissbet',
  'CutsBothWaysQuest',
  'NothingFancyQuest',
  'ViewSuitsEntry',
  'RotateEntry',
  'Messenger',
  'MilitiaCanoneer',
  'MoreOrePleaseQuest',
  'GuiltyQuest',
  'Neville',
  'CausticComboQuest',
  'PlagueLordQuest',
  'FleeAndFatigueQuest',
  'Sadrah',
  'ShakingThingsUpQuest',
  'FineFeastQuest',
  'Sculptor',
  'TickTockQuest',
  'ReptilianDentistQuest',
  'BeerGogglesQuest',
  'Vollem',
  'Vrulkax',
  'Zeefzorpul',
  'AutokillTimer',
  'DummyFence',
  'DummySword',
  'DummyNox',
  'DummyStun',
  'DummySuper',
  'DummyAssassin',
]);

const BOSS_ENRICHMENTS = [
  {
    kind: 'barracoon',
    servuoClass: 'Barracoon',
    servuoClasses: ['Barracoon', 'ExpirePolymorphTimer'],
    specialAbilities: ['BarracoonPolymorph', 'BarracoonSpawnRatmen'],
  },
  {
    kind: 'medusa',
    servuoClass: 'Medusa',
    servuoClasses: ['Medusa', 'GazeTimer', 'AddCloneCommands'],
    specialAbilities: ['VenomousBite', 'MedusaGaze', 'MedusaClone'],
  },
  {
    kind: 'primeval-lich',
    servuoClass: 'PrimevalLich',
    servuoClasses: ['PrimevalLich', 'TeleportTimer'],
    specialAbilities: ['PrimevalTeleport', 'PrimevalBlastRadius', 'PrimevalLightning'],
  },
  {
    kind: 'stygian-dragon',
    servuoClass: 'StygianDragon',
    servuoClasses: ['StygianDragon', 'CrimsonMeteorTimer'],
    specialAbilities: ['DragonBreath', 'StygianFireball', 'StygianCrimsonMeteor'],
  },
];

const MONSTERS = [
  {
    kind: 'enraged-colossus',
    aliases: ['enraged-collosus'],
    name: 'Rising Colossus',
    body: 829,
    hp: 600,
    hpMax: 600,
    str: 600,
    dex: 70,
    int: 80,
    dmgMin: 18,
    dmgMax: 21,
    notoriety: 5,
    aggroRange: 10,
    attackInterval: 1800,
    controlSlots: 5,
    virtualArmor: 58,
    bleedImmune: true,
    poisonImmune: 'Lethal',
    loot: 'filthy-rich',
    servuoClass: 'EnragedColossus',
    servuoClasses: ['EnragedColossus'],
    resists: { phys: 63, fire: 30, cold: 54, pois: 58, engy: 29 },
  },
  {
    kind: 'enraged-hart',
    name: 'an enraged hart',
    body: 0x00EA,
    hue: 0x0482,
    hp: 200,
    hpMax: 200,
    str: 200,
    dex: 200,
    int: 30,
    dmgMin: 5,
    dmgMax: 10,
    notoriety: 5,
    aggroRange: 8,
    attackInterval: 1600,
    summoned: true,
    servuoClass: 'EnragedHart',
    servuoClasses: ['EnragedHart'],
  },
  {
    kind: 'eowmu',
    name: 'Eowmu',
    body: 0x0115,
    hp: 125,
    hpMax: 125,
    str: 160,
    dex: 80,
    int: 40,
    dmgMin: 8,
    dmgMax: 14,
    notoriety: 1,
    tamable: true,
    tameable: true,
    controlSlots: 2,
    mount: true,
    servuoClass: 'Eowmu',
    servuoClasses: ['Eowmu', 'EowmuStatue', 'ICreatureStatuette'],
  },
  {
    kind: 'forgotten-servant',
    name: 'a Forgotten Servant',
    title: 'Forgotten Servant',
    body: 0x0190,
    hue: 768,
    hp: 123,
    hpMax: 123,
    str: 215,
    dex: 115,
    int: 85,
    dmgMin: 4,
    dmgMax: 14,
    notoriety: 6,
    aggroRange: 10,
    attackInterval: 1500,
    outfit: 'bandit',
    loot: 'average',
    servuoClass: 'ForgottenServant',
    servuoClasses: ['ForgottenServant'],
    resists: { phys: 35, fire: 40, cold: 30, pois: 40, engy: 40 },
  },
  {
    kind: 'bunny-hole',
    name: 'a bunny hole',
    body: 0x00CD,
    hue: 0x0481,
    hp: 1,
    hpMax: 1,
    str: 10,
    dex: 10,
    int: 10,
    dmgMin: 0,
    dmgMax: 0,
    notoriety: 1,
    invulnerable: true,
    behavior: 'idle',
    servuoClass: 'BunnyHole',
    servuoClasses: ['BunnyHole', 'VorpalBunny'],
  },
  {
    kind: 'ratman-mage',
    name: 'a ratman mage',
    body: 0x008E,
    hp: 110,
    hpMax: 110,
    str: 120,
    dex: 80,
    int: 120,
    dmgMin: 6,
    dmgMax: 14,
    notoriety: 5,
    aggroRange: 8,
    attackInterval: 1800,
    mageAI: true,
    loot: 'average',
    servuoClass: 'RatmanMage',
    servuoClasses: ['RatmanMage', 'Barracoon'],
  },
  {
    kind: 'medusa-clone',
    name: 'a medusa clone',
    body: 0x02D8,
    hue: 0x0455,
    hp: 250,
    hpMax: 250,
    str: 180,
    dex: 140,
    int: 80,
    dmgMin: 8,
    dmgMax: 16,
    notoriety: 5,
    aggroRange: 8,
    attackInterval: 1500,
    summoned: true,
    servuoClass: 'MedusaClone',
    servuoClasses: ['MedusaClone', 'AddCloneCommands'],
  },
  {
    kind: 'dummy-fence',
    name: 'a fencing training dummy',
    body: 0x0190,
    hp: 100,
    hpMax: 100,
    str: 100,
    dex: 100,
    int: 10,
    notoriety: 1,
    invulnerable: true,
    summoned: true,
    summonedUntil: 0,
    behavior: 'idle',
    servuoClass: 'DummyFence',
    servuoClasses: ['DummyFence', 'AutokillTimer'],
  },
  {
    kind: 'dummy-sword',
    name: 'a sword training dummy',
    body: 0x0190,
    hp: 100,
    hpMax: 100,
    str: 100,
    dex: 100,
    int: 10,
    notoriety: 1,
    invulnerable: true,
    summoned: true,
    summonedUntil: 0,
    behavior: 'idle',
    servuoClass: 'DummySword',
    servuoClasses: ['DummySword', 'AutokillTimer'],
  },
  {
    kind: 'dummy-nox',
    name: 'a poison training dummy',
    body: 0x0190,
    hue: 0x0044,
    hp: 100,
    hpMax: 100,
    str: 100,
    dex: 100,
    int: 10,
    notoriety: 1,
    invulnerable: true,
    summoned: true,
    summonedUntil: 0,
    behavior: 'idle',
    servuoClass: 'DummyNox',
    servuoClasses: ['DummyNox', 'AutokillTimer'],
  },
  {
    kind: 'dummy-stun',
    name: 'a stun training dummy',
    body: 0x0190,
    hue: 0x0455,
    hp: 100,
    hpMax: 100,
    str: 100,
    dex: 100,
    int: 10,
    notoriety: 1,
    invulnerable: true,
    summoned: true,
    summonedUntil: 0,
    behavior: 'idle',
    servuoClass: 'DummyStun',
    servuoClasses: ['DummyStun', 'AutokillTimer'],
  },
  {
    kind: 'dummy-super',
    name: 'a master training dummy',
    body: 0x0190,
    hue: 0x0481,
    hp: 250,
    hpMax: 250,
    str: 250,
    dex: 250,
    int: 10,
    notoriety: 1,
    invulnerable: true,
    summoned: true,
    summonedUntil: 0,
    behavior: 'idle',
    servuoClass: 'DummySuper',
    servuoClasses: ['DummySuper', 'AutokillTimer'],
  },
  {
    kind: 'dummy-assassin',
    name: 'an assassin training dummy',
    body: 0x0190,
    hue: 0x0901,
    hp: 140,
    hpMax: 140,
    str: 140,
    dex: 140,
    int: 40,
    notoriety: 1,
    invulnerable: true,
    summoned: true,
    summonedUntil: 0,
    behavior: 'idle',
    servuoClass: 'DummyAssassin',
    servuoClasses: ['DummyAssassin', 'AutokillTimer'],
  },
];

const NPCS = [
  npc('acob', 'Elder Acob', 'the wise', 0x190, 'noble', ['OverpopulationQuest', 'NewLeadershipQuest', 'ExAssassinsQuest', 'CrimeAndPunishmentQuest']),
  npc('ahie', 'Ahie', 'the cloth weaver', 0x191, 'peasant', ['HuteCoutureQuest']),
  npc('aliabeth', 'Aliabeth', 'the Tinker', 0x191, 'peasant', ['AWorthyPropositionQuest']),
  npc('andreas-vesalius', 'Andreas Vesalius', 'The Anatomy Instructor', 0x190, 'warrior', ['KnowThineEnemyQuest']),
  npc('andric', 'Andric', 'the archer trainer', 0x190, 'peasant', ['SplitEndsQuest']),
  npc('aniel', 'Aniel', 'the arborist', 0x190, 'peasant', ['DustToDustQuest', 'ArchSupportQuest']),
  npc('aulan', 'Aulan', 'the naturalist', 0x190, 'peasant', ['CreepyCrawliesQuest', 'VoraciousPlantsQuest', 'GibberJabberQuest', 'FrightmaresQuest', 'MoltenReptilesQuest']),
  npc('axem', 'Axem', 'the curator', 0x190, 'noble', ['YeOldeGargishQuest']),
  npc('brinnae', 'Brinnae', 'the wise', 0x191, 'mage', ['EvilEyeQuest', 'ThreeWishesQuest']),
  npc('caelas', 'Caelas', 'the ranger', 0x190, 'peasant', ['BigWormsQuest']),
  npc('cailla', 'Cailla', 'the hunter', 0x191, 'peasant', ['ItsGhastlyJobQuest', 'TaleOfTailQuest']),
  npc('cloorne', 'Cloorne', 'the collector', 0x190, 'peasant', ['SquishyQuest', 'BigJobQuest']),
  npc('dallid', 'Dallid', 'the provisioner', 0x190, 'peasant', ['WaitingToBeFilledQuest']),
  npc('danoel', 'Danoel', 'the musician', 0x190, 'peasant', ['MusicToMyEarsQuest']),
  npc('emerrillo', 'Emerillo', 'the chef', 0x190, 'peasant', ['CulinaryCrisisQuest']),
  npc('fabrizio', 'Fabrizio', 'the swordsman', 0x190, 'warrior', ['GentleBladeQuest']),
  npc('grandpa-charley', 'Grandpa Charley', null, 0x190, 'peasant', [], ['GrandpaCharley']),
  npc('gretchen', 'Gretchen', 'the curious', 0x191, 'peasant', ['Curiosities']),
  npc('hargrove', 'Hargrove', 'the lumberjack', 0x190, 'peasant', []),
  npc('jelrice', 'Jelrice', 'the beast hunter', 0x191, 'peasant', ['SomethingToWailAboutQuest', 'RunawaysQuest', 'ViciousPredatorQuest']),
  npc('jillian', 'Jillian', 'the scribe', 0x191, 'mage', ['ScribingArcaneKnowledgeQuest']),
  npc('jun', 'Jun', 'the stealth instructor', 0x190, 'bandit', ['WalkingSilentlyQuest']),
  npc('kane', 'Kane', 'the Master of Arms', 0x190, 'warrior', ['DoughtyWarriorsQuest'], ['Kane']),
  npc('kodar', 'Kodar', null, 0x190, 'warrior', ['KodarsRescueQuest'], ['Kodar']),
  npc('dermott', 'Dermott', null, 0x190, 'peasant', [], ['Dermott']),
  npc('lissbet', 'Lissbet', null, 0x191, 'peasant', [], ['Lissbet']),
  npc('lohn', 'Lohn', 'the blade trainer', 0x190, 'warrior', ['CutsBothWaysQuest', 'NothingFancyQuest']),
  npc('messenger', 'a messenger', null, 0x190, 'peasant', [], ['Messenger']),
  npc('militia-canoneer', 'a militia canoneer', null, 0x190, 'warrior', [], ['MilitiaCanoneer']),
  npc('mugg', 'Mugg', 'the miner', 0x190, 'peasant', ['MoreOrePleaseQuest']),
  npc('natalie', 'Natalie', null, 0x191, 'noble', ['GuiltyQuest']),
  npc('neville-brightwhistle', 'Neville Brightwhistle', null, 0x190, 'peasant', [], ['Neville']),
  npc('nillaen', 'Nillaen', 'the hunter', 0x191, 'peasant', ['CausticComboQuest', 'PlagueLordQuest']),
  npc('sadrah', 'Sadrah', null, 0x191, 'peasant', ['FleeAndFatigueQuest'], ['Sadrah']),
  npc('salaenih', 'Salaenih', 'the hunter', 0x191, 'peasant', ['ShakingThingsUpQuest']),
  npc('saril', 'Saril', 'the cook', 0x190, 'peasant', ['FineFeastQuest']),
  npc('sculptor', 'a sculptor', null, 0x190, 'peasant', [], ['Sculptor']),
  npc('sleen', 'Sleen', 'the tinker', 0x190, 'peasant', ['TickTockQuest', 'ReptilianDentistQuest']),
  npc('tholef', 'Tholef', 'the brewer', 0x190, 'peasant', ['BeerGogglesQuest']),
  npc('vollem', 'Vollem', null, 0x190, 'warrior', [], ['Vollem']),
  npc('vrulkax', 'Vrulkax', null, 0x190, 'warrior', [], ['Vrulkax']),
  npc('zeefzorpul', 'Zeefzorpul', null, 0x190, 'mage', [], ['Zeefzorpul', 'ZeefzorpulConversation']),
  {
    kind: 'attendant-guide',
    name: 'a personal guide',
    body: 0x190,
    hp: 100,
    notoriety: 1,
    behavior: 'wander',
    vocation: 'attendant',
    outfit: 'noble',
    keywords: ['guide', 'attendant', 'follow', 'stay'],
    servuoClass: 'AttendantGuide',
    servuoClasses: ['AttendantGuide', 'AttendantMaleGuide', 'AttendantFemaleGuide', 'GuideHelper', 'GuideVertex', 'AttendantStopEntry', 'AttendantDismissEntry', 'AttendantUseEntry'],
  },
  {
    kind: 'attendant-herald',
    name: 'a personal herald',
    body: 0x190,
    hp: 100,
    notoriety: 1,
    behavior: 'wander',
    vocation: 'attendant',
    outfit: 'noble',
    keywords: ['herald', 'announce', 'greet', 'follow', 'stay'],
    servuoClass: 'AttendantMaleHerald',
    servuoClasses: ['AttendantMaleHerald', 'AttendantFemaleHerald', 'HeraldSetAnnouncementTextEntry', 'HeraldSetGreetingTextEntry', 'AttendantStopEntry', 'AttendantDismissEntry', 'AttendantUseEntry'],
  },
];

const QUESTS = [
  quest('OverpopulationQuest', 'acob', [{ type: 'slay', kind: 'hind', count: 10 }], 'small-trinket-bag'),
  quest('NewLeadershipQuest', 'acob', [
    { type: 'slay', kind: 'serpents-fang-high-executioner', count: 1 },
    { type: 'slay', kind: 'tigers-claw-thief', count: 1 },
    { type: 'slay', kind: 'dragons-flame-grand-mage', count: 1 },
  ], 'reward-box'),
  quest('ExAssassinsQuest', 'acob', [{ type: 'slay', kind: 'serpents-fang-assassin', count: 10 }], 'treasure-bag'),
  quest('CrimeAndPunishmentQuest', 'acob', [{ type: 'slay', kind: 'tigers-claw-thief', count: 10 }], 'treasure-bag'),
  quest('HuteCoutureQuest', 'ahie', [{ type: 'collect', itemType: 'flower-garland', count: 10 }], 'tailors-craftsman-satchel'),
  quest('AWorthyPropositionQuest', 'aliabeth', [
    { type: 'collect', itemType: 'bamboo-flute', count: 10 },
    { type: 'collect', itemType: 'elven-fletching', count: 1 },
  ], 'valuable-imbuing-bag'),
  quest('KnowThineEnemyQuest', 'andreas-vesalius', [{ type: 'talk', keyword: 'anatomy' }], 'tunic-of-guarding'),
  quest('SplitEndsQuest', 'andric', [{ type: 'collect', itemType: 'arrow', count: 20 }], 'fletchers-satchel'),
  quest('DustToDustQuest', 'aniel', [{ type: 'slay', kind: 'earth-elemental', count: 12 }], 'treasure-bag'),
  quest('ArchSupportQuest', 'aniel', [{ type: 'collect', itemType: 'foot-stool', count: 10 }], 'carpenters-craftsman-satchel'),
  quest('CreepyCrawliesQuest', 'aulan', [{ type: 'slay', kind: 'giant-spider', count: 12 }], 'trinket-bag'),
  quest('VoraciousPlantsQuest', 'aulan', [{ type: 'slay', kind: 'corpser', count: 8 }, { type: 'slay', kind: 'swamp-tentacle', count: 2 }], 'trinket-bag'),
  quest('GibberJabberQuest', 'aulan', [{ type: 'slay', kind: 'gibberling', count: 10 }], 'trinket-bag'),
  quest('FrightmaresQuest', 'aulan', [{ type: 'slay', kind: 'plague-spawn', count: 10 }], 'trinket-bag'),
  quest('MoltenReptilesQuest', 'aulan', [{ type: 'slay', kind: 'lava-lizard', count: 10 }], 'trinket-bag'),
  quest('YeOldeGargishQuest', 'axem', [{ type: 'collect', itemType: 'untranslated-ancient-tome', count: 1 }], 'bulging-museum-bag'),
  quest('EvilEyeQuest', 'brinnae', [{ type: 'slay', kind: 'gazer', count: 12 }], 'treasure-bag'),
  quest('ThreeWishesQuest', 'brinnae', [{ type: 'slay', kind: 'efreet', count: 8 }], 'large-treasure-bag'),
  quest('BigWormsQuest', 'caelas', [{ type: 'slay', kind: 'giant-serpent', count: 10 }], 'trinket-bag'),
  quest('ItsGhastlyJobQuest', 'cailla', [{ type: 'slay', kind: 'zombie', count: 5 }, { type: 'slay', kind: 'skeleton', count: 5 }], 'trinket-bag'),
  quest('TaleOfTailQuest', 'cailla', [{ type: 'slay', kind: 'red-solen-worker', count: 12 }, { type: 'slay', kind: 'black-solen-worker', count: 12 }], 'trinket-bag'),
  quest('SquishyQuest', 'cloorne', [{ type: 'slay', kind: 'slime', count: 12 }], 'trinket-bag'),
  quest('BigJobQuest', 'cloorne', [{ type: 'slay', kind: 'ogre', count: 10 }], 'trinket-bag'),
  quest('WaitingToBeFilledQuest', 'dallid', [{ type: 'collect', itemType: 'empty-pitcher', count: 10 }], 'trinket-bag'),
  quest('MusicToMyEarsQuest', 'danoel', [{ type: 'collect', itemType: 'lap-harp', count: 20 }], 'carpenters-craftsman-satchel'),
  quest('LastWordsQuest', 'denthes-journal', [{ type: 'talk', keyword: 'last-words' }], 'treasure-bag'),
  quest('CulinaryCrisisQuest', 'emerrillo', [{ type: 'collect', itemType: 'cookie-mix', count: 5 }], 'chefs-satchel'),
  quest('GentleBladeQuest', 'fabrizio', [{ type: 'collect', itemType: 'broadsword', count: 10 }], 'smiths-craftsman-satchel'),
  quest('Curiosities', 'gretchen', [{ type: 'collect', itemType: 'spyglass', count: 20 }], 'tinkers-craftsman-satchel'),
  quest('SomethingToWailAboutQuest', 'jelrice', [{ type: 'slay', kind: 'banshee', count: 10 }], 'treasure-bag'),
  quest('RunawaysQuest', 'jelrice', [{ type: 'slay', kind: 'hell-hound', count: 10 }], 'treasure-bag'),
  quest('ViciousPredatorQuest', 'jelrice', [{ type: 'slay', kind: 'dire-wolf', count: 10 }], 'treasure-bag'),
  quest('ScribingArcaneKnowledgeQuest', 'jillian', [{ type: 'collect', itemType: 'blank-scroll', count: 25 }], 'scribes-satchel'),
  quest('WalkingSilentlyQuest', 'jun', [{ type: 'talk', keyword: 'stealth' }], 'twilight-jacket'),
  quest('KodarsRescueQuest', 'kodar', [{ type: 'escort', fromRegion: 'Palace of Paroxysmus', toRegion: 'Paroxysmus Exit' }], 'large-treasure-bag'),
  quest('CutsBothWaysQuest', 'lohn', [{ type: 'collect', itemType: 'dagger', count: 10 }], 'smiths-craftsman-satchel'),
  quest('NothingFancyQuest', 'lohn', [{ type: 'collect', itemType: 'butcher-knife', count: 10 }], 'smiths-craftsman-satchel'),
  quest('MoreOrePleaseQuest', 'mugg', [{ type: 'collect', itemType: 'iron-ore', count: 5 }], 'miners-quest-satchel'),
  quest('GuiltyQuest', 'natalie', [{ type: 'slay', kind: 'gregorio', count: 1 }], 'amulet-of-righteousness'),
  quest('CausticComboQuest', 'nillaen', [{ type: 'slay', kind: 'poison-elemental', count: 3 }, { type: 'slay', kind: 'toxic-elemental', count: 6 }], 'large-treasure-bag'),
  quest('PlagueLordQuest', 'nillaen', [{ type: 'slay', kind: 'plague-spawn', count: 10 }, { type: 'slay', kind: 'plague-beast', count: 3 }], 'large-treasure-bag'),
  quest('FleeAndFatigueQuest', 'sadrah', [{ type: 'collect', itemType: 'refresh-potion', count: 10 }], 'alchemists-satchel'),
  quest('ShakingThingsUpQuest', 'salaenih', [{ type: 'slay', kind: 'red-solen-warrior', count: 10 }, { type: 'slay', kind: 'black-solen-warrior', count: 10 }], 'treasure-bag'),
  quest('FineFeastQuest', 'saril', [{ type: 'slay', kind: 'sheep', count: 10 }], 'small-trinket-bag'),
  quest('TickTockQuest', 'sleen', [{ type: 'collect', itemType: 'clock', count: 10 }], 'tinkers-craftsman-satchel'),
  quest('ReptilianDentistQuest', 'sleen', [{ type: 'collect', itemType: 'coils-fang', count: 1 }], 'alchemist-craftsman-satchel'),
  quest('BeerGogglesQuest', 'tholef', [{ type: 'collect', itemType: 'barrel-tap', count: 25 }], 'tinkers-craftsman-satchel'),
];

const ITEM_TEMPLATES = [
  item('chefs-satchel', "Chef's Satchel", 0x0E75, ['ChefsSatchel']),
  item('smiths-craftsman-satchel', "Smith's Craftsman Satchel", 0x0E75, ['SmithsSatchel']),
  item('lumberjacks-satchel', "Lumberjack's Satchel", 0x0E75, ['LumberjacksSatchel']),
  item('egwexem-writ', "Egwexem's Writ", 0x14F0, ['EgwexemWrit']),
  {
    name: 'stained-ooze',
    label: 'stained ooze',
    itemId: 0x122A,
    hue: 0x0044,
    weight: 1,
    movable: false,
    script: 'stained-ooze',
    corrosive: true,
    servuoClass: 'StainedOoze',
    servuoClasses: ['StainedOoze'],
  },
];

function npc(kind, name, title, body, outfit, questClasses = [], extraClasses = []) {
  return {
    kind,
    name,
    title: title ?? undefined,
    body,
    hp: 100,
    notoriety: 1,
    behavior: 'wander',
    vocation: questClasses.length ? 'quest-giver' : 'townsfolk',
    outfit,
    keywords: questClasses.length ? ['quest', 'job', 'help', 'mission'] : [],
    quests: questClasses.map(classToId),
    servuoClass: classNameFromKind(kind),
    servuoClasses: [classNameFromKind(kind), ...questClasses, ...extraClasses],
  };
}

function item(name, label, itemId, classes) {
  return {
    name,
    label,
    itemId,
    weight: 1,
    container: true,
    gumpId: 0x003E,
    servuoClass: classes[0],
    servuoClasses: classes,
  };
}

function quest(className, giverKind, objectives, rewardItem) {
  return {
    id: classToId(className),
    title: classToTitle(className),
    description: `${classToTitle(className)} (${className})`,
    giverKind,
    objectives,
    rewards: rewardItem ? [{ type: 'item', itemType: rewardItem }] : [],
    unique: false,
    servuoClass: className,
    servuoClasses: [className],
    sourcePath: 'templates/ServUO/Scripts/Mobiles/NPCs',
  };
}

function classToId(className) {
  return String(className)
    .replace(/Quest$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-');
}

function classToTitle(className) {
  return String(className)
    .replace(/Quest$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function classNameFromKind(kind) {
  return String(kind)
    .split('-')
    .filter(Boolean)
    .map((p) => p[0]?.toUpperCase() + p.slice(1))
    .join('');
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function mergeClasses(prev, next) {
  return uniq([
    prev?.servuoClass,
    ...(prev?.servuoClasses ?? []),
    next?.servuoClass,
    ...(next?.servuoClasses ?? []),
  ]);
}

function upsertRegistry(disposers, registry, tmpl) {
  if (!registry?.register || !registry?.get) return;
  const prev = registry.get(tmpl.kind);
  if (!prev && !Number.isFinite(tmpl.body)) return;
  const next = {
    ...(prev ?? {}),
    ...tmpl,
    servuoClasses: mergeClasses(prev, tmpl),
  };
  registry.register(next);
  disposers.push(() => {
    if (prev) registry.register(prev);
    else registry.unregister?.(tmpl.kind);
  });
}

function upsertTemplate(disposers, templates, tmpl) {
  if (!templates?.registerTemplate) return;
  const prev = templates.getTemplate?.(tmpl.name) ?? templates.get?.(tmpl.name);
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

function registerStainedOozeScript(api, disposers) {
  const registry = api.itemScripts;
  if (!registry?.register) return;
  registry.register({
    name: 'stained-ooze',
    servuoClass: 'StainedOoze',
    onWalkOn(world, item, mob) {
      if (!mob || mob.ghost || mob.dead) return;
      const next = item._nextOozeHitAt ?? 0;
      const now = Date.now();
      if (next > now) return;
      item._nextOozeHitAt = now + 1000;
      const dmg = item.corrosive === false ? 3 : 8;
      try { api.combat?.damage?.(world, mob, dmg, item); }
      catch { mob.hp = Math.max(0, (mob.hp ?? mob.hpMax ?? 1) - dmg); }
      mob.client?.sendSystemMessage?.('The stained ooze burns your feet.');
    },
  });
  disposers.push(() => registry.unregister?.('stained-ooze'));
}

function say(api, mob, text, hue = 0x03B2) {
  if (!mob || !text) return;
  if (api.protocol?.unicodeMessage) {
    const pkt = api.protocol.unicodeMessage({
      serial: mob.serial,
      graphic: mob.body,
      type: 0,
      hue,
      font: 3,
      language: 'ENU',
      name: mob.name ?? '',
      text,
    });
    sendToClientsNear(api, mob, pkt, null, 18);
  }
}

function setAttendantMode(api, attendant, owner, mode) {
  attendant._attendantOwner = owner?.serial ?? attendant._attendantOwner;
  if (mode === 'dismiss') {
    say(api, attendant, 'I shall take my leave.');
    destroyMobileBySerial(api, attendant.serial);
    return;
  }
  if (mode === 'stay' || mode === 'stop') {
    attendant.controlOrder = 'stay';
    attendant.controlTarget = null;
    attendant._attendantStopped = true;
    say(api, attendant, 'I will wait here.');
    return;
  }
  if (mode === 'follow' || mode === 'use') {
    attendant.controlOrder = 'follow';
    attendant.controlTarget = owner?.serial ?? null;
    attendant._attendantStopped = false;
    say(api, attendant, 'I am at your service.');
  }
}

function parseSerial(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return 0;
  return Number.parseInt(text.replace(/^0x/i, ''), 16) || Number.parseInt(text, 10) || 0;
}

function registerCommands(api, disposers) {
  const commands = api.commands;
  if (!commands?.register) return;
  commands.register({
    name: 'servuo-npc',
    access: 'GameMaster',
    help: '[servuo-npc <kind> - spawn a ServUO P1 quest/attendant NPC.',
    run(ctx, rawArgs = null) {
      const args = rawArgs ?? ctx.args ?? [];
      const q = String(args[0] ?? '').toLowerCase();
      if (!q || q === 'list') {
        const kinds = NPCS.map((n) => n.kind).sort();
        ctx.state.sendSystemMessage(`ServUO P1 NPCs: ${kinds.join(', ')}`);
        return;
      }
      const found = NPCS.find((n) => n.kind === q || n.kind.includes(q) || n.name.toLowerCase().includes(q));
      if (!found) {
        ctx.state.sendSystemMessage(`Unknown ServUO P1 NPC '${q}'. Use [servuo-npc list.`);
        return;
      }
      const mob = spawnNPC(api, ctx.sender, {
        name: found.name,
        body: found.body,
        hue: found.hue ?? 0,
        notoriety: found.notoriety ?? 1,
        invulnerable: true,
        kind: found.kind,
        outfit: found.outfit,
        behavior: found.behavior,
        keywords: found.keywords,
        fields: {
          kind: found.kind,
          title: found.title,
          servuoClass: found.servuoClass,
          servuoClasses: found.servuoClasses,
          quests: found.quests,
          _listensToSpeech: found.keywords?.length > 0,
          _speechKeywords: found.keywords,
        },
      });
      if (mob) ctx.state.sendSystemMessage(`Spawned ${found.name} (0x${mob.serial.toString(16)}).`);
    },
  });
  commands.register({
    name: 'attendant',
    access: 'Player',
    help: '[attendant <serial> follow|stay|dismiss|greet <text>|announce <text>',
    run(ctx, rawArgs = null) {
      const args = rawArgs ?? ctx.args ?? [];
      const attendant = mobileBySerial(api, parseSerial(args[0]));
      if (!attendant) {
        ctx.state.sendSystemMessage('Usage: [attendant <serial> follow|stay|dismiss|greet <text>|announce <text>');
        return;
      }
      const action = String(args[1] ?? '').toLowerCase();
      if (action === 'follow' || action === 'stay' || action === 'stop' || action === 'dismiss' || action === 'use') {
        setAttendantMode(api, attendant, ctx.sender, action);
        return;
      }
      if (action === 'greet') {
        attendant._heraldGreeting = args.slice(2).join(' ') || 'Welcome, traveler.';
        attendant._heraldGreetingClass = 'HeraldSetGreetingTextEntry';
        say(api, attendant, attendant._heraldGreeting);
        return;
      }
      if (action === 'announce') {
        attendant._heraldAnnouncement = args.slice(2).join(' ') || `${ctx.sender?.name ?? 'The owner'} has arrived.`;
        attendant._heraldAnnouncementClass = 'HeraldSetAnnouncementTextEntry';
        say(api, attendant, attendant._heraldAnnouncement, 0x0035);
        return;
      }
      ctx.state.sendSystemMessage('Unknown attendant command.');
    },
  });
  commands.register({
    name: 'summondummy',
    access: 'GameMaster',
    help: '[summondummy fence|sword|nox|stun|super|assassin [seconds]',
    run(ctx, rawArgs = null) {
      const args = rawArgs ?? ctx.args ?? [];
      const kind = `dummy-${String(args[0] ?? 'fence').toLowerCase()}`;
      const cfg = api.monsters?.get?.(kind);
      if (!cfg) {
        ctx.state.sendSystemMessage('Unknown dummy kind.');
        return;
      }
      const seconds = Math.max(10, Math.min(3600, Number.parseInt(args[1] ?? '300', 10) || 300));
      const mob = createMobile(api, {
        name: cfg.name,
        body: cfg.body,
        hue: cfg.hue ?? 0,
        x: ctx.sender.x,
        y: ctx.sender.y,
        z: ctx.sender.z,
        map: ctx.sender.map ?? 1,
        notoriety: 1,
        hp: cfg.hp,
        hpMax: cfg.hpMax ?? cfg.hp,
        summoned: true,
        summonedUntil: Date.now() + seconds * 1000,
        kind,
        servuoClass: cfg.servuoClass,
        servuoClasses: cfg.servuoClasses,
      });
      if (mob) {
        try { api.ai?.attach?.(mob, 'idle'); } catch {}
        ctx.state.sendSystemMessage(`Summoned ${cfg.name} for ${seconds}s.`);
      }
    },
  });
  disposers.push(() => {
    commands.unregister?.('servuo-npc');
    commands.unregister?.('attendant');
    commands.unregister?.('summondummy');
  });
}

function sweepTimedStates(api) {
  const now = Date.now();
  for (const mob of allMobiles(api)) {
    if (mob._servuoPolymorphUntil && mob._servuoPolymorphUntil <= now) {
      mob.body = mob._servuoOriginalBody ?? mob.body;
      mob.hue = mob._servuoOriginalHue ?? mob.hue;
      delete mob._servuoPolymorphUntil;
      delete mob._servuoOriginalBody;
      delete mob._servuoOriginalHue;
      mob.client?.sendSystemMessage?.('You feel your shape return to normal.');
    }
    if (mob._medusaStoneUntil && mob._medusaStoneUntil <= now) {
      mob._paralyzedUntil = Math.min(mob._paralyzedUntil ?? 0, now);
      delete mob._medusaStoneUntil;
      mob.client?.sendSystemMessage?.("Medusa's gaze releases you.");
    }
    if (mob.summoned && mob.summonedUntil && mob.summonedUntil <= now) {
      destroyMobileBySerial(api, mob.serial);
    }
  }
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  const disposers = [];

  for (const e of BOSS_ENRICHMENTS) upsertRegistry(disposers, api.monsters, e);
  for (const m of MONSTERS) {
    const aliases = m.aliases ?? [];
    const base = { ...m };
    delete base.aliases;
    upsertRegistry(disposers, api.monsters, base);
    for (const alias of aliases) upsertRegistry(disposers, api.monsters, { ...base, kind: alias, aliasOf: base.kind });
  }
  for (const n of NPCS) upsertRegistry(disposers, api.npcs, n);
  for (const t of ITEM_TEMPLATES) upsertTemplate(disposers, api.templates, t);
  registerStainedOozeScript(api, disposers);

  let registeredQuests = 0;
  for (const q of QUESTS) {
    if (registerQuest(api, q)) registeredQuests++;
  }
  registerCommands(api, disposers);

  const interval = setInterval(() => sweepTimedStates(api), 1000);
  interval.unref?.();
  disposers.push(() => clearInterval(interval));

  api.log?.(`servuo-p1-mobiles: ${MONSTERS.length} monsters, ${NPCS.length} NPCs, ${registeredQuests} quests, ${ITEM_TEMPLATES.length} item templates registered`);
  return () => {
    for (const d of disposers.reverse()) {
      try { d(); } catch {}
    }
  };
}
