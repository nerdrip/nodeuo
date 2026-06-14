// Random world camps — ServUO `Multis/Camps/`. Each entry registers
// a spawner group that drops a small NPC pack at a fixed location with
// a campfire prop. The camp tag drives a script that decorates the
// area with tents/chests at first spawn (separate item-script
// registers `camp-decoration`).
//
// Maps:
//   1 = Trammel, 2 = Felucca (we re-use 1 for both — same tile data).

export default function register(api) {
  if (!api.spawner?.add) {
    api.log('spawn/camps: api.spawner.add unavailable');
    return () => {};
  }

  const camps = [
    // Brigand / bandit camps along Brit-Yew road
    { id: 'camp-brigand-yew',     map: 1, rect: { x1: 980,  y1: 1340, x2: 1010, y2: 1370 }, maxCount: 5, respawnMs: [600_000, 1_200_000], kinds: ['Brigand', 'Brigand', 'BrigandLeader'] },
    { id: 'camp-brigand-britain', map: 1, rect: { x1: 1810, y1: 1480, x2: 1840, y2: 1510 }, maxCount: 5, respawnMs: [600_000, 1_200_000], kinds: ['Brigand', 'Brigand', 'BrigandLeader'] },

    // Healer camps — friendly NPCs
    { id: 'camp-healer-britain', map: 1, rect: { x1: 1490, y1: 1660, x2: 1500, y2: 1670 }, maxCount: 2, respawnMs: [1_800_000, 3_600_000], kinds: ['Healer', 'Adept'] },
    { id: 'camp-healer-vesper',  map: 1, rect: { x1: 2880, y1:  680, x2: 2900, y2:  700 }, maxCount: 2, respawnMs: [1_800_000, 3_600_000], kinds: ['Healer', 'Adept'] },

    // Mage tower camp — small group of mage NPCs around a fire
    { id: 'camp-mage-tower-1', map: 1, rect: { x1: 2840, y1:  830, x2: 2860, y2:  850 }, maxCount: 4, respawnMs: [900_000, 1_800_000], kinds: ['Wanderer', 'Wanderer', 'EvilMage'] },

    // Orc camps — Orc + Orc Lord + Orc Mage
    { id: 'camp-orc-yew',     map: 1, rect: { x1: 580,  y1: 1450, x2: 620,  y2: 1490 }, maxCount: 6, respawnMs: [600_000, 1_200_000], kinds: ['Orc', 'Orc', 'OrcLord', 'OrcMage'] },
    { id: 'camp-orc-shame',   map: 1, rect: { x1: 510,  y1: 1530, x2: 550,  y2: 1570 }, maxCount: 6, respawnMs: [600_000, 1_200_000], kinds: ['Orc', 'Orc', 'OrcCaptain'] },

    // Lizardman camps — Lizardman + Shaman
    { id: 'camp-lizardman-1', map: 1, rect: { x1: 1310, y1: 2360, x2: 1340, y2: 2390 }, maxCount: 5, respawnMs: [600_000, 1_200_000], kinds: ['Lizardman', 'Lizardman', 'LizardmanShaman'] },

    // Ratman camps
    { id: 'camp-ratman-1',    map: 1, rect: { x1: 1650, y1: 1730, x2: 1680, y2: 1760 }, maxCount: 5, respawnMs: [600_000, 1_200_000], kinds: ['Ratman', 'Ratman', 'RatmanArcher'] },

    // Banker / merchant camp (caravans)
    { id: 'camp-merchant-1',  map: 1, rect: { x1: 2070, y1: 1310, x2: 2090, y2: 1330 }, maxCount: 4, respawnMs: [3_600_000, 7_200_000], kinds: ['Banker', 'Wanderer', 'Wanderer'] },

    // Pirate camp (coastal)
    { id: 'camp-pirate-1',    map: 1, rect: { x1: 4200, y1: 2900, x2: 4230, y2: 2930 }, maxCount: 5, respawnMs: [900_000, 1_800_000], kinds: ['Pirate', 'PirateCaptain'] },
  ];

  for (const c of camps) api.spawner.add(c);
  api.log(`spawn/camps: registered ${camps.length} camp groups`);

  return () => {
    for (const c of camps) api.spawner.remove?.(c.id);
  };
}
