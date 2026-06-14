// Extended food + drink catalog. ServUO `Scripts/Items/Food/`.
// Each food entry restores hunger; drink entries hydrate but currently
// share the food code path (no separate thirst meter).



// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];

function food(id, name, hunger, opts = {}) {
  __PENDING__.push({
    kind: 'consumable', category: 'food', id, name, hunger,
    stackable: true, weight: 1, ...opts,
  });
}
function drink(id, name, hunger, opts = {}) {
  __PENDING__.push({
    kind: 'consumable', category: 'drink', id, name, hunger,
    stackable: false, weight: 1, ...opts,
  });
}

// ---- Fish varieties ------------------------------------------------
food(0x097A, 'Fish Steak',  20);
food(0x097B, 'Cooked Fish', 20);
food(0x09CC, 'Raw Fish Steak', 5);
food(0x097C, 'Salmon',      18);
food(0x09F1, 'Trout',       18);
food(0x09F2, 'Tuna',        20);
food(0x09F3, 'Cod',         15);
food(0x09F4, 'Bass',        18);

// ---- Bread varieties -----------------------------------------------
food(0x103D, 'Loaf of Bread',     12);
food(0x1043, 'French Bread',      14);
food(0x1042, 'Pumpernickel',      14);

// ---- Meat ----------------------------------------------------------
food(0x09F0, 'Raw Bird',     5);
food(0x09EF, 'Cooked Bird', 25);
food(0x1602, 'Drumstick',    20);
food(0x09EC, 'Slab of Bacon',15);
food(0x09F0, 'Raw Lamb Leg', 5);
food(0x09EE, 'Cooked Lamb Leg', 28);

// ---- Vegetables ----------------------------------------------------
food(0x0C77, 'Lettuce',       6);
food(0x0C78, 'Onion',         5);
food(0x0C7B, 'Carrot',        4);
food(0x0C7F, 'Cabbage',       6);
food(0x0C81, 'Garlic',        2);
food(0x0C81, 'Ear of Corn',   5, { tagId: 'ear-of-corn', servuoClass: 'EarOfCorn' });
food(0x0C81, 'Blue Corn',     5, { tagId: 'blue-corn', hue: 1284, servuoClass: 'BlueCorn', labelNumber: 1156733 });
food(0x0C7C, 'Cantaloupe',    6);
food(0x0C70, 'Eggplant',      6);
food(0x0C72, 'Squash',        4);
food(0x0C82, 'Yellow Pepper', 3);
food(0x0C7E, 'Honeydew Melon',5);

// ---- Fruits --------------------------------------------------------
food(0x09D0, 'Banana',        4);
food(0x09D1, 'Bunch of Bananas', 6);
food(0x1727, 'Coconut',       5);
food(0x1723, 'Open Coconut',  4, { tagId: 'open-coconut', servuoClass: 'OpenCoconut' });
food(0x1725, 'Split Coconut', 4, { tagId: 'split-coconut', servuoClass: 'SplitCoconut' });
food(0x171F, 'Date',          2);
food(0x1722, 'Lemon',         3);
food(0x1728, 'Lemonade',      0);
food(0x1729, 'Lime',          3);
food(0x09EA, 'Watermelon',    8);
food(0x9E86, 'Plum',          1, { tagId: 'plum', servuoClass: 'Plum', labelNumber: 1157208 });

// ---- Holiday sweets ------------------------------------------------
food(0x2BDD, 'Candy Cane', 0, {
  tagId: 'candy-cane',
  script: 'food',
  stackable: false,
  blessed: true,
  givesToothAche: true,
  toothAcheAcidity: 32,
  holidaySweet: true,
  servuoClass: 'CandyCane',
  servuoClasses: ['CandyCane', 'BaseSweet', 'ToothAcheTimer'],
});
food(0x2BE1, 'Gingerbread Cookie', 0, {
  tagId: 'gingerbread-cookie',
  script: 'food',
  stackable: false,
  blessed: true,
  givesToothAche: true,
  toothAcheAcidity: 32,
  holidaySweet: true,
  gingerBreadMessages: [
    '',
    'Noooo!',
    "Please don't eat me... *whimper*",
    'Not the face!',
    "Ahhhhhh! My foot's gone!",
    'Please. No! I have gingerkids!',
    "No, no! I'm really made of poison. Really.",
    "Run, run as fast as you can! You can't catch me! I'm the gingerbread man!",
  ],
  servuoClass: 'GingerBreadCookie',
  servuoClasses: ['GingerBreadCookie', 'BaseSweet', 'ToothAcheTimer'],
});

// ---- Pies / cakes / cheese -----------------------------------------
food(0x103B, 'Apple Pie',    20);
food(0x103C, 'Peach Cobbler',20);
food(0x097E, 'Cheese',       12);
food(0x097F, 'Wedge of Cheese', 8);
food(0x098D, 'Sausage',      18);
food(0x097F, "Beggar's Cheese Wedge", 8, { tagId: 'beg-cheese-wedge', begReward: true });
food(0x171F, "Beggar's Dates",        4, { tagId: 'beg-dates', begReward: true });
food(0x15F9, "Beggar's Stew",        16, { tagId: 'beg-stew', begReward: true, stackable: false });
food(0x0C77, "Beggar's Turnip",       4, { tagId: 'beg-turnip', begReward: true });

// ---- Drinks (alcohol = small confused effect not modeled) ----------
drink(0x09C7, 'Beer',         8);
drink(0x099B, 'Pitcher of Ale',   12);
drink(0x099D, 'Pitcher of Wine',  12);
drink(0x099A, 'Pitcher of Liquor',12);
drink(0x099F, 'Pitcher of Cider', 12);
drink(0x09C8, 'Bottle of Wine',   8);
drink(0x09C9, 'Bottle of Liquor', 8);
drink(0x099B, 'Glass of Beer',    4);
drink(0x099D, 'Glass of Wine',    4);
drink(0x099F, 'Glass of Milk',    4);
drink(0x099F, 'Murky Milk',       2, { tagId: 'murky-milk', hue: 0x3E5, servuoClass: 'MurkyMilk' });
drink(0x09C7, 'Glass of Water',   2);
drink(0x09F5, 'Mug of Ale',       6);
drink(0x09F8, 'Cup of Tea',       4);
drink(0x09F9, 'Cup of Coffee',    4);
drink(0x0995, 'Ceramic Mug',      0, { tagId: 'ceramic-mug', servuoClass: 'CeramicMug', quantity: 0, maxQuantity: 5 });
drink(0x0995, 'Mug of Hot Cocoa', 4, { tagId: 'hot-cocoa-mug', servuoClass: 'HotCocoaMug', content: 'hot-cocoa', quantity: 5, maxQuantity: 5 });
drink(0x0995, 'Mug of Coffee',    4, { tagId: 'coffee-mug', servuoClass: 'CoffeeMug', content: 'coffee', quantity: 5, maxQuantity: 5 });
drink(0x0FF6, 'Endless Decanter of Water', 4, {
  tagId: 'endless-decanter',
  hue: 0x399,
  script: 'endless-decanter',
  content: 'water',
  quantity: 5,
  maxQuantity: 5,
  stackable: false,
  weight: 2,
  servuoClass: 'EndlessDecanter',
  labelNumber: 1115929,
});

// ---- Eodon potion resources ----------------------------------------
food(0x2808, 'Myrmidex Eggsac', 0, { tagId: 'myrmidex-eggsac', hue: 1272, kind: 'resource', category: 'alchemy', stackable: true, servuoClass: 'MyrmidexEggsac', labelNumber: 1156725 });
food(0x5736, 'Lava Berry', 1, { tagId: 'lava-berry', hue: 1955, kind: 'resource', category: 'alchemy', stackable: true, servuoClass: 'LavaBerry', labelNumber: 1156727 });
food(0x1722, 'Perfect Bananas', 4, { tagId: 'perfect-banana', hue: 1119, kind: 'resource', category: 'alchemy', stackable: true, servuoClass: 'PerfectBanana', labelNumber: 1156730 });
food(0x573D, 'River Moss', 0, { tagId: 'river-moss', hue: 1272, kind: 'resource', category: 'alchemy', stackable: true, servuoClass: 'RiverMoss', labelNumber: 1156731 });


// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('food-extra: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('food-extra: ' + e.message); } }
  api.log?.('food-extra: registered ' + count + ' items');
  return () => {};
}
