// Minor artifact skins — bulk cosmetic catalog. Mirrors the ~100
// "skin / hue variant" entries scattered across ServUO's
// `Items/Artifacts/` that don't change mechanics, just look unique
// (Doom-tier replicas, Heritage donator drops, Veteran reward
// re-skins, hue-only variants of base artifacts).
//
// Each entry is a self-registering item def — same shape as
// `sa-artifacts.js` but with `category: 'minor-artifact'` so OPL
// renders the "Minor Artifact" suffix instead of "Stygian Abyss Artifact".

const __PENDING__ = [];

// =====================================================================
//  DOOM REPLICAS (24) — hue variants of the 24 Doom artifacts that
//  drop from non-Doom bosses at a fraction of the original's stats.
// =====================================================================
const DOOM_REPLICAS = [
  { tagId: 'rep-axes-of-the-heavens',  itemId: 0x143E, hue: 0x4B9, name: 'Axes of the Heavens (replica)' },
  { tagId: 'rep-blade-of-insanity',    itemId: 0x13B9, hue: 0x21A, name: 'Blade of Insanity (replica)' },
  { tagId: 'rep-bone-crusher',         itemId: 0x143D, hue: 0x47D, name: 'Bone Crusher (replica)' },
  { tagId: 'rep-breath-of-the-dead',   itemId: 0x13B6, hue: 0x97A, name: 'Breath of the Dead (replica)' },
  { tagId: 'rep-divine-countenance',   itemId: 0x1454, hue: 0x4FB, name: 'Divine Countenance (replica)' },
  { tagId: 'rep-frostbringer',         itemId: 0x143B, hue: 0x481, name: 'Frostbringer (replica)' },
  { tagId: 'rep-gauntlets-of-nobility',itemId: 0x1413, hue: 0x4F4, name: 'Gauntlets of Nobility (replica)' },
  { tagId: 'rep-helm-of-insight',      itemId: 0x140E, hue: 0x4F4, name: 'Helm of Insight (replica)' },
  { tagId: 'rep-holy-knights-breastplate', itemId: 0x1415, hue: 0x4F4, name: 'Holy Knight\'s Breastplate (replica)' },
  { tagId: 'rep-jackals-collar',       itemId: 0x1085, hue: 0x021, name: 'Jackal\'s Collar (replica)' },
  { tagId: 'rep-leggings-of-bane',     itemId: 0x1411, hue: 0x21A, name: 'Leggings of Bane (replica)' },
  { tagId: 'rep-midnight-bracers',     itemId: 0x1086, hue: 0x027, name: 'Midnight Bracers (replica)' },
  { tagId: 'rep-orny',                 itemId: 0x1F09, hue: 0x4FE, name: 'Ornament of the Magician (replica)' },
  { tagId: 'rep-pulse-of-the-soul',    itemId: 0x1B76, hue: 0x4F4, name: 'Pulse of the Soul (replica)' },
  { tagId: 'rep-ring-of-the-elements', itemId: 0x108A, hue: 0x4F8, name: 'Ring of the Elements (replica)' },
  { tagId: 'rep-ring-of-the-vile',     itemId: 0x108A, hue: 0x4F2, name: 'Ring of the Vile (replica)' },
  { tagId: 'rep-serpents-fang',        itemId: 0x13B0, hue: 0x481, name: 'Serpent\'s Fang (replica)' },
  { tagId: 'rep-shadow-dancer-leggings', itemId: 0x13CB, hue: 0x4B9, name: 'Shadow Dancer Leggings (replica)' },
  { tagId: 'rep-spirit-of-the-totem',  itemId: 0x1450, hue: 0x4F4, name: 'Spirit of the Totem (replica)' },
  { tagId: 'rep-staff-of-the-magi',    itemId: 0x13F8, hue: 0x489, name: 'Staff of the Magi (replica)' },
  { tagId: 'rep-stormgrip',            itemId: 0x13F2, hue: 0x488, name: 'Stormgrip (replica)' },
  { tagId: 'rep-talisman-of-fey',      itemId: 0x2F58, hue: 0x4F4, name: 'Talisman of the Fey (replica)' },
  { tagId: 'rep-tunic-of-fire',        itemId: 0x1F03, hue: 0x021, name: 'Tunic of Fire (replica)' },
  { tagId: 'rep-voice-of-the-fallen-king', itemId: 0x2FB7, hue: 0x489, name: 'Voice of the Fallen King (replica)' },
];

// =====================================================================
//  HERITAGE DONATOR ITEMS (20) — UO Stratics donation rewards.
// =====================================================================
const HERITAGE = [
  { tagId: 'her-bag-of-rare-jewels',   itemId: 0x0E76, hue: 0x47E, name: 'Bag of Rare Jewels' },
  { tagId: 'her-blanket-of-snow',      itemId: 0x1761, hue: 0x481, name: 'Blanket of Snow' },
  { tagId: 'her-cedar-chair',          itemId: 0x0B57, hue: 0x441, name: 'Cedar Chair' },
  { tagId: 'her-cherrywood-table',     itemId: 0x0B7D, hue: 0x4FC, name: 'Cherrywood Table' },
  { tagId: 'her-cloak-of-silk-roses',  itemId: 0x1515, hue: 0x484, name: 'Cloak of Silk Roses' },
  { tagId: 'her-feather-mantle',       itemId: 0x1515, hue: 0x4A4, name: 'Feather Mantle' },
  { tagId: 'her-fern-tile',            itemId: 0x0CB2, hue: 0x47C, name: 'Fern Tile' },
  { tagId: 'her-gilded-mirror',        itemId: 0x1F0E, hue: 0x4F2, name: 'Gilded Mirror' },
  { tagId: 'her-golden-orrery',        itemId: 0x4076, hue: 0x4F2, name: 'Golden Orrery' },
  { tagId: 'her-heritage-totem',       itemId: 0x1450, hue: 0x4FC, name: 'Heritage Totem' },
  { tagId: 'her-illuminated-tome',     itemId: 0x0FBE, hue: 0x481, name: 'Illuminated Tome' },
  { tagId: 'her-jeweled-coffer',       itemId: 0x0E40, hue: 0x4F8, name: 'Jeweled Coffer' },
  { tagId: 'her-lacquered-cabinet',    itemId: 0x0A82, hue: 0x4FB, name: 'Lacquered Cabinet' },
  { tagId: 'her-painted-tapestry',     itemId: 0x0EAC, hue: 0x4F4, name: 'Painted Tapestry' },
  { tagId: 'her-rose-marble-bath',     itemId: 0x1DDA, hue: 0x4F2, name: 'Rose Marble Bath' },
  { tagId: 'her-silken-curtain',       itemId: 0x232A, hue: 0x4F8, name: 'Silken Curtain' },
  { tagId: 'her-snowdrift',            itemId: 0x0CB2, hue: 0x481, name: 'Snowdrift' },
  { tagId: 'her-sundial',              itemId: 0x4076, hue: 0x47D, name: 'Sundial' },
  { tagId: 'her-twilight-globe',       itemId: 0x100E, hue: 0x489, name: 'Twilight Globe' },
  { tagId: 'her-velvet-throne',        itemId: 0x0B33, hue: 0x4FC, name: 'Velvet Throne' },
];

// =====================================================================
//  VETERAN-AGE RESKINS (20) — 1yr/2yr/3yr/.../15yr cosmetic re-hues.
// =====================================================================
const VETERAN_SKINS = [
  { tagId: 'vet-1yr-cloak-bronze',     itemId: 0x1515, hue: 0x972, name: 'Bronze Cloak (1yr)' },
  { tagId: 'vet-2yr-cloak-azure',      itemId: 0x1515, hue: 0x489, name: 'Azure Cloak (2yr)' },
  { tagId: 'vet-3yr-cloak-emerald',    itemId: 0x1515, hue: 0x44, name: 'Emerald Cloak (3yr)' },
  { tagId: 'vet-4yr-cloak-amethyst',   itemId: 0x1515, hue: 0x21A, name: 'Amethyst Cloak (4yr)' },
  { tagId: 'vet-5yr-cloak-amber',      itemId: 0x1515, hue: 0x44, name: 'Amber Cloak (5yr)' },
  { tagId: 'vet-6yr-robe-prismatic',   itemId: 0x1F03, hue: 0x47F, name: 'Prismatic Robe (6yr)' },
  { tagId: 'vet-7yr-robe-stargazer',   itemId: 0x1F03, hue: 0x489, name: 'Stargazer Robe (7yr)' },
  { tagId: 'vet-8yr-hat-feathered',    itemId: 0x171A, hue: 0x47D, name: 'Feathered Hat (8yr)' },
  { tagId: 'vet-9yr-hat-tricorn',      itemId: 0x171B, hue: 0x4FB, name: 'Tricorn Hat (9yr)' },
  { tagId: 'vet-10yr-cape-britannia', itemId: 0x1F00, hue: 0x4F4, name: 'Britannia Cape (10yr)' },
  { tagId: 'vet-11yr-cape-skara',     itemId: 0x1F00, hue: 0x047, name: 'Skara Brae Cape (11yr)' },
  { tagId: 'vet-12yr-cape-nujelm',    itemId: 0x1F00, hue: 0x53F, name: 'Nujel\'m Cape (12yr)' },
  { tagId: 'vet-13yr-cape-trinsic',   itemId: 0x1F00, hue: 0x044, name: 'Trinsic Cape (13yr)' },
  { tagId: 'vet-14yr-cape-vesper',    itemId: 0x1F00, hue: 0x481, name: 'Vesper Cape (14yr)' },
  { tagId: 'vet-15yr-cape-jhelom',    itemId: 0x1F00, hue: 0x488, name: 'Jhelom Cape (15yr)' },
  { tagId: 'vet-statue-bronze',       itemId: 0x1F0F, hue: 0x972, name: 'Bronze Statuette' },
  { tagId: 'vet-statue-silver',       itemId: 0x1F0F, hue: 0x47F, name: 'Silver Statuette' },
  { tagId: 'vet-statue-gold',         itemId: 0x1F0F, hue: 0x4F4, name: 'Gold Statuette' },
  { tagId: 'vet-statue-platinum',     itemId: 0x1F0F, hue: 0x4F2, name: 'Platinum Statuette' },
  { tagId: 'vet-statue-prismatic',    itemId: 0x1F0F, hue: 0x47F, name: 'Prismatic Statuette' },
];

// =====================================================================
//  GARGISH / ELVEN RACIAL SKINS (16) — armour/weapon hue variants.
// =====================================================================
const RACIAL_SKINS = [
  { tagId: 'garg-stone-arms-jade',    itemId: 0x4D6E, hue: 0x44, name: 'Jade Gargish Stone Arms' },
  { tagId: 'garg-stone-arms-onyx',    itemId: 0x4D6E, hue: 0x455, name: 'Onyx Gargish Stone Arms' },
  { tagId: 'garg-plate-chest-jade',   itemId: 0x4D6F, hue: 0x44, name: 'Jade Gargish Plate Chest' },
  { tagId: 'garg-plate-chest-onyx',   itemId: 0x4D6F, hue: 0x455, name: 'Onyx Gargish Plate Chest' },
  { tagId: 'garg-cyclone-azure',      itemId: 0x48B0, hue: 0x489, name: 'Azure Gargish Cyclone' },
  { tagId: 'garg-cyclone-crimson',    itemId: 0x48B0, hue: 0x21, name: 'Crimson Gargish Cyclone' },
  { tagId: 'garg-talisman-jade',      itemId: 0x4D6E, hue: 0x44, name: 'Jade Gargish Talisman' },
  { tagId: 'garg-talisman-onyx',      itemId: 0x4D6E, hue: 0x455, name: 'Onyx Gargish Talisman' },
  { tagId: 'elf-cap-silver',          itemId: 0x2304, hue: 0x47F, name: 'Silver Elven Cap' },
  { tagId: 'elf-cap-gold',            itemId: 0x2304, hue: 0x4F4, name: 'Gold Elven Cap' },
  { tagId: 'elf-robe-emerald',        itemId: 0x230F, hue: 0x44, name: 'Emerald Elven Robe' },
  { tagId: 'elf-robe-sapphire',       itemId: 0x230F, hue: 0x489, name: 'Sapphire Elven Robe' },
  { tagId: 'elf-bow-blackwood',       itemId: 0x2D24, hue: 0x497, name: 'Blackwood Elven Bow' },
  { tagId: 'elf-bow-yew',             itemId: 0x2D24, hue: 0x44, name: 'Yew Elven Bow' },
  { tagId: 'elf-cloak-shimmering',    itemId: 0x230E, hue: 0x4F8, name: 'Shimmering Elven Cloak' },
  { tagId: 'elf-cloak-moonlit',       itemId: 0x230E, hue: 0x481, name: 'Moonlit Elven Cloak' },
];

// =====================================================================
//  PUBLISH ARTIFACTS (20) — drop pool from Publish-era encounters
//  (Aetheric Citadel, Sanctuary, Magincia, Eodon).
// =====================================================================
const PUBLISH = [
  { tagId: 'pub-aetheric-pendant',    itemId: 0x108A, hue: 0x47F, name: 'Aetheric Pendant' },
  { tagId: 'pub-aetheric-talisman',   itemId: 0x2F58, hue: 0x488, name: 'Aetheric Talisman' },
  { tagId: 'pub-sanctuary-ring',      itemId: 0x108A, hue: 0x4F4, name: 'Sanctuary Ring' },
  { tagId: 'pub-sanctuary-cloak',     itemId: 0x1515, hue: 0x4F4, name: 'Sanctuary Cloak' },
  { tagId: 'pub-magincia-medal',      itemId: 0x14F0, hue: 0x47D, name: 'New Magincia Medal' },
  { tagId: 'pub-magincia-flag',       itemId: 0x15A8, hue: 0x489, name: 'New Magincia Flag' },
  { tagId: 'pub-eodon-tribal-mask',   itemId: 0x4067, hue: 0x044, name: 'Eodon Tribal Mask' },
  { tagId: 'pub-eodon-feather-cloak', itemId: 0x230E, hue: 0x047, name: 'Eodon Feather Cloak' },
  { tagId: 'pub-eodon-jade-amulet',   itemId: 0x108A, hue: 0x44, name: 'Eodon Jade Amulet' },
  { tagId: 'pub-eodon-dino-tooth',    itemId: 0x14F0, hue: 0x044, name: 'Dino Tooth Pendant' },
  { tagId: 'pub-bazaar-purse',        itemId: 0x0E76, hue: 0x4F4, name: 'Bazaar Coin Purse' },
  { tagId: 'pub-bazaar-banner',       itemId: 0x15A8, hue: 0x47D, name: 'Bazaar Banner' },
  { tagId: 'pub-myrmidex-tooth',      itemId: 0x14F0, hue: 0x481, name: 'Myrmidex Drone Tooth' },
  { tagId: 'pub-myrmidex-mandible',   itemId: 0x14F0, hue: 0x021, name: 'Myrmidex Mandible' },
  { tagId: 'pub-shadowguard-key',     itemId: 0x1010, hue: 0x489, name: 'Shadowguard Key' },
  { tagId: 'pub-citadel-sigil',       itemId: 0x14F0, hue: 0x47F, name: 'Citadel Sigil' },
  { tagId: 'pub-tomb-king-crown',     itemId: 0x171A, hue: 0x4FC, name: 'Tomb King Crown (replica)' },
  { tagId: 'pub-khaldun-mask',        itemId: 0x4067, hue: 0x4F4, name: 'Khaldun Death Mask' },
  { tagId: 'pub-underworld-relic',    itemId: 0x14F0, hue: 0x489, name: 'Underworld Relic' },
  { tagId: 'pub-bedlam-talisman',     itemId: 0x2F58, hue: 0x455, name: 'Bedlam Talisman (replica)' },
];

const IMPRISONED_MOBILE_ARTIFACTS = [
  {
    tagId: 'ferret-imprisoned-in-crystal',
    itemId: 0x1F19,
    name: 'a ferret imprisoned in a crystal',
    script: 'imprisoned-mobile',
    weight: 1,
    servuoClass: 'FerretImprisonedInCrystal',
    servuoClasses: ['FerretImprisonedInCrystal', 'BaseImprisonedMobile', 'ConfirmBreakCrystalGump', 'ShimmeringFerret'],
    imprisonedServuoClass: 'FerretImprisonedInCrystal',
    imprisonedSummon: {
      kind: 'ShimmeringFerret',
      name: 'a shimmering ferret',
      body: 0x0117,
      skills: { 26: 1000, 27: 1000, 43: 1000, 1: 1000 },
      servuoClasses: ['ShimmeringFerret', 'Ferret', 'BaseCreature'],
    },
  },
  {
    tagId: 'imprisoned-dog',
    itemId: 0x1F1C,
    hue: 0x0485,
    name: 'An Imprisoned Dog',
    script: 'imprisoned-mobile',
    labelNumber: 1075091,
    weight: 1,
    servuoClass: 'ImprisonedDog',
    servuoClasses: ['ImprisonedDog', 'BaseImprisonedMobile', 'ConfirmBreakCrystalGump', 'TravestyDog', 'ClonedItem'],
    imprisonedServuoClass: 'ImprisonedDog',
    imprisonedSummon: {
      kind: 'TravestyDog',
      name: 'a travesty dog',
      body: 0x00D9,
      hue: 0x08FD,
      skills: { 26: 1000, 27: 1000, 43: 1000, 1: 1000 },
      servuoClasses: ['TravestyDog', 'Dog', 'ClonedItem', 'BaseCreature'],
    },
  },
];

const DECORATIVE_STATUETTES = [
  {
    tagId: 'santa-statue',
    itemId: 0x4A9A,
    name: 'Santa Statue',
    labelNumber: 1097968,
    weight: 10,
    movable: true,
    forceShowProperties: true,
    flipIds: [0x4A9A, 0x4A9B],
    servuoClass: 'SantaStatue',
    servuoClasses: ['SantaStatue', 'MonsterStatuette', 'MonsterStatuetteType', 'FlipableAttribute'],
    monsterStatuetteType: 'Santa',
  },
];

const TOL_DECORATIVE = [
  { tagId: 'tol-stretched-dinosaur-hide', itemId: 4202, hue: 2523, name: 'Stretched Dinosaur Hide', servuoClass: 'StretchedDinosaurHide' },
  { tagId: 'tol-carved-myrmidex-glyph', itemId: 4676, hue: 2952, name: 'Carved Myrmydex Glyph', servuoClass: 'CarvedMyrmydexGlyph' },
  { tagId: 'tol-waku-on-a-spit', itemId: 7832, name: 'Waku on a Spit', servuoClass: 'WakuOnASpit' },
  { tagId: 'tol-sacred-lava-rock', itemId: 4962, hue: 1964, name: 'Sacred Lava Rock', servuoClass: 'SacredLavaRock' },
  { tagId: 'tol-white-tiger-figurine', itemId: 38980, hue: 2500, name: 'Hand Carved White Tiger Figurine', servuoClass: 'WhiteTigerFigurine' },
  { tagId: 'tol-dragon-turtle-hatchling-net', itemId: 3574, name: 'Dragon Turtle Hatchling Net', servuoClass: 'DragonTurtleHatchlingNet' },
];

const ALORON_ATTR = { staminaIncrease: 4, regenStam: 3 };
const ALORON_RESIST = { physical: 7, fire: 7, cold: 6, poison: 7, energy: 7 };
const ALORON_SET_ATTR = { manaIncrease: 15, lowerManaCost: 20 };
const ALORON_SET_RESIST = { physical: 8, fire: 8, cold: 9, poison: 8, energy: 8 };
const ALORON_PROPS = [
  { kind: 'attr', attribute: 'BonusDex', intensity: 4 },
  { kind: 'attr', attribute: 'BonusStam', intensity: 4 },
  { kind: 'attr', attribute: 'RegenStam', intensity: 3 },
  { kind: 'attr', attribute: 'EaterCold', intensity: 2 },
];
const DARDEN_ATTR = { hitPointIncrease: 4, lowerReagentCost: 15 };
const DARDEN_RESIST = { physical: 6, fire: 7, cold: 7, poison: 7, energy: 7 };
const DARDEN_SET_ATTR = { manaIncrease: 15, lowerManaCost: 20 };
const DARDEN_SET_RESIST = { physical: 9, fire: 8, cold: 8, poison: 8, energy: 8 };
const DARDEN_PROPS = [
  { kind: 'attr', attribute: 'BonusStr', intensity: 4 },
  { kind: 'attr', attribute: 'BonusHits', intensity: 4 },
  { kind: 'attr', attribute: 'LowerRegCost', intensity: 15 },
  { kind: 'attr', attribute: 'EaterKinetic', intensity: 2 },
];

const EPIPHANY_PROPS = [
  { kind: 'attr', attribute: 'MageArmor', intensity: 1 },
  { kind: 'attr', attribute: 'EpiphanyFrequency', intensity: 1 },
];
const EPIPHANY_RESIST = { physical: 6, fire: 6, cold: 6, poison: 6, energy: 6 };
function epiphanyPiece(alignment, tag, cls, itemId, layer, name, hue) {
  return {
    tagId: `epiphany-${alignment}-${tag}`,
    itemId,
    name,
    servuoClass: cls,
    servuoClasses: [cls, 'EpiphanyHelper'],
    layer,
    hue,
    ar: layer === 13 ? 48 : layer === 4 ? 40 : layer === 19 ? 34 : 30,
    strReq: alignment === 'villainous' ? 75 : 70,
    armorAttributes: { mageArmor: 1 },
    mageArmor: true,
    epiphanyAlignment: alignment === 'virtuous' ? 'good' : 'evil',
    epiphanyType: 'mana',
    resist: EPIPHANY_RESIST,
    _magicProps: EPIPHANY_PROPS,
  };
}

const EPIPHANY_ARTIFACTS = [
  epiphanyPiece('villainous', 'helm', 'HelmOfVillainousEpiphany', 9797, 6, 'Helm of Villainous Epiphany', 1778),
  epiphanyPiece('villainous', 'gorget', 'GorgetOfVillainousEpiphany', 0x1413, 10, 'Gorget of Villainous Epiphany', 1778),
  epiphanyPiece('villainous', 'breastplate', 'BreastplateOfVillainousEpiphany', 9793, 13, 'Breastplate of Villainous Epiphany', 1778),
  epiphanyPiece('villainous', 'arms', 'ArmsOfVillainousEpiphany', 9815, 19, 'Arms of Villainous Epiphany', 1778),
  epiphanyPiece('villainous', 'gauntlets', 'GauntletsOfVillainousEpiphany', 9795, 7, 'Gauntlets of Villainous Epiphany', 1778),
  epiphanyPiece('villainous', 'legs', 'LegsOfVillainousEpiphany', 9799, 4, 'Leggings of Villainous Epiphany', 1778),
  epiphanyPiece('villainous', 'kilt', 'KiltOfVillainousEpiphany', 780, 4, 'Kilt of Villainous Epiphany', 1778),
  epiphanyPiece('villainous', 'earrings', 'EarringsOfVillainousEpiphany', 16915, 18, 'Earrings of Villainous Epiphany', 1778),
  epiphanyPiece('villainous', 'gargish-breastplate', 'GargishBreastplateOfVillainousEpiphany', 778, 13, 'Breastplate of Villainous Epiphany', 1778),
  epiphanyPiece('villainous', 'gargish-arms', 'GargishArmsOfVillainousEpiphany', 776, 19, 'Arms of Villainous Epiphany', 1778),
  epiphanyPiece('villainous', 'necklace', 'NecklaceOfVillainousEpiphany', 16912, 10, 'Necklace of Villainous Epiphany', 1778),
  epiphanyPiece('villainous', 'gargish-legs', 'GargishLegsOfVillainousEpiphany', 782, 4, 'Legs of Villainous Epiphany', 1778),

  epiphanyPiece('virtuous', 'helm', 'HelmOfVirtuousEpiphany', 0x1419, 6, 'Helm of Virtuous Epiphany', 2076),
  epiphanyPiece('virtuous', 'gorget', 'GorgetOfVirtuousEpiphany', 0x1413, 10, 'Gorget of Virtuous Epiphany', 2076),
  epiphanyPiece('virtuous', 'breastplate', 'BreastplateOfVirtuousEpiphany', 0x1415, 13, 'Breastplate of Virtuous Epiphany', 2076),
  epiphanyPiece('virtuous', 'arms', 'ArmsOfVirtuousEpiphany', 0x1410, 19, 'Arms of Virtuous Epiphany', 2076),
  epiphanyPiece('virtuous', 'gauntlets', 'GauntletsOfVirtuousEpiphany', 0x1414, 7, 'Gauntlets of Virtuous Epiphany', 2076),
  epiphanyPiece('virtuous', 'legs', 'LegsOfVirtuousEpiphany', 0x1411, 4, 'Leggings of Virtuous Epiphany', 2076),
  epiphanyPiece('virtuous', 'kilt', 'KiltOfVirtuousEpiphany', 780, 4, 'Kilt of Virtuous Epiphany', 2076),
  epiphanyPiece('virtuous', 'earrings', 'EarringsOfVirtuousEpiphany', 16915, 18, 'Earrings of Virtuous Epiphany', 2076),
  epiphanyPiece('virtuous', 'gargish-breastplate', 'GargishBreastplateOfVirtuousEpiphany', 778, 13, 'Breastplate of Virtuous Epiphany', 2076),
  epiphanyPiece('virtuous', 'gargish-arms', 'GargishArmsOfVirtuousEpiphany', 776, 19, 'Arms of Virtuous Epiphany', 2076),
  epiphanyPiece('virtuous', 'necklace', 'NecklaceOfVirtuousEpiphany', 16912, 10, 'Necklace of Virtuous Epiphany', 2076),
  epiphanyPiece('virtuous', 'gargish-legs', 'GargishLegsOfVirtuousEpiphany', 782, 4, 'Legs of Virtuous Epiphany', 2076),
];

const EQUIPMENT_ARTIFACTS = [
  { tagId: 'alorons-gorget', itemId: 30761, name: "Aloron's Gorget", servuoClass: 'AloronsGorget', layer: 10, setId: 'aloron', setPieces: 4, attributes: ALORON_ATTR, resist: ALORON_RESIST, setAttributes: ALORON_SET_ATTR, setResist: ALORON_SET_RESIST, _magicProps: ALORON_PROPS, slayer: 'dinosaur' },
  { tagId: 'alorons-tunic', itemId: 30754, name: "Aloron's Tunic", servuoClass: 'AloronsTunic', layer: 13, setId: 'aloron', setPieces: 4, attributes: ALORON_ATTR, resist: ALORON_RESIST, setAttributes: ALORON_SET_ATTR, setResist: ALORON_SET_RESIST, _magicProps: ALORON_PROPS, slayer: 'dinosaur' },
  { tagId: 'alorons-bustier', itemId: 30754, name: "Aloron's Bustier", servuoClass: 'AloronsBustier', layer: 13, setId: 'aloron', setPieces: 4, attributes: ALORON_ATTR, resist: ALORON_RESIST, setAttributes: ALORON_SET_ATTR, setResist: ALORON_SET_RESIST, _magicProps: ALORON_PROPS, slayer: 'dinosaur' },
  { tagId: 'alorons-skirt', itemId: 30756, name: "Aloron's Skirt", servuoClass: 'AloronsSkirt', layer: 4, setId: 'aloron', setPieces: 4, attributes: ALORON_ATTR, resist: ALORON_RESIST, setAttributes: ALORON_SET_ATTR, setResist: ALORON_SET_RESIST, _magicProps: ALORON_PROPS, slayer: 'dinosaur' },
  { tagId: 'alorons-shorts', itemId: 30757, name: "Aloron's Shorts", servuoClass: 'AloronsShorts', layer: 4, setId: 'aloron', setPieces: 4, attributes: ALORON_ATTR, resist: ALORON_RESIST, setAttributes: ALORON_SET_ATTR, setResist: ALORON_SET_RESIST, _magicProps: ALORON_PROPS, slayer: 'dinosaur' },
  { tagId: 'alorons-legs', itemId: 30756, name: "Aloron's Leggings", servuoClass: 'AloronsLegs', layer: 4, setId: 'aloron', setPieces: 4, attributes: ALORON_ATTR, resist: ALORON_RESIST, setAttributes: ALORON_SET_ATTR, setResist: ALORON_SET_RESIST, _magicProps: ALORON_PROPS, slayer: 'dinosaur' },
  { tagId: 'alorons-long-skirt', itemId: 30756, name: "Aloron's Long Skirt", servuoClass: 'AloronsLongSkirt', layer: 4, setId: 'aloron', setPieces: 4, attributes: ALORON_ATTR, resist: ALORON_RESIST, setAttributes: ALORON_SET_ATTR, setResist: ALORON_SET_RESIST, _magicProps: ALORON_PROPS, slayer: 'dinosaur' },
  { tagId: 'alorons-helm', itemId: 30760, name: "Aloron's Helm", servuoClass: 'AloronsHelm', layer: 6, setId: 'aloron', setPieces: 4, attributes: ALORON_ATTR, resist: ALORON_RESIST, setAttributes: ALORON_SET_ATTR, setResist: ALORON_SET_RESIST, _magicProps: ALORON_PROPS, slayer: 'dinosaur' },
  { tagId: 'dardens-helm', itemId: 30765, name: "Darden's Helm", servuoClass: 'DardensHelm', layer: 6, setId: 'darden', setPieces: 4, attributes: DARDEN_ATTR, resist: DARDEN_RESIST, setAttributes: DARDEN_SET_ATTR, setResist: DARDEN_SET_RESIST, _magicProps: DARDEN_PROPS, slayer: 'myrmidex' },
  { tagId: 'dardens-tunic', itemId: 30762, name: "Darden's Tunic", servuoClass: 'DardensTunic', layer: 13, setId: 'darden', setPieces: 4, attributes: DARDEN_ATTR, resist: DARDEN_RESIST, setAttributes: DARDEN_SET_ATTR, setResist: DARDEN_SET_RESIST, _magicProps: DARDEN_PROPS, slayer: 'myrmidex' },
  { tagId: 'dardens-bustier', itemId: 30762, name: "Darden's Bustier", servuoClass: 'DardensBustier', layer: 13, setId: 'darden', setPieces: 4, attributes: DARDEN_ATTR, resist: DARDEN_RESIST, setAttributes: DARDEN_SET_ATTR, setResist: DARDEN_SET_RESIST, _magicProps: DARDEN_PROPS, slayer: 'myrmidex' },
  { tagId: 'dardens-legs', itemId: 30764, name: "Darden's Leggings", servuoClass: 'DardensLegs', layer: 4, setId: 'darden', setPieces: 4, attributes: DARDEN_ATTR, resist: DARDEN_RESIST, setAttributes: DARDEN_SET_ATTR, setResist: DARDEN_SET_RESIST, _magicProps: DARDEN_PROPS, slayer: 'myrmidex' },
  { tagId: 'dardens-sleeves', itemId: 30766, name: "Darden's Sleeves", servuoClass: 'DardensSleeves', layer: 19, setId: 'darden', setPieces: 4, attributes: DARDEN_ATTR, resist: DARDEN_RESIST, setAttributes: DARDEN_SET_ATTR, setResist: DARDEN_SET_RESIST, _magicProps: DARDEN_PROPS, slayer: 'myrmidex' },
  { tagId: 'spell-focusing-sash', itemId: 5441, name: 'Spell Focusing Sash', servuoClass: 'SpellFocusingSash', layer: 20, spellFocusing: true, attributes: { manaIncrease: 1, defenseChanceIncrease: 5 }, _magicProps: [{ kind: 'attr', attribute: 'BonusMana', intensity: 1 }, { kind: 'attr', attribute: 'DefendChance', intensity: 5 }, { kind: 'attr', attribute: 'Brittle', intensity: 1 }] },
  { tagId: 'turquoise-ring', itemId: 4234, name: 'Turquoise Ring', servuoClass: 'TurqouiseRing', layer: 14, attributes: { damageIncrease: 15 }, _magicProps: [{ kind: 'attr', attribute: 'WeaponDamage', intensity: 15 }] },
  { tagId: 'death-shroud', itemId: 0x204E, name: 'Death Shroud', servuoClass: 'DeathShroud', layer: 22, accessLevel: 'GameMaster', hue: 0 },
  { tagId: 'feeble-wand', itemId: 3570, name: 'Feeble Wand', servuoClass: 'FeebleWand', kind: 'weapon', magicSpell: 'feeblemind', magicCharges: 30, charges: 30, layer: 1 },
  ...EPIPHANY_ARTIFACTS,
];

const CONTAINER_ARTIFACTS = [
  { tagId: 'essence-box', itemId: 2474, hue: 2306, name: 'Essence Box', servuoClass: 'EssenceBox', kind: 'container', container: true, gumpId: 0x3E, capacity: 50, autoFillLoot: 'essence' },
  { tagId: 'smiths-craftsman-satchel', itemId: 3701, name: "Smith's Craftsman Satchel", servuoClass: 'SmithsCraftsmanSatchel', kind: 'container', container: true, gumpId: 0x3C, capacity: 25, autoFillLoot: 'smith-craftsman' },
];

for (const def of [...DOOM_REPLICAS, ...HERITAGE, ...VETERAN_SKINS, ...RACIAL_SKINS, ...PUBLISH]) {
  __PENDING__.push({
    kind: 'artifact',
    category: 'minor-artifact',
    layer: 0,
    weight: 4,
    minorArtifact: true,
    id: def.id ?? def.itemId,
    ...def,
  });
}

for (const def of [...IMPRISONED_MOBILE_ARTIFACTS, ...DECORATIVE_STATUETTES]) {
  __PENDING__.push({
    kind: 'artifact',
    category: 'decorative-artifact',
    movable: true,
    displayWeight: false,
    id: def.id ?? def.itemId,
    ...def,
  });
}

for (const def of TOL_DECORATIVE) {
  __PENDING__.push({
    kind: 'artifact',
    category: 'decorative-artifact',
    weight: 1,
    movable: true,
    displayWeight: false,
    artifactRarity: 11,
    id: def.id ?? def.itemId,
    ...def,
  });
}

for (const def of EQUIPMENT_ARTIFACTS) {
  __PENDING__.push({
    kind: def.kind ?? 'armor',
    category: 'equipment-artifact',
    weight: def.weight ?? 4,
    _artifact: def.name,
    setSelfRepair: def.setSelfRepair ?? 3,
    id: def.id ?? def.itemId,
    ...def,
  });
}

for (const def of CONTAINER_ARTIFACTS) {
  __PENDING__.push({
    category: 'reward-container',
    weight: 2,
    movable: true,
    id: def.id ?? def.itemId,
    ...def,
  });
}

export const MINOR_ARTIFACT_TAGS = __PENDING__.map((d) => d.tagId);
export const MINOR_ARTIFACT_COUNT = __PENDING__.length;

export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('artifacts-extra: registerItem missing'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) {
    try { reg(def); count++; }
    catch (e) { api.log?.(`artifacts-extra: ${def.tagId}: ${e.message}`); }
  }
  api.log?.(`artifacts-extra: registered ${count} minor artifact skins`);
  return () => {};
}
