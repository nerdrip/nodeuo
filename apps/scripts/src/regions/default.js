// Default region set — Britannia (Trammel facet 1) plus the canonical
// Felucca duplicates (facet 0), Lost Lands (Ilshenar facet 2), Tokuno
// (facet 5), and TerMur (facet 4). Town rectangles ported from ServUO's
// `Data/Regions.xml` + `Scripts/Regions/`. Music ids match the client
// `Music/Digital/Config.txt` mapping.

export default function (api) {
  const { regions } = api;
  if (!regions) return;

  const registered = [];
  function add(r) { registered.push(regions.register(r)); }

  // ============ Trammel (map 1) — civilised facet ============
  // Britain (centerpiece — bank + town + east farms).
  add({ name: 'Britain Bank', map: 1, guarded: true, noKill: true,
        rects: [{ x1: 1411, y1: 1538, x2: 1446, y2: 1581 }] });
  add({ name: 'Britain',      map: 1, guarded: true, music: 'britain1',
        rects: [{ x1: 1340, y1: 1470, x2: 1657, y2: 1730 }] });
  add({ name: 'Britain Sewers', map: 1, music: 'dungeon2',
        rects: [{ x1: 5114, y1: 1812, x2: 5390, y2: 2118 }] });
  // Britain farmlands.
  add({ name: 'Britain Farmlands', map: 1, music: 'forest_a',
        rects: [{ x1: 1100, y1: 1500, x2: 1340, y2: 1900 }] });

  // Yew (forest town in NW).
  add({ name: 'Yew',     map: 1, guarded: true, music: 'forest_a',
        rects: [{ x1: 540, y1: 820,  x2: 740,  y2: 1080 }] });
  add({ name: 'Empath Abbey', map: 1, guarded: true, music: 'forest_a',
        rects: [{ x1: 600, y1: 800,  x2: 720,  y2: 920 }] });
  add({ name: 'Yew Crypt', map: 1, music: 'dungeon9',
        rects: [{ x1: 911, y1: 681,  x2: 947,  y2: 738 }] });

  // Minoc (mountain town).
  add({ name: 'Minoc',     map: 1, guarded: true, music: 'mountn_a',
        rects: [{ x1: 2380, y1: 440, x2: 2640, y2: 640 }] });
  add({ name: 'Minoc Mines', map: 1, music: 'mountn_a',
        rects: [{ x1: 2410, y1: 220, x2: 2580, y2: 380 }] });

  // Trinsic (knights of paladin city).
  add({ name: 'Trinsic Bank', map: 1, guarded: true, noKill: true,
        rects: [{ x1: 1820, y1: 2767, x2: 1850, y2: 2782 }] });
  add({ name: 'Trinsic', map: 1, guarded: true, music: 'trinsic',
        rects: [{ x1: 1810, y1: 2680, x2: 2080, y2: 2950 }] });

  // Vesper (sea-faring town).
  add({ name: 'Vesper',  map: 1, guarded: true, music: 'vesper',
        rects: [{ x1: 2740, y1: 660, x2: 3010, y2: 950 }] });
  add({ name: 'Vesper Bank', map: 1, guarded: true, noKill: true,
        rects: [{ x1: 2853, y1: 681, x2: 2884, y2: 705 }] });

  // Moonglow (mage scholars).
  add({ name: 'Moonglow', map: 1, guarded: true, music: 'magincia',
        rects: [{ x1: 4406, y1: 1040, x2: 4690, y2: 1330 }] });
  add({ name: 'Moonglow Bank', map: 1, guarded: true, noKill: true,
        rects: [{ x1: 4470, y1: 1158, x2: 4498, y2: 1184 }] });

  // Magincia (city of pride — destroyed lore but still a region).
  add({ name: 'Magincia', map: 1, guarded: true, music: 'magincia',
        rects: [{ x1: 3650, y1: 2030, x2: 3850, y2: 2330 }] });
  add({ name: 'New Magincia', map: 1, guarded: true, music: 'magincia',
        rects: [{ x1: 3650, y1: 2030, x2: 3850, y2: 2330 }] });

  // Skara Brae (island town).
  add({ name: 'Skara Brae', map: 1, guarded: true, music: 'skarabrae',
        rects: [{ x1: 540,  y1: 2120, x2: 720,  y2: 2300 }] });
  add({ name: 'Skara Brae Bank', map: 1, guarded: true, noKill: true,
        rects: [{ x1: 575,  y1: 2179, x2: 600,  y2: 2207 }] });

  // Jhelom (warrior town).
  add({ name: 'Jhelom', map: 1, guarded: true, music: 'jhelom',
        rects: [{ x1: 1290, y1: 3700, x2: 1490, y2: 3920 }] });
  add({ name: 'Jhelom Bank', map: 1, guarded: true, noKill: true,
        rects: [{ x1: 1413, y1: 3819, x2: 1437, y2: 3839 }] });

  // Nujel'm (eastern island).
  add({ name: "Nujel'm", map: 1, guarded: true, music: 'samlethe',
        rects: [{ x1: 3640, y1: 1180, x2: 3870, y2: 1430 }] });
  add({ name: "Nujel'm Bank", map: 1, guarded: true, noKill: true,
        rects: [{ x1: 3753, y1: 1257, x2: 3777, y2: 1276 }] });

  // Cove (small village in Britain region).
  add({ name: 'Cove', map: 1, guarded: true, music: 'forest_a',
        rects: [{ x1: 2200, y1: 1180, x2: 2310, y2: 1280 }] });

  // Buccaneer's Den (pirate town — NOT guarded).
  add({ name: "Buccaneer's Den", map: 1, music: 'samlethe',
        rects: [{ x1: 2620, y1: 2052, x2: 2810, y2: 2245 }] });

  // Serpent's Hold (dragoon).
  add({ name: "Serpent's Hold", map: 1, guarded: true, music: 'jhelom',
        rects: [{ x1: 2960, y1: 3320, x2: 3140, y2: 3500 }] });

  // Wind (mage academy in mountains).
  add({ name: 'Wind', map: 1, guarded: true, music: 'dungeon9',
        rects: [{ x1: 5170, y1: 30, x2: 5450, y2: 290 }] });

  // Occlo (training island).
  add({ name: 'Occlo', map: 1, guarded: true, music: 'tavern02',
        rects: [{ x1: 3550, y1: 2495, x2: 3700, y2: 2680 }] });

  // ============ Dungeons (no guards, dramatic music) ============
  add({ name: 'Despise',   map: 1, music: 'dungeon9',
        rects: [{ x1: 5380, y1: 530,  x2: 5640, y2: 950 }] });
  add({ name: 'Destard',   map: 1, music: 'dungeon2',
        rects: [{ x1: 5170, y1: 690,  x2: 5380, y2: 950 }] });
  add({ name: 'Deceit',    map: 1, music: 'dungeon9',
        rects: [{ x1: 5140, y1: 530,  x2: 5300, y2: 690 }] });
  add({ name: 'Hythloth',  map: 1, music: 'dungeon9',
        rects: [{ x1: 5630, y1: 1300, x2: 5970, y2: 1500 }] });
  add({ name: 'Shame',     map: 1, music: 'dungeon9',
        rects: [{ x1: 5380, y1: 1797, x2: 5630, y2: 2046 }] });
  add({ name: 'Wrong',     map: 1, music: 'dungeon9',
        rects: [{ x1: 5630, y1: 50,   x2: 6020, y2: 510 }] });
  add({ name: 'Covetous',  map: 1, music: 'dungeon2',
        rects: [{ x1: 5380, y1: 1798, x2: 5630, y2: 2046 }] });
  add({ name: 'Ice Dungeon', map: 1, music: 'dungeon9',
        rects: [{ x1: 5950, y1: 50,   x2: 6160, y2: 510 }] });
  add({ name: 'Fire Dungeon', map: 1, music: 'dungeon2',
        rects: [{ x1: 5630, y1: 1300, x2: 5970, y2: 1500 }] });

  // ============ Felucca (map 0) — duplicates with PvP enabled ============
  // ServUO ships separate XML region files per facet (Felucca.xml +
  // Trammel.xml), not an auto-mirror at runtime. Keep the same
  // per-facet-declared approach here: only the canonical mainland
  // cities are dual-listed. Anything Felucca-specific (champion
  // altars, faction strongholds, Lost Lands) is declared inline below.
  for (const name of ['Britain', 'Yew', 'Minoc', 'Trinsic', 'Vesper',
                      'Moonglow', 'Magincia', 'Skara Brae', 'Jhelom',
                      "Nujel'm", "Buccaneer's Den"]) {
    // Reuse the trammel rect (Felucca shares geometry with map 1).
    const trammelRect = registered.find((r) => r?.name === name)?.rects?.[0];
    if (!trammelRect) continue;
    add({ name: `${name} (Felucca)`, map: 0, guarded: name !== "Buccaneer's Den",
          music: 'britain1', pvp: true,
          rects: [{ ...trammelRect }] });
  }

  // ============ Additional dungeons (peerless + special) ============
  add({ name: 'Doom Gauntlet', map: 1, music: 'dungeon9',
        rects: [{ x1: 2450, y1: 800, x2: 2620, y2: 1000 }] });
  add({ name: 'Khaldun', map: 1, music: 'dungeon2',
        rects: [{ x1: 5450, y1: 1390, x2: 5610, y2: 1620 }] });
  add({ name: 'Painted Caves', map: 1, music: 'dungeon9',
        rects: [{ x1: 5070, y1: 1380, x2: 5180, y2: 1500 }] });
  add({ name: "Travesty's Lair", map: 1, music: 'dungeon9',     // Citadel
        rects: [{ x1: 6020, y1: 50, x2: 6160, y2: 200 }] });
  add({ name: "Tomb of Kings", map: 4, music: 'dungeon2',
        rects: [{ x1: 935, y1: 3400, x2: 1100, y2: 3550 }] });
  add({ name: 'Stygian Abyss', map: 4, music: 'dungeon9',
        rects: [{ x1: 935, y1: 3550, x2: 1090, y2: 3700 }] });
  add({ name: 'Underworld', map: 4, music: 'dungeon2',
        rects: [{ x1: 935, y1: 3700, x2: 1090, y2: 3850 }] });
  // T2A — Lost Lands (Felucca facet 0, sub-region after expansion).
  add({ name: 'Papua',       map: 0, guarded: true, music: 'samlethe',
        rects: [{ x1: 5670, y1: 3050, x2: 5910, y2: 3290 }] });
  add({ name: 'Delucia',     map: 0, guarded: true, music: 'forest_a',
        rects: [{ x1: 5170, y1: 3450, x2: 5400, y2: 3680 }] });
  // Champion altars (each is a tiny named region for music + flags).
  add({ name: 'Champion - Despise',  map: 0, music: 'dungeon9',
        rects: [{ x1: 5450, y1: 770, x2: 5470, y2: 790 }] });
  add({ name: 'Champion - Destard',  map: 0, music: 'dungeon9',
        rects: [{ x1: 5240, y1: 880, x2: 5260, y2: 900 }] });
  add({ name: 'Champion - Hythloth', map: 0, music: 'dungeon9',
        rects: [{ x1: 5775, y1: 1400, x2: 5795, y2: 1420 }] });
  add({ name: 'Champion - Shame',    map: 0, music: 'dungeon9',
        rects: [{ x1: 5470, y1: 1880, x2: 5490, y2: 1900 }] });

  // ============ Tokuno (map 5) — Asian-themed continent ============
  add({ name: 'Zento', map: 5, guarded: true, music: 'tokuno1',
        rects: [{ x1: 707, y1: 1140, x2: 808, y2: 1252 }] });
  add({ name: 'Homare-Jima', map: 5, music: 'tokuno1',
        rects: [{ x1: 0, y1: 0, x2: 1448, y2: 700 }] });
  add({ name: 'Makoto-Jima', map: 5, music: 'tokuno1',
        rects: [{ x1: 0, y1: 700, x2: 1448, y2: 1300 }] });
  add({ name: 'Isamu-Jima', map: 5, music: 'tokuno1',
        rects: [{ x1: 0, y1: 1300, x2: 1448, y2: 1448 }] });

  // ============ Ilshenar (map 2) — Lost Lands ============
  add({ name: 'Lakeshire', map: 2, guarded: true, music: 'forest_a',
        rects: [{ x1: 1218, y1: 1090, x2: 1320, y2: 1180 }] });
  add({ name: 'Mistas',    map: 2, guarded: true, music: 'mountn_a',
        rects: [{ x1: 600,  y1: 750,  x2: 740,  y2: 870 }] });
  add({ name: 'Montor',    map: 2, guarded: true, music: 'magincia',
        rects: [{ x1: 1730, y1: 690,  x2: 1900, y2: 830 }] });

  // ============ TerMur (map 4) — Gargoyle realm ============
  add({ name: 'Royal City', map: 4, guarded: true, music: 'magincia',
        rects: [{ x1: 880, y1: 3400, x2: 1100, y2: 3650 }] });

  return () => {
    regions.regions = regions.regions.filter((r) => !registered.includes(r));
  };
}
