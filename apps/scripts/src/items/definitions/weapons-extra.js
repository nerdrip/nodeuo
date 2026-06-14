// Extended weapon roster — Tokuno (Samurai Empire), Gargish (Stygian
// Abyss throwing weapons), Mondain's Legacy (elven), exotic blades.
// Mirrors ServUO `Items/Equipment/Weapons/*.cs` for the missing 100+
// entries (we already have ~25 base weapons in `weapons.js`).



// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];

function weapon(def) {
  const isBow = def.category === 'bow' || def.category === 'throw';
  const ammoId = isBow
    ? (def.id === 0x0F50 || def.id === 0x13FD || def.id === 0x26C3 ? 0x1BFB : 0x0F3F)
    : null;
  __PENDING__.push({
    kind: 'weapon',
    layer: def.layer ?? (def.twoHanded ? 2 : 1),
    weapon: {
      range: def.range ?? (isBow ? 8 : 1),
      ammoId,
      swingMs: Math.round(60_000 / Math.max(1, def.speed)),
      minDamage: def.minDamage, maxDamage: def.maxDamage,
      skill: def.skill,
    },
    ...def,
  });
}

// =====================================================================
//  TOKUNO (Samurai Empire) — katana family + naginata + lajatang
// =====================================================================
weapon({ id: 0x27A2, name: 'Bokuto',          category: 'sword',  skill: 41, minDamage: 9,  maxDamage: 11, speed: 50, strReq: 20, twoHanded: false });
weapon({ id: 0x27A3, name: 'Daisho',          category: 'sword',  skill: 41, minDamage: 11, maxDamage: 13, speed: 41, strReq: 30, twoHanded: false });
weapon({ id: 0x27A5, name: 'Lajatang',        category: 'sword',  skill: 41, minDamage: 12, maxDamage: 14, speed: 36, strReq: 35, twoHanded: true });
weapon({ id: 0x27A6, name: 'No-Dachi',        category: 'sword',  skill: 41, minDamage: 13, maxDamage: 15, speed: 30, strReq: 50, twoHanded: true });
weapon({ id: 0x27A8, name: 'Tetsubo',         category: 'mace',   skill: 42, minDamage: 14, maxDamage: 16, speed: 30, strReq: 40, twoHanded: true });
weapon({ id: 0x27AB, name: 'Tessen',          category: 'fencing',skill: 43, minDamage: 9,  maxDamage: 11, speed: 50, strReq: 20, twoHanded: false });
weapon({ id: 0x27AD, name: 'Wakizashi',       category: 'fencing',skill: 43, minDamage: 10, maxDamage: 12, speed: 47, strReq: 20, twoHanded: false });
weapon({ id: 0x27AE, name: 'Yumi',            category: 'bow',    skill: 32, minDamage: 16, maxDamage: 18, speed: 28, strReq: 40, twoHanded: true });
weapon({ id: 0x27A1, name: 'Kama',            category: 'sword',  skill: 41, minDamage: 11, maxDamage: 13, speed: 41, strReq: 25, twoHanded: false });
weapon({ id: 0x27AF, name: 'Naginata',        category: 'fencing',skill: 43, minDamage: 13, maxDamage: 15, speed: 33, strReq: 40, twoHanded: true });
weapon({ id: 0x27A4, name: 'Fukiya',          category: 'throw',  skill: 58, minDamage: 4,  maxDamage: 6,  speed: 40, strReq: 10, twoHanded: false, range: 6 });
weapon({ id: 0x27AC, name: 'Nunchaku',        category: 'mace',   skill: 42, minDamage: 9,  maxDamage: 11, speed: 50, strReq: 20, twoHanded: false });

// =====================================================================
//  GARGISH (Stygian Abyss — Throw skill)
// =====================================================================
weapon({ id: 0x48B0, name: 'Gargish Cyclone',     category: 'throw', skill: 58, minDamage: 11, maxDamage: 14, speed: 42, strReq: 35, twoHanded: false, range: 8 });
weapon({ id: 0x4067, name: 'Soul Glaive',         category: 'throw', skill: 58, minDamage: 17, maxDamage: 20, speed: 25, strReq: 40, twoHanded: false, range: 8 });
weapon({ id: 0x4068, name: 'Boomerang',           category: 'throw', skill: 58, minDamage: 12, maxDamage: 14, speed: 35, strReq: 25, twoHanded: false, range: 8 });
weapon({ id: 0x48B0, name: 'Gargish Daisho',      category: 'sword', skill: 41,  minDamage: 11, maxDamage: 13, speed: 41, strReq: 30, twoHanded: false, race: 'gargoyle' });
weapon({ id: 0x48B2, name: 'Gargish Tessen',      category: 'fencing',skill: 43, minDamage: 9,  maxDamage: 11, speed: 50, strReq: 20, twoHanded: false, race: 'gargoyle' });
weapon({ id: 0x48B6, name: 'Gargish Lance',       category: 'fencing',skill: 43, minDamage: 17, maxDamage: 20, speed: 24, strReq: 95, twoHanded: true,  race: 'gargoyle' });
weapon({ id: 0x48B8, name: 'Gargish Battle Axe',  category: 'sword', skill: 41,  minDamage: 17, maxDamage: 21, speed: 30, strReq: 35, twoHanded: true,  race: 'gargoyle' });
weapon({ id: 0x48BA, name: 'Gargish Bardiche',    category: 'sword', skill: 41,  minDamage: 17, maxDamage: 22, speed: 26, strReq: 80, twoHanded: true,  race: 'gargoyle' });
weapon({ id: 0x48BC, name: 'Gargish Bone Harvester',category: 'sword',skill: 41, minDamage: 13, maxDamage: 15, speed: 32, strReq: 35, twoHanded: false, race: 'gargoyle' });
weapon({ id: 0x48BE, name: 'Gargish Butcher Knife',category: 'sword',skill: 41,  minDamage: 13, maxDamage: 15, speed: 35, strReq: 25, twoHanded: false, race: 'gargoyle' });
weapon({ id: 0x48C0, name: 'Gargish Cleaver',     category: 'sword', skill: 41,  minDamage: 13, maxDamage: 15, speed: 35, strReq: 25, twoHanded: false, race: 'gargoyle' });
weapon({ id: 0x48C2, name: 'Gargish Crescent Blade',category: 'sword',skill: 41, minDamage: 13, maxDamage: 17, speed: 32, strReq: 30, twoHanded: false, race: 'gargoyle' });
weapon({ id: 0x48C4, name: 'Gargish Dagger',      category: 'sword', skill: 41,  minDamage: 1,  maxDamage: 15, speed: 56, strReq: 10, twoHanded: false, race: 'gargoyle' });
weapon({ id: 0x48C6, name: 'Gargish Glass Sword', category: 'sword', skill: 41,  minDamage: 14, maxDamage: 16, speed: 33, strReq: 30, twoHanded: false, race: 'gargoyle' });
weapon({ id: 0x48C8, name: 'Gargish Katana',      category: 'sword', skill: 41,  minDamage: 8,  maxDamage: 19, speed: 48, strReq: 25, twoHanded: false, race: 'gargoyle' });
weapon({ id: 0x48CA, name: 'Gargish Kryss',       category: 'fencing',skill: 43, minDamage: 4,  maxDamage: 16, speed: 53, strReq: 10, twoHanded: false, race: 'gargoyle' });
weapon({ id: 0x48CC, name: 'Gargish Talwar',      category: 'sword', skill: 41,  minDamage: 14, maxDamage: 16, speed: 33, strReq: 30, twoHanded: false, race: 'gargoyle' });
weapon({ id: 0x48CE, name: 'Gargish War Axe',     category: 'sword', skill: 41,  minDamage: 14, maxDamage: 16, speed: 33, strReq: 35, twoHanded: false, race: 'gargoyle' });
weapon({ id: 0x48D0, name: 'Gargish War Hammer',  category: 'mace',  skill: 42,  minDamage: 17, maxDamage: 21, speed: 31, strReq: 95, twoHanded: true,  race: 'gargoyle' });
weapon({ id: 0x48D2, name: 'Gargish War Mace',    category: 'mace',  skill: 42,  minDamage: 14, maxDamage: 16, speed: 33, strReq: 40, twoHanded: false, race: 'gargoyle' });

// =====================================================================
//  ML / Stygian special blades
// =====================================================================
weapon({ id: 0x2D24, name: 'Diamond Mace',     category: 'mace',  skill: 42, minDamage: 14, maxDamage: 17, speed: 35, strReq: 40, twoHanded: false });
weapon({ id: 0x2D33, name: 'Magical Shortbow', category: 'bow',   skill: 32, minDamage: 9,  maxDamage: 11, speed: 50, strReq: 25, twoHanded: false });
weapon({ id: 0x2D32, name: 'Elven Composite Longbow', category: 'bow', skill: 32, minDamage: 13, maxDamage: 17, speed: 30, strReq: 45, twoHanded: true });
weapon({ id: 0x2D2A, name: 'Wild Staff',       category: 'staff', skill: 42, minDamage: 13, maxDamage: 17, speed: 32, strReq: 30, twoHanded: true });
weapon({ id: 0x2D27, name: 'Elven Spellblade', category: 'sword', skill: 41, minDamage: 13, maxDamage: 15, speed: 30, strReq: 35, twoHanded: false });
weapon({ id: 0x2D29, name: 'Elven Machete',    category: 'sword', skill: 41, minDamage: 12, maxDamage: 17, speed: 36, strReq: 30, twoHanded: false });
weapon({ id: 0x2D34, name: 'Rune Blade',       category: 'sword', skill: 41, minDamage: 13, maxDamage: 17, speed: 32, strReq: 30, twoHanded: false });
weapon({ id: 0x2D32, name: 'Radiant Scimitar', category: 'sword', skill: 41, minDamage: 13, maxDamage: 15, speed: 35, strReq: 30, twoHanded: false });
weapon({ id: 0x2D35, name: 'Assassin Spike',   category: 'fencing',skill: 43,minDamage: 11, maxDamage: 13, speed: 40, strReq: 10, twoHanded: false });
weapon({ id: 0x2D31, name: 'Leafblade',        category: 'fencing',skill: 43,minDamage: 11, maxDamage: 13, speed: 35, strReq: 25, twoHanded: false });
weapon({ id: 0x2D2D, name: 'War Cleaver',      category: 'fencing',skill: 43,minDamage: 13, maxDamage: 15, speed: 32, strReq: 25, twoHanded: false });

// =====================================================================
//  EXOTIC: Bola, Slime trap, Crook (utility)
// =====================================================================
weapon({ id: 0x26AC, name: 'Bola Ball',        category: 'throw', skill: 58, minDamage: 1,  maxDamage: 4,  speed: 30, strReq: 5,  twoHanded: false, range: 6 });
weapon({ id: 0x4068, name: 'Cyclone Boomerang',category: 'throw', skill: 58, minDamage: 13, maxDamage: 16, speed: 38, strReq: 30, twoHanded: false, range: 8 });


// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('weapons-extra: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('weapons-extra: ' + e.message); } }
  api.log?.('weapons-extra: registered ' + count + ' items');
  return () => {};
}
