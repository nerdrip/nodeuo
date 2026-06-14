// Revamped dungeons — Shame, Wrong, Despise, Underworld, Tomb of Kings.
// Each is registered as a typed region (`type: 'dungeon'`) so combat
// allowGate = false, pvp = true, and the music + ambient track follow
// the OSI dungeon tone.
//
// Coords match ServUO `Scripts/Regions/Dungeons.cs` rectangles. Most of
// these dungeons span multiple tiers — we register the perimeter rect
// + each named sub-area at higher priority so deeper rooms can override
// the music / spell rules.

export default function (api) {
  const { regions } = api;
  if (!regions) return;

  const registered = [];
  function add(r) { registered.push(regions.register(r)); }

  // ============ SHAME (revamp) ============
  add({ name: 'Shame', map: 1, type: 'dungeon', music: 'dungeon10',
        ambientSound: 'cave-drip', priority: 0,
        rects: [{ x1: 5380, y1: 8, x2: 5639, y2: 273 }] });
  add({ name: 'Shame — Wisp Lord', map: 1, type: 'dungeon', music: 'combat',
        priority: 5, blockedSpells: ['recall', 'gate-travel'],
        rects: [{ x1: 5402, y1: 70, x2: 5440, y2: 110 }] });
  add({ name: 'Shame — Belfry', map: 1, type: 'dungeon', music: 'dungeon10',
        priority: 5, rects: [{ x1: 5510, y1: 145, x2: 5560, y2: 190 }] });

  // ============ WRONG ============
  add({ name: 'Wrong', map: 1, type: 'dungeon', music: 'dungeon2',
        ambientSound: 'cave-wind', priority: 0,
        rects: [{ x1: 5380, y1: 268, x2: 5639, y2: 525 }] });
  add({ name: 'Wrong — Gibbet', map: 1, type: 'dungeon', priority: 5,
        blockedSpells: ['recall', 'gate-travel'],
        rects: [{ x1: 5450, y1: 360, x2: 5500, y2: 410 }] });

  // ============ DESPISE (revamp — good vs evil) ============
  add({ name: 'Despise', map: 1, type: 'dungeon', music: 'dungeon9',
        ambientSound: 'forest-night', priority: 0, pvp: false,
        rects: [{ x1: 5119, y1: 528, x2: 5375, y2: 783 }] });
  add({ name: 'Despise — Good Side', map: 1, type: 'dungeon',
        priority: 4, hue: 0x59,
        rects: [{ x1: 5125, y1: 535, x2: 5240, y2: 660 }] });
  add({ name: 'Despise — Evil Side', map: 1, type: 'dungeon',
        priority: 4, hue: 0x21,
        rects: [{ x1: 5260, y1: 660, x2: 5370, y2: 780 }] });

  // ============ UNDERWORLD (Stygian Abyss) ============
  add({ name: 'Underworld', map: 5, type: 'dungeon', music: 'dungeon10',
        ambientSound: 'lava-bubble', priority: 0, pvp: false,
        rects: [{ x1: 1010, y1: 480, x2: 1330, y2: 920 }] });
  add({ name: 'Tomb of Kings', map: 5, type: 'dungeon', music: 'death',
        priority: 5, blockedSpells: ['recall', 'gate-travel'],
        rects: [{ x1: 1240, y1: 530, x2: 1310, y2: 600 }] });
  add({ name: 'Stygian Abyss — Crystal Field', map: 5, type: 'dungeon',
        priority: 4, music: 'dungeon10',
        rects: [{ x1: 100, y1: 1700, x2: 320, y2: 1900 }] });

  // ============ BLACKTHORN ============
  add({ name: "Blackthorn's Castle", map: 1, type: 'dungeon',
        music: 'combat3', priority: 0, pvp: false,
        rects: [{ x1: 6220, y1: 220, x2: 6500, y2: 480 }] });

  // ============ KHALDUN ============
  add({ name: 'Khaldun', map: 1, type: 'dungeon', music: 'death',
        ambientSound: 'crypt-whisper', priority: 0,
        rects: [{ x1: 5895, y1: 3470, x2: 6132, y2: 3645 }] });
  add({ name: 'Khaldun — Puzzle Chamber', map: 1, type: 'dungeon',
        priority: 5, blockedSpells: ['recall', 'gate-travel', 'mark'],
        rects: [{ x1: 5990, y1: 3530, x2: 6040, y2: 3580 }] });

  // ============ DOOM (Gauntlet entry) ============
  add({ name: 'Doom — Approach', map: 1, type: 'dungeon', music: 'death',
        ambientSound: 'demon-chant', priority: 0,
        rects: [{ x1: 2270, y1: 1175, x2: 2370, y2: 1290 }] });
  add({ name: 'Doom — Gauntlet', map: 1, type: 'dungeon',
        music: 'combat2', priority: 5,
        blockedSpells: ['recall', 'gate-travel', 'mark', 'sacred-journey'],
        rects: [{ x1: 360, y1: 5, x2: 420, y2: 75 }] });

  // ============ COVETOUS (Void Pool) ============
  add({ name: 'Covetous — Void Pool', map: 1, type: 'dungeon',
        music: 'combat', priority: 0,
        rects: [{ x1: 5573, y1: 1804, x2: 5681, y2: 1935 }] });

  // ============ EXODUS ENCOUNTER (Mythic Dungeon) ============
  add({ name: 'Exodus Encounter', map: 1, type: 'dungeon',
        music: 'combat3', priority: 0, pvp: false,
        rects: [{ x1: 2300, y1: 800, x2: 2500, y2: 1000 }] });

  // ============ AETHERIC CITADEL (Stygian Abyss expansion) ============
  // ServUO `Scripts/Quests/Dungeons/AethericCitadel/`. Stygian Abyss
  // mid-tier dungeon — air-elemental tier-1, lich tier-2, Aetheric
  // Lord boss at the back.
  add({ name: 'Aetheric Citadel', map: 5, type: 'dungeon',
        music: 'dungeon9', ambientSound: 'wind-howl', priority: 0,
        pvp: false,
        rects: [{ x1: 700, y1: 1100, x2: 920, y2: 1340 }] });
  add({ name: 'Aetheric Citadel — Inner Sanctum', map: 5, type: 'dungeon',
        music: 'combat', priority: 5,
        blockedSpells: ['recall', 'gate-travel', 'mark'],
        rects: [{ x1: 800, y1: 1200, x2: 870, y2: 1280 }] });

  // ============ THE SANCTUARY (Mondain's Legacy) ============
  // ServUO `Scripts/Quests/SanctuaryQuest/`. A forest-temple zone in
  // Ilshenar full of Heartwood-elf quest givers + the Sanctuary boss
  // (Aboleth-style aquatic horror).
  add({ name: 'The Sanctuary', map: 2, type: 'forest',
        music: 'forest_a', ambientSound: 'forest-birds', priority: 0,
        pvp: false,
        rects: [{ x1: 6100, y1: 100, x2: 6280, y2: 280 }] });
  add({ name: 'Sanctuary — Heart Pool', map: 2, type: 'forest',
        music: 'forest_a', priority: 5,
        rects: [{ x1: 6160, y1: 170, x2: 6210, y2: 220 }] });

  // ============ MAGINCIA NEW BAZAAR (rebuilt city) ============
  // Two zones — Trammel + Felucca. Vendor stall ring around the
  // city center coords (3713, 2113) per the canonical sigil position.
  add({ name: 'New Magincia Bazaar', map: 1, type: 'town',
        music: 'jhelom', ambientSound: 'town-day', priority: 0,
        pvp: false, guarded: true,
        rects: [{ x1: 3650, y1: 2050, x2: 3780, y2: 2180 }] });

  return () => {
    // Region registry is append-only — disposer is best-effort
    // (no-op in practice). Hot-reload re-runs init which appends a
    // fresh copy; primary() returns the latest by insertion order so
    // duplicates are harmless during dev.
  };
}
