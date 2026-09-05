// Bowcraft / Fletching — skill id 9. Bows and arrows from boards +
// feathers. Reference ServUO Scripts/Services/Craft/DefBowFletching.cs.

// Bowcraft/Fletching = 9 in skills.json. The earlier value 8 collided
// with Blacksmithy.

// --- queue-and-flush loader pattern -------------------------------------
const __PENDING__ = [];

const SKILL = 9;
const BOARDS = 0x1BD7;
const FEATHERS = 0x1BD1;
const SHAFTS = 0x1BD4;

function fletch(id, name, category, minSkill, outputItemId, opts = {}) {
  __PENDING__.push({
    id, name, category, skillId: SKILL,
    minSkill, maxSkill: opts.maxSkill ?? minSkill + 250,
    outputItemId, outputCount: opts.outputCount ?? 1,
    toolKind: 'fletcher',
    inputs: opts.inputs,
    exceptionalChance: opts.exceptionalChance ?? 0.05,
  });
}

// ---- Arrows / bolts (stack of 1) -------------------------------------
fletch(8001, 'Arrow',          'Ammunition', 0, 0x0F3F, {
  inputs: [{ itemId: SHAFTS, count: 1 }, { itemId: FEATHERS, count: 1 }],
});
fletch(8002, 'Crossbow Bolt',  'Ammunition', 0, 0x1BFB, {
  inputs: [{ itemId: SHAFTS, count: 1 }, { itemId: FEATHERS, count: 1 }],
});
fletch(8003, 'Wooden Shafts',  'Components', 0, SHAFTS, {
  outputCount: 5,
  inputs: [{ itemId: BOARDS, count: 1 }],
});

// ---- Bows -------------------------------------------------------------
fletch(8010, 'Bow',         'Bows', 300, 0x13B2, {
  inputs: [{ itemId: BOARDS, count: 7 }],
});
fletch(8011, 'Crossbow',    'Bows', 600, 0x0F50, {
  inputs: [{ itemId: BOARDS, count: 7 }],
});
fletch(8012, 'Heavy Crossbow','Bows', 800, 0x13FD, {
  inputs: [{ itemId: BOARDS, count: 10 }],
});


// --- script entry point ----------------------------------------------
export default function register(api) {
  const sys = api.systems?.crafting;
  if (!sys?.registerRecipe) { api.log?.('crafting/fletching: engine missing, skipping'); return () => {}; }
  let count = 0;
  const owned = [];
  for (const def of __PENDING__) { try { const registered = sys.registerRecipe(def); if (registered !== false) { owned.push(registered ?? sys.getRecipe?.(def.id) ?? def); count++; } } catch (e) { api.log?.('crafting/fletching: ' + e.message); } }
  api.log?.('crafting/fletching: registered ' + count + ' recipes');
  return () => { for (const def of owned) sys.unregisterRecipe?.(def.id, def); };
}
