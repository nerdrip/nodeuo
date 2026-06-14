# Architecture: server = engine, scripts = game

## Principle

> If you delete `apps/scripts/` entirely, a player should still be able
> to log in, walk around, and chat. Nothing else should work — no
> spells, no combat damage, no NPC AI, no crafting, no loot, no quests.

`apps/server/src/` = **engine only**: network, world state, persistence,
registries + dispatchers, event bus, system tick scheduler.

`apps/scripts/src/` = **game**: every spell effect, item template, mob,
recipe, loot table, quest, AI, NPC dialogue, season event, skill
implementation, gump layout. Loaded at boot by `server/src/scripts.js`.

## Layout — `apps/server/src/` (engine)

```
server/src/
├── main.js              # entry point + wiring
├── scripts.js           # script-runtime loader (hot-reload, error isolation)
├── config.js            # config loader
│
├── net/                 # TCP, packet parsing, opcode dispatch, account auth
├── world/               # world state (mobiles, items, sectors, persistence,
│                        # land/templates/loot registries, pathfinding, AI scheduler)
├── content/             # registry façades only (no content)
│   ├── ARCHITECTURE.md  # this file
│   ├── items/           # registerItem + getItem API
│   └── mobiles/         # registerMobile + getMobile API
│
├── admin/               # admin web UI server (separate HTTP listener)
│
├── chat-channels.js     # chat engine (channels, moderation, broadcast helper)
├── cliloc-broadcast.js  # broadcast cliloc helper
├── cliloc-constants.js  # cliloc id constants
├── combat-formulas.js   # combat formulas (engine defaults; scripts can override via setter)
├── corpse.js            # corpse spawn + loot drop engine + kill-hook chain
├── day-night.js         # day/night cycle engine
├── guild.js             # guild engine (CRUD + ranks)
├── help-queue.js        # GM help queue engine
├── notoriety.js         # karma/criminal rules (engine defaults; scripts can override)
├── party.js             # party engine
├── poison.js            # poison apply/cure engine (level table from scripts)
├── regen.js             # HP/mana/stam regen engine (formulas from scripts)
├── regions.js           # region engine (allow-cast, on-enter)
├── skill-gain.js        # skill gain engine (curves)
├── spawner.js           # spawner engine
└── status-effects.js    # status effect lifecycle engine
│
└── systems/             # dispatcher + registry engines, grouped:
    ├── spells/          # cast pipeline + registry + reagent engine
    │                    # (spell SCHOOLS live in scripts/spells/schools/)
    ├── crafting/        # craft pipeline + recipe registry + runic + extracted shim
    │                    # (RECIPES live in scripts/crafting/)
    ├── bards/           # bard skill dispatcher
    ├── bosses/          # peerless, champion, doom, shadowguard,
    │                    # myrmidex, khaldun, world bosses, revamped dungeons
    ├── content/         # currently empty (placeholder for future)
    ├── dispatchers/     # currently empty (placeholder)
    ├── economy/         # bods, auction, vendors, harvest, loyalty,
    │                    # cleanup britannia, points-systems, casino, insurance, store
    ├── events/          # seasonal-events scheduler, anniversary, christmas,
    │                    # easter, halloween, krampus, gift-giving
    ├── housing/         # houses, plants, addons, camps, damageable items, lotto
    ├── pets/            # pet stable, hunger, customization, training, ethereal mounts
    ├── pvp/             # factions, ethics, sigils, vvv, pvp-arena, faction-capture/strongholds
    ├── quests/          # quest registry, conversation dispatcher, ml quests
    └── rewards/         # achievements, daily-login, veteran rewards, virtues
    + ~34 misc.          # smaller engine helpers (astronomy, town-cryer,
                         # mastery-abilities, runic-reforging, etc.) — still at root
```

## Layout — `apps/scripts/src/` (game content)

```
scripts/src/
├── commands/            # player + admin commands
│   ├── admin/           # staff-only (gm, kick, ban, set, save, shutdown, ...)
│   ├── debug/           # diagnostic (info-skills, srvstats, mobs, items, who)
│   ├── system/          # world-state (daynight, season, sky, weather, atmosphere, news)
│   ├── crafting/        # craft, imbue, reforge, repair, smelt, unravel, weave, ...
│   ├── housing/         # house, design, addon, camp-place, garden, plant, ...
│   ├── magic/           # cast, rune, runebook, tithe
│   ├── combat/          # combat, disarm, duel, arena, pvp, polymorph, honor, sacrifice
│   ├── economy/         # auction, bank, bod, casino, loot, trade, vendor, ...
│   ├── guild/           # guild, party, joinguild, ethics, faction, sigil, virtues
│   ├── quest/           # quest, myrmidex, shadowguard, skulls, treasuremap, ...
│   └── (root)           # universal player cmds (help, stuck, where, time, afk, go, tele)
│
├── skills/              # skill implementations + README
│                        # (anatomy, bandage, beg, camp, chop, cook, detect-hidden,
│                        # fish, forensic, herd, hide, identify, lockpick, lore, mine,
│                        # snoop, spiritspeak, steal, stealth, tame, tasteid, track, vet,
│                        # wpn, cartography, poison)
│
├── gumps/               # server-emitted gump LAYOUTS (engine only owns dispatcher)
│                        # GuildGump, RaceChangeGump, BulkOrderGump, HelpCategoriesGump, etc.
│
├── spells/              # spell implementations
│   ├── index.js         # SINGLE registration entrypoint — top-level-awaits
│   │                    # dynamic imports for every `script` field in
│   │                    # data/config/spells.json and calls registerSpell()
│   │                    # for each. ~137 spells across 7 schools.
│   ├── schools/         # only mastery-style registries remain here:
│   │                    # masteries, bard-mastery, gargoyle. The legacy
│   │                    # per-school stubs (magery, necromancy, chivalry,
│   │                    # bushido, ninjitsu, mysticism, spellweaving)
│   │                    # were deleted 2026-05-17 — their metadata moved
│   │                    # to data/config/spells.json.
│   ├── reagents.js      # reagent table loader — projects the `reagents`
│   │                    # field out of spells.json into the server engine.
│   ├── magery/          # 64 magery spells in 8 circles
│   │   ├── circle1/     # per-spell circle 1-8 magery implementations
│   │   ├── ...
│   │   └── circle8/
│   ├── bushido/         # full bushido spell implementations
│   ├── chiv/, necro/, mysticism/, ninjitsu/, spellweaving/
│   └── _helpers.js etc.
│
├── crafting/            # craft recipe definitions per school
│                        # (alchemy, blacksmithing, carpentry, cartography, cooking,
│                        # fletching, glassblowing, inscription, masonry, tailoring, tinkering)
│
├── items/               # item content
│   ├── definitions/     # registerItem table files (weapons, armor, jewelry,
│   │                    # instruments, scrolls, wands, talismans, runic-tools, etc.)
│   ├── behaviors/       # per-item lifecycle scripts (book, doors, shrines,
│   │                    # spellbook, house-acl, pot-plants, templates, ...)
│   ├── loaders/         # JSON-driven catalogs (loot-packs, eodon-artifacts,
│   │                    # books-extended, decoratives, damageable)
│   └── scripts/         # named-script registry (item.script = 'name' lookup)
│       └── _shared/, consumables/, equipment/, functional/, lights/,
│           tools/, traps/, world/
│
├── npcs/                # NPC content
│   ├── templates/       # registerMobile table files (humanoids, animals, dragons,
│   │                    # undead, elementals, peerless, eodon-void, regional-npcs, etc.)
│   ├── ai/              # AI behaviors (mage-ai, healer, necro-ai, bard-ai, boss-ai,
│   │                    # paladin-ai, predator-ai, samurai-ai, ninja-ai, thief-ai)
│   └── vendors/         # vendor + role NPCs (banker, healer, hair-stylist, trainer,
│                        # vendor, town-crier, named, donation-vendor, eodon-quest-givers)
│
├── quests/              # quest chains (Eodon, Heartwood, Heritage Pack,
│                        # Mondain's Legacy, Solen Queen, Haven Heritage)
│                        # PLUS chain-loader.js (multi-stage chains from
│                        # data/world/quest-chains.json: Uzeraan's Turmoil,
│                        # Dark Tides, Emino's Undertaking, Haochi's Trials,
│                        # Mad Scientist, Witch's Apprentice, Collector,
│                        # Discovering Animal Training, Bard Mastery x3,
│                        # Study of the Solen Hive, The Ritual, Summoning,
│                        # Exodus Encounter, Cloak of Humility, Sacred Quest,
│                        # Exploring the Deep, Terrible Hatchlings,
│                        # Tiered Mining + Lumberjacking)
│
├── systems/             # script-runtime loaders bridging JSON data into engine systems
│                        # (anniversary, camps, addons, magincia-distillation, peerless-arenas,
│                        # poison, regen, revamped-dungeons, seasonal-events, store-inventory,
│                        # termur-content)
│
├── regions/             # region definitions
├── spawns/              # spawn definitions (xml-spawner + boss arenas)
├── data/                # pure-data JSON tables (skills, items, loot-tables,
│                        # spells, anniversary-tiers, store-catalogue,
│                        # camps, addons, regional-npcs, summons, etc.)
└── properties/          # OPL tooltip providers
```

## Script registration pattern

```js
// Top-level: data + helpers populate a local PENDING bucket
const __PENDING__ = [];
function weapon(def) { __PENDING__.push({ kind: 'weapon', ...def }); }
weapon({ id: 0x13B2, name: 'Bow', ... });

// Default export: script-runtime entry point
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) return () => {};
  for (const def of __PENDING__) reg(def);
  return () => { /* disposer for hot-reload */ };
}
```

API exposed to scripts (`server/src/scripts.js`):
- `api.world`, `api.items` (createItem/destroyItem), `api.commands`, `api.targeting`
- `api.protocol` (`@uo/protocol` packet builders)
- `api.catalog.{items,mobiles}` — registry façades
- `api.systems.{spells,crafting,...}` — engine dispatchers grouped by category
- `api.gumps` — gump send/close helpers
- `api.combat`, `api.poison`, `api.statusEffects`, `api.regions`
- `api.spawner`, `api.persistence`, `api.helpQueue`, `api.chatChannels`
- `api.log(msg)`

## What broke / changed in this reorg

- `scripts/src/commands/{admin,debug,system,crafting,housing,magic,combat,economy,guild,quest}/` — 125 root commands grouped into 10 subfolders, ~16 universal commands remain at root.
- `scripts/src/skills/` — new folder with 27 skill commands extracted from `commands/`. See `skills/README.md` for the skill table mapping.
- `scripts/src/gumps/` — new folder for server-emitted gump layouts. Engine `state.activeGumps` dispatcher is in `server/src/net/handlers.js`.
- `scripts/src/items/{definitions,behaviors,loaders}/` — 43 root files split by role.
- `scripts/src/npcs/{templates,ai,vendors}/` — 54 root files split by role.
- `server/src/systems/{pvp,bards,events,economy,pets,bosses,housing,quests,rewards}/` — 67 of 101 systems grouped.

## Migration totals (across all sessions)

- **142 content files** moved out of `server/src/` into `apps/scripts/src/`
- Engine `server/src/content/` shrunk from ~55 files to **2 façades + 2 registries** (38 lines total)
- Server `systems/` shrunk to 34 root files + 9 subgroups
- Scripts grew to ~660 files in 33 leaf folders

## Tests

`server/test/_setup-content.js` exposes `loadSpells()`, `loadCrafting()`,
`loadLootPacks()` for tests that need registries populated.

Full suite: **561/561 ✓** with `--testTimeout=30000`.

## Remaining roadmap

Roadmap previously listed in this file (Phases 5–8) still applies for
combat-formulas, notoriety, skill-gain, and the ~34 untouched systems/ files.
The reorg made navigation easier but those split tasks remain.
