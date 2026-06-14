// Book of Masteries + Codex of Wisdom + lore-book contents. Mirrors
// ServUO `Items/Books/`: BookOfMasteries.cs (mastery selection
// gump-source), CodexOfWisdom.cs (random hint pool), HuntmastersDeck.cs.
//
// Each entry is a registered item that, when used, surfaces its
// `pages[]` to the client via the existing book gump (0x66 / 0x93 /
// 0x6E protocol). Server-side caller `apps/scripts/src/items/book.js`
// handles the page-flip request.



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

// =====================================================================
//  BOOK OF MASTERIES — picker for the player's active mastery slot
// =====================================================================
book({
  id: 0x225B, name: 'Book of Masteries', tagId: 'book-of-masteries',
  title: 'Book of Masteries',
  author: 'The Order of the Silver Serpent',
  pages: [
    [
      'BOOK OF MASTERIES',
      '',
      'Each warrior may dedicate themselves to one',
      'Mastery. Use the table within to choose your',
      'path. The choice may be changed only once',
      'per real-world week.',
    ],
    ['BARD MASTERIES (Musicianship)', '',
      '• Despair', '• Inspire', '• Invigorate',
      '• Perseverance', '• Resilience', '• Tribulation',
      '• Whispering',
    ],
    ['MELEE MASTERIES (Tactics)', '',
      '• Toughness', '• Tolerance', '• Onslaught',
      '• Stagger', '• Pierce', '• Thrust',
      '• Shield Bash', '• Fists of Fury',
    ],
    ['CASTER MASTERIES (Magery, Necromancy, Mysticism)', '',
      '• Mana Shield', '• Mystic Weapon',
      '• Conduit', '• Ethereal Burst', '• Rejuvinate',
      '• Death Ray', '• Nether Blast', '• Elemental Fury',
      '• Holy Fist', '• White Tiger Form', '• Stone Form',
    ],
    ['RANGED MASTERIES (Archery / Throwing)', '',
      '• Called Shot', '• Flaming Shot',
      '• Focused Eye', '• Heightened Senses',
    ],
    ['SUMMONER MASTERIES (Spellweaving)', '',
      '• Summon Reaper', '• Command Undead',
    ],
    ['TAMING MASTERIES (Animal Taming)', '',
      '• Body Guard', '• Combat Training',
    ],
  ],
});

// =====================================================================
//  CODEX OF WISDOM — randomized hint pool
// =====================================================================
book({
  id: 0x4203, name: 'Codex of Wisdom', tagId: 'codex-of-wisdom',
  title: 'Codex of Wisdom',
  author: 'Lord British',
  pages: [
    ['THE EIGHT VIRTUES', '',
      'Honesty, Compassion, Valor,',
      'Justice, Sacrifice, Honor,',
      'Spirituality, Humility.',
    ],
    ['ON COMBAT', '',
      'Mind your stamina before you swing.',
      'A weary blade is a slow blade.',
    ],
    ['ON MAGIC', '',
      'Reagents and mana are coin in the same purse.',
      'Spend them wisely.',
    ],
    ['ON CRAFTING', '',
      'A skilled smith is recognized by their tools',
      'and the company they keep at the forge.',
    ],
    ['ON TRAVEL', '',
      'A marked rune in your pack is worth two',
      'in a runebook on a distant shelf.',
    ],
    ['ON HOUSING', '',
      'Your home is sacred ground.',
      'Set thy locks well, and trust no thief.',
    ],
    ['ON PETS', '',
      'A bonded pet returns. A starved pet does not.',
      'Feed thy companion or carry thy own load.',
    ],
    ['ON DEATH', '',
      'When fallen, hasten to thy corpse —',
      'others may not be so generous.',
    ],
  ],
});

// =====================================================================
//  HUNTMASTER'S DECK — list of trophy targets for the weekly contest
// =====================================================================
book({
  id: 0x42D7, name: "Huntmaster's Deck", tagId: 'huntmasters-deck',
  title: "Huntmaster's Deck",
  author: 'Huntmaster Sergei',
  pages: [
    ['THE TWELVE TROPHIES', '',
      '1. Troll', '2. Ogre Lord', '3. Lich',
      '4. Cyclops', '5. Lich Lord', '6. Titan',
    ],
    ['', '',
      '7. Wyvern', '8. Dragon', '9. Demon',
      '10. Silver Serpent', '11. Ancient Wyrm',
      '12. Abyssal Infernal',
    ],
    ['THE TROPHY ROOM', '',
      'Bring the head of the rotation target',
      'to the Huntmaster. The strongest specimen',
      'each week takes the prize.',
    ],
  ],
});

// =====================================================================
//  TRAVELER'S MAP — Ilshenar / Felucca / Trammel / Tokuno landmarks
// =====================================================================
book({
  id: 0x14EC, name: "Traveler's Map", tagId: 'travelers-map',
  title: "Traveler's Map",
  author: 'Cartographer Dorin',
  pages: [
    ['MAP OF BRITANNIA', '',
      'Trammel — guarded cities, no full PvP.',
      'Felucca — dangerous, full looting.',
    ],
    ['ILSHENAR', '',
      'Lost Lands — no recall, no mark.',
      'Walk through a mossy moongate to enter.',
    ],
    ['MALAS (NECROMANCER LANDS)', '',
      'Umbra — necromancer city.',
      'Luna — paladin city.',
    ],
    ['TOKUNO', '',
      'Three islands of the Samurai Empire:',
      'Isamu-Jima, Makoto-Jima, Homare-Jima.',
    ],
    ['TER MUR (STYGIAN ABYSS)', '',
      'Royal City — gargish capital.',
      'Holy City — gargish religious center.',
      'Stygian Abyss — descent of seven levels.',
    ],
    ['EODON (TIME OF LEGENDS)', '',
      'Seven tribes of the Valley:',
      'Barako, Uraban, Jukari, Sakkhra,',
      'Kurak, Upa, Tigersclaw.',
    ],
  ],
});

// =====================================================================
//  TIPS BOOK FOR NEW PLAYERS
// =====================================================================
book({
  id: 0x42D5, name: "Newbie's Companion", tagId: 'newbies-companion',
  title: "Newbie's Companion",
  author: 'Lord Avery',
  pages: [
    ['WELCOME', '',
      'You are now in Britannia. To begin,',
      'speak with Uzeraan in Haven.',
    ],
    ['CONTROLS', '',
      'Click — single action / look',
      'Double click — use / attack',
      'Drag — move items',
      'Ctrl+Shift — show all names',
    ],
    ['CHAT', '',
      'Just type — local say',
      '/ — party',
      '\\ — guild',
      '; — yell',
      ', — whisper',
    ],
    ['SAFETY', '',
      'Bank often. Your corpse can be looted.',
      'Travel with friends. Use [stuck if lost.',
    ],
  ],
});


// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('books-of-knowledge: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('books-of-knowledge: ' + e.message); } }
  api.log?.('books-of-knowledge: registered ' + count + ' items');
  return () => {};
}
