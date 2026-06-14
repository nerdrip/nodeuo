// Quest item fluff catalog — bulk-registered one-off drops referenced
// by the many ServUO `Items/Quest/` entries. Each is a flavor item:
// no mechanics, just shows up in quest-reward containers / NPC give
// dialogs / fetch-quest objective targets.
//
// Organized by the chain that requests them so adding new chains can
// reference these tagIds directly in `quest-chains.json`.

const __PENDING__ = [];

function ql(def) {
  // ql = quest-loot — sensible defaults for quest fluff.
  __PENDING__.push({
    kind: 'quest-item',
    category: 'quest-fluff',
    weight: 1,
    layer: 0,
    movable: true,
    questItem: true,
    ...def,
  });
}

// =====================================================================
//  HAVEN STARTERS (Uzeraan's Turmoil, Witch Apprentice etc.) — 18
// =====================================================================
ql({ tagId: 'q-uzeraans-knowledge-tome',  itemId: 0x0FBE, hue: 0x4F4, name: "Uzeraan's Knowledge Tome" });
ql({ tagId: 'q-uzeraans-letter',          itemId: 0x14F0, hue: 0x47C, name: "Uzeraan's Letter" });
ql({ tagId: 'q-corrupted-crystal',        itemId: 0x4079, hue: 0x489, name: 'Corrupted Crystal' });
ql({ tagId: 'q-holy-water-flask',         itemId: 0x183C, hue: 0x47F, name: 'Holy Water Flask' });
ql({ tagId: 'q-haven-charter',            itemId: 0x14F0, hue: 0x481, name: 'Haven Charter' });
ql({ tagId: 'q-witch-apprentice-scroll',  itemId: 0x1F4D, hue: 0x4F2, name: "Witch's Apprentice Scroll" });
ql({ tagId: 'q-witch-broom',              itemId: 0x0F62, hue: 0x44E, name: 'Witch Broom' });
ql({ tagId: 'q-witch-eye-of-newt',        itemId: 0x09B5, hue: 0x44, name: 'Eye of Newt' });
ql({ tagId: 'q-witch-wolfbane-sprig',     itemId: 0x0CAE, hue: 0x44, name: 'Wolfbane Sprig' });
ql({ tagId: 'q-witch-amber-ring',         itemId: 0x108A, hue: 0x4F4, name: 'Amber Witch Ring' });
ql({ tagId: 'q-minor-magic-scroll-bag',   itemId: 0x0E76, hue: 0x481, name: 'Minor Magic Scroll Bag' });
ql({ tagId: 'q-minor-healing-bag',        itemId: 0x0E76, hue: 0x44, name: 'Minor Healing Bag' });
ql({ tagId: 'q-bandaged-letter',          itemId: 0x14F0, hue: 0x044, name: 'Bandaged Letter' });
ql({ tagId: 'q-sealed-envelope-haven',    itemId: 0x14F0, hue: 0x4F8, name: 'Sealed Haven Envelope' });
ql({ tagId: 'q-rusted-ration-tin',        itemId: 0x103C, hue: 0x44, name: 'Rusted Ration Tin' });
ql({ tagId: 'q-vesper-courier-pouch',     itemId: 0x0E76, hue: 0x4F2, name: 'Vesper Courier Pouch' });
ql({ tagId: 'q-haven-guard-badge',        itemId: 0x14F0, hue: 0x47D, name: 'Haven Guard Badge' });
ql({ tagId: 'q-novice-spellbook-page',    itemId: 0x1F4D, hue: 0x481, name: 'Novice Spellbook Page' });

// =====================================================================
//  ML BARD/SOLEN/HEARTWOOD (Bard Mastery, Solen Queen) — 22
// =====================================================================
ql({ tagId: 'q-bard-master-token',        itemId: 0x14F0, hue: 0x44, name: 'Bard Mastery Token' });
ql({ tagId: 'q-bard-tuning-fork',         itemId: 0x1054, hue: 0x47C, name: 'Bard Tuning Fork' });
ql({ tagId: 'q-bard-master-sigil',        itemId: 0x14F0, hue: 0x4F4, name: 'Bard Master Sigil' });
ql({ tagId: 'q-velindes-cloak',           itemId: 0x230E, hue: 0x47F, name: "Velinde's Cloak" });
ql({ tagId: 'q-sir-berran-medal',         itemId: 0x14F0, hue: 0x47D, name: 'Sir Berran Medal' });
ql({ tagId: 'q-felean-ledger',            itemId: 0x0FBE, hue: 0x488, name: 'Felean Ledger' });
ql({ tagId: 'q-hareus-charm',             itemId: 0x108A, hue: 0x489, name: "Hareus' Charm" });
ql({ tagId: 'q-solen-queen-letter',       itemId: 0x14F0, hue: 0x47E, name: "Solen Queen's Letter" });
ql({ tagId: 'q-pheromones-vial',          itemId: 0x183C, hue: 0x44, name: 'Pheromones Vial' });
ql({ tagId: 'q-solen-egg-fragment',       itemId: 0x09B5, hue: 0x47F, name: 'Solen Egg Fragment' });
ql({ tagId: 'q-fertile-zoogi-dirt',       itemId: 0x09B5, hue: 0x44, name: 'Fertile Zoogi Dirt' });
ql({ tagId: 'q-naturalist-tome',          itemId: 0x0FBE, hue: 0x481, name: 'Naturalist Tome' });
ql({ tagId: 'q-naturalists-ribbon',       itemId: 0x14F0, hue: 0x044, name: "Naturalist's Ribbon" });
ql({ tagId: 'q-ranger-cloak',             itemId: 0x230E, hue: 0x044, name: 'Ranger Cloak' });
ql({ tagId: 'q-laifem-weavers-shawl',     itemId: 0x230E, hue: 0x484, name: "Laifem's Weaver Shawl" });
ql({ tagId: 'q-treefellow-token',         itemId: 0x14F0, hue: 0x044, name: 'Treefellow Token' });
ql({ tagId: 'q-wisp-feather',             itemId: 0x09B5, hue: 0x489, name: 'Wisp Feather' });
ql({ tagId: 'q-arcane-circle-stone',      itemId: 0x14F0, hue: 0x47F, name: 'Arcane Circle Stone' });
ql({ tagId: 'q-spellweaver-rune',         itemId: 0x14F0, hue: 0x47F, name: 'Spellweaver Rune' });
ql({ tagId: 'q-elven-tome',               itemId: 0x0FBE, hue: 0x44, name: 'Elven Tome' });
ql({ tagId: 'q-elven-keepers-key',        itemId: 0x1010, hue: 0x47F, name: "Elven Keeper's Key" });
ql({ tagId: 'q-elven-mead-vial',          itemId: 0x183C, hue: 0x47F, name: 'Elven Mead Vial' });

// =====================================================================
//  STYGIAN ABYSS / TER MUR (Moug-Guur, Gemkeepers, Marauders) — 22
// =====================================================================
ql({ tagId: 'q-moug-guur-skull',          itemId: 0x1854, hue: 0x47D, name: "Moug-Guur's Skull" });
ql({ tagId: 'q-moug-guur-banner',         itemId: 0x15A8, hue: 0x047, name: 'Moug-Guur Battle Banner' });
ql({ tagId: 'q-marauder-tag',             itemId: 0x14F0, hue: 0x44, name: 'Marauder Identification Tag' });
ql({ tagId: 'q-marauder-helm',            itemId: 0x140E, hue: 0x027, name: 'Marauder Helm' });
ql({ tagId: 'q-gemkeeper-emerald',        itemId: 0x1F13, hue: 0x44, name: 'Gemkeeper Emerald' });
ql({ tagId: 'q-gemkeeper-ruby',           itemId: 0x1F0F, hue: 0x21, name: 'Gemkeeper Ruby' });
ql({ tagId: 'q-gemkeeper-sapphire',       itemId: 0x1F09, hue: 0x489, name: 'Gemkeeper Sapphire' });
ql({ tagId: 'q-gemkeeper-diamond',        itemId: 0x1F1A, hue: 0x47F, name: 'Gemkeeper Diamond' });
ql({ tagId: 'q-gemkeeper-ledger',         itemId: 0x0FBE, hue: 0x44, name: 'Gemkeeper Ledger' });
ql({ tagId: 'q-vernix-talisman',          itemId: 0x2F58, hue: 0x027, name: "Vernix's Talisman" });
ql({ tagId: 'q-vernix-dagger',            itemId: 0x0F51, hue: 0x021, name: "Vernix's Dagger" });
ql({ tagId: 'q-aemaeth-charm',            itemId: 0x108A, hue: 0x47F, name: 'Aemaeth Charm' });
ql({ tagId: 'q-aemaeth-rite-stone',       itemId: 0x14F0, hue: 0x47D, name: 'Aemaeth Rite Stone' });
ql({ tagId: 'q-blighted-grove-vine',      itemId: 0x0CAE, hue: 0x044, name: 'Blighted Grove Vine' });
ql({ tagId: 'q-bog-thing-pelt',           itemId: 0x1078, hue: 0x47, name: 'Bog Thing Pelt' });
ql({ tagId: 'q-covetous-ghost-tear',      itemId: 0x183C, hue: 0x47F, name: 'Covetous Ghost Tear' });
ql({ tagId: 'q-soulforge-primer',         itemId: 0x0FBE, hue: 0x489, name: 'Soulforge Primer' });
ql({ tagId: 'q-soulforge-mastery-tome',   itemId: 0x0FBE, hue: 0x4F4, name: 'Soulforge Mastery Tome' });
ql({ tagId: 'q-soulforge-secrets',        itemId: 0x0FBE, hue: 0x47F, name: 'Soulforge Secrets Tome' });
ql({ tagId: 'q-stygian-pendant',          itemId: 0x108A, hue: 0x489, name: 'Stygian Pendant' });
ql({ tagId: 'q-stygian-key-shard',        itemId: 0x1010, hue: 0x489, name: 'Stygian Key Shard' });
ql({ tagId: 'q-niporailem-fang',          itemId: 0x14F0, hue: 0x047, name: 'Niporailem Fang' });

// =====================================================================
//  TOKUNO / SAMURAI EMPIRE (Haochi's Trials, Tokuno collectibles) — 18
// =====================================================================
ql({ tagId: 'q-haochi-trial-token',       itemId: 0x14F0, hue: 0x44, name: "Haochi's Trial Token" });
ql({ tagId: 'q-haochi-honor-blade',       itemId: 0x13B6, hue: 0x021, name: "Haochi's Honor Blade" });
ql({ tagId: 'q-haochi-tea-cup',           itemId: 0x4083, hue: 0x44, name: "Haochi's Tea Cup" });
ql({ tagId: 'q-haochi-meditation-mat',    itemId: 0x0AA1, hue: 0x47F, name: "Haochi's Meditation Mat" });
ql({ tagId: 'q-yamandon-scale',           itemId: 0x09B5, hue: 0x489, name: 'Yamandon Scale' });
ql({ tagId: 'q-tokuno-pigment-blue',      itemId: 0x4007, hue: 0x489, name: 'Blue Tokuno Pigment' });
ql({ tagId: 'q-tokuno-pigment-red',       itemId: 0x4007, hue: 0x21, name: 'Red Tokuno Pigment' });
ql({ tagId: 'q-tokuno-pigment-gold',      itemId: 0x4007, hue: 0x4F4, name: 'Gold Tokuno Pigment' });
ql({ tagId: 'q-fan-of-the-dragon',        itemId: 0x27EA, hue: 0x4F8, name: 'Fan of the Dragon' });
ql({ tagId: 'q-tokuno-mask-oni',          itemId: 0x4067, hue: 0x21, name: 'Oni Mask' });
ql({ tagId: 'q-tokuno-mask-fox',          itemId: 0x4067, hue: 0x44, name: 'Fox Mask' });
ql({ tagId: 'q-tokuno-bell-shrine',       itemId: 0x2AF9, hue: 0x4F4, name: 'Shrine Bell' });
ql({ tagId: 'q-tokuno-spirit-bracelet',   itemId: 0x1086, hue: 0x489, name: 'Spirit Bracelet' });
ql({ tagId: 'q-tokuno-master-storyteller-tome', itemId: 0x0FBE, hue: 0x47F, name: 'Master Storyteller Tome' });
ql({ tagId: 'q-tokuno-bonsai-shears',     itemId: 0x0F9D, hue: 0x44, name: 'Bonsai Shears' });
ql({ tagId: 'q-tokuno-koi-pond-tile',     itemId: 0x0CB2, hue: 0x489, name: 'Koi Pond Tile' });
ql({ tagId: 'q-ninja-shroud-fragment',    itemId: 0x230E, hue: 0x455, name: 'Ninja Shroud Fragment' });
ql({ tagId: 'q-samurai-honor-scroll',     itemId: 0x1F4D, hue: 0x4F4, name: 'Samurai Honor Scroll' });

// =====================================================================
//  HALLOWEEN / KRAMPUS / VALENTINE / EASTER (seasonal fluff) — 22
// =====================================================================
ql({ tagId: 'q-trick-treat-bag-empty',    itemId: 0x232A, hue: 0x21, name: 'Empty Trick-or-Treat Bag' });
ql({ tagId: 'q-pumpkin-mask',             itemId: 0x4067, hue: 0x47D, name: 'Pumpkin Mask' });
ql({ tagId: 'q-bone-charm-halloween',     itemId: 0x14F0, hue: 0x21, name: 'Halloween Bone Charm' });
ql({ tagId: 'q-naughty-list-scroll',      itemId: 0x1F4D, hue: 0x21, name: 'Naughty List Scroll' });
ql({ tagId: 'q-nice-list-scroll',         itemId: 0x1F4D, hue: 0x44, name: 'Nice List Scroll' });
ql({ tagId: 'q-coal-lump-naughty',        itemId: 0x09B5, hue: 0x000, name: 'Lump of Coal' });
ql({ tagId: 'q-krampus-horn-fragment',    itemId: 0x09B5, hue: 0x21, name: 'Krampus Horn Fragment' });
ql({ tagId: 'q-krampus-festive-bell',     itemId: 0x2AF9, hue: 0x21, name: 'Krampus Festive Bell' });
ql({ tagId: 'q-yule-letter-to-santa',     itemId: 0x14F0, hue: 0x47F, name: 'Letter to Santa' });
ql({ tagId: 'q-yule-elf-cookie',          itemId: 0x09B5, hue: 0x44, name: 'Elf Cookie' });
ql({ tagId: 'q-yule-mistletoe-sprig',     itemId: 0x0CAE, hue: 0x44, name: 'Mistletoe Sprig' });
ql({ tagId: 'q-yule-snowman-charm',       itemId: 0x14F0, hue: 0x481, name: 'Snowman Charm' });
ql({ tagId: 'q-easter-painted-egg',       itemId: 0x09B5, hue: 0x47E, name: 'Painted Egg' });
ql({ tagId: 'q-easter-chocolate-bunny',   itemId: 0x09B5, hue: 0x44, name: 'Chocolate Bunny' });
ql({ tagId: 'q-easter-bunny-trail',       itemId: 0x09B5, hue: 0x47F, name: 'Bunny Trail Marker' });
ql({ tagId: 'q-valentine-rose-bouquet',   itemId: 0x234D, hue: 0x21, name: 'Valentine Rose Bouquet' });
ql({ tagId: 'q-valentine-love-letter',    itemId: 0x14F0, hue: 0x21, name: 'Love Letter' });
ql({ tagId: 'q-valentine-heart-locket',   itemId: 0x108A, hue: 0x21, name: 'Heart Locket' });
ql({ tagId: 'q-anniversary-token',        itemId: 0x14F0, hue: 0x4F4, name: 'Anniversary Token' });
ql({ tagId: 'q-anniversary-cake-slice',   itemId: 0x09B5, hue: 0x47E, name: 'Anniversary Cake Slice' });
ql({ tagId: 'q-anniversary-pin',          itemId: 0x14F0, hue: 0x47F, name: 'Anniversary Lapel Pin' });
ql({ tagId: 'q-anniversary-firework',     itemId: 0x09B5, hue: 0x4F4, name: 'Anniversary Firework' });

// =====================================================================
//  ESCORT / DELIVERY / DIALOG QUESTS (Ortlem, Pepta, Battered Bucket,
//  Honest Beggar, A Little Something, Missing Person, ...) — 24
// =====================================================================
ql({ tagId: 'q-ortlems-message',          itemId: 0x14F0, hue: 0x47F, name: "Ortlem's Message" });
ql({ tagId: 'q-pepta-package',            itemId: 0x0E76, hue: 0x47D, name: "Pepta's Package" });
ql({ tagId: 'q-battered-bucket',          itemId: 0x09B5, hue: 0x44, name: 'Battered Bucket' });
ql({ tagId: 'q-honest-beggar-coin-purse', itemId: 0x0E76, hue: 0x47F, name: "Beggar's Coin Purse" });
ql({ tagId: 'q-honest-beggar-rags',       itemId: 0x1517, hue: 0x47, name: "Beggar's Rags" });
ql({ tagId: 'q-little-something-trinket', itemId: 0x14F0, hue: 0x47E, name: 'A Little Trinket' });
ql({ tagId: 'q-missing-person-locket',    itemId: 0x108A, hue: 0x47, name: 'Missing Person Locket' });
ql({ tagId: 'q-missing-person-portrait',  itemId: 0x0EAC, hue: 0x47C, name: 'Missing Person Portrait' });
ql({ tagId: 'q-tangled-web-thread',       itemId: 0x1779, hue: 0x47F, name: 'Tangled Web Thread' });
ql({ tagId: 'q-tangled-web-clue',         itemId: 0x14F0, hue: 0x21, name: 'Tangled Web Clue' });
ql({ tagId: 'q-friend-of-library-bookmark', itemId: 0x14F0, hue: 0x489, name: 'Library Bookmark' });
ql({ tagId: 'q-friend-of-library-card',   itemId: 0x14F0, hue: 0x47D, name: 'Library Card' });
ql({ tagId: 'q-discipline-trial-token',   itemId: 0x14F0, hue: 0x44, name: 'Discipline Trial Token' });
ql({ tagId: 'q-doughty-warrior-medal',    itemId: 0x14F0, hue: 0x021, name: 'Doughty Warrior Medal' });
ql({ tagId: 'q-ending-the-threat-tag',    itemId: 0x14F0, hue: 0x021, name: 'Threat Slayer Tag' });
ql({ tagId: 'q-evidence-folder',          itemId: 0x0FBE, hue: 0x4F2, name: 'Evidence Folder' });
ql({ tagId: 'q-athenaeum-passage-ticket', itemId: 0x14F0, hue: 0x489, name: 'Athenaeum Passage Ticket' });
ql({ tagId: 'q-bad-company-ledger',       itemId: 0x0FBE, hue: 0x21, name: 'Bad Company Ledger' });
ql({ tagId: 'q-deboor-honor-pin',         itemId: 0x14F0, hue: 0x4F4, name: 'DeBoor Honor Pin' });
ql({ tagId: 'q-ratmen-sanctuary-cloak',   itemId: 0x230E, hue: 0x47, name: 'Sanctuary Rat Cloak' });
ql({ tagId: 'q-summon-fey-rune',          itemId: 0x14F0, hue: 0x489, name: 'Summon Fey Rune' });
ql({ tagId: 'q-summon-fiend-rune',        itemId: 0x14F0, hue: 0x21, name: 'Summon Fiend Rune' });
ql({ tagId: 'q-ancient-world-relic',      itemId: 0x14F0, hue: 0x47F, name: 'Ancient World Relic' });
ql({ tagId: 'q-unfading-memory',          itemId: 0x14F0, hue: 0x47F, name: 'Unfading Memory' });

// =====================================================================
//  HIGH SEAS / EXPLORATION (Profession Bounty, Profession Fisher,
//  SOS messages, Dock Master) — 14
// =====================================================================
ql({ tagId: 'q-bounty-ticket',            itemId: 0x14F0, hue: 0x47, name: 'Bounty Ticket' });
ql({ tagId: 'q-bounty-list',              itemId: 0x14F0, hue: 0x047, name: 'Bounty List' });
ql({ tagId: 'q-captains-spyglass',        itemId: 0x14F6, hue: 0x4F4, name: "Captain's Spyglass" });
ql({ tagId: 'q-fishermans-reel',          itemId: 0x0DBF, hue: 0x44, name: "Fisherman's Reel" });
ql({ tagId: 'q-rare-fish-trophy',         itemId: 0x09CC, hue: 0x489, name: 'Rare Fish Trophy' });
ql({ tagId: 'q-kraken-trophy',            itemId: 0x09B5, hue: 0x489, name: 'Kraken Trophy' });
ql({ tagId: 'q-sos-bottle-corked',        itemId: 0x099F, hue: 0x47F, name: 'Corked SOS Bottle' });
ql({ tagId: 'q-sos-message',              itemId: 0x14F0, hue: 0x47F, name: 'SOS Message' });
ql({ tagId: 'q-treasure-map-shred',       itemId: 0x14EB, hue: 0x47F, name: 'Treasure Map Shred' });
ql({ tagId: 'q-dock-master-token',        itemId: 0x14F0, hue: 0x44, name: 'Dock Master Token' });
ql({ tagId: 'q-pirate-doubloon',          itemId: 0x14F0, hue: 0x4F4, name: 'Pirate Doubloon' });
ql({ tagId: 'q-mariners-locket',          itemId: 0x108A, hue: 0x489, name: "Mariner's Locket" });
ql({ tagId: 'q-deep-sea-pearl',           itemId: 0x09B5, hue: 0x47F, name: 'Deep Sea Pearl' });
ql({ tagId: 'q-storm-stone',              itemId: 0x14F0, hue: 0x489, name: 'Storm Stone' });

export const QUEST_FLUFF_TAGS = __PENDING__.map((d) => d.tagId);
export const QUEST_FLUFF_COUNT = __PENDING__.length;

export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('quest-items-extra: registerItem missing'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) {
    try { reg(def); count++; }
    catch (e) { api.log?.(`quest-items-extra: ${def.tagId}: ${e.message}`); }
  }
  api.log?.(`quest-items-extra: registered ${count} quest fluff items`);
  return () => {};
}
