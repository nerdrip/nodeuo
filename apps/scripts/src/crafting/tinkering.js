// Tinkering — skill id 38. Mirrors ServUO `Scripts/Services/Craft/DefTinkering.cs`.
//
// Tinkering produces utility items (clocks, gears, lockpicks) and trap-
// related parts. Many recipes need iron ingots (or wood logs); higher-tier
// items (clockwork assemblies) also need clockwork mechanisms or springs.
//
// Sub-categories:
//   Parts          — gears, axles, springs, hinges (low skill)
//   Tools          — sextants, clocks, scissors (mid skill)
//   Lock & Trap    — lockpicks, trap kits (mid-high skill)
//   Jewelry        — rings/bracelets in metals (jewelry-recipes use ingots)

// Audit #43 P1-1 — Tinkering is id 38 (skills.json:39). Was 36 (Stealing).

// --- queue-and-flush loader pattern -------------------------------------
const __PENDING__ = [];

const SKILL = 38;

const ITEM = {
  IronIngot:  0x1BF2, Logs:       0x1BDD, Boards:     0x1BD7,
  // Parts.
  Gears:      0x1053, GearsTwo:   0x1054, Axle:       0x105B, AxleTwo: 0x105C,
  Springs:    0x105D, SmallSpring:0x105E, Sextant:    0x1057,
  ClockParts: 0x104F, ClockFrame: 0x104B, Hinges:     0x1059, Hatchet: 0x0F43,
  // Tools.
  Lockpick:   0x14FC, Scissors:   0x0F9F, Tongs:      0x0FBB, Pickaxe: 0x0E86,
  TinkerTool: 0x1EBC, Pliers:     0x1EBC, Calipers: 0x1EBD,
  // Locks & Traps.
  KeyRing:    0x1011, Key:        0x1010, TrapKit:    0x1BF7,
  // Jewelry (default art id).
  GoldRing:   0x108A, GoldBracelet: 0x1086, SilverRing: 0x108A, SilverBracelet: 0x1086,
};

function recipe(id, name, category, minSkill, output, inputs, opts = {}) {
  __PENDING__.push({
    id, name, category, skillId: SKILL,
    minSkill, maxSkill: opts.maxSkill ?? minSkill + 200,
    outputItemId: output, outputCount: opts.outputCount ?? 1,
    toolKind: 'tinker',
    inputs: inputs.map(([itemId, count]) => ({ itemId, count })),
    exceptionalChance: opts.exceptionalChance ?? 0.05,
    onCraft: opts.onCraft,
  });
}

// ---- Parts (low skill, ingot-cheap) --------------------------------------
recipe(36001, 'Gears',            'Parts',     0,   ITEM.Gears,        [[ITEM.IronIngot, 2]]);
recipe(36002, 'Axle',             'Parts',    50,   ITEM.Axle,         [[ITEM.Logs, 1]]);
recipe(36003, 'Springs',          'Parts',   100,   ITEM.Springs,      [[ITEM.IronIngot, 1]]);
recipe(36004, 'Hinges',           'Parts',   100,   ITEM.Hinges,       [[ITEM.IronIngot, 2]]);
recipe(36005, 'Clock Parts',      'Parts',   200,   ITEM.ClockParts,   [[ITEM.IronIngot, 2]]);
recipe(36006, 'Clock Frame',      'Parts',   300,   ITEM.ClockFrame,   [[ITEM.IronIngot, 6], [ITEM.Logs, 2]]);

// ---- Tools (mid skill) ----------------------------------------------------
recipe(36010, 'Scissors',         'Tools',     0,   ITEM.Scissors,     [[ITEM.IronIngot, 2]]);
recipe(36011, 'Tongs',            'Tools',    50,   ITEM.Tongs,        [[ITEM.IronIngot, 4]]);
recipe(36012, 'Pickaxe',          'Tools',   500,   ITEM.Pickaxe,      [[ITEM.IronIngot, 4]]);
recipe(36013, 'Tinker Tools',     'Tools',     0,   ITEM.TinkerTool,   [[ITEM.IronIngot, 4]]);
recipe(36014, 'Hatchet',          'Tools',   200,   ITEM.Hatchet,      [[ITEM.IronIngot, 4]]);
recipe(36015, 'Sextant',          'Tools',   600,   ITEM.Sextant,      [[ITEM.IronIngot, 4], [ITEM.Logs, 1]]);
recipe(36016, 'Calipers',         'Tools',   400,   ITEM.Calipers,     [[ITEM.IronIngot, 2]]);

// ---- Locks & Traps --------------------------------------------------------
recipe(36020, 'Lockpick',         'Locks',     0,   ITEM.Lockpick,     [[ITEM.IronIngot, 1]]);
// Audit #34 P2 #6 — ServUO `Key.cs` stamps a random `KeyValue` on every
// crafted key; lock items match against `LockableContainer.KeyValue` /
// `BaseDoor.KeyValue`. Without a value the crafted key is useless for
// any lock; a future `[rekey` command (or drag-onto-lock workflow)
// would copy the lock's id onto an adjacent blank key.
recipe(36021, 'Key',              'Locks',     0,   ITEM.Key,          [[ITEM.IronIngot, 1]], {
  onCraft(item) {
    // Random 31-bit positive value; 0 is reserved for "unset / blank".
    item.key = { keyId: 1 + Math.floor(Math.random() * 0x7FFFFFFE) };
  },
});
recipe(36022, 'Key Ring',         'Locks',    50,   ITEM.KeyRing,      [[ITEM.IronIngot, 2]]);
recipe(36023, 'Dart Trap Kit',    'Traps',   500,   ITEM.TrapKit,      [[ITEM.IronIngot, 5], [ITEM.Springs, 1]]);
recipe(36024, 'Poison Trap Kit',  'Traps',   650,   ITEM.TrapKit,      [[ITEM.IronIngot, 5], [ITEM.Springs, 2]]);
recipe(36025, 'Explosion Trap Kit','Traps',  750,   ITEM.TrapKit,      [[ITEM.IronIngot, 5], [ITEM.Springs, 3]]);

// ---- Jewelry --------------------------------------------------------------
recipe(36030, 'Gold Ring',        'Jewelry',  20,   ITEM.GoldRing,     [[ITEM.IronIngot, 2]]);
recipe(36031, 'Gold Bracelet',    'Jewelry',  30,   ITEM.GoldBracelet, [[ITEM.IronIngot, 2]]);
recipe(36032, 'Silver Ring',      'Jewelry',  20,   ITEM.SilverRing,   [[ITEM.IronIngot, 2]]);
recipe(36033, 'Silver Bracelet',  'Jewelry',  30,   ITEM.SilverBracelet,[[ITEM.IronIngot, 2]]);

// =====================================================================
//  EXTENDED TINKERING — clocks, sextants, springs, mechanisms, ML
//  trap kits, automaton parts, golem parts, Soulforge components.
// =====================================================================

// Clockwork mechanisms (used by Automaton crafting)
recipe(36040, 'Clockwork Mechanism', 'Mechanisms', 700, 0x1EA8, [
  [ITEM.IronIngot, 5], [ITEM.Gears, 2], [ITEM.Springs, 1], [ITEM.Hinges, 1],
]);
recipe(36041, 'Greater Clockwork',   'Mechanisms', 850, 0x1EA9, [
  [ITEM.IronIngot, 10], [ITEM.Gears, 5], [ITEM.Springs, 3], [ITEM.ClockFrame, 1],
]);

// Sextant variants
recipe(36042, 'Brass Sextant',       'Tools',  450, ITEM.Sextant, [[ITEM.IronIngot, 4]]);
recipe(36043, 'Gold Sextant',        'Tools',  650, ITEM.Sextant, [[ITEM.IronIngot, 6]]);

// Clock variants
recipe(36044, 'Wall Clock',          'Tools',  600, 0x104B, [[ITEM.IronIngot, 6], [ITEM.ClockParts, 2]]);
recipe(36045, 'Grandfather Clock',   'Tools',  900, 0x104D, [[ITEM.Boards, 8], [ITEM.ClockParts, 4], [ITEM.Hinges, 2]]);
recipe(36046, 'Pocket Watch',        'Tools',  750, 0x104A, [[ITEM.IronIngot, 2], [ITEM.ClockParts, 1]]);

// Lock variants
recipe(36050, 'Lock',                'Locks',  300, 0x108E, [[ITEM.IronIngot, 4]]);
recipe(36051, 'Heavy Lock',          'Locks',  500, 0x108F, [[ITEM.IronIngot, 8]]);
recipe(36052, 'Chest Lock',          'Locks',  400, 0x108D, [[ITEM.IronIngot, 5]]);
recipe(36053, 'Padlock',             'Locks',  350, 0x108E, [[ITEM.IronIngot, 4]]);

// Detect-trap kits + extended traps
recipe(36060, 'Magic Trap Kit',      'Traps',  800, ITEM.TrapKit, [
  [ITEM.IronIngot, 5], [ITEM.Springs, 3],
]);
recipe(36061, 'Sleep Trap Kit',      'Traps',  700, ITEM.TrapKit, [
  [ITEM.IronIngot, 5], [ITEM.Springs, 2],
]);
recipe(36062, 'Spike Trap Kit',      'Traps',  600, ITEM.TrapKit, [
  [ITEM.IronIngot, 6], [ITEM.Springs, 2],
]);
recipe(36063, 'Fire Trap Kit',       'Traps',  750, ITEM.TrapKit, [
  [ITEM.IronIngot, 5], [ITEM.Springs, 2],
]);

// Soulforge components (gating Imbuing crafting station)
recipe(36070, 'Soulforge Crucible',  'Soulforge', 950, 0x4275, [
  [ITEM.IronIngot, 20], [ITEM.Gears, 4], [ITEM.Hinges, 4],
]);
recipe(36071, 'Soulforge Bellows',   'Soulforge', 950, 0x4276, [
  [ITEM.IronIngot, 15], [ITEM.Springs, 4], [ITEM.Hinges, 2],
]);

// Automaton heart + key (for clockwork pet creation)
recipe(36080, 'Automaton Actuator',  'Automaton', 920, 0x4F2D, [
  [ITEM.IronIngot, 30], [ITEM.Gears, 8], [ITEM.Springs, 4], [ITEM.ClockParts, 4],
]);
recipe(36081, 'Pet Slot Key',         'Automaton', 700, 0x100E, [
  [ITEM.IronIngot, 10], [ITEM.Hinges, 1],
]);

// Pet trainer toolkit (for crafting class items)
recipe(36090, 'Pet Trainer Tools',    'Tools',  500, ITEM.TinkerTool, [[ITEM.IronIngot, 8]]);

// Empty bottles + small flasks (alchemy support)
recipe(36100, 'Empty Bottle',         'Tools',   40, 0x0F0E, [[ITEM.IronIngot, 1]]);
recipe(36101, 'Small Bottle',         'Tools',  150, 0x0F0E, [[ITEM.IronIngot, 1]]);

// Imbuing-tools support
recipe(36110, 'Empty Crystal',        'Imbuing', 800, 0x573C, [[ITEM.IronIngot, 2]]);

// Hand-tools batch
recipe(36120, 'Hammer',               'Tools',   30, 0x102A, [[ITEM.IronIngot, 4]]);
recipe(36121, 'Mallet',               'Tools',   30, 0x12B3, [[ITEM.Boards, 2]]);
recipe(36122, 'Saw',                  'Tools',   30, 0x1034, [[ITEM.IronIngot, 4]]);
recipe(36123, 'Drawknife',            'Tools',   30, 0x10E4, [[ITEM.IronIngot, 4]]);
recipe(36124, 'Inkwell',              'Tools',  100, 0x0FBE, [[ITEM.IronIngot, 1]]);

// Clockwork toys (low-skill curios + ML automaton support)
recipe(36130, 'Wind-up Mouse',        'Toys',   150, 0x1054, [[ITEM.IronIngot, 1], [ITEM.Springs, 1]]);
recipe(36131, 'Wind-up Bird',         'Toys',   200, 0x205C, [[ITEM.IronIngot, 2], [ITEM.Springs, 1]]);
recipe(36132, 'Music Box',            'Toys',   400, 0x2AF9, [[ITEM.IronIngot, 4], [ITEM.Gears, 2]]);
recipe(36133, 'Hourglass',            'Tools',  300, 0x1810, [[ITEM.IronIngot, 4], [ITEM.Logs, 2]]);
recipe(36134, 'Spyglass',             'Tools',  500, 0x14F5, [[ITEM.IronIngot, 6], [ITEM.Logs, 1]]);

// Spy / utility kit
recipe(36140, 'Skeleton Key',         'Locks',  650, ITEM.Key,      [[ITEM.IronIngot, 3]]);
recipe(36141, 'Magic Wand Reservoir', 'Mechanisms', 750, 0x0DF2,   [[ITEM.IronIngot, 4], [ITEM.Gears, 1]]);
recipe(36142, 'Sound Capacitor',      'Mechanisms', 700, 0x1EA8,   [[ITEM.IronIngot, 6], [ITEM.Springs, 2]]);

// Smith / craft enclosures
recipe(36150, 'Anvil',                'Furniture', 800, 0x0FB1, [[ITEM.IronIngot, 30]]);
recipe(36151, 'Forge',                'Furniture', 800, 0x0FB0, [[ITEM.IronIngot, 40]]);
recipe(36152, 'Bellows',              'Furniture', 700, 0x0FAF, [[ITEM.IronIngot, 8], [ITEM.Springs, 2]]);

// Birdcage / lantern set
recipe(36160, 'Iron Birdcage',        'Furniture', 550, 0x1B7C, [[ITEM.IronIngot, 12]]);
recipe(36161, 'Hanging Lantern',      'Furniture', 350, 0x0A1A, [[ITEM.IronIngot, 6], [ITEM.Springs, 1]]);
recipe(36162, 'Iron Brazier',         'Furniture', 450, 0x0E31, [[ITEM.IronIngot, 10]]);


// --- script entry point ----------------------------------------------
export default function register(api) {
  const sys = api.systems?.crafting;
  if (!sys?.registerRecipe) { api.log?.('crafting/tinkering: engine missing, skipping'); return () => {}; }
  let count = 0;
  const owned = [];
  for (const def of __PENDING__) { try { const registered = sys.registerRecipe(def); if (registered !== false) { owned.push(registered ?? sys.getRecipe?.(def.id) ?? def); count++; } } catch (e) { api.log?.('crafting/tinkering: ' + e.message); } }
  api.log?.('crafting/tinkering: registered ' + count + ' recipes');
  return () => { for (const def of owned) sys.unregisterRecipe?.(def.id, def); };
}
