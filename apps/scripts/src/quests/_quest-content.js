// Quest content authoring — registers all NPCs, monsters, items, loot
// tables, and spawns required by the Mondain's Legacy and Solen Queen
// quest chains. Single-file content authoring (avoids editing the bulk
// JSON registries directly).
//
// Loaded BEFORE `mondains-legacy.js` / `solen-queen.js` (underscore prefix
// guarantees alphabetical ordering in the script collector).
//
// What it registers:
//
//   Monsters (item-script registry):
//     pyromancer-wraith       — Bedlam target
//     mature-pixie            — drops pixie-wing for ML stage 2
//     parasitic-root          — Lord Oaks' summon (peerless boss content)
//
//   Items (template registry):
//     pixie-wing              — collectible (ML stage 2)
//     sapphire-crystal        — collectible (Solen stage 2)
//     solen-egg               — collectible (Solen stage 3)
//     heartwood-shield        — ML reward
//     ancient-greatsword      — ML reward
//     scroll-of-valor         — ML reward
//     ml-jewel                — ML reward (final)
//     solen-crown-of-power    — Solen reward
//
//   Loot tables:
//     pixie-loot              — pixie-wing 0.4
//     pyromancer-wraith-loot  — heartwood-shield 0.05 + gold + magic
//     red-solen-worker-loot   — sapphire-crystal 0.3
//     black-solen-worker-loot — sapphire-crystal 0.3
//     red-solen-warrior-loot  — sapphire-crystal 0.5 + solen-egg 0.1
//     black-solen-warrior-loot— sapphire-crystal 0.5 + solen-egg 0.1
//
//   Spawns (registered via api.spawner):
//     twisted-weald-pixies    (Twisted Weald)
//     heart-wood-treefellows  (Heart Wood region)
//     bedlam-wraiths          (Bedlam asylum)
//     red-solen-hive          (Red Solen Hive)
//     black-solen-hive        (Black Solen Hive)
//
//   NPCs (named registry):
//     aelorn                  — Heartwood quest-giver (ML stage 1)
//     lady-yelena             — Twisted Weald (ML stages 1-3)
//     lord-oaks               — Lord Oaks (NPC form, ML stage 3-4)
//                               distinct from peerless boss kind
//     wraith-elder            — Bedlam quest-giver (ML stage 5)
//     solen-emissary-red      — Red Solen Hive entrance
//     solen-emissary-black    — Black Solen Hive entrance
//     red-solen-queen-npc     — Red Solen final NPC
//     black-solen-queen-npc   — Black Solen final NPC

import { mobileBySerial } from '../_entities.js';
import { createMobile, destroyMobileBySerial } from '../_mobiles.js';
import { allMobiles } from '../_spatial.js';

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  const disposers = [];

  // ============== MONSTERS ==============
  // Most quest monsters already exist (treefellow, pixie, red/black-solen-*).
  // We add the Bedlam wraith + parasitic-root + a stronger "mature pixie".
  const monsters = [
    {
      kind: 'pyromancer-wraith',
      name: 'a pyromancer wraith',
      body: 26, hue: 0x4F2,
      hp: 220, str: 100, dex: 110, int: 130,
      notoriety: 5, aggroRange: 8, attackInterval: 1500,
      gold: [180, 320],
      loot: 'pyromancer-wraith-loot',
      mageAI: true,
      damageBreakdown: { fire: 80, energy: 20 },
      virtualArmor: 35,
    },
    {
      kind: 'mature-pixie',
      name: 'a mature pixie',
      body: 128, hue: 0x4F2,
      hp: 90, str: 50, dex: 90, int: 120,
      notoriety: 5, aggroRange: 6, attackInterval: 1300,
      gold: [40, 90],
      loot: 'pixie-loot',
      mageAI: true,
      damageBreakdown: { physical: 30, energy: 70 },
    },
    {
      kind: 'parasitic-root',
      name: 'a parasitic root',
      body: 5, hue: 0x47F,
      hp: 60, str: 70, dex: 30, int: 30,
      notoriety: 5, aggroRange: 4, attackInterval: 2000,
      gold: [0, 0],
      damageBreakdown: { physical: 100 },
    },
  ];
  if (api.monsters) {
    for (const m of monsters) {
      try { api.monsters.register(m); } catch { /* already there */ }
    }
    disposers.push(() => {
      for (const m of monsters) try { api.monsters.unregister(m.kind); } catch {}
    });
    api.log(`quest-content: ${monsters.length} quest monster templates registered`);
  }

  // ============== ITEMS ==============
  const items = [
    {
      name: 'pixie-wing', label: 'a pixie wing',
      itemId: 0x1BD1, weight: 1, hue: 0x4F2, stackable: true,
      questItem: true,
    },
    {
      name: 'sapphire-crystal', label: 'a sapphire crystal',
      itemId: 0x0F19, weight: 1, hue: 0x4F2, stackable: true,
      questItem: true,
    },
    {
      name: 'solen-egg', label: 'a solen egg',
      itemId: 0x4079, weight: 1, hue: 0x489, stackable: false,
      questItem: true,
    },
    {
      name: 'heartwood-shield', label: 'a heartwood shield',
      itemId: 0x1B7B, weight: 6, hue: 0x59,
      shield: true, ar: 18, layer: 2,
      attributes: { defenseChanceIncrease: 5, hitPointIncrease: 5 },
    },
    {
      name: 'ancient-greatsword', label: 'an ancient greatsword',
      itemId: 0x13FF, weight: 8, hue: 0x47F,
      weapon: true, layer: 1,
      damageMin: 18, damageMax: 24, weaponSpeed: 30,
      attributes: { damageIncrease: 30, hitChanceIncrease: 10 },
      slayer: 'fey',
    },
    {
      name: 'scroll-of-valor', label: 'a Scroll of Valor',
      itemId: 0x1F58, weight: 1, hue: 0x35,
      virtueScroll: { virtue: 'valor', charges: 5 },
    },
    {
      name: 'ml-jewel', label: 'a Mondain\'s Legacy Jewel',
      itemId: 0x1F09, weight: 1, hue: 0x4F2,
      layer: 25,
      attributes: { hitPointIncrease: 8, manaIncrease: 5,
                    fasterCasting: 1, defenseChanceIncrease: 5 },
    },
    {
      name: 'solen-crown-of-power', label: 'a Solen Crown of Power',
      itemId: 0x1727, weight: 2, hue: 0x489,
      layer: 6,                                    // helm
      ar: 15,
      talisman: { skillBonus: { skillId: 29, bonus: 5 } },
    },
  ];
  if (api.templates) {
    for (const t of items) {
      try { api.templates.registerTemplate(t); } catch { /* dupe */ }
    }
    disposers.push(() => {
      for (const t of items) try { api.templates.unregisterTemplate(t.name); } catch {}
    });
    api.log(`quest-content: ${items.length} quest item templates registered`);
  }

  // ============== LOOT TABLES ==============
  const tables = [
    { name: 'pixie-loot', entries: [
      { template: 'pixie-wing', chance: 0.4 },
      { template: 'gold',       chance: 0.6, amount: [20, 50] },
    ]},
    { name: 'pyromancer-wraith-loot', entries: [
      { template: 'gold',              chance: 0.9, amount: [180, 320] },
      { template: 'heartwood-shield',  chance: 0.05 },
      { template: 'scroll-of-valor',   chance: 0.02 },
    ]},
    { name: 'red-solen-worker-loot', entries: [
      { template: 'sapphire-crystal',  chance: 0.30 },
      { template: 'gold',              chance: 0.6, amount: [10, 30] },
    ]},
    { name: 'black-solen-worker-loot', entries: [
      { template: 'sapphire-crystal',  chance: 0.30 },
      { template: 'gold',              chance: 0.6, amount: [10, 30] },
    ]},
    { name: 'red-solen-warrior-loot', entries: [
      { template: 'sapphire-crystal',  chance: 0.50 },
      { template: 'solen-egg',         chance: 0.10 },
      { template: 'gold',              chance: 0.8, amount: [60, 140] },
    ]},
    { name: 'black-solen-warrior-loot', entries: [
      { template: 'sapphire-crystal',  chance: 0.50 },
      { template: 'solen-egg',         chance: 0.10 },
      { template: 'gold',              chance: 0.8, amount: [60, 140] },
    ]},
  ];
  if (api.loot) {
    for (const t of tables) {
      try { api.loot.register(t); } catch { /* dupe */ }
    }
    disposers.push(() => {
      for (const t of tables) try { api.loot.unregister(t.name); } catch {}
    });
    api.log(`quest-content: ${tables.length} quest loot tables registered`);
  }

  // ============== SPAWNS ==============
  if (api.spawner) {
    const spawnGroups = [
      // ML — Twisted Weald (Trammel forest north of Yew, OSI: ~map 1, around 2240, 1240).
      {
        id: 'twisted-weald-pixies', map: 1,
        rect: { x1: 2200, y1: 1200, x2: 2280, y2: 1280 },
        maxCount: 6, respawnMs: [60_000, 180_000],
        kinds: ['pixie', 'mature-pixie'],
      },
      // ML — Heart Wood (deeper grove, OSI: map 1, around 2300, 1100).
      {
        id: 'heart-wood-treefellows', map: 1,
        rect: { x1: 2280, y1: 1080, x2: 2360, y2: 1160 },
        maxCount: 4, respawnMs: [120_000, 240_000],
        kinds: ['treefellow', 'treefellow-guardian'],
      },
      // ML — Bedlam asylum (placeholder coords map 4 / Tokuno-side dungeon).
      {
        id: 'bedlam-wraiths', map: 4,
        rect: { x1: 100, y1: 1500, x2: 220, y2: 1620 },
        maxCount: 5, respawnMs: [120_000, 300_000],
        kinds: ['pyromancer-wraith', 'wraith'],
      },
      // Solen Hive — Red side (canonical Felucca/Trammel coords ~2740, 700).
      {
        id: 'red-solen-hive', map: 1,
        rect: { x1: 2700, y1: 660, x2: 2780, y2: 740 },
        maxCount: 8, respawnMs: [60_000, 180_000],
        kinds: ['red-solen-worker', 'red-solen-warrior'],
      },
      // Solen Hive — Black side (~5640, 1880 in dungeon coordinates).
      {
        id: 'black-solen-hive', map: 1,
        rect: { x1: 5600, y1: 1840, x2: 5680, y2: 1920 },
        maxCount: 8, respawnMs: [60_000, 180_000],
        kinds: ['black-solen-worker', 'black-solen-warrior'],
      },
    ];
    const registered = [];
    for (const g of spawnGroups) {
      try {
        api.spawner.add?.(g);
        registered.push(g.id);
      } catch (e) {
        api.log(`quest-content: spawn ${g.id} failed: ${e.message}`);
      }
    }
    disposers.push(() => {
      for (const id of registered) {
        try { api.spawner.remove?.(id, { preserveRuntime: true }); } catch { /* ignore */ }
      }
    });
    api.log(`quest-content: ${registered.length} quest spawn groups registered`);
  }

  // ============== NPCs (named registry) ==============
  // We store quest NPCs in the per-script disposable cache; the
  // `[spawnnamed` command uses NAMED from named.js, so we publish the
  // additions via api.questNamed for [questspawn to consume.
  const namedQuestNPCs = {
    'aelorn': {
      name: 'Aelorn',
      body: 0x190, hue: 0x83EA,
      role: 'elder',
      outfit: 'mage',
      notoriety: 7,
      city: 'Heartwood',
      mapHint: { map: 1, x: 1532, y: 1421 },
      says: [
        'A great corruption rises in the Twisted Weald.',
        'Speak with Lady Yelena — she will guide you.',
      ],
      questGiver: 'mondains-legacy', questStage: 0,
    },
    'lady-yelena': {
      name: 'Lady Yelena',
      body: 0x191, hue: 0x4F2,
      role: 'noble',
      outfit: 'mage',
      notoriety: 7,
      city: 'Twisted Weald',
      mapHint: { map: 1, x: 2240, y: 1240 },
      says: [
        'The forest weeps. Bring me 5 pixie wings as proof of your resolve.',
        'When you have them, I will take you to Lord Oaks.',
      ],
      questGiver: 'mondains-legacy', questStage: 1,
    },
    'lord-oaks-npc': {
      name: 'Lord Oaks',
      body: 173, hue: 0,
      role: 'lord',
      outfit: null,
      notoriety: 7,
      city: 'Heart Wood',
      mapHint: { map: 1, x: 2320, y: 1120 },
      says: [
        'Welcome, mortal. The Heart Wood thanks you.',
        'Three corrupted treefellows roam the grove. Slay them.',
      ],
      questGiver: 'mondains-legacy', questStage: 3,
    },
    'wraith-elder': {
      name: 'the Wraith Elder',
      body: 26, hue: 0x4F2,
      role: 'spirit',
      outfit: null,
      notoriety: 7,
      city: 'Bedlam',
      mapHint: { map: 4, x: 145, y: 1555 },
      says: [
        'Through madness, clarity. Through fire, rebirth.',
        'Bring me proof of the pyromancer\'s defeat.',
      ],
      questGiver: 'mondains-legacy', questStage: 4,
    },
    'solen-emissary-red': {
      name: 'a Red Solen Emissary',
      body: 0x308, hue: 0x21,
      role: 'emissary',
      outfit: null,
      notoriety: 5,
      city: 'Red Solen Hive',
      mapHint: { map: 1, x: 2740, y: 700 },
      says: [
        'You stand at the entrance of the Red Hive. Will you serve our queen?',
      ],
      questGiver: 'solen-queen', questStage: 0, side: 'red',
    },
    'solen-emissary-black': {
      name: 'a Black Solen Emissary',
      body: 0x308, hue: 0x489,
      role: 'emissary',
      outfit: null,
      notoriety: 5,
      city: 'Black Solen Hive',
      mapHint: { map: 1, x: 5640, y: 1880 },
      says: [
        'The Black Hive welcomes a worthy ally. Sapphires for the queen!',
      ],
      questGiver: 'solen-queen', questStage: 0, side: 'black',
    },
    'red-solen-queen-npc': {
      name: 'the Red Solen Queen',
      body: 0x30B, hue: 0x21,
      role: 'queen',
      outfit: null,
      notoriety: 7,
      city: 'Red Solen Hive',
      mapHint: { map: 1, x: 2755, y: 720 },
      says: [
        'Kneel, hatchling. The crown is yours.',
      ],
      questGiver: 'solen-queen', questStage: 3, side: 'red',
    },
    'black-solen-queen-npc': {
      name: 'the Black Solen Queen',
      body: 0x30B, hue: 0x489,
      role: 'queen',
      outfit: null,
      notoriety: 7,
      city: 'Black Solen Hive',
      mapHint: { map: 1, x: 5660, y: 1900 },
      says: [
        'Kneel, hatchling. The crown is yours.',
      ],
      questGiver: 'solen-queen', questStage: 3, side: 'black',
    },
  };
  // Expose the table so `[questnpc` can spawn quest NPCs without
  // duplicating the schema.
  api.questNamed = namedQuestNPCs;

  // Register a `[questnpc` command that uses _spawn helper similar to
  // [spawnnamed but reads from questNamed.
  if (api.commands) {
    api.commands.register({
      name: 'questnpc',
      help: '[questnpc <id> — spawn a quest NPC at your feet.',
      access: 'GameMaster',
      run(ctx) {
        const id = String(ctx.args[0] ?? '').toLowerCase();
        const cfg = api.questNamed?.[id];
        if (!cfg) {
          ctx.state.sendSystemMessage(`Unknown quest NPC '${id}'. Try one of: ${Object.keys(api.questNamed).join(', ')}`);
          return;
        }
        const mob = createMobile(api, api.world, {
          name: cfg.name, body: cfg.body, hue: cfg.hue ?? 0,
          notoriety: cfg.notoriety ?? 7,
          invulnerable: (cfg.notoriety ?? 7) === 7,
          x: ctx.sender.x, y: ctx.sender.y, z: ctx.sender.z, map: ctx.sender.map,
        });
        if (mob) {
          mob._greetings = cfg.says;
          mob._questGiver = cfg.questGiver;
          mob._questStage = cfg.questStage;
          mob._side = cfg.side;
          ctx.state.sendSystemMessage(`Spawned ${cfg.name}.`);
        }
      },
    });

    api.commands.register({
      name: 'questnpc-list',
      help: '[questnpc-list — show every spawnable quest NPC.',
      access: 'Player',
      run(ctx) {
        const lines = Object.entries(api.questNamed ?? {})
          .map(([id, cfg]) => `  ${id} → ${cfg.name} (${cfg.city ?? '?'}, ${cfg.questGiver ?? '?'})`);
        ctx.state.sendSystemMessage(['Quest NPCs:', ...lines].join('\n'));
      },
    });

    // Auto-spawn all canonical quest NPCs at boot. Each NPC is placed
    // at its `mapHint` coords. Re-runs on hot-reload because the
    // disposer below removes the previous batch first.
    const spawned = [];
    for (const [, cfg] of Object.entries(namedQuestNPCs)) {
      const hint = cfg.mapHint;
      if (!hint) continue;
      // Skip if already there from a prior run (find by name + position).
      const existing = [...allMobiles(api)].find((m) =>
        m.name === cfg.name && m.x === hint.x && m.y === hint.y && m.map === hint.map);
      if (existing) {
        spawned.push(existing.serial);
        continue;
      }
      const mob = createMobile(api, api.world, {
        name: cfg.name, body: cfg.body, hue: cfg.hue ?? 0,
        notoriety: cfg.notoriety ?? 7,
        invulnerable: (cfg.notoriety ?? 7) === 7,
        x: hint.x, y: hint.y, z: 0, map: hint.map,
      });
      if (mob) {
        mob._greetings = cfg.says;
        mob._questGiver = cfg.questGiver;
        mob._questStage = cfg.questStage;
        mob._side = cfg.side;
        spawned.push(mob.serial);
      }
    }
    api.log(`quest-content: ${spawned.length} quest NPCs auto-spawned`);

    disposers.push(() => {
      api.commands.unregister('questnpc');
      api.commands.unregister('questnpc-list');
      for (const serial of spawned) {
        try {
          const mob = mobileBySerial(api, serial);
          if (mob && !mob.client) destroyMobileBySerial(api, mob);
        } catch {}
      }
      delete api.questNamed;
    });
  }

  return () => {
    for (const d of disposers.reverse()) {
      try { d(); } catch (e) { console.error('[quest-content] disposer threw:', e); }
    }
  };
}
