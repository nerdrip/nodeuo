// Musical instruments — used by Bards (Discordance/Peacemaking/Provocation)
// and the Bard Mastery system. ServUO: Scripts/Items/Equipment/Instruments/.
//
// Each instrument carries:
//   • a `quality` modifier (0..2) that scales the bard skill check —
//     exceptional / mastercraft instruments roll +25% chance.
//   • a `slayerType` slot that, when set, gives a flat skill bonus when
//     the instrument's slayer matches the target creature.
//   • `usesRemaining` — instruments wear out and break (default 30 uses).
//
// Discordance/Peacemaking/Provocation read these via the bard skill
// path in `world/skills.js`. Without registered instruments the bard
// commands fall back to the no-instrument penalty (ServUO -25 effective
// skill).



// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];

function instrument(def) {
  __PENDING__.push({
    kind: 'instrument',
    usesRemaining: 30,
    quality: 0,
    ...def,
  });
}

// ---- Wind ----------------------------------------------------------
instrument({ id: 0x0E9C, name: 'Drum',          category: 'percussion', soundId: 0x0038 });
instrument({ id: 0x0E9D, name: 'Tambourine',    category: 'percussion', soundId: 0x0053 });
instrument({ id: 0x0E9E, name: 'Tambourine (Tassel)', category: 'percussion', soundId: 0x0054 });

// ---- Strings -------------------------------------------------------
instrument({ id: 0x0EB1, name: 'Lute',          category: 'string',     soundId: 0x004E });
instrument({ id: 0x0EB2, name: 'Lap Harp',      category: 'string',     soundId: 0x0044 });
instrument({ id: 0x0EB3, name: 'Standing Harp', category: 'string',     soundId: 0x0044 });

// ---- Wind ----------------------------------------------------------
instrument({ id: 0x0E9F, name: 'Bamboo Flute',  category: 'wind',       soundId: 0x004D });

// ---- Slayer-tagged instruments (drop-only, named by slayer affix) --
instrument({ id: 0x0EB1, name: 'Slayer Lute',          category: 'string',     hue: 0x046F, slayerType: 'silver' });
instrument({ id: 0x0E9C, name: 'Slayer War Drum',      category: 'percussion', hue: 0x047E, slayerType: 'undead' });


// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('instruments: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('instruments: ' + e.message); } }
  api.log?.('instruments: registered ' + count + ' items');
  return () => {};
}