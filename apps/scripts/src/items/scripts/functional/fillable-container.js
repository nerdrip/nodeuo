import { createItem, destroyItemBySerial } from '../../../_items.js';
import { itemBySerial } from '../../../_entities.js';
import { childrenOf } from '../../../_inventory.js';
import { nearbyMobiles } from '../../../_spatial.js';

const CHECK_INTERVAL_MS = 15_000;
const MIN_RESPAWN_MS = 5 * 60_000;
const MAX_RESPAWN_MS = 30 * 60_000;

const FILLABLE_CONTAINER_DEFAULTS = {
  FillableLargeCrate: { gumpId: 0x0044, capacity: 125, maxWeight: 400, weight: 1 },
  FillableSmallCrate: { gumpId: 0x0044, capacity: 75, maxWeight: 300, weight: 1 },
  FillableWoodenBox: { gumpId: 0x0042, capacity: 75, maxWeight: 300, weight: 4 },
  FillableMetalBox: { gumpId: 0x0044, capacity: 75, maxWeight: 300, weight: 7 },
  FillableBarrel: { gumpId: 0x003E, capacity: 60, maxWeight: 400, weight: 25, lockable: false, trapable: false },
  FillableMetalChest: { gumpId: 0x0048, capacity: 125, maxWeight: 400, weight: 9 },
  FillableMetalGoldenChest: { gumpId: 0x0048, capacity: 125, maxWeight: 400, weight: 9 },
  FillableWoodenChest: { gumpId: 0x0049, capacity: 125, maxWeight: 400, weight: 8 },
  LibraryBookcase: { gumpId: 0x004C, capacity: 125, maxWeight: 400, weight: 1, lockable: false, trapable: false },
};

const ITEM_ID_DEFAULTS = new Map([
  [0x0E3C, FILLABLE_CONTAINER_DEFAULTS.FillableLargeCrate],
  [0x0E3D, FILLABLE_CONTAINER_DEFAULTS.FillableLargeCrate],
  [0x09A9, FILLABLE_CONTAINER_DEFAULTS.FillableSmallCrate],
  [0x0E7E, FILLABLE_CONTAINER_DEFAULTS.FillableSmallCrate],
  [0x09AA, FILLABLE_CONTAINER_DEFAULTS.FillableWoodenBox],
  [0x0E7D, FILLABLE_CONTAINER_DEFAULTS.FillableWoodenBox],
  [0x09A8, FILLABLE_CONTAINER_DEFAULTS.FillableMetalBox],
  [0x0E80, FILLABLE_CONTAINER_DEFAULTS.FillableMetalBox],
  [0x0E77, FILLABLE_CONTAINER_DEFAULTS.FillableBarrel],
  [0x09AB, FILLABLE_CONTAINER_DEFAULTS.FillableMetalChest],
  [0x0E7C, FILLABLE_CONTAINER_DEFAULTS.FillableMetalChest],
  [0x0E40, FILLABLE_CONTAINER_DEFAULTS.FillableMetalGoldenChest],
  [0x0E41, FILLABLE_CONTAINER_DEFAULTS.FillableMetalGoldenChest],
  [0x0E42, FILLABLE_CONTAINER_DEFAULTS.FillableWoodenChest],
  [0x0E43, FILLABLE_CONTAINER_DEFAULTS.FillableWoodenChest],
]);

const WEAPON_TYPES = [
  'Broadsword', 'Longsword', 'Katana', 'Kryss', 'Dagger', 'Mace', 'WarMace',
  'Club', 'HammerPick', 'WarAxe', 'Bow', 'Crossbow', 'HeavyCrossbow',
  'Spear', 'WarFork', 'Bardiche', 'Halberd', 'Axe', 'BattleAxe',
  'DoubleAxe', 'ExecutionersAxe',
];
const ARMOR_TYPES = [
  'ChainCoif', 'ChainChest', 'ChainLegs', 'RingmailArms', 'RingmailChest',
  'RingmailGloves', 'RingmailLegs', 'PlateArms', 'PlateChest', 'PlateGloves',
  'PlateGorget', 'PlateLegs', 'CloseHelm', 'Helmet', 'NorseHelm', 'Bascinet',
  'LeatherArms', 'LeatherChest', 'LeatherGloves', 'LeatherGorget', 'LeatherLegs',
  'StuddedArms', 'StuddedChest', 'StuddedGloves', 'StuddedGorget', 'StuddedLegs',
];
const SHIELD_TYPES = ['BronzeShield', 'Buckler', 'MetalKiteShield', 'HeaterShield', 'WoodenShield', 'MetalShield'];
const GEM_TYPES = ['Amber', 'Amethyst', 'Citrine', 'Diamond', 'Emerald', 'Ruby', 'Sapphire', 'StarSapphire', 'Tourmaline'];
const LIBRARY_BOOK_TYPES = ['RedBook', 'BlueBook', 'TanBook', 'BrownBook'];
const REGULAR_SCROLL_TYPES = [
  'ClumsyScroll', 'CreateFoodScroll', 'FeeblemindScroll', 'HealScroll',
  'MagicArrowScroll', 'NightSightScroll', 'ReactiveArmorScroll', 'WeakenScroll',
  'AgilityScroll', 'CunningScroll', 'CureScroll', 'HarmScroll',
  'MagicTrapScroll', 'MagicUnTrapScroll', 'ProtectionScroll', 'StrengthScroll',
  'BlessScroll', 'FireballScroll', 'MagicLockScroll', 'PoisonScroll',
  'TelekinesisScroll', 'TeleportScroll', 'UnlockScroll', 'WallOfStoneScroll',
  'ArchCureScroll', 'ArchProtectionScroll', 'CurseScroll', 'FireFieldScroll',
  'GreaterHealScroll', 'LightningScroll', 'ManaDrainScroll', 'RecallScroll',
  'BladeSpiritsScroll', 'DispelFieldScroll', 'IncognitoScroll', 'MagicReflectScroll',
  'MindBlastScroll', 'ParalyzeScroll', 'PoisonFieldScroll', 'SummonCreatureScroll',
  'DispelScroll', 'EnergyBoltScroll', 'ExplosionScroll', 'InvisibilityScroll',
  'MarkScroll', 'MassCurseScroll', 'ParalyzeFieldScroll', 'RevealScroll',
  'ChainLightningScroll', 'EnergyFieldScroll', 'FlamestrikeScroll', 'GateTravelScroll',
  'ManaVampireScroll', 'MassDispelScroll', 'MeteorSwarmScroll', 'PolymorphScroll',
  'EarthquakeScroll', 'EnergyVortexScroll', 'ResurrectionScroll', 'AirElementalScroll',
  'SummonDaemonScroll', 'EarthElementalScroll', 'FireElementalScroll', 'WaterElementalScroll',
].map((name, i) => ({ type: name, itemId: 0x1F2D + i, spellId: i + 1 }));

const POOLS = {
  WeaponTypes: WEAPON_TYPES,
  ArmorTypes: ARMOR_TYPES,
  ShieldTypes: SHIELD_TYPES,
  GemTypes: GEM_TYPES,
  LibraryBookTypes: LIBRARY_BOOK_TYPES,
  RegularScrollTypes: REGULAR_SCROLL_TYPES,
};

const FALLBACK_ITEMS = {
  Key: { itemId: 0x100E, name: 'key', force: true },
  Pitcher: { itemId: 0x0FF6, name: 'pitcher' },
  BeverageBottle: { itemId: 0x099B, name: 'bottle' },
  Jug: { itemId: 0x09C8, name: 'jug' },
  Clock: { itemId: 0x104B, name: 'clock' },
  ClockParts: { itemId: 0x104F, name: 'clock parts' },
  AxleGears: { itemId: 0x1051, name: 'axle and gears' },
  Gears: { itemId: 0x1053, name: 'gears' },
  Hinge: { itemId: 0x1055, name: 'hinge' },
  Springs: { itemId: 0x105D, name: 'springs' },
  Axle: { itemId: 0x105B, name: 'axle' },
  SextantParts: { itemId: 0x1059, name: 'sextant parts' },
  ToolKit: { itemId: 0x1EB8, name: 'tool kit' },
  Lockpicks: { itemId: 0x14FC, name: 'lockpicks', amount: [1, 3] },
  Lockpick: { itemId: 0x14FC, name: 'lockpick', amount: [1, 3] },
  Arrow: { itemId: 0x0F3F, name: 'arrow', amount: [2, 6] },
  Bolt: { itemId: 0x1BFB, name: 'bolt', amount: [2, 6] },
  Bandage: { itemId: 0x0E21, name: 'bandage', amount: [1, 3] },
  Bag: { itemId: 0x0E76, name: 'bag', gumpId: 0x003D, container: true },
  Book: { itemId: 0x0FF2, name: 'book' },
  RedBook: { itemId: 0x0FF1, name: 'red book' },
  BlueBook: { itemId: 0x0FF2, name: 'blue book' },
  TanBook: { itemId: 0x0FEF, name: 'tan book' },
  BrownBook: { itemId: 0x0FF0, name: 'brown book' },
};

function e(weightOrType, typeOrOpts = null, maybeOpts = null) {
  if (typeof weightOrType === 'number') {
    return { weight: weightOrType, type: typeOrOpts, ...(maybeOpts ?? {}) };
  }
  return { weight: 1, type: weightOrType, ...(typeOrOpts ?? {}) };
}

function pool(name, weight = 1, offset = 0, count = null) {
  return { weight, pool: name, offset, count };
}

function bvrg(weight, type, content) {
  return e(weight, type, { beverage: content });
}

const FILLABLE_CONTENT = {
  Alchemist: {
    level: 1, vendors: ['alchemist'], entries: [
      e('NightSightPotion'), e('LesserCurePotion'), e('AgilityPotion'),
      e('StrengthPotion'), e('LesserPoisonPotion'), e('RefreshPotion'),
      e('LesserHealPotion'), e('LesserExplosionPotion'), e('MortarPestle'),
    ],
  },
  Armorer: {
    level: 2, vendors: ['armorer'], entries: [
      e(2, 'ChainCoif'), e('PlateGorget'), e('BronzeShield'), e('Buckler'),
      e(2, 'MetalKiteShield'), e(2, 'HeaterShield'), e('WoodenShield'), e('MetalShield'),
    ],
  },
  ArtisanGuild: {
    level: 1, vendors: ['artisan', 'architect'], entries: [
      e('PaintsAndBrush'), e('SledgeHammer'), e(2, 'SmithHammer'), e(2, 'Tongs'),
      e(4, 'Lockpick'), e(4, 'TinkerTools'), e('MalletAndChisel'),
      e('StatueEast2'), e('StatueSouth'), e('StatueSouthEast'), e('StatueWest'),
      e('StatueNorth'), e('StatueEast'), e('BustEast'), e('BustSouth'),
      e('BearMask'), e('DeerMask'), e(4, 'OrcHelm'), e('TribalMask'), e('HornedTribalMask'),
    ],
  },
  Baker: {
    level: 1, vendors: ['baker'], entries: [
      e('RollingPin'), e(2, 'SackFlour'), e(2, 'BreadLoaf'), e('FrenchBread'),
    ],
  },
  Bard: {
    level: 1, vendors: ['bard'], entries: [
      e('LapHarp'), e(2, 'Lute'), e('Drums'), e('Tambourine'), e('TambourineTassel'),
    ],
  },
  Blacksmith: {
    level: 2, vendors: ['blacksmith'], entries: [
      e(8, 'SmithHammer'), e(8, 'Tongs'), e(8, 'SledgeHammer'), e(8, 'IronIngot'),
      e('IronWire'), e('SilverWire'), e('GoldWire'), e('CopperWire'),
      e('HorseShoes'), e('ForgedMetal'),
    ],
  },
  Bowyer: {
    level: 2, vendors: ['bowyer', 'fletcher'], entries: [
      e(2, 'Bow'), e(2, 'Crossbow'), e('Arrow'),
    ],
  },
  Butcher: {
    level: 1, vendors: ['butcher'], entries: [
      e(2, 'Cleaver'), e(2, 'SlabOfBacon'), e(2, 'Bacon'), e('RawFishSteak'),
      e('FishSteak'), e(2, 'CookedBird'), e(2, 'RawBird'), e(2, 'Ham'),
      e('RawLambLeg'), e('LambLeg'), e('Ribs'), e('RawRibs'), e(2, 'Sausage'),
      e('RawChickenLeg'), e('ChickenLeg'),
    ],
  },
  Carpenter: {
    level: 1, vendors: ['carpenter', 'architect', 'shipwright'], entries: [
      e('ChiselsNorth'), e('ChiselsWest'), e(2, 'DovetailSaw'), e(2, 'Hammer'),
      e(2, 'MouldingPlane'), e(2, 'Nails'), e(2, 'JointingPlane'),
      e(2, 'SmoothingPlane'), e(2, 'Saw'), e(2, 'DrawKnife'), e('Log'),
      e('Froe'), e('Inshave'), e('Scorp'),
    ],
  },
  Clothier: {
    level: 1, vendors: ['tailor', 'weaver'], entries: [
      e('Cotton'), e('Wool'), e('DarkYarn'), e('LightYarn'), e('LightYarnUnraveled'),
      e('SpoolOfThread'), e('Dyes'), e(2, 'Leather'),
    ],
  },
  Cobbler: {
    level: 1, vendors: ['cobbler'], entries: [
      e('Boots'), e(2, 'Shoes'), e(2, 'Sandals'), e('ThighBoots'),
    ],
  },
  Docks: {
    level: 1, vendors: ['fisherman'], entries: [
      e('FishingPole'), e('SmallFish'), e('SmallFish'), e(4, 'Fish'),
    ],
  },
  Farm: {
    level: 1, vendors: ['farmer', 'rancher', 'milkmaid'], entries: [
      e('Shirt'), e('ShortPants'), e('Skirt'), e('PlainDress'), e('Cap'),
      e(2, 'Sandals'), e(2, 'GnarledStaff'), e(2, 'Pitchfork'), e('Bag'),
      e('Kindling'), e('Lettuce'), e('Onion'), e('Turnip'), e('Ham'), e('Bacon'),
      e('RawLambLeg'), e('SheafOfHay'), bvrg(1, 'Pitcher', 'Milk'),
    ],
  },
  FighterGuild: {
    level: 3, vendors: ['warrior', 'fighter', 'paladin'], entries: [
      pool('ArmorTypes', 12), pool('WeaponTypes', 8), pool('ShieldTypes', 3), e('Arrow'),
    ],
  },
  Guard: {
    level: 3, vendors: ['guard', 'guard-captain'], entries: [
      pool('ArmorTypes', 12), pool('WeaponTypes', 8), pool('ShieldTypes', 3), e('Arrow'),
    ],
  },
  Healer: {
    level: 1, vendors: ['healer', 'wandering-healer'], entries: [
      e('Bandage'), e('MortarPestle'), e('LesserHealPotion'),
    ],
  },
  Herbalist: {
    level: 1, vendors: ['herbalist'], entries: [
      e(10, 'Garlic'), e(10, 'Ginseng'), e(10, 'MandrakeRoot'), e('DeadWood'),
      e('WhiteDriedFlowers'), e('GreenDriedFlowers'), e('DriedOnions'), e('DriedHerbs'),
    ],
  },
  Inn: {
    level: 1, vendors: ['innkeeper'], entries: [
      e('Candle'), e('Torch'), e('Lantern'),
    ],
  },
  Jeweler: {
    level: 2, vendors: ['jeweler'], entries: [
      e('GoldRing'), e('GoldBracelet'), e('GoldEarrings'), e('GoldNecklace'),
      e('GoldBeadNecklace'), e('Necklace'), e('Beads'), pool('GemTypes', 9),
    ],
  },
  Library: {
    level: 1, vendors: ['scribe'], entries: [
      pool('LibraryBookTypes', 8), e('RedBook'), e('BlueBook'),
    ],
  },
  Mage: {
    level: 2, vendors: ['mage', 'scribe'], entries: [
      e(16, 'BlankScroll'), e(14, 'Spellbook'),
      pool('RegularScrollTypes', 12, 0, 8), pool('RegularScrollTypes', 11, 8, 8),
      pool('RegularScrollTypes', 10, 16, 8), pool('RegularScrollTypes', 9, 24, 8),
      pool('RegularScrollTypes', 8, 32, 8), pool('RegularScrollTypes', 7, 40, 8),
      pool('RegularScrollTypes', 6, 48, 8), pool('RegularScrollTypes', 5, 56, 8),
    ],
  },
  Merchant: {
    level: 1, vendors: ['merchant', 'provisioner'], entries: [
      e('CheeseWheel'), e('CheeseWedge'), e('CheeseSlice'), e('Eggs'),
      e(4, 'Fish'), e(2, 'RawFishSteak'), e(2, 'FishSteak'), e('Apple'),
      e(2, 'Banana'), e(2, 'Bananas'), e(2, 'OpenCoconut'), e('SplitCoconut'),
      e('Coconut'), e('Dates'), e('Grapes'), e('Lemon'), e('Lemons'), e('Lime'),
      e('Limes'), e('Peach'), e('Pear'), e(2, 'SlabOfBacon'), e(2, 'Bacon'),
      e(2, 'CookedBird'), e(2, 'RawBird'), e(2, 'Ham'), e('RawLambLeg'),
      e('LambLeg'), e('Ribs'), e('RawRibs'), e(2, 'Sausage'), e('RawChickenLeg'),
      e('ChickenLeg'), e('Watermelon'), e('SmallWatermelon'), e(3, 'Turnip'),
      e(2, 'YellowGourd'), e(2, 'GreenGourd'), e(2, 'Pumpkin'), e('SmallPumpkin'),
      e(2, 'Onion'), e(2, 'Lettuce'), e(2, 'Squash'), e(2, 'HoneydewMelon'),
      e('Carrot'), e(2, 'Cantaloupe'), e(2, 'Cabbage'), e(4, 'EarOfCorn'),
    ],
  },
  Mill: { level: 1, vendors: ['miller'], entries: [e('SackFlour')] },
  Mine: {
    level: 1, vendors: ['miner'], entries: [
      e(2, 'Pickaxe'), e(2, 'Shovel'), e(2, 'IronIngot'), e('ForgedMetal'),
    ],
  },
  Observatory: {
    level: 1, vendors: ['mapmaker', 'cartographer'], entries: [
      e(2, 'Sextant'), e(2, 'Clock'), e('Spyglass'),
    ],
  },
  Painter: {
    level: 1, vendors: ['painter', 'artist'], entries: [
      e('PaintsAndBrush'), e(2, 'PenAndInk'),
    ],
  },
  Provisioner: null,
  Ranger: {
    level: 2, vendors: ['ranger'], entries: [
      e(2, 'StuddedChest'), e(2, 'StuddedLegs'), e(2, 'StuddedArms'),
      e(2, 'StuddedGloves'), e('StuddedGorget'), e(2, 'LeatherChest'),
      e(2, 'LeatherLegs'), e(2, 'LeatherArms'), e(2, 'LeatherGloves'),
      e('LeatherGorget'), e(2, 'FeatheredHat'), e('CloseHelm'), e('TallStrawHat'),
      e('Bandana'), e('Cloak'), e(2, 'Boots'), e(2, 'ThighBoots'),
      e(2, 'GnarledStaff'), e('Whip'), e(2, 'Bow'), e(2, 'Crossbow'),
      e(2, 'HeavyCrossbow'), e(4, 'Arrow'),
    ],
  },
  Stables: { level: 1, vendors: ['stablemaster', 'animaltrainer', 'animal-trainer'], entries: [e('Carrot')] },
  Tanner: {
    level: 2, vendors: ['tanner', 'furtrader', 'leatherworker'], entries: [
      e('FeatheredHat'), e('LeatherArms'), e(2, 'LeatherLegs'),
      e(2, 'LeatherChest'), e(2, 'LeatherGloves'), e('LeatherGorget'), e(2, 'Leather'),
    ],
  },
  Tavern: {
    level: 1, vendors: ['tavernkeeper', 'barkeeper', 'waiter', 'cook'], entries: [
      bvrg(1, 'BeverageBottle', 'Ale'), bvrg(1, 'BeverageBottle', 'Wine'),
      bvrg(1, 'BeverageBottle', 'Liquor'), bvrg(1, 'Jug', 'Cider'),
    ],
  },
  ThiefGuild: {
    level: 1, vendors: ['thief', 'thiefguildmaster'], entries: [
      e('Lockpick'), e('BearMask'), e('DeerMask'), e('TribalMask'), e('HornedTribalMask'), e(4, 'OrcHelm'),
    ],
  },
  Tinker: {
    level: 1, vendors: ['tinker'], entries: [
      e('Lockpick'), e(2, 'Clock'), e(2, 'ClockParts'), e(2, 'AxleGears'),
      e(2, 'Gears'), e(2, 'Hinge'), e(2, 'Sextant'), e(2, 'SextantParts'),
      e(2, 'Axle'), e(2, 'Springs'), e(5, 'TinkerTools'), e(4, 'Key'),
      e('DecoArrowShafts'), e('Lockpicks'), e('ToolKit'),
    ],
  },
  Veterinarian: {
    level: 1, vendors: ['veterinarian', 'vet'], entries: [
      e('Bandage'), e('MortarPestle'), e('LesserHealPotion'), e('Carrot'),
    ],
  },
  Weaponsmith: {
    level: 2, vendors: ['weaponsmith'], entries: [pool('WeaponTypes', 8), e('Arrow')],
  },
};
FILLABLE_CONTENT.Provisioner = FILLABLE_CONTENT.Merchant;

const CONTENT_BY_VENDOR = new Map();
for (const [key, content] of Object.entries(FILLABLE_CONTENT)) {
  for (const vendor of content?.vendors ?? []) CONTENT_BY_VENDOR.set(normalizeKey(vendor), key);
}

function normalizeKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeContentType(value) {
  if (!value) return null;
  const want = normalizeKey(value);
  for (const key of Object.keys(FILLABLE_CONTENT)) {
    if (normalizeKey(key) === want) return key;
  }
  return null;
}

function containerDefaults(item) {
  const type = item?.fillableType ?? item?.decoType ?? item?.servuoClass;
  return FILLABLE_CONTAINER_DEFAULTS[type] ?? ITEM_ID_DEFAULTS.get(item?.itemId | 0) ?? FILLABLE_CONTAINER_DEFAULTS.FillableWoodenChest;
}

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function randomRespawnDelay() {
  return randInt(MIN_RESPAWN_MS, MAX_RESPAWN_MS);
}

function getItemsCount(api, container) {
  let count = 0;
  for (const item of childrenOf(api, container)) count += Math.max(1, item.amount ?? 1);
  return count;
}

function weightedPick(entries) {
  const total = entries.reduce((sum, entry) => sum + Math.max(1, entry.weight | 0), 0);
  let roll = Math.random() * total;
  for (const entry of entries) {
    roll -= Math.max(1, entry.weight | 0);
    if (roll <= 0) return entry;
  }
  return entries[entries.length - 1];
}

function expandEntry(entry) {
  if (!entry?.pool) return entry;
  const pool = POOLS[entry.pool] ?? [];
  const slice = pool.slice(entry.offset ?? 0, entry.count != null ? (entry.offset ?? 0) + entry.count : undefined);
  const picked = slice[Math.floor(Math.random() * slice.length)];
  if (!picked) return null;
  if (typeof picked === 'string') return { ...entry, pool: null, type: picked };
  return { ...entry, pool: null, ...picked };
}

function amountFor(entry, type) {
  if (Array.isArray(entry.amount)) return randInt(entry.amount[0] | 0, entry.amount[1] | 0);
  if (Number.isFinite(entry.amount)) return Math.max(1, entry.amount | 0);
  const fb = FALLBACK_ITEMS[type];
  if (Array.isArray(fb?.amount)) return randInt(fb.amount[0] | 0, fb.amount[1] | 0);
  if (Number.isFinite(fb?.amount)) return Math.max(1, fb.amount | 0);
  if (type === 'Arrow' || type === 'Bolt') return randInt(2, 6);
  if (type === 'Bandage' || type === 'Lockpick') return randInt(1, 3);
  return 1;
}

function scriptForType(type, entry) {
  if (entry?.beverage) return 'drink';
  if (/HealPotion$/i.test(type)) return 'potion-heal';
  if (/CurePotion$/i.test(type)) return 'potion-cure';
  if (/RefreshPotion$/i.test(type)) return 'potion-refresh';
  if (/PoisonPotion$/i.test(type)) return 'poison-potion';
  if (/Scroll$/i.test(type)) return 'magic-scroll';
  return undefined;
}

function resolveSpec(api, entry) {
  const type = entry?.type;
  if (!type) return null;
  const fallback = FALLBACK_ITEMS[type];
  const resolved = api.itemTypes?.resolve?.(type);
  const itemId = entry.itemId
    ?? (fallback?.force ? fallback.itemId : ((resolved?.itemId | 0) > 0 ? resolved.itemId : fallback?.itemId));
  if (!Number.isFinite(itemId) || itemId <= 0) return null;
  return {
    itemId: itemId | 0,
    hue: entry.hue ?? resolved?.hue ?? fallback?.hue ?? 0,
    name: entry.name ?? fallback?.name ?? type.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase(),
    amount: amountFor(entry, type),
    script: entry.script ?? scriptForType(type, entry) ?? fallback?.script,
    gumpId: entry.gumpId ?? fallback?.gumpId ?? 0,
    container: entry.container ?? fallback?.container ?? false,
    beverage: entry.beverage,
    spellId: entry.spellId,
    servuoClass: type,
  };
}

function createContentItem(api, world, container, entry) {
  const expanded = expandEntry(entry);
  const spec = resolveSpec(api, expanded);
  if (!spec) return null;

  const data = {
    itemId: spec.itemId,
    hue: spec.hue,
    name: spec.name,
    amount: spec.amount,
    parent: container.serial,
    x: randInt(35, 120),
    y: randInt(35, 110),
    z: 0,
    map: 0,
    servuoClass: spec.servuoClass,
  };
  if (spec.script) data.script = spec.script;
  if (spec.gumpId) data.gumpId = spec.gumpId;
  if (spec.container) {
    data.kind = 'container';
    data.container = true;
    data.capacity = 25;
  }
  if (spec.beverage) {
    data.content = spec.beverage.toLowerCase();
    data.quantity = 5;
    data.maxQuantity = 5;
  }
  if (spec.spellId) data.spellId = spec.spellId;

  const item = createItem(api, world, data);
  const merge = api.items?.findMergeableStack?.(world, container.serial, item);
  if (merge && api.items?.mergeStacks) return api.items.mergeStacks(world, merge, item);
  return item;
}

function contentFor(item) {
  const type = normalizeContentType(item.fillableContentType ?? item.contentType);
  return type ? FILLABLE_CONTENT[type] : null;
}

function acquireContent(api, world, item) {
  const explicit = normalizeContentType(item.fillableContentType ?? item.contentType);
  if (explicit) {
    item.fillableContentType = explicit;
    return FILLABLE_CONTENT[explicit];
  }

  let best = null;
  let bestDist = Infinity;
  for (const mob of nearbyMobiles({ world }, item, null, 60)) {
    const keys = [
      mob.vendorKind, mob.kind, mob.behavior, mob.title, mob.name,
    ].map(normalizeKey).filter(Boolean);
    const contentType = keys.map((k) => CONTENT_BY_VENDOR.get(k)).find(Boolean);
    if (!contentType) continue;
    const dist = Math.max(Math.abs((mob.x | 0) - (item.x | 0)), Math.abs((mob.y | 0) - (item.y | 0)));
    if (dist < bestDist) {
      bestDist = dist;
      best = contentType;
    }
  }
  if (best) item.fillableContentType = best;
  return best ? FILLABLE_CONTENT[best] : null;
}

function resetTrap(item, content) {
  if (!content) return;
  const level = Math.max(1, content.level | 0);
  item.trapped = {
    level,
    damage: level * randInt(10, 30),
    kind: level > randInt(0, 4) ? 'poison' : 'explosion',
  };
  item.trapPower = item.trapped.damage;
}

function respawn(api, world, item, all = false) {
  const content = contentFor(item) ?? acquireContent(api, world, item);
  if (!content || !item || itemBySerial({ ...api, world }, item.serial) !== item) return false;
  const maxSpawn = Math.max(1, item.fillableMaxSpawnCount ?? randInt(3, 5));
  item.fillableMaxSpawnCount = maxSpawn;
  const count = getItemsCount({ world }, item);
  if (count >= maxSpawn) return false;
  const toSpawn = all ? Math.max(0, maxSpawn - count) : 1;
  for (let i = 0; i < toSpawn; i++) {
    const entry = weightedPick(content.entries);
    createContentItem(api, world, item, entry);
  }

  const defaults = containerDefaults(item);
  if (defaults.lockable !== false && !item.locked) {
    const difficulty = Math.max(0, (content.level - 1) * 30);
    item.locked = true;
    item.lockLevel = difficulty - 10;
    item.lockpickDifficulty = difficulty + 30;
    item.requiredSkill = difficulty;
  }
  if (defaults.trapable !== false && (content.level > 1 || Math.random() < 0.8)) {
    item.fillableTotalTraps = 1 + (Math.random() < 0.25 ? 1 : 0) + (Math.random() < 0.0625 ? 1 : 0);
    resetTrap(item, content);
  } else {
    delete item.trapped;
    item.trapPower = 0;
    item.fillableTotalTraps = 0;
  }
  item.fillableNextRespawnAt = null;
  item.fillableNextCheckAt = Date.now() + CHECK_INTERVAL_MS + randInt(0, CHECK_INTERVAL_MS);
  return true;
}

function ensureContainerShape(item) {
  const defaults = containerDefaults(item);
  item.kind = 'container';
  item.container = true;
  item.gumpId ||= defaults.gumpId;
  item.capacity ??= defaults.capacity;
  item.maxWeight ??= defaults.maxWeight;
  item.weight ??= defaults.weight;
  item.movable = false;
  item.servuoClasses ??= [
    item.servuoClass ?? item.fillableType ?? 'FillableContainer',
    'FillableContainer',
    'FillableContent',
    'FillableBvrge',
  ];
}

export default function buildFillableContainer(api) {
  return {
    name: 'fillable-container',
    hasTick: true,
    onCreate(world, item) {
      ensureContainerShape(item);
      item.fillableType ??= item.decoType ?? item.servuoClass ?? 'FillableContainer';
      item.fillableContentType = normalizeContentType(item.fillableContentType ?? item.contentType);
      item.fillableMaxSpawnCount ??= randInt(3, 5);
      const content = acquireContent(api, world, item);
      if (content) respawn(api, world, item, false);
      else item.fillableNextCheckAt = Date.now() + randInt(10_000, 60_000);
    },
    onUse(world, item) {
      ensureContainerShape(item);
      acquireContent(api, world, item);
      return false;
    },
    onDestroy(world, item) {
      for (const child of [...childrenOf({ world }, item)]) {
        destroyItemBySerial({ world }, child.serial);
      }
    },
    onTick(world, item) {
      const now = Date.now();
      if ((item.fillableNextCheckAt ?? 0) > now) return;
      item.fillableNextCheckAt = now + CHECK_INTERVAL_MS + randInt(0, CHECK_INTERVAL_MS);
      ensureContainerShape(item);
      const content = contentFor(item) ?? acquireContent(api, world, item);
      if (!content) return;
      if (item.parent != null || item.movable === true || item.lockedDown || item.secure) {
        item.fillableNextRespawnAt = null;
        return;
      }
      const maxSpawn = Math.max(1, item.fillableMaxSpawnCount ?? 4);
      const threshold = Math.max(0, item.fillableSpawnThreshold ?? (maxSpawn - 1));
      if (getItemsCount({ world }, item) > threshold) {
        item.fillableNextRespawnAt = null;
        return;
      }
      if (!item.fillableNextRespawnAt) {
        item.fillableNextRespawnAt = now + randomRespawnDelay();
        return;
      }
      if (now >= item.fillableNextRespawnAt) respawn(api, world, item, false);
    },
  };
}

export const _TEST = {
  FILLABLE_CONTENT,
  normalizeContentType,
  resolveSpec,
};
