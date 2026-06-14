// Boats / High Seas content — dock items, cannon ammo, galleon
// types, ship upgrades. Mirrors ServUO `Items/Multis/Boats/` +
// `Misc/HighSeas/`. The boat-system engine (`systems/boats.js`)
// already handles sailing; this file adds the static items players
// craft + interact with.



// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];

function functional(def) {
  __PENDING__.push({
    kind: 'functional',
    weight: def.weight ?? 5,
    movable: def.movable ?? true,
    ...def,
  });
}

function consumable(def) {
  __PENDING__.push({ kind: 'consumable', weight: 0.5, ...def });
}

// =====================================================================
//  DOCKING
// =====================================================================
functional({ id: 0x14F2, name: 'Dock Pier',          tagId: 'dock-pier',
             script: 'dock', weight: 200, movable: false });
functional({ id: 0x4007, name: 'Dock Crane',         tagId: 'dock-crane',
             script: 'dock-crane', weight: 250, movable: false });
functional({ id: 0x14F3, name: 'Mooring Post',       tagId: 'mooring-post',
             script: 'mooring-post', weight: 50, movable: false });
functional({ id: 0x14F4, name: 'Ship Plans (Small)', tagId: 'ship-plans-small',
             script: 'ship-plans', shipKind: 'small' });
functional({ id: 0x14F5, name: 'Ship Plans (Medium)',tagId: 'ship-plans-medium',
             script: 'ship-plans', shipKind: 'medium' });
functional({ id: 0x14F6, name: 'Ship Plans (Large)', tagId: 'ship-plans-large',
             script: 'ship-plans', shipKind: 'large' });
functional({ id: 0x14F7, name: 'Galleon Plans (Britannian)', tagId: 'galleon-plans-brit',
             script: 'ship-plans', shipKind: 'galleon-britannian' });
functional({ id: 0x14F8, name: 'Galleon Plans (Tokuno)',     tagId: 'galleon-plans-tokuno',
             script: 'ship-plans', shipKind: 'galleon-tokuno' });
functional({ id: 0x14F9, name: 'Galleon Plans (Gargish)',    tagId: 'galleon-plans-garg',
             script: 'ship-plans', shipKind: 'galleon-gargish' });
functional({ id: 0x14FA, name: 'Galleon Plans (Orcish)',     tagId: 'galleon-plans-orc',
             script: 'ship-plans', shipKind: 'galleon-orcish' });

// =====================================================================
//  CANNONS + AMMO
// =====================================================================
functional({ id: 0x4690, name: 'Light Cannon',  tagId: 'cannon-light',
             script: 'cannon', weight: 500, movable: false, cannon: { tier: 'light',  damage: [25, 35] } });
functional({ id: 0x4691, name: 'Heavy Cannon',  tagId: 'cannon-heavy',
             script: 'cannon', weight: 800, movable: false, cannon: { tier: 'heavy',  damage: [40, 60] } });
functional({ id: 0x4692, name: 'Culverin',      tagId: 'cannon-culverin',
             script: 'cannon', weight: 600, movable: false, cannon: { tier: 'culverin', damage: [30, 45] } });
functional({ id: 0x4693, name: 'Carronade',     tagId: 'cannon-carronade',
             script: 'cannon', weight: 700, movable: false, cannon: { tier: 'carronade', damage: [35, 50] } });

consumable({ id: 0x232C, name: 'Cannon Ball',           tagId: 'cannon-ball', weight: 8 });
consumable({ id: 0x232D, name: 'Heavy Cannon Ball',     tagId: 'cannon-ball-heavy', weight: 12 });
consumable({ id: 0x2334, name: 'Powder Charge',         tagId: 'powder-charge', weight: 1 });
consumable({ id: 0x2335, name: 'Strong Powder Charge',  tagId: 'powder-charge-strong', weight: 1 });
consumable({ id: 0x2336, name: 'Grape Shot',            tagId: 'cannon-grape', weight: 6 });
consumable({ id: 0x2337, name: 'Chain Shot',            tagId: 'cannon-chain', weight: 7 });
consumable({ id: 0x2338, name: 'Frost Shot',            tagId: 'cannon-frost', weight: 8 });
consumable({ id: 0x2339, name: 'Flame Shot',            tagId: 'cannon-flame', weight: 8 });

// =====================================================================
//  SHIP MISC — pumps, anchors, decoration
// =====================================================================
functional({ id: 0x4070, name: 'Bilge Pump',     tagId: 'bilge-pump',     script: 'bilge-pump',     weight: 100, movable: false });
functional({ id: 0x4071, name: 'Ship Anchor',    tagId: 'ship-anchor',    script: 'ship-anchor',    weight: 200, movable: false });
functional({ id: 0x4072, name: 'Ship Wheel',     tagId: 'ship-wheel',     script: 'ship-wheel',     weight: 50,  movable: false });
functional({ id: 0x4073, name: 'Captain\'s Cabin Door',  tagId: 'cabin-door',     script: 'cabin-door',     weight: 30,  movable: false });
functional({ id: 0x4074, name: 'Captain\'s Hold',        tagId: 'cabin-hold',     script: 'cabin-hold',     weight: 30,  movable: false });
functional({ id: 0x4075, name: 'Map Table',      tagId: 'ship-map-table', script: 'ship-map-table', weight: 60 });

// =====================================================================
//  FISHING / SAILING tools
// =====================================================================
functional({ id: 0x14EC, name: 'Sea Chart',       tagId: 'sea-chart',
             script: 'sea-chart',       weight: 4 });
functional({ id: 0x14EC, name: 'Treasure Map (Sea)', tagId: 'treasure-map-sea',
             script: 'treasure-map-sea',weight: 4, hue: 0x44 });
functional({ id: 0x0DBF, name: 'Master Fishing Pole', tagId: 'master-fishing-pole',
             kind: 'tool', fishBonus: 30, weight: 8 });
functional({ id: 0x0DC0, name: 'Lobster Trap',     tagId: 'lobster-trap',
             script: 'lobster-trap',    weight: 10 });
functional({ id: 0x0DC1, name: 'Crab Trap',        tagId: 'crab-trap',
             script: 'crab-trap',       weight: 10 });

// =====================================================================
//  MERCHANT NPCs (sea-only) — register classes here so the spawner
//  recognises them. Bodies inherit from townspeople. Moved from
//  module top-level (which imported a now-deleted catalog) into the
//  script `register()` body where `api.npcs.register` is in scope.
// =====================================================================

const SEA_NPCS = [
  ['Shipwright',    0x190, 0x067D],
  ['SeaMerchant',   0x190, 0x44],
  ['NavigationMaster', 0x190, 0x481],
  ['Harbormaster',  0x190, 0x47E],
];

// --- script entry point ----------------------------------------------
export default function register(api) {
  if (api.npcs?.register) {
    for (const [name, body, hue] of SEA_NPCS) {
      try {
        api.npcs.register({
          kind: name, body, hue,
          name: name.replace(/([A-Z])/g, ' $1').trim().toLowerCase(),
          str: [60, 100], dex: [60, 100], int: [60, 120],
          hp: 120, hpMax: 140, damage: [4, 8], ar: 18,
          skills: { 40: 600, 41: 600, 5: 700 /* fishing */ },
          loot: [{ itemId: 0x0EED, min: 100, max: 300, chance: 0.7 }],
          ai: 'melee', flags: [], fame: 200,
        });
      } catch (e) { api.log?.(`boats-extra: sea-NPC ${name} — ${e.message}`); }
    }
  }
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('boats-extra: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('boats-extra: ' + e.message); } }
  api.log?.('boats-extra: registered ' + count + ' items');
  return () => {};
}