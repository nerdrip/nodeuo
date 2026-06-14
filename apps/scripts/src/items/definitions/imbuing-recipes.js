// Imbuing recipe scrolls + special imbuing-related items. Mirrors
// ServUO `Items/Skill Items/Imbuing/`. The actual imbuing engine
// (`apps/scripts/src/commands/imbue.js` + `magic-properties.json`)
// already has full attribute coverage; what was missing were the
// recipe scrolls + key reagents you find at vendor shops / loot.



// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];

function recipe(def) {
  __PENDING__.push({
    kind: 'consumable',
    weight: 1,
    script: 'imbue-recipe-scroll',
    ...def,
  });
}

// =====================================================================
//  IMBUING RESOURCES (loot-tier reagents — extends `resources.js`)
//  Most imbue-recipe scrolls require these as ingredients.
// =====================================================================
function ingredient(def) {
  __PENDING__.push({
    kind: 'resource', weight: 1,
    ...def,
  });
}

const INGREDIENTS = [
  // Essences (drop pool)
  ['MagicalResidue',     0x4288, 'magical residue',  10],
  ['EnchantedEssence',   0x4289, 'enchanted essence', 30],
  ['RelicFragment',      0x428A, 'relic fragment',    100],
  // Specials (per-attribute exotic ingredient)
  ['SeedOfRenewal',      0x5736, 'seed of renewal',         200],
  ['EssenceSingularity', 0x4282, 'essence of singularity',  300],
  ['EssencePrecision',   0x4283, 'essence of precision',    250],
  ['EssenceBalance',     0x4284, 'essence of balance',      275],
  ['EssenceFeeling',     0x4285, 'essence of feeling',      225],
  ['EssenceAchievement', 0x4286, 'essence of achievement',  225],
  ['EssenceDirection',   0x4287, 'essence of direction',    200],
  ['EssencePassion',     0x428B, 'essence of passion',      200],
  ['EssenceOrder',       0x428C, 'essence of order',        200],
  ['EssenceControl',     0x428D, 'essence of control',      200],
  ['EssenceDiligence',   0x428E, 'essence of diligence',    200],
  ['EssencePersistence', 0x428F, 'essence of persistence',  200],
  // Crystal / mineral ingredients
  ['Crystalline',        0x573D, 'crystalline blackrock',   400],
  ['CrystalShards',      0x573C, 'crystal shards',          50],
  ['LuminescentFungi',   0x573E, 'luminescent fungi',       80],
  ['ParasiticPlant',     0x573F, 'parasitic plant',         100],
  // Slayer / dragon byproducts
  ['CapturedEssence',    0x5740, 'captured essence',        500],
  ['ChagaMushroom',      0x5741, 'chaga mushroom',          120],
  ['LavaSerpentCrust',   0x5742, 'lava serpent crust',      150],
];
for (const [name, itemId, label, value] of INGREDIENTS) {
  ingredient({
    id: itemId, name: label, tagId: name,
    imbuingMagic: true, value,
  });
}

// =====================================================================
//  IMBUING RECIPE SCROLLS — drop from rare mobs / quest rewards
//  Using the scroll teaches a permanent recipe (per-account flag).
// =====================================================================
const RECIPE_SCROLLS = [
  ['recipe-glasses-of-the-arts',           'Glasses of the Arts recipe',     400],
  ['recipe-folded-steel-glasses',          'Folded Steel Glasses recipe',    400],
  ['recipe-mage-glasses',                  'Mage Glasses recipe',            400],
  ['recipe-crystalline-ring',              'Crystalline Ring recipe',        500],
  ['recipe-resilient-bracer',              'Resilient Bracer recipe',        500],
  ['recipe-stormgrip',                     'Stormgrip recipe',               700],
  ['recipe-tangle',                        'Tangle recipe',                  700],
  ['recipe-luna-lance',                    'Luna Lance recipe',              700],
  ['recipe-soul-seeker',                   'Soul Seeker recipe',             800],
  ['recipe-quiver-of-rage',                'Quiver of Rage recipe',          750],
  ['recipe-quiver-of-elements',            'Quiver of Elements recipe',      750],
  ['recipe-quiver-of-infinity',            'Quiver of Infinity recipe',      900],
  ['recipe-bracelet-of-binding',           'Bracelet of Binding recipe',     650],
  ['recipe-greater-bracelet-of-binding',   'Greater Bracelet of Binding recipe', 1000],
  ['recipe-jade-armband',                  'Jade Armband recipe',            500],
  ['recipe-leggings-of-bane',              'Leggings of Bane recipe',        700],
  ['recipe-petrified-snake',               'Petrified Snake recipe',         600],
  ['recipe-shroud-of-deceit',              'Shroud of Deceit recipe',        700],
  ['recipe-talisman-of-protection',        'Talisman of Protection recipe',  600],
  ['recipe-greymist-leggings',             'Greymist Leggings recipe',       650],
  ['recipe-broken-crystals-collection',    'Broken Crystals Collection recipe', 500],
  ['recipe-evil-orc-helm',                 'Evil Orc Helm recipe',           400],
  ['recipe-ranger-armor',                  'Ranger Armor recipe',            550],
  ['recipe-paladin-armor',                 'Paladin Armor recipe',           550],
  ['recipe-totem-of-the-tribe',            'Totem of the Tribe recipe',      500],
  ['recipe-staff-of-pyros',                'Staff of Pyros recipe',          750],
  ['recipe-glacial-staff',                 'Glacial Staff recipe',           700],
  ['recipe-leurocians-mempo',              "Leurocian's Mempo recipe",       800],
  ['recipe-belt-of-the-magi',              'Belt of the Magi recipe',        700],
  ['recipe-orc-chieftain-helm',            'Orc Chieftain Helm recipe',      500],
  ['recipe-shaman-rattle',                 'Shaman Rattle recipe',           400],
  ['recipe-ornate-crown-of-the-harrower',  'Ornate Crown of the Harrower recipe', 1500],
];
for (const [tag, name, value] of RECIPE_SCROLLS) {
  recipe({
    id: 0x14F0, tagId: tag, name,
    hue: 0x47E,
    recipeUnlock: tag,
    value,
  });
}

// =====================================================================
//  SOULFORGE — special crafting station for Imbuing
// =====================================================================
__PENDING__.push({
  id: 0x4277, kind: 'functional',
  name: 'Soulforge', tagId: 'soulforge',
  craftingStation: 'soulforge', script: 'soulforge',
  weight: 500, movable: false,
});
__PENDING__.push({
  id: 0x4278, kind: 'functional',
  name: 'Cathedral Soulforge', tagId: 'cathedral-soulforge',
  craftingStation: 'soulforge', script: 'soulforge',
  weight: 500, movable: false, special: true,
});


// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('imbuing-recipes: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('imbuing-recipes: ' + e.message); } }
  api.log?.('imbuing-recipes: registered ' + count + ' items');
  return () => {};
}