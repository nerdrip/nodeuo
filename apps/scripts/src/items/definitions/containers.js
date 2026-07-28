// Container catalog — bags, chests, barrels, strongboxes, trapped
// chests, kegs, coffins. Mirrors ServUO `Scripts/Items/Containers/`
// (`Bag.cs`, `Backpack.cs`, `WoodenChest.cs`, `MetalChest.cs`,
// `Pouch.cs`, `Strongbox.cs`, `TrapableContainer.cs`, `Barrel.cs`,
// `Coffin.cs`).
//
// Each entry's `gumpId` is the container-art gump UO ships in
// `gumpart.mul`. Without it the client opens an empty default gump and
// items render off-grid. Values match CUO `ContainerData.cs` defaults.
//
// Capacity / max-weight follow OSI: regular containers cap at 125
// items / 400 stones; pouches cap at 25 items / 50 stones; strongboxes
// at 200/600 (and refuse non-owners via house-ACL); trapped chests
// trigger their payload via `script: 'trap-chest'` lifecycle hook.



// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];

function container(def) {
  __PENDING__.push({
    kind: 'container',
    container: true,
    weight: 1,
    capacity: 125,
    maxWeight: 400,
    ...def,
  });
}

// ---- Bags & pouches -------------------------------------------------
container({ id: 0x0E76, name: 'Bag',         gumpId: 0x003D, weight: 2 });
container({ id: 0x0E75, name: 'Backpack',    gumpId: 0x003C, weight: 3 });
container({ id: 0x0E79, name: 'Pouch',       gumpId: 0x003F, weight: 1, capacity: 25, maxWeight: 50 });
container({ id: 0x0E78, name: 'Bag of Sending', gumpId: 0x003D, weight: 2,
  tagId: 'bag-of-sending', script: 'bag-of-sending', charges: 30 });
container({ id: 0x0E76, name: 'Bag of Holding', gumpId: 0x003D, weight: 1,
  tagId: 'bag-of-holding', capacity: 250, maxWeight: 1000 });
container({
  id: 0x0E76, name: 'Salvage Bag', tagId: 'salvage-bag',
  servuoClass: 'SalvageBag', servuoClasses: ['SalvageBag', 'SalvageAllEntry'], gumpId: 0x003D, weight: 2,
  capacity: 125, maxWeight: 400, script: 'salvage-bag', salvageMode: 'all',
});

// ---- Wooden / metal chests + boxes ----------------------------------
container({ id: 0x0E40, name: 'Wooden Chest', gumpId: 0x0049, weight: 8 });
container({ id: 0x0E43, name: 'Wooden Chest', gumpId: 0x0049, weight: 8 }); // open variant art
container({ id: 0x0E7C, name: 'Wooden Box',   gumpId: 0x0042, weight: 4 });
container({ id: 0x09AA, name: 'Metal Box',    gumpId: 0x0044, weight: 7 });
container({ id: 0x09A8, name: 'Metal Chest',  gumpId: 0x0048, weight: 9 });
container({ id: 0x09AB, name: 'Metal Golden Chest', gumpId: 0x0048, weight: 9 });
container({ id: 0x0E7D, name: 'Wooden Box',   gumpId: 0x0043, weight: 4 });

// ---- Strongbox (admin / house-locked storage) -----------------------
container({
  id: 0x09A8, name: 'Strongbox', tagId: 'strongbox',
  gumpId: 0x004B, weight: 25, capacity: 200, maxWeight: 600,
});

// ---- Barrels & kegs -------------------------------------------------
container({ id: 0x0E77, name: 'Barrel',       gumpId: 0x003E, weight: 25, capacity: 60 });
container({ id: 0x0E7F, name: 'Keg',          gumpId: 0x003E, weight: 5,  capacity: 25 });
container({
  id: 0x1843, name: 'Powder Keg', tagId: 'powder-keg',
  gumpId: 0x003E, weight: 50, explosive: true,
});

// ---- Coffins / sarcophagi -------------------------------------------
container({ id: 0x0E40, name: 'Coffin', tagId: 'coffin',
  gumpId: 0x0009, weight: 50 });

// ---- Crates ---------------------------------------------------------
container({ id: 0x0E7E, name: 'Small Crate',  gumpId: 0x0044, weight: 4 });
container({ id: 0x0E3F, name: 'Crate',        gumpId: 0x0044, weight: 8 });
container({ id: 0x0E3E, name: 'Large Crate',  gumpId: 0x0044, weight: 12 });

// ---- ServUO fillable world containers -------------------------------
// These are the decoration-spawned crates/chests/barrels that restock
// from nearby vendor archetypes (`FillableContent.Acquire`) instead of
// using static loot tables.
[
  { id: 0x0E3D, name: 'Fillable Large Crate', cls: 'FillableLargeCrate', gumpId: 0x0044, weight: 1 },
  { id: 0x09A9, name: 'Fillable Small Crate', cls: 'FillableSmallCrate', gumpId: 0x0044, weight: 1 },
  { id: 0x09AA, name: 'Fillable Wooden Box', cls: 'FillableWoodenBox', gumpId: 0x0042, weight: 4 },
  { id: 0x09A8, name: 'Fillable Metal Box', cls: 'FillableMetalBox', gumpId: 0x0044, weight: 7 },
  { id: 0x0E77, name: 'Fillable Barrel', cls: 'FillableBarrel', gumpId: 0x003E, weight: 25, capacity: 60 },
  { id: 0x09AB, name: 'Fillable Metal Chest', cls: 'FillableMetalChest', gumpId: 0x0048, weight: 9 },
  { id: 0x0E41, name: 'Fillable Metal Golden Chest', cls: 'FillableMetalGoldenChest', gumpId: 0x0048, weight: 9 },
  { id: 0x0E43, name: 'Fillable Wooden Chest', cls: 'FillableWoodenChest', gumpId: 0x0049, weight: 8 },
].forEach((def) => container({
  id: def.id,
  name: def.name,
  tagId: def.cls.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase(),
  gumpId: def.gumpId,
  weight: def.weight,
  capacity: def.capacity ?? 125,
  script: 'fillable-container',
  movable: false,
  servuoClass: def.cls,
  servuoClasses: [def.cls, 'FillableContainer', 'FillableContent', 'FillableBvrge'],
  fillableType: def.cls,
}));

// ---- Trapped variants ------------------------------------------------
// Trapable containers carry a `trapped` payload activated on open.
// The packet handler runs the canonical lock/trap flow before opening, so
// these intentionally use the generic container path instead of a duplicate
// lifecycle script.
container({
  id: 0x0E40, name: 'Trapped Wooden Chest', tagId: 'trapped-wooden-chest',
  gumpId: 0x0049, weight: 8,
});
container({
  id: 0x09A8, name: 'Trapped Metal Chest', tagId: 'trapped-metal-chest',
  gumpId: 0x0048, weight: 9,
});

// ---- Treasure chests (5 levels) -------------------------------------
// Treasure-map chests already get spawned by the treasure-map system
// with a `treasureLevel` field; we register variant art-ids so the
// loot generator can pick a visually-distinct chest per tier.
for (let lvl = 1; lvl <= 5; lvl++) {
  container({
    id: 0x09AB, name: `Treasure Chest (Lv.${lvl})`,
    tagId: `treasure-chest-${lvl}`, gumpId: 0x0048,
    weight: 100, treasureLevel: lvl, capacity: 250, maxWeight: 1000,
    script: 'treasure-chest',
    servuoClass: `TreasureLevel${lvl}`,
    servuoClasses: [
      `TreasureLevel${lvl}`, 'BaseTreasureChest', 'BaseTreasureChestMod',
      'TreasureResetTimer', 'ChestTimer',
    ],
  });
}

// ---- Resource bag (pre-bundled crafting starter) --------------------
container({
  id: 0x0E76, name: 'Resource Bag', tagId: 'resource-bag',
  gumpId: 0x003D, weight: 5, capacity: 125,
});

// ---- Bank box (per-account vault, opened by [bank) ------------------
container({
  id: 0x09AB, name: 'Bank Box', tagId: 'bank-box',
  gumpId: 0x004A, weight: 0, capacity: 125, maxWeight: 1600,
  movable: false,
});

// ---- Specialized organisers (ServUO Items/Functional/{JewelryBox,
//      SeedBox, CommodityDeedBox}) ------------------------------------
// JewelryBox: holds rings/bracelets/earrings/necklaces with a
// dedicated layout. SeedBox: 24 slot grid for plant seeds. Commodity
// Deed Box: stack→deed conversion + holding.

container({
  id: 0x9AA1, name: 'Jewelry Box', tagId: 'jewelry-box',
  gumpId: 0x0042, weight: 4, capacity: 125,
});
container({
  id: 0x4B23, name: 'Seed Box', tagId: 'seed-box',
  gumpId: 0x004A, weight: 8, capacity: 24,
});
container({
  id: 0xA2C5, name: 'Commodity Deed Box', tagId: 'commodity-deed-box',
  gumpId: 0x0042, weight: 8, capacity: 125,
});

// ---- Elven Quiver (ServUO Items/Equipment/Quivers/) -------------------
// Container that lives in the Cloak/Talisman layer (per ServUO 22) and
// reduces the weight of arrows/bolts inside by 50 % (`weightReducePct`).
// `ammoBonus` lets ranged combat code grant +5 hit chance when the
// quiver holds matching ammo.

container({
  id: 0x2FB7, name: 'Elven Quiver', tagId: 'elven-quiver',
  gumpId: 0x108, weight: 2, capacity: 50, maxWeight: 50,
  layer: 22, weightReducePct: 50, ammoBonus: 5,
});
container({
  id: 0x2B02, name: 'Quiver of Infinity', tagId: 'quiver-of-infinity',
  gumpId: 0x108, weight: 2, capacity: 100, maxWeight: 100,
  layer: 22, weightReducePct: 100, ammoBonus: 8,
});

// ---- Garbage / cleanup-britannia bin ---------------------------------
container({
  id: 0xE77, name: 'Trash Barrel', tagId: 'trash-barrel',
  servuoClass: 'TrashBarrel',
  servuoClasses: ['TrashBarrel', 'BaseTrash', 'CleanupArray', 'AppraiseforCleanup', 'EmptyTimer'],
  gumpId: 0x003E, weight: 25, capacity: 60, script: 'trash-barrel',
  movable: false,
});
container({
  id: 0xFAE, name: 'Trash - Keep Britannia Clean', tagId: 'cleanup-trash-barrel',
  hue: 2500,
  servuoClass: 'CleanupTrashBarrel',
  servuoClasses: ['CleanupTrashBarrel', 'BaseTrash', 'CleanupArray', 'AppraiseforCleanup'],
  gumpId: 0x003E, weight: 25, capacity: 60, script: 'trash-barrel',
  movable: false,
});
container({
  id: 0xE41, name: 'Trash Chest', tagId: 'trash-chest',
  servuoClass: 'TrashChest',
  servuoClasses: ['TrashChest', 'BaseTrash', 'CleanupArray', 'AppraiseforCleanup'],
  gumpId: 0x0049, weight: 25, capacity: 60, script: 'trash-barrel',
  movable: false,
});


// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('containers: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('containers: ' + e.message); } }
  api.log?.('containers: registered ' + count + ' items');
  return () => {};
}
