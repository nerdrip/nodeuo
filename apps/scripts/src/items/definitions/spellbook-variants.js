// Spellbook variants — one per school. ServUO: Scripts/Items/Equipment/
// Spellbooks/{NecromancerSpellbook.cs, ChivalrySpellbook.cs, ...}.
//
// Each book has a distinct art id + a `school` enum the spellbook gump
// uses to pick its layout (Magery has 8 circles × 8 spells, Necro has
// 17 spells in 1 list, Chiv 10, Bushido 6, Ninjitsu 8, Spellweaving
// 16, Mysticism 16). The school tag is consumed by the 0xBF 0x1B
// NewSpellbookContent emitter on container open.



// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];

function spellbook(def) {
  __PENDING__.push({
    kind: 'spellbook',
    spellbook: true,
    layer: 1,                   // off-hand by default; Magery book usually goes 1H
    container: true,
    twoHanded: false,
    // Spell knowledge is character infrastructure, not corpse loot.
    newbied: true,
    blessed: true,
    ...def,
  });
}

// School ids match the ones our `extNewSpellbookContent` emitter uses
// as the `offset` field — derived from the first spell id in each
// school's contiguous range.
spellbook({ id: 0x0EFA, name: 'Spellbook',           school: 'magery',       firstSpellId:   1, capacity: 64 });
spellbook({ id: 0x2253, name: 'Necromancer Spellbook', school: 'necromancy', firstSpellId: 101, capacity: 17 });
spellbook({ id: 0x2252, name: 'Chivalry Spellbook',  school: 'chivalry',     firstSpellId: 201, capacity: 10 });
spellbook({ id: 0x238C, name: 'Bushido Spellbook',   school: 'bushido',      firstSpellId: 401, capacity:  6 });
spellbook({ id: 0x23A0, name: 'Ninjitsu Spellbook',  school: 'ninjitsu',     firstSpellId: 501, capacity:  8 });
spellbook({ id: 0x2D9D, name: 'Spellweaving Spellbook', school: 'spellweaving', firstSpellId: 601, capacity: 16 });
spellbook({ id: 0x2D50, name: 'Mystic Spellbook',    school: 'mysticism',    firstSpellId: 678, capacity: 16 });

// Bard-mastery / skill-mastery primer — UO modern era. Treats the
// "spellbook" as a passive item — opening it dispatches the
// CombatBookGump, not the spell-casting variant.
spellbook({ id: 0x225E, name: 'Mastery Primer',      school: 'mastery',      firstSpellId: 700, capacity: 96 });


// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('spellbook-variants: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('spellbook-variants: ' + e.message); } }
  api.log?.('spellbook-variants: registered ' + count + ' items');
  return () => {};
}
