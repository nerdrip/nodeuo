// Extra lore + flavour content — books, signposts, decoration. Mirrors
// ServUO `Items/Books/Library/` + `Items/Decorative/Sign*.cs`.
// Pure data; uses the existing `book` script (page-flip) + `sign-post`
// (look-name).



// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];

function book(def) {
  __PENDING__.push({
    kind: 'book', weight: 2,
    script: 'readable-book',
    pages: def.pages ?? [],
    title: def.title, author: def.author ?? 'Unknown',
    ...def,
  });
}

function signpost(def) {
  __PENDING__.push({
    kind: 'functional', weight: 30, movable: false,
    script: 'sign-post',
    ...def,
  });
}

// =====================================================================
//  HISTORY BOOKS
// =====================================================================
book({
  id: 0x42AC, name: 'A History of Britannia',
  tagId: 'book-history-britannia',
  title: 'A History of Britannia', author: 'Sage Avery',
  pages: [
    ['CHAPTER ONE', '',
      'Before Lord British walked these lands,',
      'the realms were ruled by the Three Mages,',
      'who fell to the Triad of Evil.',
    ],
    ['CHAPTER TWO', '',
      'The Avatar arrived from another world',
      'and walked the path of the Eight Virtues.',
      'Through trial and sacrifice, the Avatar',
      'restored order to Britannia.',
    ],
    ['CHAPTER THREE', '',
      'The Gargish Wars opened a portal',
      'between Britannia and Ter Mur.',
      'Today, gargoyles walk our cities',
      'as friends and merchants.',
    ],
    ['CHAPTER FOUR', '',
      'The Stygian Abyss opened beneath',
      'Royal City. The Stygian Dragon',
      'and his minions threaten us still.',
    ],
  ],
});

book({
  id: 0x42AD, name: 'On the Eight Virtues',
  tagId: 'book-eight-virtues',
  title: 'On the Eight Virtues', author: 'Lord British',
  pages: [
    ['HONESTY', '',
      'Truth is the foundation of trust.',
      'Speak honestly even when it pains thee.',
    ],
    ['COMPASSION', '',
      'Tend to those who suffer.',
      'A kind word costs nothing.',
    ],
    ['VALOR', '',
      'Stand against evil without flinching.',
      'Run not from a worthy battle.',
    ],
    ['JUSTICE', '',
      'Reward goodness, punish evil.',
      'Let no crime go unanswered.',
    ],
    ['SACRIFICE', '',
      'Give of thyself for others.',
      'A coin given freely is worth more',
      'than ten coins hoarded.',
    ],
    ['HONOR', '',
      'Live by thy word.',
      'A promise made is a promise kept.',
    ],
    ['SPIRITUALITY', '',
      'Seek the inner truth.',
      'Meditate often. Listen to the silence.',
    ],
    ['HUMILITY', '',
      'Walk lightly upon the world.',
      'No deed of thine is so great that it',
      'should be remembered above thy soul.',
    ],
  ],
});

book({
  id: 0x42AE, name: 'A Bestiary of Britannia',
  tagId: 'book-bestiary',
  title: 'A Bestiary of Britannia', author: 'Animal Lorist Pyros',
  pages: [
    ['DRAGONS', '',
      'Largest predators of Britannia.',
      'Breath: fire (red), ice (white), poison (green).',
      'Hide makes excellent armor.',
    ],
    ['LICHES', '',
      'Risen wizards who refused death.',
      'Cast spells of necromancy and magery.',
      'Phylacteries hidden, prevent true death.',
    ],
    ['DAEMONS', '',
      'Outsiders from the planes of fire.',
      'Hate cold, vulnerable to silver weapons.',
      'Some can be commanded by skilled summoners.',
    ],
    ['ELEMENTALS', '',
      'Living embodiments of the four elements.',
      'Fire, water, earth, air, plus rare blood',
      'and snow variants.',
    ],
    ['UNDEAD', '',
      'Skeletons, zombies, wraiths, mummies.',
      'Repelled by holy symbols and Chivalry.',
      'Drop bones, raw materials for necromancy.',
    ],
  ],
});

book({
  id: 0x42AF, name: 'Cooking with Britannia',
  tagId: 'book-cookbook',
  title: 'Cooking with Britannia', author: 'Chef Hank',
  pages: [
    ['BREAD', '',
      'Take 1 measure of flour.',
      'Mix with water. Bake on hot stone.',
      'Yield: 1 loaf.',
    ],
    ['ROAST CHICKEN', '',
      'Pluck chicken. Salt and herb generously.',
      'Roast over open fire 30 minutes.',
      'Yield: hearty meal for two.',
    ],
    ['APPLE PIE', '',
      'Peel four apples. Mix with sugar + flour.',
      'Bake in iron oven 45 minutes.',
      'Cool before serving.',
    ],
    ['SPICED WINE', '',
      'Heat wine with cinnamon and cloves.',
      'Add honey. Serve hot, not boiling.',
    ],
  ],
});

book({
  id: 0x42B0, name: 'A Smith\'s Apprentice Manual',
  tagId: 'book-smith-manual',
  title: 'A Smith\'s Apprentice Manual',
  author: 'Master Smith Gareth',
  pages: [
    ['THE FORGE', '',
      'Heat is everything. A cold forge ruins iron.',
      'Stoke until coals glow white.',
    ],
    ['TONGS AND HAMMERS', '',
      'Choose the right tongs for the task.',
      'A heavy hammer wears the smith faster',
      'than a light hammer used precisely.',
    ],
    ['QUENCHING', '',
      'Quench in oil for hardness.',
      'Quench in water for brittleness.',
      'A skilled smith knows which to choose.',
    ],
  ],
});

book({
  id: 0x42B1, name: 'Notes on Magery',
  tagId: 'book-magery-notes',
  title: 'Notes on Magery',
  author: 'Apprentice Sage',
  pages: [
    ['REAGENTS', '',
      'Black Pearl, Blood Moss, Garlic,',
      'Ginseng, Mandrake Root, Nightshade,',
      'Spider Silk, Sulfurous Ash.',
    ],
    ['CIRCLES', '',
      'Eight circles, each more difficult.',
      'Magic Arrow → Earthquake.',
      'Skill required scales with circle.',
    ],
    ['SPELL FAILURE', '',
      'A failed spell wastes mana and reagents.',
      'Stand still while casting; movement',
      'increases the chance of fizzle.',
    ],
  ],
});

// =====================================================================
//  GARGISH DOCUMENTS (ServUO `GargishDocumentBook` / `Note`)
// =====================================================================
const GARGISH_DOCUMENT_BOOKS = [
  {
    tagId: 'gargish-challenge-rite',
    servuoClass: 'ChallengeRite',
    title: '#1150904',
    author: 'unknown',
    hue: 1007,
    clilocs: [1150915, 1150916, 1150917, 1150918, 1150919, 1150920, 1150921, 1150922],
  },
  {
    tagId: 'gargish-on-the-void',
    servuoClass: 'OnTheVoid',
    title: '#1150907',
    author: 'Prugyilonus',
    hue: 404,
    clilocs: [1150894, 1150895, 1150896],
  },
  {
    tagId: 'gargish-in-memory',
    servuoClass: 'InMemory',
    title: '#1150913',
    author: 'Queen Zhah',
    hue: 375,
    clilocs: [1151071, 1151072, 1151073],
  },
  {
    tagId: 'gargish-queen-chronicle-1',
    servuoClass: 'ChronicleOfTheGargoyleQueen1',
    title: '#1150914',
    author: 'Queen Zhah',
    hue: 567,
    charges: 500,
    clilocs: [1150901, ...Array.from({ length: 33 }, (_, i) => 1150943 + i)],
  },
];
for (const doc of GARGISH_DOCUMENT_BOOKS) {
  book({
    id: 4082,
    name: `Gargish Document - ${doc.title}`,
    tagId: doc.tagId,
    title: doc.title,
    author: doc.author,
    hue: doc.hue,
    charges: doc.charges,
    bookContentClilocs: doc.clilocs,
    pages: [],
    readOnly: true,
    servuoClass: doc.servuoClass,
    servuoBaseClass: 'GargishDocumentBook',
    servuoClasses: [doc.servuoClass, 'GargishDocumentBook', 'BaseLocalizedBook', 'BookPageDetails'],
  });
}

const GARGISH_DOCUMENT_NOTES = [
  ['gargish-athenaeum-decree', 'AnthenaeumDecree', '#1150905', 1150891],
  ['gargish-letter-from-the-king', 'LetterFromTheKing', '#1150906',
    'To Her Honor the High Broodmother, Lady Zhah from his majesty, King Trajalem:<br><br>High Broodmother, I have received your latest petition regarding your desires and I once again must remind you that I have absolutely no interest in altering tradition or granting you freedom from the slavery you have deluded yourself into believing makes up your life.'],
  ['gargish-shilaxrinars-memorial', 'ShilaxrinarsMemorial', '#1150908', 1150899],
  ['gargish-to-the-high-scholar', 'ToTheHighScholar', '#1150909', 1151062],
  ['gargish-to-the-high-broodmother', 'ToTheHighBroodmother', '#1150910', 1151064],
  ['gargish-reply-to-the-high-scholar', 'ReplyToTheHighScholar', '#1150911', 1151066],
  ['gargish-access-to-the-isle', 'AccessToTheIsle', '#1150912', 1151069],
];
for (const [tagId, servuoClass, title, content] of GARGISH_DOCUMENT_NOTES) {
  book({
    id: 5357,
    name: `Gargish Document - ${title}`,
    tagId,
    title,
    author: 'Unknown',
    bookContentClilocs: Number.isFinite(content) ? [content] : [],
    noteString: typeof content === 'string' ? content : undefined,
    pages: [],
    readOnly: true,
    servuoClass,
    servuoBaseClass: 'GargishDocumentNote',
    servuoClasses: [servuoClass, 'GargishDocumentNote', 'Note', 'BookPageDetails'],
  });
}

// =====================================================================
//  SIGNPOSTS — major town gates + dungeon entrances
// =====================================================================
signpost({ id: 0x0BAA, name: 'Britain', tagId: 'sign-britain' });
signpost({ id: 0x0BAA, name: 'Trinsic', tagId: 'sign-trinsic' });
signpost({ id: 0x0BAA, name: 'Vesper',  tagId: 'sign-vesper' });
signpost({ id: 0x0BAA, name: 'Minoc',   tagId: 'sign-minoc' });
signpost({ id: 0x0BAA, name: 'Yew',     tagId: 'sign-yew' });
signpost({ id: 0x0BAA, name: 'Magincia',tagId: 'sign-magincia' });
signpost({ id: 0x0BAA, name: 'Skara Brae', tagId: 'sign-skara' });
signpost({ id: 0x0BAA, name: 'Jhelom',  tagId: 'sign-jhelom' });
signpost({ id: 0x0BAA, name: 'Moonglow',tagId: 'sign-moonglow' });
signpost({ id: 0x0BAA, name: 'Cove',    tagId: 'sign-cove' });
signpost({ id: 0x0BAA, name: 'Zento — Tokuno',     tagId: 'sign-zento' });
signpost({ id: 0x0BAA, name: 'Umbra — City of the Dead', tagId: 'sign-umbra' });
signpost({ id: 0x0BAA, name: 'Luna — City of the Light', tagId: 'sign-luna' });

signpost({ id: 0x0BAB, name: 'Despise',     tagId: 'sign-dungeon-despise' });
signpost({ id: 0x0BAB, name: 'Destard',     tagId: 'sign-dungeon-destard' });
signpost({ id: 0x0BAB, name: 'Hythloth',    tagId: 'sign-dungeon-hythloth' });
signpost({ id: 0x0BAB, name: 'Wrong',       tagId: 'sign-dungeon-wrong' });
signpost({ id: 0x0BAB, name: 'Deceit',      tagId: 'sign-dungeon-deceit' });
signpost({ id: 0x0BAB, name: 'Shame',       tagId: 'sign-dungeon-shame' });
signpost({ id: 0x0BAB, name: 'Covetous',    tagId: 'sign-dungeon-covetous' });
signpost({ id: 0x0BAB, name: 'Ice Dungeon', tagId: 'sign-dungeon-ice' });
signpost({ id: 0x0BAB, name: 'Khaldun',     tagId: 'sign-dungeon-khaldun' });
signpost({ id: 0x0BAB, name: 'Bedlam',      tagId: 'sign-dungeon-bedlam' });
signpost({ id: 0x0BAB, name: 'Doom Gauntlet', tagId: 'sign-dungeon-doom' });
signpost({ id: 0x0BAB, name: 'Stygian Abyss', tagId: 'sign-dungeon-abyss' });
signpost({ id: 0x0BAB, name: 'Tomb of Kings', tagId: 'sign-dungeon-tomb' });

// Shop signs (used in town squares)
signpost({ id: 0x0BC4, name: 'Bank',         tagId: 'sign-bank' });
signpost({ id: 0x0BC5, name: 'Inn',          tagId: 'sign-inn' });
signpost({ id: 0x0BC6, name: 'Healer',       tagId: 'sign-healer' });
signpost({ id: 0x0BC7, name: 'Mage Tower',   tagId: 'sign-mage' });
signpost({ id: 0x0BC8, name: 'Provisioner',  tagId: 'sign-provisioner' });
signpost({ id: 0x0BC9, name: 'Blacksmith',   tagId: 'sign-blacksmith' });
signpost({ id: 0x0BCA, name: 'Tailor',       tagId: 'sign-tailor' });
signpost({ id: 0x0BCB, name: 'Carpenter',    tagId: 'sign-carpenter' });
signpost({ id: 0x0BCC, name: 'Animal Trainer', tagId: 'sign-trainer' });
signpost({ id: 0x0BCD, name: 'Stable',       tagId: 'sign-stable' });
signpost({ id: 0x0BCE, name: 'Auction House',tagId: 'sign-auction' });
signpost({ id: 0x0BCF, name: 'Library',      tagId: 'sign-library' });


// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('lore-extra: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('lore-extra: ' + e.message); } }
  api.log?.('lore-extra: registered ' + count + ' items');
  return () => {};
}
