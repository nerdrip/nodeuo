// Weapon item definitions. Stat table for every weapon our crafting system
// can produce, plus the weapons monsters drop. ServUO reference:
// Scripts/Items/Weapons/*/*.cs — one file per weapon class, heavy OOP.
//
// We collapse to a flat table: each row has the server-side stats the
// combat engine needs (damage range, speed, skill, two-handed flag) plus
// the client art id. Adding a new weapon = one row.



// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];

/**
 * @typedef {Object} WeaponDef
 * @property {number} id           UO art id
 * @property {string} name
 * @property {string} category     'sword'|'mace'|'fencing'|'bow'|'polearm'|'staff'
 * @property {number} skill        ServUO skill id (swordsmanship 41, mace 42, fencing 43, archery 32)
 * @property {number} minDamage
 * @property {number} maxDamage
 * @property {number} speed        swings per second × 10 (classic UO unit)
 * @property {number} strReq
 * @property {boolean} twoHanded
 * @property {number} [layer]      paperdoll layer — defaults to 1-hand (1) or 2-hand (2)
 */

function weapon(def) {
  // FAZA FN: derive a runtime `weapon` descriptor that the equip path
  // (handlers.handleWearItem) copies onto mob._weapon. Combat-formulas
  // + ranged-arrow-consume + slayer-matrix all read from there.
  const isBow = def.category === 'bow';
  const ammoId = isBow
    ? (def.id === 0x0F50 || def.id === 0x13FD ? 0x1BFB /* bolts */ : 0x0F3F /* arrows */)
    : null;
  __PENDING__.push({
    kind: 'weapon',
    layer: def.layer ?? (def.twoHanded ? 2 : 1),
    weapon: {
      range: isBow ? 8 : 1,
      ammoId,
      swingMs: Math.round(60_000 / Math.max(1, def.speed)),
      minDamage: def.minDamage, maxDamage: def.maxDamage,
      skill: def.skill,
    },
    ...def,
  });
}

// ---- Swords (skill 41) ----------------------------------------------
weapon({ id: 0x0F51, name: 'Dagger',         category: 'sword',   skill: 41, minDamage: 1, maxDamage: 15, speed: 56, strReq: 10, twoHanded: false });
weapon({ id: 0x13FE, name: 'Katana',         category: 'sword',   skill: 41, minDamage: 8, maxDamage: 19, speed: 48, strReq: 25, twoHanded: false });
weapon({ id: 0x13B6, name: 'Scimitar',       category: 'sword',   skill: 41, minDamage: 10, maxDamage: 29, speed: 43, strReq: 25, twoHanded: false });
weapon({ id: 0x0F5E, name: 'Broadsword',     category: 'sword',   skill: 41, minDamage: 14, maxDamage: 16, speed: 33, strReq: 25, twoHanded: false });
weapon({ id: 0x0F61, name: 'Longsword',      category: 'sword',   skill: 41, minDamage: 15, maxDamage: 19, speed: 33, strReq: 35, twoHanded: false });
weapon({ id: 0x13FB, name: 'Battle Axe',     category: 'sword',   skill: 41, minDamage: 17, maxDamage: 21, speed: 30, strReq: 35, twoHanded: true });
weapon({ id: 0x1443, name: 'Two-Handed Axe', category: 'sword',   skill: 41, minDamage: 18, maxDamage: 22, speed: 27, strReq: 45, twoHanded: true });
weapon({ id: 0x143E, name: 'Halberd',        category: 'sword',   skill: 41, minDamage: 20, maxDamage: 28, speed: 25, strReq: 95, twoHanded: true });

// ---- Maces (skill 42) ------------------------------------------------
weapon({ id: 0x0F5C, name: 'Mace',            category: 'mace',   skill: 42, minDamage: 10, maxDamage: 30, speed: 30, strReq: 20, twoHanded: false });
weapon({ id: 0x1407, name: 'War Mace',        category: 'mace',   skill: 42, minDamage: 14, maxDamage: 16, speed: 33, strReq: 40, twoHanded: false });
weapon({ id: 0x143B, name: 'Maul',            category: 'mace',   skill: 42, minDamage: 10, maxDamage: 30, speed: 30, strReq: 20, twoHanded: false });
weapon({ id: 0x1439, name: 'War Hammer',      category: 'mace',   skill: 42, minDamage: 17, maxDamage: 21, speed: 31, strReq: 95, twoHanded: true });
weapon({ id: 0x143D, name: 'Hammer Pick',     category: 'mace',   skill: 42, minDamage: 15, maxDamage: 18, speed: 32, strReq: 35, twoHanded: true });
weapon({ id: 0x0DF0, name: 'Black Staff',     category: 'staff',  skill: 42, minDamage: 8,  maxDamage: 28, speed: 35, strReq: 35, twoHanded: true });
weapon({ id: 0x0DF0, name: 'Chyloth Staff',   category: 'staff',  skill: 42, minDamage: 8,  maxDamage: 28, speed: 35, strReq: 35, twoHanded: true, hue: 0x482, servuoClass: 'ChylothStaff', servuoClasses: ['ChylothStaff', 'BlackStaff', 'IDurability', 'IWearableDurability'] });
weapon({ id: 0x13F8, name: 'Gnarled Staff',   category: 'staff',  skill: 42, minDamage: 10, maxDamage: 30, speed: 30, strReq: 20, twoHanded: true });
weapon({ id: 0x13F9, name: 'Quarter Staff',   category: 'staff',  skill: 42, minDamage: 8,  maxDamage: 28, speed: 35, strReq: 30, twoHanded: true });
weapon({ id: 0x0E89, name: 'Shepherd\'s Crook','category': 'staff', skill: 42, minDamage: 4,  maxDamage: 16, speed: 40, strReq: 10, twoHanded: true });

// ---- Fencing (skill 43) ---------------------------------------------
weapon({ id: 0x1401, name: 'Kryss',            category: 'fencing', skill: 43, minDamage: 4,  maxDamage: 16, speed: 53, strReq: 10, twoHanded: false });
weapon({ id: 0x1403, name: 'Short Spear',      category: 'fencing', skill: 43, minDamage: 8,  maxDamage: 18, speed: 46, strReq: 15, twoHanded: false });
weapon({ id: 0x0F62, name: 'Spear',            category: 'fencing', skill: 43, minDamage: 10, maxDamage: 20, speed: 30, strReq: 25, twoHanded: true });
weapon({ id: 0x26BC, name: 'Pike',             category: 'fencing', skill: 43, minDamage: 13, maxDamage: 17, speed: 25, strReq: 60, twoHanded: true });
weapon({ id: 0x0F63, name: 'Pitchfork',        category: 'fencing', skill: 43, minDamage: 4,  maxDamage: 16, speed: 38, strReq: 25, twoHanded: true });

// ---- Archery (skill 32) ---------------------------------------------
weapon({ id: 0x13B2, name: 'Bow',              category: 'bow',     skill: 32, minDamage: 9,  maxDamage: 41, speed: 25, strReq: 30, twoHanded: true });
weapon({ id: 0x0F50, name: 'Crossbow',         category: 'bow',     skill: 32, minDamage: 8,  maxDamage: 43, speed: 24, strReq: 30, twoHanded: true });
weapon({ id: 0x13FD, name: 'Heavy Crossbow',   category: 'bow',     skill: 32, minDamage: 11, maxDamage: 56, speed: 22, strReq: 80, twoHanded: true });


// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('weapons: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('weapons: ' + e.message); } }
  api.log?.('weapons: registered ' + count + ' items');
  return () => {};
}
