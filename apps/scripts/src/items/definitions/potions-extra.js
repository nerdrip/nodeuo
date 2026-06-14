// Extended potion catalog — greater variants, mana, total cure /
// refresh, lethal poison. ServUO `Items/Potions/` ships a 4-tier
// pyramid for each (lesser → standard → greater → deadly/total).
//
// Cooldown / delay enforcement (potion drink-out / 10s window) is
// handled by the alchemy module; here we only declare the data.



// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];

function potion(id, name, effect, opts = {}) {
  __PENDING__.push({
    kind: 'consumable', category: 'potion', id, name, effect,
    weight: 1, stackable: false, ...opts,
  });
}

// ---- Heal tiers -----------------------------------------------------
potion(0x0F0C, 'Lesser Heal Potion', (user) => {
  const heal = 4 + Math.floor(Math.random() * 5);
  user.hp = Math.min(user.hpMax ?? 100, (user.hp ?? 0) + heal);
}, { tagId: 'potion-lesser-heal', hue: 0x21 });
potion(0x0F0C, 'Greater Heal Potion', (user) => {
  const heal = 16 + Math.floor(Math.random() * 14);
  user.hp = Math.min(user.hpMax ?? 100, (user.hp ?? 0) + heal);
}, { tagId: 'potion-greater-heal', hue: 0x47 });
potion(0x0F0C, 'Total Refresh Potion', (user) => {
  user.stam = user.stamMax ?? 100;
}, { tagId: 'potion-total-refresh', hue: 0x4D });

// ---- Cure tiers -----------------------------------------------------
potion(0x0F07, 'Lesser Cure Potion', () => {}, {
  tagId: 'potion-lesser-cure', script: 'potion-cure', cureTier: 'lesser',
  servuoClass: 'LesserCurePotion', servuoClasses: ['LesserCurePotion', 'BaseCurePotion', 'CureLevelInfo'],
});
potion(0x0F07, 'Greater Cure Potion', () => {}, {
  tagId: 'potion-greater-cure', hue: 0x4F, script: 'potion-cure', cureTier: 'greater',
  servuoClass: 'GreaterCurePotion', servuoClasses: ['GreaterCurePotion', 'BaseCurePotion', 'CureLevelInfo'],
});
potion(0x0F07, 'Total Cure Potion', () => {}, {
  tagId: 'potion-total-cure', hue: 0x47, script: 'potion-cure', cureTier: 'total',
  servuoClass: 'TotalCurePotion', servuoClasses: ['TotalCurePotion', 'BaseCurePotion', 'CureLevelInfo'],
});

// ---- Mana ------------------------------------------------------------
potion(0x0F09, 'Lesser Mana Potion', (user) => {
  user.mana = Math.min(user.manaMax ?? 100, (user.mana ?? 0) + 10);
}, { tagId: 'potion-lesser-mana', hue: 0x4D });
potion(0x0F09, 'Mana Potion', (user) => {
  user.mana = Math.min(user.manaMax ?? 100, (user.mana ?? 0) + 20);
}, { tagId: 'potion-mana' });
potion(0x0F09, 'Greater Mana Potion', (user) => {
  user.mana = Math.min(user.manaMax ?? 100, (user.mana ?? 0) + 40);
}, { tagId: 'potion-greater-mana', hue: 0x47 });
potion(0x0F09, 'Total Mana Potion', (user) => {
  user.mana = user.manaMax ?? 100;
}, { tagId: 'potion-total-mana', hue: 0x21 });

// ---- Strength tiers -------------------------------------------------
potion(0x0F09, 'Lesser Strength Potion', (user) => {
  user.strBuffUntil = Date.now() + 60_000;
  user.strBuffAmount = 5;
}, { tagId: 'potion-lesser-str', hue: 0x4D });
potion(0x0F09, 'Greater Strength Potion', (user) => {
  user.strBuffUntil = Date.now() + 120_000;
  user.strBuffAmount = 15;
}, { tagId: 'potion-greater-str', hue: 0x47 });

// ---- Agility / Wisdom -----------------------------------------------
potion(0x0F08, 'Lesser Agility Potion', (user) => {
  user.dexBuffUntil = Date.now() + 60_000;
  user.dexBuffAmount = 5;
}, { tagId: 'potion-lesser-agi', hue: 0x4D });
potion(0x0F08, 'Greater Agility Potion', (user) => {
  user.dexBuffUntil = Date.now() + 120_000;
  user.dexBuffAmount = 15;
}, { tagId: 'potion-greater-agi', hue: 0x47 });

// ---- Poison tiers (applied to weapon via target) --------------------
potion(0x0F0A, 'Lesser Poison Potion', () => {}, { tagId: 'potion-lesser-poison', poisonLevel: 0, hue: 0x4D, script: 'potion-poison', servuoClass: 'LesserPoisonPotion' });
potion(0x0F0A, 'Poison Potion',         () => {}, { tagId: 'potion-poison',        poisonLevel: 1, script: 'potion-poison', servuoClass: 'PoisonPotion' });
potion(0x0F0A, 'Greater Poison Potion', () => {}, { tagId: 'potion-greater-poison',poisonLevel: 2, hue: 0x47, script: 'potion-poison', servuoClass: 'GreaterPoisonPotion' });
potion(0x0F0A, 'Deadly Poison Potion',  () => {}, { tagId: 'potion-deadly-poison', poisonLevel: 3, hue: 0x21, script: 'potion-poison', servuoClass: 'DeadlyPoisonPotion' });
potion(0x0F0A, 'Lethal Poison Potion',  () => {}, { tagId: 'potion-lethal-poison', poisonLevel: 4, hue: 0x844, script: 'potion-poison', servuoClass: 'LethalPoisonPotion' });
potion(0x0F0A, 'Parasitic Poison',      () => {}, { tagId: 'parasitic-potion', poisonLevel: 4, poisonKind: 'parasitic', hue: 0x17C, script: 'potion-poison', minPoisoningSkill: 95, servuoClass: 'ParasiticPotion', labelNumber: 1072848 });
potion(0x0F0A, 'Darkglow Poison',       () => {}, { tagId: 'darkglow-potion', poisonLevel: 4, poisonKind: 'darkglow', hue: 0x096, script: 'potion-poison', minPoisoningSkill: 95, servuoClass: 'DarkglowPotion', labelNumber: 1072849 });

// ---- Explosion tiers -------------------------------------------------
potion(0x0F0D, 'Lesser Explosion Potion', () => {}, { tagId: 'potion-lesser-explosion', damage: [3, 6], hue: 0x4D, script: 'area-potion', aoeRadius: 2, damageType: { physical: 100 }, servuoClass: 'LesserExplosionPotion' });
potion(0x0F0D, 'Explosion Potion',         () => {}, { tagId: 'potion-explosion',        damage: [5, 10], script: 'area-potion', aoeRadius: 2, damageType: { physical: 100 }, servuoClass: 'ExplosionPotion' });
potion(0x0F0D, 'Greater Explosion Potion', () => {}, { tagId: 'potion-greater-explosion',damage: [10, 20], hue: 0x47, script: 'area-potion', aoeRadius: 3, damageType: { physical: 100 }, servuoClass: 'GreaterExplosionPotion' });

// ---- Conflagration / Confusion (Pirate Pack) ------------------------
potion(0x0F06, 'Conflagration Potion', () => {}, { tagId: 'potion-conflagration', damage: [4, 8], statusEffect: 'burning', statusDurationMs: 10_000, script: 'area-potion', aoeRadius: 3, damageType: { fire: 100 }, servuoClass: 'ConflagrationPotion' });
potion(0x0F06, 'Confusion Blast Potion', () => {}, { tagId: 'potion-confusion-blast', damage: [0, 0], statusEffect: 'confusion', statusDurationMs: 4000, script: 'area-potion', aoeRadius: 3, servuoClass: 'ConfusionBlastPotion' });
potion(0x0F06, 'Exploding Tar Potion', () => {}, { tagId: 'exploding-tar-potion', damage: [8, 14], statusEffect: 'slowed', statusDurationMs: 5000, script: 'area-potion', aoeRadius: 3, damageType: { fire: 50, physical: 50 }, servuoClass: 'ExplodingTarPotion', labelNumber: 1095147 });

// ---- Ninja smoke bomb -----------------------------------------------
potion(0x2808, 'Smoke Bomb', (user) => {
  // Hides the player for 8s — leverages the existing stealth system.
  user.hidden = true;
  user.hiddenUntil = Date.now() + 8000;
}, { tagId: 'smoke-bomb' });

// ---- Time of Legends / Eodon potions --------------------------------
potion(0x0F06, 'Barrab Hemolymph Concentrate', () => {}, { tagId: 'barrab-hemolymph-concentrate', hue: 1272, stackable: true, script: 'eodon-potion', eodonEffect: 'barrab', servuoClass: 'BarrabHemolymphConcentrate', labelNumber: 1156724 });
potion(0x0F06, 'Jukari Burn Poultice',         () => {}, { tagId: 'jukari-burn-poiltice', hue: 2727, stackable: true, script: 'eodon-potion', eodonEffect: 'jukari', servuoClass: 'JukariBurnPoiltice', labelNumber: 1156726 });
potion(0x0F06, 'Kurak Ambusher\'s Essence',    () => {}, { tagId: 'kurak-ambushers-essence', hue: 1260, stackable: true, script: 'eodon-potion', eodonEffect: 'kurak', eodonDurationMs: 600_000, servuoClass: 'KurakAmbushersEssence', labelNumber: 1156728 });
potion(0x0F06, 'Barako Draft of Might',        () => {}, { tagId: 'barako-draft-of-might', hue: 1072, stackable: true, script: 'eodon-potion', eodonEffect: 'barako', servuoClass: 'BarakoDraftOfMight', labelNumber: 1156729 });
potion(0x0F06, 'Urali Trance Tonic',           () => {}, { tagId: 'urali-trance-tonic', hue: 1098, stackable: true, script: 'eodon-potion', eodonEffect: 'urali', servuoClass: 'UraliTranceTonic', labelNumber: 1156734 });
potion(0x0F06, 'Sakkhra Prophylaxis Potion',   () => {}, { tagId: 'sakkhra-prophylaxis-potion', hue: 2531, stackable: true, script: 'eodon-potion', eodonEffect: 'sakkhra', servuoClass: 'SakkhraProphylaxisPotion', labelNumber: 1156732 });


// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('potions-extra: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('potions-extra: ' + e.message); } }
  api.log?.('potions-extra: registered ' + count + ' items');
  return () => {};
}
