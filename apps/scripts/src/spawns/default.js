// Default spawn groups — ensures the shard has some wild mobs roaming
// without requiring an admin to run `[spawnmob`. Uses api.spawner, which
// calls the factory registered by npcs/aggressive.js.
//
// Ranges are near the default spawn point (1496, 1625) on facet 1 so a
// freshly logged-in test account can run into hostiles.

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.spawner) {
    api.log('spawns/default: api.spawner missing; skipping');
    return () => {};
  }

  // Britain region per `apps/scripts/src/regions/default.js:19`:
  // (1340,1470)–(1657,1730). Every spawner rect below MUST sit
  // outside that box; the previous values (1450..1610 × 1500..1770)
  // were entirely inside the guarded city which produced a
  // "wilderness-orcs in the middle of Britain" overlay on the admin
  // map (player report 2026-05-17). Distance bumps below place each
  // group within ~50 tiles of a Britain gate so a fresh test account
  // can still encounter mobs in a short walk, but on the *outside* of
  // the wall in the canonical wilderness biome.
  const groups = [
    // --- South-east of Britain south gate (~1700, 1820): farmland rats.
    {
      id: 'wilderness-rats',
      map: 1,
      rect: { x1: 1680, y1: 1800, x2: 1720, y2: 1840 },
      maxCount: 4,
      respawnMs: [30_000, 90_000],
      kinds: ['rat'],
    },
    // --- East of Britain east gate (~1720, 1600): scattered orc raid.
    // Britain east wall ends at x=1657; we start at 1720 to leave a
    // safe corridor of 60+ tiles between the orcs and the city.
    {
      id: 'wilderness-orcs',
      map: 1,
      rect: { x1: 1720, y1: 1580, x2: 1770, y2: 1630 },
      maxCount: 3,
      respawnMs: [60_000, 180_000],
      kinds: ['orc', 'skeleton'],
    },
    // --- Compassion Forest (west of Britain, near Lord British's castle
    // approach). The forest west of (1340, …) is the canonical wild biome.
    {
      id: 'forest-trolls',
      map: 1,
      rect: { x1: 1240, y1: 1500, x2: 1320, y2: 1580 },
      maxCount: 4,
      respawnMs: [90_000, 240_000],
      kinds: ['troll', 'ogre', 'ettin'],
    },
    // --- Brigand-haunted road north of Britain (Britain → Yew route).
    // Britain north wall y=1470; brigand camp on the road at y~1400.
    {
      id: 'forest-brigands',
      map: 1,
      rect: { x1: 1420, y1: 1380, x2: 1500, y2: 1440 },
      maxCount: 5,
      respawnMs: [60_000, 180_000],
      kinds: ['brigand', 'brigand', 'evil-mage'],
    },
    // --- Britain Cemetery (north of Britain Bank, just outside the
    // city wall): undead are the canon residents.
    {
      id: 'dungeon-undead',
      map: 1,
      rect: { x1: 1340, y1: 1395, x2: 1400, y2: 1445 },
      maxCount: 6,
      respawnMs: [60_000, 240_000],
      kinds: ['skeleton', 'skeleton', 'lich'],
    },
    // --- South marshes (between Britain and Trinsic road) — gazers
    // and a lone lich, slow respawn.
    {
      id: 'dungeon-gazers',
      map: 1,
      rect: { x1: 1640, y1: 1830, x2: 1690, y2: 1880 },
      maxCount: 3,
      respawnMs: [180_000, 360_000],
      kinds: ['gazer', 'gazer', 'lich'],
    },
    // --- Boss-tier lone dragon, very slow respawn, narrow rect.
    {
      id: 'dragon-lair',
      map: 1,
      rect: { x1: 1620, y1: 1740, x2: 1640, y2: 1760 },
      maxCount: 1,
      respawnMs: [600_000, 1_200_000],
      kinds: ['dragon'],
    },
    // ============ Dungeon-zone spawns (uses extracted ServUO catalog) ============
    // Despise — earth elementals + ogres
    {
      id: 'despise-elementals',
      map: 1,
      rect: { x1: 5400, y1: 600, x2: 5600, y2: 800 },
      maxCount: 6,
      respawnMs: [120_000, 300_000],
      kinds: ['earth-elemental', 'mountain-goat', 'orc', 'ogre'],
    },
    // Destard — dragons & wyverns
    {
      id: 'destard-drakes',
      map: 1,
      rect: { x1: 5200, y1: 720, x2: 5350, y2: 920 },
      maxCount: 4,
      respawnMs: [240_000, 600_000],
      kinds: ['drake', 'wyvern', 'dragon', 'ancient-wyrm'],
    },
    // Deceit — undead crypt
    {
      id: 'deceit-undead',
      map: 1,
      rect: { x1: 5160, y1: 550, x2: 5280, y2: 680 },
      maxCount: 6,
      respawnMs: [60_000, 180_000],
      kinds: ['skeleton', 'zombie', 'wraith', 'lich', 'bone-knight'],
    },
    // Hythloth — daemons & gates of hell
    {
      id: 'hythloth-daemons',
      map: 1,
      rect: { x1: 5650, y1: 1320, x2: 5950, y2: 1480 },
      maxCount: 5,
      respawnMs: [180_000, 480_000],
      kinds: ['imp', 'daemon', 'arch-daemon', 'balron', 'gargoyle'],
    },
    // Shame — water/earth elementals
    {
      id: 'shame-elementals',
      map: 1,
      rect: { x1: 5400, y1: 1820, x2: 5600, y2: 2020 },
      maxCount: 5,
      respawnMs: [120_000, 300_000],
      kinds: ['water-elemental', 'air-elemental', 'earth-elemental', 'fire-elemental'],
    },
    // Wrong — orcs & ratmen
    {
      id: 'wrong-orcs',
      map: 1,
      rect: { x1: 5650, y1: 80, x2: 6000, y2: 480 },
      maxCount: 8,
      respawnMs: [60_000, 180_000],
      kinds: ['orc', 'orc', 'orc-mage', 'orc-lord', 'ratman', 'ratman-mage'],
    },
    // Covetous — undead + slimes
    {
      id: 'covetous-mix',
      map: 1,
      rect: { x1: 5400, y1: 1820, x2: 5600, y2: 2030 },
      maxCount: 7,
      respawnMs: [60_000, 180_000],
      kinds: ['skeleton', 'slime', 'gargoyle', 'lich', 'mongbat'],
    },
    // Ice Dungeon — frost creatures
    {
      id: 'ice-frost',
      map: 1,
      rect: { x1: 5980, y1: 80, x2: 6140, y2: 480 },
      maxCount: 6,
      respawnMs: [120_000, 300_000],
      kinds: ['frost-troll', 'frost-spider', 'snow-elemental', 'ice-fiend', 'ice-serpent'],
    },
    // Fire Dungeon — fire creatures
    {
      id: 'fire-burning',
      map: 1,
      rect: { x1: 5650, y1: 1320, x2: 5950, y2: 1480 },
      maxCount: 5,
      respawnMs: [120_000, 300_000],
      kinds: ['fire-elemental', 'lava-lizard', 'hell-hound', 'phoenix'],
    },
    // ============ Wild fauna across Britannia ============
    // Yew forest — sheep/deer/bears
    {
      id: 'yew-forest',
      map: 1,
      rect: { x1: 540, y1: 800, x2: 720, y2: 1080 },
      maxCount: 8,
      respawnMs: [90_000, 240_000],
      kinds: ['great-hart', 'cougar', 'black-bear', 'grizzly-bear', 'wolf'],
    },
    // Minoc mountains — boars/cougars/skeletal wolves
    {
      id: 'minoc-wild',
      map: 1,
      rect: { x1: 2380, y1: 220, x2: 2640, y2: 440 },
      maxCount: 6,
      respawnMs: [90_000, 240_000],
      kinds: ['boar', 'cougar', 'cave-bear'],
    },
    // Trinsic swamps — alligators/snakes
    {
      id: 'trinsic-swamp',
      map: 1,
      rect: { x1: 1900, y1: 2950, x2: 2100, y2: 3100 },
      maxCount: 6,
      respawnMs: [60_000, 180_000],
      kinds: ['alligator', 'giant-serpent', 'lizardman', 'swamp-tentacle', 'mongbat'],
    },
    // Skara Brae beaches — sea serpents
    {
      id: 'skara-beach',
      map: 1,
      rect: { x1: 540, y1: 2100, x2: 720, y2: 2300 },
      maxCount: 4,
      respawnMs: [240_000, 600_000],
      kinds: ['sea-serpent', 'kraken', 'deep-sea-serpent'],
    },
    // ============ Peerless / endgame zones ============
    // Doom Gauntlet — single mega-boss + minions.
    {
      id: 'doom-gauntlet',
      map: 1,
      rect: { x1: 2450, y1: 800, x2: 2620, y2: 1000 },
      maxCount: 8,
      respawnMs: [180_000, 480_000],
      proximityRange: 60,
      kinds: [['daemon', 4], ['arch-daemon', 2], ['balron', 1], ['daemon-knight', 1]],
    },
    // Khaldun — undead + lich royalty.
    {
      id: 'khaldun-undead',
      map: 1,
      rect: { x1: 5450, y1: 1390, x2: 5610, y2: 1620 },
      maxCount: 7,
      respawnMs: [60_000, 240_000],
      proximityRange: 60,
      kinds: [['lich', 2], ['skeleton', 4], ['lich-lord', 1], ['ancient-lich', 1]],
    },
    // Painted Caves — orcs + ratmen.
    {
      id: 'painted-caves',
      map: 1,
      rect: { x1: 5070, y1: 1380, x2: 5180, y2: 1500 },
      maxCount: 6,
      respawnMs: [60_000, 180_000],
      kinds: ['orc', 'orc-mage', 'orc-lord', 'ratman'],
    },
    // Stygian Abyss (TerMur).
    {
      id: 'stygian-abyss',
      map: 4,
      rect: { x1: 935, y1: 3550, x2: 1090, y2: 3700 },
      maxCount: 5,
      respawnMs: [180_000, 480_000],
      proximityRange: 60,
      kinds: [['gargoyle', 3], ['stygian-dragon', 1], ['fire-elemental', 2]],
    },
    // Underworld — gargoyle dwellings.
    {
      id: 'underworld',
      map: 4,
      rect: { x1: 935, y1: 3700, x2: 1090, y2: 3850 },
      maxCount: 6,
      respawnMs: [120_000, 360_000],
      kinds: ['gargoyle', 'fire-gargoyle', 'stone-gargoyle', 'gargoyle-mage'],
    },
    // Tokuno wild — youroshi + lesser hiryu.
    {
      id: 'tokuno-isamu',
      map: 5,
      rect: { x1: 100, y1: 1300, x2: 1448, y2: 1448 },
      maxCount: 6,
      respawnMs: [120_000, 360_000],
      kinds: ['lesser-hiryu', 'oni', 'fan-dancer', 'tsuki-wolf', 'kappa'],
    },
    {
      id: 'tokuno-makoto',
      map: 5,
      rect: { x1: 100, y1: 700, x2: 1448, y2: 1300 },
      maxCount: 5,
      respawnMs: [120_000, 360_000],
      kinds: ['rune-beetle', 'kepetch', 'kirin', 'gaman'],
    },
    // T2A — Lost Lands (Felucca, post-T2A).
    {
      id: 'lost-lands-papua',
      map: 0,
      rect: { x1: 5670, y1: 3050, x2: 5910, y2: 3290 },
      maxCount: 6,
      respawnMs: [90_000, 240_000],
      kinds: ['terathan-warrior', 'terathan-drone', 'ophidian-warrior', 'ophidian-mage'],
    },
    {
      id: 'lost-lands-delucia',
      map: 0,
      rect: { x1: 5170, y1: 3450, x2: 5400, y2: 3680 },
      maxCount: 5,
      respawnMs: [90_000, 240_000],
      kinds: ['lizardman', 'great-hart', 'troll', 'ettin'],
    },
    // ============ Champion spawns (1 per altar — boss-tier, slow) ============
    // These are intentionally tight rects matching the altar tile.
    {
      id: 'champ-despise',
      map: 0,
      rect: { x1: 5450, y1: 770, x2: 5470, y2: 790 },
      maxCount: 1,
      respawnMs: [600_000, 1_800_000],
      proximityRange: 30,
      kinds: ['ogre-lord'],
    },
    {
      id: 'champ-destard',
      map: 0,
      rect: { x1: 5240, y1: 880, x2: 5260, y2: 900 },
      maxCount: 1,
      respawnMs: [600_000, 1_800_000],
      proximityRange: 30,
      kinds: ['ancient-wyrm'],
    },
    {
      id: 'champ-hythloth',
      map: 0,
      rect: { x1: 5775, y1: 1400, x2: 5795, y2: 1420 },
      maxCount: 1,
      respawnMs: [600_000, 1_800_000],
      proximityRange: 30,
      kinds: ['arch-daemon'],
    },
    {
      id: 'champ-shame',
      map: 0,
      rect: { x1: 5470, y1: 1880, x2: 5490, y2: 1900 },
      maxCount: 1,
      respawnMs: [600_000, 1_800_000],
      proximityRange: 30,
      kinds: ['neira'],
    },
    // ============ Town wandering NPCs (low-HP fauna near gates) ============
    {
      id: 'britain-fauna',
      map: 1,
      rect: { x1: 1430, y1: 1620, x2: 1480, y2: 1690 },
      maxCount: 4,
      respawnMs: [180_000, 600_000],
      kinds: ['cat', 'rabbit', 'cow', 'dog'],
    },
    {
      id: 'yew-fauna',
      map: 1,
      rect: { x1: 600, y1: 880, x2: 720, y2: 980 },
      maxCount: 4,
      respawnMs: [180_000, 600_000],
      kinds: ['rabbit', 'great-hart', 'sheep', 'chicken'],
    },
  ];

  for (const g of groups) api.spawner.add(g);

  return () => {
    for (const g of groups) api.spawner.remove(g.id);
  };
}
