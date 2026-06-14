// Functional world items — ServUO `Scripts/Items/Functional/`.
// Anvil, Forge, Campfire, ChickenCoop, Farmable crops, Switches,
// Special doors (secret/sliding/portcullis), AcidVine/SpiderWebbing,
// Peerless altars, HouseRaffleStone.
//
// Each entry uses our existing item registry. World gameplay hooks
// (lighting, harvest, summon-on-use) live in apps/scripts/src/items
// — those scripts attach to entries by `tagId`.



// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];

function functional(def) {
  __PENDING__.push({
    kind: def.kind ?? 'functional',
    weight: def.weight ?? 5,
    movable: def.movable ?? true,
    ...def,
  });
}

// ---- Smithing stations -----------------------------------------------
// `craftingStation: 'forge' | 'anvil' | 'sawmill'` is read by the
// crafting system to grant "near a station" bonuses.

functional({ id: 0x0FAF, name: 'Anvil',         tagId: 'anvil',          craftingStation: 'anvil',  weight: 50, movable: false });
functional({ id: 0x0FB1, name: 'Forge',         tagId: 'forge',          craftingStation: 'forge',  weight: 100, movable: false });
functional({ id: 0x1996, name: 'Large Forge',   tagId: 'large-forge',    craftingStation: 'forge',  weight: 300, movable: false });
functional({ id: 0x1A22, name: 'Sawmill',       tagId: 'sawmill',        craftingStation: 'sawmill',weight: 200, movable: false });
functional({ id: 0x1EBB, name: 'Loom',          tagId: 'loom',           craftingStation: 'loom',   weight: 50,  movable: false });
functional({ id: 0x105F, name: 'Spinning Wheel',tagId: 'spinning-wheel', craftingStation: 'loom',   weight: 50,  movable: false });
functional({ id: 40334,  name: 'Alchemy Station', tagId: 'alchemy-station',
  script: 'alchemy-table', craftingStation: 'alchemy', weight: 80, movable: false });
functional({ id: 40350,  name: 'BBQ Smoker', tagId: 'bbq-smoker',
  script: 'oven', craftingStation: 'oven', weight: 80, movable: false });
functional({ id: 38945,  name: 'Advanced Training Dummy (East)', tagId: 'advanced-training-dummy-east',
  script: 'training-dummy', weight: 80, movable: false, training: { minSkill: -25, maxSkill: 60 },
  servuoClass: 'AdvancedTrainingDummy',
  servuoClasses: ['AdvancedTrainingDummy', 'AdvancedTrainingDummyEastAddon', 'AdvancedTrainingDummyEastDeed'] });
functional({ id: 38940,  name: 'Advanced Training Dummy (South)', tagId: 'advanced-training-dummy-south',
  script: 'training-dummy', weight: 80, movable: false, training: { minSkill: -25, maxSkill: 60 },
  servuoClass: 'AdvancedTrainingDummy',
  servuoClasses: ['AdvancedTrainingDummy', 'AdvancedTrainingDummySouthAddon', 'AdvancedTrainingDummySouthDeed'] });
functional({ id: 39982,  name: 'Fletching Station', tagId: 'fletching-station',
  script: 'fletching-station', craftingStation: 'fletching', weight: 80, movable: false });
functional({ id: 39496,  name: 'Sewing Machine', tagId: 'sewing-machine',
  script: 'sewing-machine', craftingStation: 'tailoring', weight: 80, movable: false });
functional({ id: 39592,  name: 'Smithing Press', tagId: 'smithing-press',
  script: 'smithing-press', craftingStation: 'forge', weight: 120, movable: false });
functional({ id: 39962,  name: 'Spinning Lathe', tagId: 'spinning-lathe',
  script: 'spinning-lathe', craftingStation: 'carpentry', weight: 100, movable: false });
functional({ id: 40938,  name: 'Enchanted Writing Desk', tagId: 'writing-desk',
  script: 'writing-desk', craftingStation: 'inscription', weight: 100, movable: false });
functional({ id: 0x14F0, name: 'Alchemy Station Deed', tagId: 'alchemy-station-deed',
  script: 'addon-deed', weight: 1, addonName: 'alchemy-station' });
functional({ id: 0x14F0, name: 'BBQ Smoker Deed', tagId: 'bbq-smoker-deed',
  script: 'addon-deed', weight: 1, addonName: 'bbq-smoker' });
functional({ id: 0x14F0, name: 'Advanced Training Dummy East Deed', tagId: 'advanced-training-dummy-east-deed',
  script: 'addon-deed', weight: 1, addonName: 'advanced-training-dummy-east',
  servuoClass: 'AdvancedTrainingDummyEastDeed',
  servuoClasses: ['AdvancedTrainingDummyEastDeed', 'AdvancedTrainingDummyEastAddon', 'AdvancedTrainingDummy'] });
functional({ id: 0x14F0, name: 'Advanced Training Dummy South Deed', tagId: 'advanced-training-dummy-south-deed',
  script: 'addon-deed', weight: 1, addonName: 'advanced-training-dummy-south',
  servuoClass: 'AdvancedTrainingDummySouthDeed',
  servuoClasses: ['AdvancedTrainingDummySouthDeed', 'AdvancedTrainingDummySouthAddon', 'AdvancedTrainingDummy'] });
functional({ id: 0x14F0, name: 'Fletching Station Deed', tagId: 'fletching-station-deed',
  script: 'addon-deed', weight: 1, addonName: 'fletching-station-south' });
functional({ id: 0x14F0, name: 'Sewing Machine Deed', tagId: 'sewing-machine-deed',
  script: 'addon-deed', weight: 1, addonName: 'sewing-machine-south' });
functional({ id: 0x14F0, name: 'Smithing Press Deed', tagId: 'smithing-press-deed',
  script: 'addon-deed', weight: 1, addonName: 'smithing-press-south' });
functional({ id: 0x14F0, name: 'Spinning Lathe Deed', tagId: 'spinning-lathe-deed',
  script: 'addon-deed', weight: 1, addonName: 'spinning-lathe-south' });
functional({ id: 0x14F0, name: 'Enchanted Writing Desk Deed', tagId: 'writing-desk-deed',
  script: 'addon-deed', weight: 1, addonName: 'writing-desk-south' });
functional({ id: 0x14F0, name: 'Metal Tub Deed', tagId: 'metal-tub-deed',
  script: 'addon-deed', weight: 1, addonNames: { south: 'metal-tub-south', east: 'metal-tub-east' },
  servuoClass: 'MetalTubDeed', servuoClasses: ['MetalTubDeed', 'MetalTubAddon', 'IWaterSource', 'IRewardOption'] });
functional({ id: 0x14F0, name: 'Dungeon Fountain Deed', tagId: 'dungeon-fountain-deed',
  script: 'addon-deed', weight: 1, addonName: 'dungeon-fountain',
  servuoClass: 'DungeonFountainDeed', servuoClasses: ['DungeonFountainDeed', 'DungeonFountainAddon'] });
functional({ id: 0x14F0, name: 'Fountain Deed', tagId: 'fountain-deed',
  script: 'addon-deed', weight: 1, addonName: 'fountain', blessed: true,
  labelNumber: 1076283,
  servuoClass: 'FountainDeed', servuoClasses: ['FountainDeed', 'FountainAddon', 'StoneFountainAddon'] });
functional({ id: 0x14F0, name: 'Flaming Head Deed', tagId: 'flaming-head-deed',
  script: 'flaming-head-deed', weight: 1, blessed: true,
  labelNumber: 1041050,
  servuoClass: 'FlamingHeadDeed', servuoClasses: ['FlamingHeadDeed', 'FlamingHead', 'StoneFaceTrapNoDamage', 'InternalTarget', 'IRewardItem'] });
functional({ id: 0x14F0, name: 'Dolphin Rug Deed', tagId: 'dolphin-rug-deed',
  script: 'addon-deed', weight: 1, blessed: true,
  addonNames: {
    'East 7x7': 'dolphin-rug-large-east',
    'South 7x7': 'dolphin-rug-large-south',
    'East 3x5': 'dolphin-rug-small-east',
    'South 3x5': 'dolphin-rug-small-south',
  },
  servuoClass: 'DolphinRugAddonDeed',
  servuoClasses: ['DolphinRugAddonDeed', 'DolphinRugAddon', 'InternalAddonComponent', 'RugType', 'RewardOptionGump', 'IRewardOption', 'IRewardItem'] });
functional({ id: 0x14F0, name: 'Pickpocket Dip East Deed', tagId: 'pickpocket-dip-east-deed',
  script: 'addon-deed', weight: 1, addonName: 'pickpocket-dip-east',
  labelNumber: 1044337,
  servuoClass: 'PickpocketDipEastDeed', servuoClasses: ['PickpocketDipEastDeed', 'PickpocketDipEastAddon', 'PickpocketDip', 'InternalTimer'] });
functional({ id: 0x14F0, name: 'Pickpocket Dip South Deed', tagId: 'pickpocket-dip-south-deed',
  script: 'addon-deed', weight: 1, addonName: 'pickpocket-dip-south',
  labelNumber: 1044338,
  servuoClass: 'PickpocketDipSouthDeed', servuoClasses: ['PickpocketDipSouthDeed', 'PickpocketDipSouthAddon', 'PickpocketDip', 'InternalTimer'] });
functional({ id: 0x14F0, name: 'Hearth of the Home Fire Deed', tagId: 'hearth-of-home-fire-deed',
  script: 'addon-deed', weight: 1,
  blessed: true,
  addonNames: { south: 'hearth-of-home-fire-south', east: 'hearth-of-home-fire-east' },
  labelNumber: 1062919,
  servuoClass: 'HearthOfHomeFireDeed',
  servuoClasses: ['HearthOfHomeFireDeed', 'HearthOfHomeFire'] });
functional({ id: 0x0974, name: 'Hag Cauldron', tagId: 'hag-cauldron',
  weight: 50, movable: false, light: 9,
  servuoClass: 'HagCauldron',
  servuoClasses: ['HagCauldron'] });
functional({ id: 0x14F0, name: 'Metal Ladder Deed', tagId: 'metal-ladder-deed',
  script: 'addon-deed', weight: 1,
  addonNames: {
    south: 'metal-ladder-south', east: 'metal-ladder-east',
    north: 'metal-ladder-north', west: 'metal-ladder-west',
    'south castle': 'metal-ladder-south-castle', 'east castle': 'metal-ladder-east-castle',
    'north castle': 'metal-ladder-north-castle', 'west castle': 'metal-ladder-west-castle',
  },
  servuoClass: 'MetalLadderDeed', servuoClasses: ['MetalLadderDeed', 'MetalLadderAddon', 'MetalLadderType', 'IRewardOption'] });
functional({ id: 0x14F0, name: 'Contest Mini House Deed', tagId: 'contest-mini-house-deed',
  script: 'addon-deed', weight: 1, blessed: true,
  addonName: 'contest-mini-house',
  miniHouseType: 'MalasMountainPass',
  isRewardItem: true,
  labelNumber: 1062692,
  servuoClass: 'ContestMiniHouseDeed',
  servuoClasses: ['ContestMiniHouseDeed', 'ContestMiniHouse', 'MiniHouseDeed', 'MiniHouseAddon', 'MiniHouseInfo', 'IRewardItem'] });
functional({ id: 0x14F0, name: 'Contest 2004 Mini House Deed', tagId: 'contest-mini-house-church-at-night-deed',
  script: 'addon-deed', weight: 1, blessed: true,
  addonName: 'contest-mini-house-church-at-night',
  miniHouseType: 'ChurchAtNight',
  isRewardItem: true,
  labelNumber: 1072216,
  servuoClass: 'ContestMiniHouseDeed',
  servuoClasses: ['ContestMiniHouseDeed', 'ContestMiniHouse', 'MiniHouseDeed', 'MiniHouseAddon', 'MiniHouseInfo', 'IRewardItem'] });
functional({ id: 0x14F0, name: 'Enchanted Granite Cart Deed', tagId: 'enchanted-granite-cart-deed',
  script: 'addon-deed', weight: 1, blessed: true,
  addonNames: { south: 'enchanted-granite-cart-south', east: 'enchanted-granite-cart-east' },
  labelNumber: 1159422,
  isRewardItem: true,
  servuoClass: 'EnchantedGraniteCartAddonDeed',
  servuoClasses: ['EnchantedGraniteCartAddonDeed', 'EnchantedGraniteCartAddon', 'EnchantedGraniteCartComponent', 'IRewardItem', 'IRewardOption'] });
functional({ id: 0x14F0, name: 'Mining Cart Deed', tagId: 'mining-cart-deed',
  script: 'addon-deed', weight: 1, blessed: true,
  addonNames: {
    'Ore South': 'mining-cart-ore-south',
    'Ore East': 'mining-cart-ore-east',
    'Gem South': 'mining-cart-gem-south',
    'Gem East': 'mining-cart-gem-east',
  },
  labelNumber: 1080385,
  isRewardItem: true,
  servuoClass: 'MiningCartDeed',
  servuoClasses: ['MiningCartDeed', 'MiningCart', 'MiningCartType', 'InternalAddonComponent', 'RewardOptionGump', 'IRewardItem', 'IRewardOption'] });
functional({ id: 0x14F0, name: 'Garden Shed Deed', tagId: 'garden-shed-deed',
  script: 'addon-deed', weight: 1, blessed: true,
  addonNames: { South: 'garden-shed-south', East: 'garden-shed-east' },
  labelNumber: 1153491,
  isRewardItem: true,
  servuoClass: 'GardenShedDeed',
  servuoClasses: ['GardenShedDeed', 'GardenShedAddon', 'GardenShedBarrel', 'GardenShedComponent', 'BaseAddonContainerDeed', 'InternalGump', 'IRewardItem'] });
functional({ id: 0x14F0, name: 'Harpsichord Deed', tagId: 'harpsichord-deed',
  script: 'addon-deed', weight: 1, blessed: true,
  addonNames: { South: 'harpsichord-south', East: 'harpsichord-east' },
  labelNumber: 1152937,
  harpsichordSongs: [],
  servuoClass: 'HarpsichordAddonDeed',
  servuoClasses: ['HarpsichordAddonDeed', 'HarpsichordAddon', 'HarpsichordSongGump', 'HarpsichordColor', 'DirectionType', 'AddonOptionGump', 'IRewardOption'] });
functional({ id: 0x4BA1, name: 'Harpsichord Roll', tagId: 'harpsichord-roll',
  script: 'harpsichord-roll', weight: 1, labelNumber: 1098233,
  servuoClass: 'HarpsichordRoll', servuoClasses: ['HarpsichordRoll', 'InternalTarget'] });
functional({ id: 0x14F0, name: 'Sheep Statue Deed', tagId: 'sheep-statue-deed',
  script: 'addon-deed', weight: 1, blessed: true, addonName: 'sheep-statue',
  labelNumber: 1151835,
  isRewardItem: true,
  servuoClass: 'SheepStatueDeed',
  servuoClasses: ['SheepStatueDeed', 'SheepStatue', 'InternalAddonComponent', 'IRewardItem'] });
functional({ id: 0x14F0, name: 'Gold Carpet Deed', tagId: 'gold-carpet-deed',
  script: 'addon-deed', weight: 1, addonName: 'gold-carpet',
  servuoClass: 'goldcarpetAddonDeed',
  servuoClasses: ['goldcarpetAddonDeed', 'GoldCarpetAddon'] });
functional({ id: 0x14F0, name: 'MedusaSNest Deed', tagId: 'medusa-s-nest-deed',
  script: 'addon-deed', weight: 1, addonName: 'medusa-s-nest',
  servuoClass: 'MedusaSNestAddonDeed',
  servuoClasses: ['MedusaSNestAddonDeed', 'MedusaSNestAddon'] });
functional({ id: 0x14F0, name: 'Alchemist Bookcase Deed', tagId: 'alchemists-bookshelf-deed',
  script: 'addon-deed', weight: 1, blessed: true,
  addonNames: { South: 'alchemists-bookshelf-south', East: 'alchemists-bookshelf-east' },
  labelNumber: 1154192,
  servuoClass: 'AlchemistsBookshelfDeed',
  servuoClasses: ['AlchemistsBookshelfDeed', 'AlchemistsBookshelfAddon', 'AddonOptionGump', 'IRewardOption'] });
functional({ id: 0x14F0, name: 'Rose Rug Deed', tagId: 'rose-rug-deed',
  script: 'addon-deed', weight: 1, blessed: true,
  addonNames: {
    'Large East': 'rose-rug-large-east',
    'Large South': 'rose-rug-large-south',
    'Small East': 'rose-rug-small-east',
    'Small South': 'rose-rug-small-south',
  },
  labelNumber: 1150121,
  isRewardItem: true,
  servuoClass: 'RoseRugAddonDeed',
  servuoClasses: ['RoseRugAddonDeed', 'RoseRugAddon', 'RugType', 'RewardOptionGump', 'IRewardItem', 'IRewardOption'] });
functional({ id: 0x14F0, name: 'Skull Rug Deed', tagId: 'skull-rug-deed',
  script: 'addon-deed', weight: 1, blessed: true,
  addonNames: {
    'Large East': 'skull-rug-large-east',
    'Large South': 'skull-rug-large-south',
    'Small East': 'skull-rug-small-east',
    'Small South': 'skull-rug-small-south',
  },
  labelNumber: 1150120,
  isRewardItem: true,
  servuoClass: 'SkullRugAddonDeed',
  servuoClasses: ['SkullRugAddonDeed', 'SkullRugAddon', 'RugType', 'RewardOptionGump', 'IRewardItem', 'IRewardOption'] });
functional({ id: 0x14F0, name: 'Fire Painting Deed', tagId: 'fire-painting-deed',
  script: 'addon-deed', weight: 1, blessed: true,
  addonNames: { South: 'fire-painting-south', East: 'fire-painting-east' },
  labelNumber: 1154182,
  servuoClass: 'FirePaintingDeed',
  servuoClasses: ['FirePaintingDeed', 'FirePaintingAddon', 'FirePaintingComponent', 'AddonOptionGump', 'DirectionType', 'IRewardOption'] });
functional({ id: 0x14F0, name: 'Ship Painting Deed', tagId: 'ship-painting-deed',
  script: 'addon-deed', weight: 1, blessed: true,
  addonNames: { South: 'ship-painting-south', East: 'ship-painting-east' },
  labelNumber: 1154180,
  servuoClass: 'ShipPaintingDeed',
  servuoClasses: ['ShipPaintingDeed', 'ShipPaintingAddon', 'ShipPaintingComponent', 'AddonOptionGump', 'DirectionType', 'IRewardOption'] });
functional({ id: 0x14F0, name: "Medusa's Floor Tile Deed", tagId: 'medusa-floor-tile-deed',
  script: 'addon-deed', weight: 1, addonName: 'medusa-floor-tile',
  labelNumber: 1113918,
  servuoClass: 'MedusaFloorTileAddonDeed',
  servuoClasses: ['MedusaFloorTileAddonDeed', 'MedusaFloorTileAddon', 'LocalizedAddonComponent'] });
functional({ id: 0x14F0, name: 'Lord British Throne Deed', tagId: 'lord-british-throne-deed',
  script: 'addon-deed', weight: 1, addonName: 'lord-british-throne',
  labelNumber: 1073243,
  servuoClass: 'LordBritishThroneDeed',
  servuoClasses: ['LordBritishThroneDeed', 'LordBritishThroneAddon'] });
functional({ id: 0x14F0, name: 'Enormous Venus Flytrap Deed', tagId: 'enormous-venus-flytrap-deed',
  script: 'addon-deed', weight: 1, blessed: true,
  addonNames: { South: 'enormous-venus-flytrap-south', East: 'enormous-venus-flytrap-east' },
  labelNumber: 1154462,
  servuoClass: 'EnormousVenusFlytrapAddonDeed',
  servuoClasses: ['EnormousVenusFlytrapAddonDeed', 'EnormousVenusFlytrapAddon', 'BaseAddonContainerDeed', 'CleanupArray', 'AppraiseforCleanup'] });
functional({ id: 0x14F0, name: 'Sacrificial Altar Deed', tagId: 'sacrificial-altar-deed',
  script: 'addon-deed', weight: 1, blessed: true,
  addonNames: { South: 'sacrificial-altar-south', East: 'sacrificial-altar-east' },
  labelNumber: 1074818,
  servuoClass: 'SacrificialAltarDeed',
  servuoClasses: ['SacrificialAltarDeed', 'SacrificialAltarAddon', 'BaseAddonContainerDeed', 'CleanupArray', 'AppraiseforCleanup'] });
functional({ id: 0x14F0, name: 'Vendor Mall Deed', tagId: 'vendor-mall-deed',
  script: 'addon-deed', weight: 1, addonName: 'vendor-mall',
  servuoClass: 'VendorMallAddonDeed',
  servuoClasses: ['VendorMallAddonDeed', 'VendorMallAddon'] });
functional({ id: 0x14F0, name: 'Spiral Staircase Deed', tagId: 'spiral-staircase-deed',
  script: 'addon-deed', weight: 1,
  addonNames: { top: 'spiral-staircase-topper', plain: 'spiral-staircase' },
  servuoClass: 'SpiralStaircaseDeed', servuoClasses: ['SpiralStaircaseDeed', 'SpiralStaircaseAddon', 'TeleporterComponent', 'IRewardOption'] });

// ---- Lights & atmospheric ---------------------------------------------
functional({ id: 0x0DE3, name: 'Campfire',      tagId: 'campfire',       script: 'campfire', light: { radius: 8, color: 0xFFA040 }, weight: 10 });
functional({ id: 0x0E31, name: 'Brazier',       tagId: 'brazier',        light: { radius: 5, color: 0xFFB060 }, weight: 30, movable: false });
functional({ id: 0x0F6C, name: 'Skull Brazier', tagId: 'skull-brazier',  light: { radius: 6, color: 0x8080FF }, weight: 30, movable: false });
functional({ id: 0x0A12, name: 'Sconce',        tagId: 'sconce',         light: { radius: 4, color: 0xFFC080 }, weight: 5,  movable: false });

// ---- Farmable crops (ServUO `Items/Functional/FarmableCabbage.cs` …)
// Each crop sits in the world; players use [chop or [harvest to pull
// the resource into their pack. `farm: { yield, resource }` is read by
// the harvest system; without it the script just deletes silently.

const CROPS = [
  { id: 0x0C7B, name: 'Cabbage',  resource: 'cabbage',  yield: 1, hue: 0x42 },
  { id: 0x0C77, name: 'Carrot',   resource: 'carrot',   yield: 1, hue: 0x47 },
  { id: 0x0C50, name: 'Cotton',   resource: 'cotton',   yield: 4, hue: 0 },
  { id: 0x1A99, name: 'Flax',     resource: 'flax',     yield: 4, hue: 0 },
  { id: 0x0C70, name: 'Lettuce',  resource: 'lettuce',  yield: 1, hue: 0x42 },
  { id: 0x0C7D, name: 'Onion',    resource: 'onion',    yield: 1, hue: 0x05 },
  { id: 0x0C6A, name: 'Pumpkin',  resource: 'pumpkin',  yield: 1, hue: 0x39 },
  { id: 0x0C77, name: 'Turnip',   resource: 'turnip',   yield: 1, hue: 0x4B },
  { id: 0x0C56, name: 'Wheat',    resource: 'wheat',    yield: 5, hue: 0 },
];
for (const c of CROPS) {
  functional({
    id: c.id, name: c.name, tagId: `crop-${c.resource}`, hue: c.hue,
    weight: 1, movable: false, script: 'farmable-crop',
    farm: { resource: c.resource, yield: c.yield, regrowMs: 30 * 60 * 1000 },
  });
}

// ---- Pet incubation (ServUO `ChickenCoop.cs`, eggs)
functional({ id: 0x4910, name: 'Chicken Coop',          tagId: 'chicken-coop',         weight: 50, script: 'chicken-coop',         movable: false });
functional({ id: 0x40FB, name: 'Battle Chicken Lizard Egg', tagId: 'battle-chicken-egg', weight: 1,  script: 'incubator-egg',  data: { hatch: 'battle-chicken-lizard', daysToHatch: 7 } });
functional({ id: 0x40FB, name: 'Dragon Turtle Egg',     tagId: 'dragon-turtle-egg',    weight: 1,  script: 'incubator-egg',  data: { hatch: 'dragon-turtle', daysToHatch: 14 } });
functional({ id: 0x4222, name: 'Incubator',             tagId: 'incubator',            weight: 30, script: 'incubator',           movable: false });

// ---- Switches / lever / portals (dungeon puzzles) --------------------
functional({ id: 0x108C, name: 'Iron Lever',  tagId: 'lever',         script: 'switch', weight: 10, movable: false });
functional({ id: 0x108E, name: 'Stone Switch',tagId: 'stone-switch',  script: 'switch', weight: 10, movable: false });
functional({ id: 0x108F, name: 'Wall Switch', tagId: 'wall-switch',   script: 'switch', weight: 10, movable: false });

// ---- Special doors -----------------------------------------------------
// `script: 'door'` already exists in items/doors.js — we just enrol the
// extended door variants ServUO ships separately.
functional({ id: 0x0867, name: 'Secret Door',     tagId: 'secret-door',     script: 'secret-door', weight: 100, movable: false });
functional({ id: 0x0866, name: 'Sliding Door',    tagId: 'sliding-door',    script: 'sliding-door', weight: 80,  movable: false });
functional({ id: 0x0866, name: 'Portcullis',      tagId: 'portcullis',      script: 'portcullis',  weight: 200, movable: false });

// ---- Movement-impair tiles -------------------------------------------
functional({ id: 0x3979, name: 'Acid Vine',     tagId: 'acid-vine',     script: 'acid-vine',     weight: 0, movable: false, immobile: true });
functional({ id: 0x10D2, name: 'Spider Webbing',tagId: 'spider-web',    script: 'spider-web',    weight: 0, movable: false, immobile: true });
functional({ id: 0x1BC3, name: 'Xml Tile Trap', tagId: 'xml-tile-trap', script: 'xml-tile-trap', weight: 0, movable: false, visible: false });

// ---- Peerless boss summon altars -------------------------------------
// 6 unique altars (Paroxysmus, Blighted Grove, Bedlam, Twisted Weald,
// Citadel, Prism of Light). Players "use" the altar with a key
// fragment + group to spawn the boss. Hook lives in
// `apps/scripts/src/items/altars.js` (registers `script: 'peerless-altar'`).
const PEERLESS_ALTARS = [
  ['Paroxysmus Altar',     0x32F0, 'paroxysmus',     'chief-paroxysmus'],
  ['Blighted Grove Altar', 0x32F1, 'blighted-grove', 'lady-melisande'],
  ['Bedlam Altar',         0x32F2, 'bedlam',         'monstrous-interred-grizzle'],
  ['Twisted Weald Altar',  0x32F3, 'twisted-weald',  'dread-horn'],
  ['Citadel Altar',        0x32F4, 'citadel',        'travesty'],
  ['Prism of Light Altar', 0x32F5, 'prism-of-light', 'shimmering-effusion'],
];
for (const [name, id, tag, boss] of PEERLESS_ALTARS) {
  functional({
    id, name, tagId: `peerless-altar-${tag}`, script: 'peerless-altar',
    weight: 500, movable: false, peerless: { tag, boss, keyCount: 4 },
  });
}

// ---- Housing items ---------------------------------------------------
functional({ id: 0x14F0, name: 'House Raffle Stone', tagId: 'house-raffle-stone',
  script: 'house-raffle-stone', weight: 200, movable: false });
functional({ id: 0x14F0, name: 'Moving Crate',       tagId: 'moving-crate',
  kind: 'container', container: true, capacity: 1000, maxWeight: 100000,
  script: 'moving-crate', weight: 1, movable: false });
functional({ id: 0x14F0, name: 'Interior Decorator', tagId: 'interior-decorator',
  script: 'interior-decorator', weight: 1 });
functional({ id: 0x14F0, name: 'Mannequin Deed', tagId: 'mannequin-deed',
  script: 'mannequin-deed', weight: 1 });
functional({ id: 0x1086, name: "Treasure Hunter's Trinket", tagId: 'treasure-trinket',
  script: 'treasure-trinket', weight: 1, charges: 10 });
functional({ id: 0x14F8, name: 'Rope of Ascension', tagId: 'rope-of-ascension',
  script: 'rope-of-ascension', weight: 3, charges: 10 });
functional({ id: 0x14F0, name: 'Pet Bonding Deed', tagId: 'pet-bonding-deed',
  script: 'pet-bonding-deed', weight: 1 });
functional({ id: 0x080F, name: 'House Refresh Stone', tagId: 'refresh-stone',
  script: 'refresh-stone', weight: 1 });
functional({ id: 0x080F, name: 'Greater House Refresh Stone', tagId: 'greater-refresh-stone',
  script: 'refresh-stone', weight: 1, _refreshDays: 30 });
functional({ id: 0x232A, name: 'Heritage Token Bag', tagId: 'heritage-token-bag',
  script: 'heritage-token-bag', weight: 1 });
functional({ id: 0x232A, name: 'Tokuno Pigment Sack', tagId: 'tokuno-pigment-sack',
  script: 'tokuno-pigment-sack', weight: 1 });
functional({ id: 0x232A, name: 'Sanctuary Reward Bag', tagId: 'sanctuary-reward-bag',
  script: 'sanctuary-reward-bag', weight: 1 });
functional({ id: 0x232A, name: 'Neon Gift Box', tagId: 'gift-box-neon',
  kind: 'container', container: true, gumpId: 0x003E, capacity: 125, maxWeight: 400,
  script: 'gift-box-neon', weight: 1, flipIds: [0x232A, 0x232B],
  servuoClass: 'GiftBoxNeon', servuoClasses: ['GiftBoxNeon', 'GiftBoxHues', 'FlipableAttribute'] });

// ---- Player house message/vote boards -------------------------------
functional({
  id: 0x09A8, name: 'Ballot Box', tagId: 'ballot-box',
  servuoClass: 'BallotBox', servuoClasses: ['BallotBox', 'TopicPrompt', 'BallotBoxAddon', 'BallotBoxDeed'],
  script: 'ballot-box', weight: 10, movable: false,
});
functional({
  id: 0x2311, name: 'Player Bulletin Board (South)', tagId: 'player-bb-south',
  servuoClass: 'PlayerBBSouth', servuoClasses: ['PlayerBBSouth', 'BasePlayerBB', 'PlayerBBGump', 'PostPrompt', 'SetTitlePrompt', 'PlayerBBMessage'],
  script: 'player-bulletin-board', weight: 15, movable: false,
});
functional({
  id: 0x2312, name: 'Player Bulletin Board (East)', tagId: 'player-bb-east',
  servuoClass: 'PlayerBBEast', servuoClasses: ['PlayerBBEast', 'BasePlayerBB', 'PlayerBBGump', 'PostPrompt', 'SetTitlePrompt', 'PlayerBBMessage'],
  script: 'player-bulletin-board', weight: 15, movable: false,
});

// ---- Misc tools ------------------------------------------------------
functional({ id: 0x0E2F, name: 'Unassigned Staff Orb', tagId: 'staff-orb', script: 'staff-orb', weight: 0, blessed: true, staffOrbAutoRes: true, servuoClass: 'StaffOrb', servuoClasses: ['StaffOrb', 'SetHomeEntry', 'GoHomeEntry', 'AutoResTimer'] });
functional({ id: 0x14F0, name: 'Ball of Summoning',         tagId: 'ball-of-summoning', script: 'ball-of-summoning', weight: 5, charges: 20 });
functional({ id: 0x1086, name: 'Bracelet of Binding',       tagId: 'bracelet-of-binding', script: 'bracelet-binding', weight: 1, charges: 30, maxCharges: 999, layer: 14, servuoClass: 'BraceletOfBinding', servuoClasses: ['BraceletOfBinding', 'TransportTimer', 'BindTarget', 'InscribePrompt'] });
functional({ id: 0x1086, name: 'Greater Bracelet of Binding',tagId: 'greater-bracelet-of-binding', script: 'bracelet-binding', weight: 1, charges: 60, maxCharges: 60, layer: 14, servuoClass: 'GreaterBraceletOfBinding', servuoClasses: ['GreaterBraceletOfBinding', 'BraceletOfBinding', 'GreaterBraceletOfBindingGump', 'ConfirmBindGump', 'BindEntry', 'TransportTimer'] });
functional({ id: 0x4910, name: 'Chest of Sending',          tagId: 'chest-of-sending', weight: 5, script: 'chest-of-sending', charges: 50, maxCharges: 50, blessed: true, flipIds: [0x4910, 0x4911], servuoClass: 'ChestOfSending', servuoClasses: ['ChestOfSending', 'UseChestEntry', 'FlipableAttribute'] });
functional({
  id: 0x14F0, hue: 0x672, name: 'a vendor rental contract', tagId: 'vendor-rental-contract',
  servuoClass: 'VendorRentalContract',
  servuoClasses: [
    'VendorRentalContract', 'VendorRentalDuration', 'VendorRentalContractGump',
    'VendorRentalOfferGump', 'ContractOptionEntry', 'OfferExpireTimer',
    'RentedVendor', 'RenterVendorRentalGump', 'LandlordVendorRentalGump',
    'VendorRentalRefundGump', 'RentalExpireTimer',
  ],
  script: 'vendor-rental-contract',
  rentalDurationId: 0,
  rentalPrice: 1500,
  rentalLandlordRenew: false,
  rentalOffereeSerial: 0,
  rentalOfferExpiresAt: 0,
  weight: 1,
});
functional({ id: 0x1ED0, name: 'Communication Crystal (Broadcast)', tagId: 'broadcast-crystal', servuoClass: 'BroadcastCrystal', script: 'communication-crystal', weight: 1, crystalKind: 'broadcast', crystalCharges: 2000, crystalActive: false, crystalReceivers: [] });
functional({ id: 0x1ED0, name: 'Communication Crystal (Receiver)', tagId: 'receiver-crystal', servuoClass: 'ReceiverCrystal', script: 'communication-crystal', weight: 1, crystalKind: 'receiver', crystalActive: false });
functional({ id: 0x14F0, name: 'Forged Metal of Artifacts', tagId: 'forged-metal-of-artifacts', script: 'reroll-artifact', weight: 5, charges: 10 });
functional({ id: 0x1006, hue: 2419, name: 'Powder of Fortifying', tagId: 'powder-of-fortifying', script: 'powder-of-fortifying', weight: 1, charges: 10, servuoClass: 'PowderOfTemperament', servuoClasses: ['PowderOfTemperament', 'IDurability', 'IWearableDurability'] });
functional({ id: 0x0E86, name: 'Caddellite Pickaxe', tagId: 'caddellite-pickaxe', script: 'pickaxe', kind: 'tool', weight: 10, charges: 50, pickaxeBonus: true, caddelliteTool: true, servuoClass: 'CaddellitePickaxe', servuoClasses: ['CaddellitePickaxe', 'ICaddelliteTool', 'Caddellite'] });
functional({ id: 0x0F43, name: 'Caddellite Hatchet', tagId: 'caddellite-hatchet', script: 'hatchet', kind: 'tool', weight: 6, charges: 50, lumberjackBonus: true, caddelliteTool: true, servuoClass: 'CaddelliteHatchet', servuoClasses: ['CaddelliteHatchet', 'ICaddelliteTool', 'Caddellite'] });
functional({ id: 0x0DC0, name: 'Caddellite Fishing Pole', tagId: 'caddellite-fishing-pole', script: 'fishing-pole', kind: 'tool', weight: 8, charges: 50, fishBonus: 10, caddelliteTool: true, servuoClass: 'CaddelliteFishingPole', servuoClasses: ['CaddelliteFishingPole', 'ICaddelliteTool', 'Caddellite'] });
functional({ id: 0x1364, name: 'Rough Meteorite', tagId: 'rough-meteorite', script: 'caddellite-infuser', weight: 1, stackable: true, servuoClass: 'Meteorite', servuoClasses: ['Meteorite', 'Caddellite'] });
functional({ id: 0x097B, name: 'Khaldun Tasty Treat', tagId: 'khaldun-tasty-treat', script: 'khaldun-tasty-treat', weight: 1, stackable: true, servuoClass: 'KhaldunTastyTreat', servuoClasses: ['KhaldunTastyTreat', 'Caddellite'] });
functional({ id: 0x20DD, name: 'Staff Ethereal Steed', tagId: 'gm-ethereal-steed',
  script: 'servuo-ethereal', weight: 5, blessed: true, staffOnly: true, mountKind: 'gm-ethereal',
  ethereal: { kind: 'gm-ethereal', hue: 0, summoned: false },
  servuoClass: 'GMEthereal', servuoClasses: ['GMEthereal', 'GMEthVirtual', 'EtherealMount'] });
functional({ id: 0x13E3, name: 'Hammer of Hephaestus',      tagId: 'hammer-hephaestus', kind: 'weapon', subKind: 'mace', weight: 8, damage: [15, 22], smithBonus: 30 });
functional({ id: 0x13E3, name: 'Ancient Smithy Hammer',     tagId: 'ancient-smithy-hammer', kind: 'weapon', subKind: 'mace', weight: 8, damage: [12, 18], smithBonus: 60 });
functional({ id: 0x0E86, name: "Gargoyle's Pickaxe",        tagId: 'gargoyles-pickaxe', kind: 'tool', mineBonus: 30, weight: 10, charges: 30 });
functional({ id: 0x14F0, name: "Amelia's Toolbox",          tagId: 'amelias-toolbox', script: 'multi-tool', weight: 5, charges: 50 });
functional({ id: 0x0E86, name: "Jacob's Pickaxe",           tagId: 'jacobs-pickaxe', kind: 'tool', mineBonus: 50, weight: 10, charges: 50 });
functional({ id: 0x0DBF, name: "Xenrr's Fishing Pole",      tagId: 'xenrr-fishing-pole', kind: 'tool', fishBonus: 50, weight: 8, charges: 50 });
functional({
  id: 0x0F8B, name: 'Moonstone to Felucca', tagId: 'moonstone-felucca',
  servuoClass: 'Moonstone', servuoClasses: ['Moonstone', 'MoonstoneGate', 'SettleTimer'],
  script: 'moonstone', moonstoneType: 'Felucca', weight: 1,
});
functional({
  id: 0x0F8B, name: 'Moonstone to Trammel', tagId: 'moonstone-trammel',
  servuoClass: 'Moonstone', servuoClasses: ['Moonstone', 'MoonstoneGate', 'SettleTimer'],
  script: 'moonstone', moonstoneType: 'Trammel', weight: 1,
});

// ---- Aquarium support items -----------------------------------------
functional({
  id: 0x241C, name: 'Fish Bowl', tagId: 'fish-bowl',
  servuoClass: 'FishBowl', servuoClasses: ['FishBowl', 'RemoveCreature'],
  kind: 'container', container: true, gumpId: 0x003D, hue: 0x47E,
  script: 'fish-bowl', capacity: 1, maxWeight: 10, weight: 2,
});
functional({
  id: 0x0EFC, name: 'Aquarium Food', tagId: 'aquarium-food',
  servuoClass: 'AquariumFood', kind: 'aquarium-food', weight: 1,
});
functional({
  id: 0x0973, name: 'Vacation Wafer', tagId: 'aquarium-vacation-wafer',
  servuoClass: 'VacationWafer', kind: 'aquarium-vacation-wafer', weight: 1,
});
functional({
  id: 0x0DC8, name: 'Aquarium Fishing Net', tagId: 'aquarium-fishing-net',
  labelNumber: 1074463, script: 'aquarium-fishing-net',
  servuoClass: 'AquariumFishingNet',
  servuoClasses: ['AquariumFishingNet', 'AquariumFishNet', 'SpecialFishingNet'],
  kind: 'fishing-net', weight: 1, movable: true,
});
const AQUARIUM_REWARDS = [
  ['aquarium-fish-bones', 'FishBones', 'Fish Bones', 0x3B0C, {}],
  ['aquarium-waterlogged-boots', 'WaterloggedBoots', 'Waterlogged Boots', 0x1711, { clothing: true, equipLayer: 3, slot: 'shoes' }],
  ['captain-blackhearts-fishing-pole', 'CaptainBlackheartsFishingPole', "Captain Blackheart's Fishing Pole", 0x0DC0, { labelNumber: 1074571, script: 'fishing-pole', kind: 'tool' }],
  ['craftys-fishing-hat', 'CraftysFishingHat', "Crafty's Fishing Hat", 0x1713, { clothing: true, equipLayer: 6, slot: 'hat' }],
  ['aquarium-message', 'AquariumMessage', 'Message in a Bottle', 0x099F, { labelNumber: 1073894 }],
  ['aquarium-island-statue', 'IslandStatue', 'Island Statue', 0x3B0F, {}],
  ['aquarium-shell', 'Shell', 'A Shell', 0x3B12, { labelNumber: 1074598 }],
  ['aquarium-toy-boat', 'ToyBoat', 'Toy Boat', 0x14F4, {}],
];
for (const [tagId, servuoClass, name, id, extra] of AQUARIUM_REWARDS) {
  functional({
    id, name, tagId, servuoClass,
    servuoClasses: [servuoClass],
    kind: extra.kind ?? 'aquarium-decoration',
    aquariumDecoration: true,
    weight: 1,
    movable: true,
    ...extra,
  });
}
const AQUARIUM_FISH = [
  ['minoc-blue-fish', 'MinocBlueFish', 'Minoc Blue Fish', 0x3AFE],
  ['albino-courtesan-fish', 'AlbinoCourtesanFish', 'Albino Courtesan Fish', 0x3B04],
  ['nujelm-honey-fish', 'NujelmHoneyFish', 'Nujelm Honey Fish', 0x3B06],
  ['spotted-buccaneer', 'SpottedBuccaneer', 'Spotted Buccaneer', 0x3B09],
  ['vesper-reef-tiger', 'VesperReefTiger', 'Vesper Reef Tiger', 0x3B08],
  ['yellow-fin-bluebelly', 'YellowFinBluebelly', 'Yellow Fin Bluebelly', 0x3B07],
  ['spined-scratcher-fish', 'SpinedScratcherFish', 'Spined Scratcher Fish', 0x3B05],
  ['small-mouth-sucker-fin', 'SmallMouthSuckerFin', 'Small Mouth Sucker Fin', 0x3B01],
  ['golden-broadtail', 'GoldenBroadtail', 'Golden Broadtail', 0x3B03],
  ['fandancer-fish', 'FandancerFish', 'Fandancer Fish', 0x3B02],
  ['red-dart-fish', 'RedDartFish', 'Red Dart Fish', 0x3B00],
  ['britain-crown-fish', 'BritainCrownFish', 'Britain Crown Fish', 0x3AFF],
  ['killer-frog', 'KillerFrog', 'Killer Frog', 0x3B0D],
  ['purple-frog', 'PurpleFrog', 'Purple Frog', 0x3B0D],
  ['albino-frog', 'AlbinoFrog', 'Albino Frog', 0x3B0D],
  ['jellyfish', 'Jellyfish', 'Jellyfish', 0x3B0E],
  ['shrimp', 'Shrimp', 'Shrimp', 0x3B14],
  ['long-claw-crab', 'LongClawCrab', 'Long Claw Crab', 0x3AFC],
  ['speckled-crab', 'SpeckledCrab', 'Speckled Crab', 0x3AFC],
  ['sea-horse-fish', 'SeaHorseFish', 'Sea Horse', 0x3B10],
  ['brine-shrimp', 'BrineShrimp', 'Brine Shrimp', 0x3B11],
  ['full-moon-fish', 'FullMoonFish', 'Full Moon Fish', 0x3B15],
  ['coral', 'Coral', 'Coral', 0x3AF9],
  ['stripped-flake-fish', 'StrippedFlakeFish', 'Stripped Flake Fish', 0x3B0A],
  ['stripped-sosarian-swill', 'StrippedSosarianSwill', 'Stripped Sosarian Swill', 0x3B0A],
];
for (const [tagId, servuoClass, name, id] of AQUARIUM_FISH) {
  functional({
    id, name, tagId, servuoClass, servuoBaseClass: 'BaseFish',
    kind: 'aquarium-fish', aquariumFish: true, fishKind: tagId,
    weight: 1, movable: true,
  });
}

// ---- Additional traps (ServUO 9 dedicated trap types) ----------------
const TRAPS = [
  ['Flame Spurt Trap', 0x3979, 'flame-spurt', 'fire'],
  ['Fire Column Trap', 0x3996, 'fire-column', 'fire'],
  ['Goblin Floor Trap',0x33F1, 'goblin-floor','phys'],
  ['Mushroom Trap',    0x39B2, 'mushroom',    'poison'],
  ['Saw Trap',         0x10D2, 'saw',         'phys'],
  ['Spike Trap',       0x10F4, 'spike',       'phys'],
  ['Giant Spike Trap', 0x10F5, 'giant-spike', 'phys'],
  ['Stone Face Trap',  0x108D, 'stone-face',  'energy'],
  ['Gas Trap',         0x10A4, 'gas',         'poison'],
];
for (const [name, id, tag, dmgType] of TRAPS) {
  functional({
    id, name, tagId: `trap-${tag}`, script: 'world-trap',
    weight: 0, movable: false, immobile: true,
    trap: { kind: tag, dmgType, dmg: [10, 20], rearmMs: 4_000 },
  });
}

// ---- Ankhs (ServUO Ankhs.cs / DespiseAnkh.cs) ------------------------
functional({ id: 0x0003, name: 'Ankh',         tagId: 'ankh',         script: 'shrine', weight: 50, movable: false });
functional({ id: 0x0004, name: 'Despise Ankh', tagId: 'despise-ankh', script: 'despise-ankh', weight: 50, movable: false });

// ---- Decoration addons (ServUO Items/Addons/) -----------------------
// House-placeable cosmetics. All immovable, weight 50 — placement is
// gated by `[house place` deeds rather than per-item check, so the
// definitions just register the catalogue.

// Fountains.
functional({ id: 0x0E2E, name: 'Small Fountain',     tagId: 'fountain-small',  weight: 50, movable: false });
functional({ id: 0x0E30, name: 'Large Fountain',     tagId: 'fountain-large',  weight: 50, movable: false });
functional({ id: 0x153A, name: 'Wall Fountain',      tagId: 'fountain-wall',   weight: 50, movable: false });
functional({ id: 0x153B, name: 'Stone Fountain',     tagId: 'fountain-stone',  weight: 50, movable: false });
functional({ id: 0x153C, name: 'Marble Fountain',    tagId: 'fountain-marble', weight: 50, movable: false });

// Ovens (variants — kitchen / bakery / brick).
functional({ id: 0x0939, name: 'Stone Oven',         tagId: 'oven-stone',  weight: 80, movable: false, craftingStation: 'oven' });
functional({ id: 0x093A, name: 'Bakery Oven',        tagId: 'oven-bakery', weight: 80, movable: false, craftingStation: 'oven' });
functional({ id: 0x09A3, name: 'Brick Oven',         tagId: 'oven-brick',  weight: 80, movable: false, craftingStation: 'oven' });

// Mortar & Pestle stations (alchemy decorative — different from carry).
functional({ id: 0x1843, name: 'Alchemy Bench',      tagId: 'alchemy-bench',  weight: 60, movable: false, craftingStation: 'alchemy' });
functional({ id: 0x182C, name: 'Apothecary Cabinet', tagId: 'apothecary',     weight: 50, movable: false });

// Weapon racks.
functional({ id: 0x1840, name: 'Weapon Rack',        tagId: 'weapon-rack',    weight: 50, movable: false });
functional({ id: 0x1841, name: 'Sword Rack',         tagId: 'sword-rack',     weight: 50, movable: false });
functional({ id: 0x1842, name: 'Bow Rack',           tagId: 'bow-rack',       weight: 50, movable: false });

// Armor displays / mannequin variants (separate from the playable
// Mannequin item-script — these are pure cosmetics with no pose state).
functional({ id: 0x1581, name: 'Armor Display Stand',     tagId: 'armor-stand',     weight: 60, movable: false });
functional({ id: 0x1583, name: 'Helm Display Stand',      tagId: 'helm-stand',      weight: 30, movable: false });
functional({ id: 0x1584, name: 'Plate Armor Display',     tagId: 'plate-display',   weight: 100, movable: false });

// Garden/decorative.
functional({ id: 0x0CB3, name: 'Stone Bench',        tagId: 'bench-stone',  weight: 80, movable: false });
functional({ id: 0x0CB4, name: 'Wooden Bench',       tagId: 'bench-wood',   weight: 30, movable: false });
functional({ id: 0x1F0E, name: 'Marble Statue',      tagId: 'statue-marble', weight: 150, movable: false });
functional({ id: 0x1F0F, name: 'Bronze Statue',      tagId: 'statue-bronze', weight: 150, movable: false });
functional({ id: 0x1216, name: 'Abbatoir',           tagId: 'abbatoir', script: 'abattoir-block', weight: 150, movable: false });
functional({ id: 0x14F0, name: 'Abbatoir Deed',      tagId: 'abbatoir-deed', script: 'addon-deed', weight: 1, addonName: 'abbatoir' });

// Lighting decorations.
functional({ id: 0x0B26, name: 'Tall Candelabra',    tagId: 'candelabra-tall',  weight: 30, movable: false, lit: false, hue: 0 });
functional({ id: 0x0B1A, name: 'Standing Candelabra', tagId: 'candelabra-stand', weight: 30, movable: false, lit: false, hue: 0 });

// ---- Dye Tubs (ServUO Items/Resource/*DyeTub.cs) --------------------
// 20 variants matching the canonical ServUO catalogue. Each tub
// carries its hue palette in `dyeHues`; the [dye command pulls a
// random hue from the array when no explicit hue is passed.

const STD_PALETTE = [0x59, 0x5A, 0x4E, 0x9F, 0xA2, 0xAB, 0xB4, 0xBD, 0xC6, 0xCF];
functional({ id: 0x0FAB, script: 'dye-tub', name: 'Dye Tub',                  tagId: 'dye-tub-standard', weight: 5, movable: true, dyeHues: STD_PALETTE });
functional({ id: 0x0FAB, script: 'dye-tub', name: 'Black Dye Tub',            tagId: 'dye-tub-black',    weight: 5, movable: true, dyeHues: [0x0001] });
functional({ id: 0x0FAB, script: 'dye-tub', name: 'Furniture Dye Tub',        tagId: 'dye-tub-furniture',weight: 5, movable: true, dyeHues: [...STD_PALETTE, 0x047D, 0x048D] });
functional({ id: 0x0FAB, script: 'dye-tub', name: 'Special Dye Tub',          tagId: 'dye-tub-special',  weight: 5, movable: true, dyeHues: [0x0021, 0x0034, 0x0043, 0x0058, 0x006D, 0x0083, 0x0096] });
functional({ id: 0x0FAB, script: 'dye-tub', name: 'Leather Dye Tub',          tagId: 'dye-tub-leather',  weight: 5, movable: true, dyeHues: [0x008B, 0x0186, 0x0286, 0x0386, 0x0486, 0x0586] });
functional({ id: 0x0FAB, script: 'dye-tub', name: 'Statuette Dye Tub',        tagId: 'dye-tub-statuette',weight: 5, movable: true, dyeHues: [0x0832, 0x0834, 0x0836, 0x0838, 0x083A] });
functional({ id: 0x0FAB, script: 'dye-tub', name: 'Reward Dye Tub',           tagId: 'dye-tub-reward',   weight: 5, movable: true, dyeHues: [0x047D, 0x048D, 0x049D, 0x04AD] });
functional({ id: 0x0FAB, script: 'dye-tub', name: 'Metallic Dye Tub',         tagId: 'dye-tub-metallic', weight: 5, movable: true, dyeHues: [0x047E, 0x047F, 0x0480, 0x0481] });
functional({ id: 0x0FAB, script: 'dye-tub', name: 'Heritage Dye Tub',         tagId: 'dye-tub-heritage', weight: 5, movable: true, dyeHues: [0x04F5, 0x04F6, 0x04F7] });
functional({ id: 0x0FAB, script: 'dye-tub', name: 'Pigments of Tokuno',       tagId: 'dye-tub-tokuno',   weight: 5, movable: true, dyeHues: [0x0537, 0x0538, 0x0539, 0x053A, 0x053B] });
functional({ id: 0x0FAB, script: 'dye-tub', name: 'Natural Dye Tub',          tagId: 'dye-tub-natural',  weight: 5, movable: true, dyeHues: [0x017F, 0x025F, 0x0297, 0x031D, 0x03A5] });
functional({ id: 0x0FAB, script: 'dye-tub', name: 'Runic Dye Tub',            tagId: 'dye-tub-runic',    weight: 5, movable: true, dyeHues: [0x0A82, 0x0A84, 0x0A86, 0x0A88] });
functional({ id: 0x0FAB, script: 'dye-tub', name: 'Holiday Dye Tub',          tagId: 'dye-tub-holiday',  weight: 5, movable: true, dyeHues: [0x0021, 0x0058, 0x0042, 0x0044] });
functional({ id: 0x0FAB, script: 'dye-tub', name: 'Anniversary Dye Tub',      tagId: 'dye-tub-anniv',    weight: 5, movable: true, dyeHues: [0x047A, 0x047B, 0x047C, 0x047D] });
functional({ id: 0x0FAB, script: 'dye-tub', name: 'Plant Pigment Tub',        tagId: 'dye-tub-plant',    weight: 5, movable: true, dyeHues: [0x0011, 0x0017, 0x002A, 0x004A, 0x0066] });
functional({ id: 0x0FAB, script: 'dye-tub', name: 'Gargoyle Dye Tub',         tagId: 'dye-tub-gargoyle', weight: 5, movable: true, dyeHues: [0x08AF, 0x08B0, 0x08B1] });
functional({ id: 0x0FAB, script: 'dye-tub', name: 'Elven Dye Tub',            tagId: 'dye-tub-elven',    weight: 5, movable: true, dyeHues: [0x05DC, 0x05DD, 0x05DE, 0x05DF] });
functional({ id: 0x0FAB, script: 'dye-tub', name: 'Shadow Dye Tub',           tagId: 'dye-tub-shadow',   weight: 5, movable: true, dyeHues: [0x0001, 0x0455, 0x0966] });
functional({ id: 0x0FAB, script: 'dye-tub', name: 'Faction Dye Tub',          tagId: 'dye-tub-faction',  weight: 5, movable: true, dyeHues: [0x0026, 0x0023, 0x0030, 0x0033] });
functional({ id: 0x0FAB, script: 'dye-tub', name: 'Royal Dye Tub',            tagId: 'dye-tub-royal',    weight: 5, movable: true, dyeHues: [0x0507, 0x0508, 0x0509, 0x050A] });

// Library / collector pieces.
functional({ id: 0x0FC1, name: 'Globe',              tagId: 'globe',         weight: 25, movable: false });
functional({ id: 0x0EB1, name: 'Music Stand',        tagId: 'music-stand',   weight: 30, movable: false });
functional({ id: 0x0A98, name: 'Bookcase Tall',      tagId: 'bookcase-tall', weight: 80, movable: false });
functional({ id: 0x0A99, name: 'Bookcase Wide',      tagId: 'bookcase-wide', weight: 80, movable: false });

// ---- ViceVsVirtue rewards (ServUO Engines/VvV/Items/) ----------------
// 10 canonical items players unlock via VvV silver. Awarded via
// `[vvv claim <itemTag>` (rewards command checks the player's
// VvV silver balance + side flag). Items themselves are passive
// trophies / utility decorations.

functional({ id: 0x4216, name: 'Crimson Cincture',             tagId: 'vvv-crimson-cincture',     weight: 3, movable: true, vvvCost: 8000 });
functional({ id: 0x098C, name: 'VvV Britannia Banner',         tagId: 'vvv-banner-britannia',     weight: 30, movable: false, vvvCost: 6000 });
functional({ id: 0x098D, name: 'VvV Minax Banner',             tagId: 'vvv-banner-minax',         weight: 30, movable: false, vvvCost: 6000 });
functional({ id: 0x098E, name: 'VvV Shadowlords Banner',       tagId: 'vvv-banner-shadowlords',   weight: 30, movable: false, vvvCost: 6000 });
functional({ id: 0x098F, name: 'VvV Council of Mages Banner',  tagId: 'vvv-banner-council',       weight: 30, movable: false, vvvCost: 6000 });
functional({ id: 0x14F0, name: 'VvV Trap Kit',                 tagId: 'vvv-trap-kit',             weight: 5,  movable: true, vvvCost: 4000 });
functional({ id: 0x14F0, name: 'VvV Vendor Search Deed',       tagId: 'vvv-vendor-search-deed',   weight: 1,  movable: true, vvvCost: 5000 });
functional({ id: 0x09A0, name: 'VvV Battle Standard',          tagId: 'vvv-battle-standard',      weight: 80, movable: false, vvvCost: 12000 });
functional({ id: 0x4CBD, name: 'VvV Brazier of Battle',        tagId: 'vvv-brazier',              weight: 50, movable: false, vvvCost: 7000 });
functional({ id: 0x40A0, name: 'VvV Silver Net',               tagId: 'vvv-silver-net',           weight: 4,  movable: true, vvvCost: 3500 });

// Faza F.3.13 — VvV reward catalog expansion (ServUO `Engines/VvV/Items/`).
// 20 additional reward items covering trophies, cosmetics, war kits,
// and rare consumables.
functional({ id: 0x14EF, name: 'VvV Hooded Robe (Virtue)',     tagId: 'vvv-robe-virtue',           weight: 4,  movable: true, vvvCost: 5500, hue: 0x0481 });
functional({ id: 0x14EF, name: 'VvV Hooded Robe (Vice)',       tagId: 'vvv-robe-vice',             weight: 4,  movable: true, vvvCost: 5500, hue: 0x0026 });
functional({ id: 0x1F03, name: 'VvV Skull Trophy',             tagId: 'vvv-skull-trophy',          weight: 3,  movable: false, vvvCost: 8000 });
functional({ id: 0x1F0A, name: 'VvV Marshal Cape',             tagId: 'vvv-marshal-cape',          weight: 2,  movable: true, vvvCost: 7500 });
functional({ id: 0x2FC4, name: 'VvV Heraldic Tabard',          tagId: 'vvv-heraldic-tabard',       weight: 3,  movable: true, vvvCost: 6500 });
functional({ id: 0x152F, name: 'VvV Crystal Globe of Power',   tagId: 'vvv-crystal-globe',         weight: 2,  movable: true, vvvCost: 9000 });
functional({ id: 0x14F0, name: 'VvV Battle Field Reward Bag',  tagId: 'vvv-reward-bag',            weight: 2,  movable: true, vvvCost: 0 });
functional({ id: 0x9A14, name: 'VvV Castle Stronghold Deed',   tagId: 'vvv-stronghold-deed',       weight: 1,  movable: true, vvvCost: 30000 });
functional({ id: 0x2DB7, name: 'VvV Crystal Lockdown',         tagId: 'vvv-crystal-lockdown',      weight: 5,  movable: true, vvvCost: 11000 });
functional({ id: 0x4C12, name: 'VvV War Horse Token',          tagId: 'vvv-war-horse-token',       weight: 1,  movable: true, vvvCost: 14000 });
functional({ id: 0x1413, name: 'VvV Sigil of Honor (Aegis)',   tagId: 'vvv-sigil-aegis',           weight: 2,  movable: false, vvvCost: 10000 });
functional({ id: 0x1413, name: 'VvV Sigil of Honor (Vile)',    tagId: 'vvv-sigil-vile',            weight: 2,  movable: false, vvvCost: 10000 });
functional({ id: 0x3140, name: 'VvV Power Potion (Greater)',   tagId: 'vvv-power-potion-g',        weight: 1,  movable: true, vvvCost: 2500, charges: 5 });
functional({ id: 0x3140, name: 'VvV Cure-All Potion',          tagId: 'vvv-cure-all-potion',       weight: 1,  movable: true, vvvCost: 2000, charges: 5 });
functional({ id: 0x3140, name: 'VvV Invisibility Potion',      tagId: 'vvv-invis-potion',          weight: 1,  movable: true, vvvCost: 3000, charges: 3 });
functional({ id: 0x09C0, name: 'VvV Battle Trumpet',           tagId: 'vvv-battle-trumpet',        weight: 2,  movable: true, vvvCost: 4500 });
functional({ id: 0x1411, name: 'VvV Pulvereus Defender Shield',tagId: 'vvv-defender-shield',       weight: 8,  movable: true, vvvCost: 13000 });
functional({ id: 0x13E3, name: 'VvV Conqueror Helm',           tagId: 'vvv-conqueror-helm',        weight: 5,  movable: true, vvvCost: 9500 });
functional({ id: 0x2249, name: 'VvV Throne of Victory',        tagId: 'vvv-throne-of-victory',     weight: 60, movable: false, vvvCost: 18000 });
functional({ id: 0x4255, name: 'VvV Royal Standard',           tagId: 'vvv-royal-standard',        weight: 25, movable: false, vvvCost: 9000 });

// ---- ServUO P1 quest/decorative mechanics ---------------------------
functional({ id: 0x3BBA, hue: 2711, name: 'Spiked Egg Nog', tagId: 'spiked-egg-nog', script: 'spiked-eggnog', weight: 1, lockedDown: true, servuoClass: 'SpikedEggNog', servuoClasses: ['SpikedEggNog', 'BleedTimer'] });
functional({ id: 0x122F, hue: 0x481, name: 'Icy Patch', tagId: 'icy-patch', script: 'icy-patch', weight: 5, movable: false, servuoClass: 'IcyPatch', servuoClasses: ['IcyPatch'] });
functional({ id: 0x227A, hue: 0x44E, name: 'Calling of Kronus', tagId: 'calling-of-kronus', script: 'kronus-scroll', weight: 1, questItem: true, servuoClass: 'KronusScroll', servuoClasses: ['KronusScroll', 'CallingTimer', 'SummonedPaladin'] });
functional({ id: 0x1EA7, hue: 0x497, name: 'a section of an obsidian statue', tagId: 'obsidian-statue-section', script: 'obsidian-statue', weight: 1, questItem: true, obsidianQuantity: 1, servuoClass: 'Obsidian', servuoClasses: ['Obsidian', 'DisassembleEntry'] });
functional({ id: 0x2206, name: 'Shimmering Crystals', tagId: 'shimmering-crystals', script: 'shimmering-crystals', weight: 1, questItem: true, servuoClass: 'ShimmeringCrystals', servuoClasses: ['ShimmeringCrystals'] });
functional({ id: 0x1C2B, name: 'Maabus Coffin', tagId: 'maabus-coffin', script: 'maabus-coffin', weight: 200, movable: false, servuoClass: 'MaabusCoffin', servuoClasses: ['MaabusCoffin', 'MaabusCoffinComponent', 'Maabus'] });
functional({ id: 0x0866, name: 'Secret Wall', tagId: 'quest-secret-wall', script: 'secret-wall', weight: 100, movable: false, secretWallLocked: true, secretWallActive: true, servuoClass: 'SecretWall', servuoClasses: ['SecretWall'] });
functional({ id: 0x108F, name: 'Secret Switch', tagId: 'quest-secret-switch', script: 'secret-switch', weight: 10, movable: false, servuoClass: 'SecretSwitch', servuoClasses: ['SecretSwitch', 'SecretWall'] });
functional({ id: 0x09CC, hue: 643, name: 'Mud Puppy', tagId: 'mud-puppy', weight: 1, _trophyWeight: 30, servuoClass: 'MudPuppy', servuoClasses: ['MudPuppy', 'BigFish'] });
functional({ id: 0x09CC, hue: 337, name: 'Red Herring', tagId: 'red-herring', weight: 1, _trophyWeight: 30, servuoClass: 'RedHerring', servuoClasses: ['RedHerring', 'BigFish', 'BritainCrownFish'] });
functional({ id: 0xA4E7, name: 'Pet Whistle', tagId: 'pet-whistle', script: 'pet-whistle', weight: 1, blessed: true, servuoClass: 'PetWhistle', servuoClasses: ['PetWhistle', 'PetWhistleGump', 'LinkBondedPetEntry'] });
functional({ id: 0x2AF9, name: "Dawn's Music Box", tagId: 'dawns-music-box-reward',
  script: 'music-box', weight: 1, secureLevel: 'coOwners', musicDurationMs: 120000,
  musicTracks: [0x3D, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47],
  flipIds: [0x2AF9, 0x2AFD], servuoClass: 'DawnsMusicBox',
  servuoClasses: ['DawnsMusicBox', 'PlayingTimer', 'MusicGump', 'TrackInfo', 'TrackRarity', 'StopMusic', 'FlipableAttribute'] });
functional({ id: 6663, name: 'chains of the tormented', tagId: 'tormented-chains',
  script: 'tormented-chains', weight: 1, servuoClass: 'TormentedChains', servuoClasses: ['TormentedChains'] });
functional({ id: 0x9707, name: 'Secret Chest', tagId: 'secret-chest',
  kind: 'container', container: true, gumpId: 0x058E, capacity: 125, maxWeight: 400,
  script: 'secret-chest', weight: 10, locked: true, flipIds: [0x9707, 0x9706],
  servuoClass: 'SecretChest', servuoClasses: ['SecretChest', 'SecretChestArray', 'SecretChestGump', 'SetEditKeyNumber', 'ResetKeyNumber'] });

// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('functional: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('functional: ' + e.message); } }
  api.log?.('functional: registered ' + count + ' items');
  return () => {};
}
