// Consumable item definitions — potions, food, scrolls. Each records
// the on-use effect so `handleUseReq` can dispatch to it.



// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];

function potion(id, name, effect, opts = {}) {
  __PENDING__.push({ kind: 'consumable', id, name, effect, ...opts });
}
function food(id, name, hunger) {
  __PENDING__.push({ kind: 'consumable', id, name, category: 'food', hunger });
}

// ---- Potions --------------------------------------------------------
potion(0x0F07, 'Cure Potion',   () => {}, {
  tagId: 'potion-cure',
  script: 'potion-cure',
  cureTier: 'normal',
  servuoClass: 'CurePotion',
  servuoClasses: ['CurePotion', 'BaseCurePotion', 'CureLevelInfo'],
});
potion(0x0F0B, 'Refresh Potion',(user) => { user.stam = user.stamMax ?? 100; });
potion(0x0F0C, 'Heal Potion',   (user) => {
  const heal = 10 + Math.floor(Math.random() * 10);
  user.hp = Math.min(user.hpMax ?? 100, (user.hp ?? 0) + heal);
});
potion(0x0F08, 'Agility Potion',(user) => { user.dexBuffUntil = Date.now() + 120000; });
potion(0x0F09, 'Strength Potion',(user) => { user.strBuffUntil = Date.now() + 120000; });
potion(0x0F06, 'Nightsight Potion',(user) => { user.nightSightUntil = Date.now() + 600000; });
potion(0x0F0A, 'Poison Potion', (_user) => { /* applied to target via targeting */ });
potion(0x0F0D, 'Explosion Potion', (_user) => { /* delayed AOE via scheduled event */ });

// ---- Food (hunger restore) -----------------------------------------
food(0x09B7, 'Chicken Leg', 15);
food(0x09B8, 'Lamb Leg',    25);
food(0x097B, 'Roll',        5);
food(0x097D, 'Cake',        30);
food(0x097E, 'Cheese',      10);
food(0x09C0, 'Apple',       5);
food(0x09D1, 'Grapes',      3);
food(0x09E9, 'Peach',       5);
food(0x09EB, 'Pear',        5);
food(0x09F1, 'Fish Steak',  15);
food(0x09F2, 'Ham',         20);
food(0x1044, 'Bread Loaf',  10);


// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('consumables: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('consumables: ' + e.message); } }
  api.log?.('consumables: registered ' + count + ' items');
  return () => {};
}
