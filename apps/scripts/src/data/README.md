# `apps/scripts/src/data/` — taxonomy

Two kinds of files live in this folder, organised into two subdirs.
Knowing which kind you're editing tells you what changes when you save,
and which loaders touch it at boot.

```
data/
├── README.md          (this file)
├── config/            (A — source-of-truth templates)
│   ├── npcs.json      (NPC archetypes — single source of truth)
│   ├── monsters.json  (701 hostile creature templates — UNIFIED)
│   ├── npc-names.json (random-name pools per race/gender/monster)
│   └── items.json, item-types.json, magic-properties.json, loot-*.json,
│       recipes.json, skills.json, spell-*.json,
│       poison-levels.json, vendor-inventory.json, store-catalogue.json,
│       housedata.json, sfx-table.js, magincia-recipes.json
└── world/             (B — placement data + quest content)
    ├── decorations.json, signs.json, teleporters.json,
    ├── regional-npcs.json, xmlspawners.json, camps.json, addons.json,
    ├── decoratives.json, quest-chains.json, quest-reward-items.json,
    ├── quests-extracted.json, revamped-dungeons.json,
    ├── seasonal-events.json, anniversary-tiers.json,
    ├── peerless-arenas.json, termur-content.json, books-extended.json,
    ├── artifacts.json, eodon-artifacts.json,
    └── spawns/         (10 JSONs — every hardcoded spawn-script block extracted)
        ├── aetheric-sanctuary.json  (2 SA boss encounters; region regex as string)
        ├── champions.json           (13 champion altar definitions)
        ├── despise-pillars.json     (2 pillars + aura cadence + buff effects)
        ├── doom-gauntlet.json       (altar + 10 gauntlet keys + 12 doom artifacts)
        ├── dungeon-revamp-bosses.json (3 boss encounters; region regex as string)
        ├── magincia-bazaar.json     (4x4 stall grid center + spacing)
        ├── moongates.json           (4 facet networks: trammel/felucca/malas/tokuno)
        ├── random-encounters.json   (6 wilderness encounter pools + cadence + chance)
        ├── storyteller-tales.json   (4-tale pool + line delay)
        └── tokuno-sky-garden.json   (Makoto-Jima center + 6 bonsai species + economy)
```

### Spawn data conventions

Every hardcoded `const ALTARS = [...]` / `const NPCS = [...]` /
`const ENCOUNTERS = [...]` block in `spawns/*.js` has been lifted into
`world/spawns/*.json`. The script keeps the logic; the JSON owns the
data. Edit the JSON and `[reload`.

Regex literals in source (`region: /Hythloth/i`) are stored as a string
in JSON; the loader compiles to `new RegExp(src, 'i')` at script-load.
Hex literals (`0x28DC`) are stored as decimal integers. Multi-line
strings with embedded `"` use JSON's standard `\"` escape.


---

## A) CONFIG / TEMPLATES — source of truth for *types*

These define **what things ARE**. A change here ripples to every spawn,
craft, drop, or skill check after the next script reload.

| File | What it defines | Consumed by |
| --- | --- | --- |
| **`config/npcs.json`** | NPC archetype templates (`kind`, `body`, `hue`, `name`, `title`, `vendorKind`, `ai`, `behavior`, `outfit`, `stats`, `skills`, `flags`, `notoriety`, `race`). The single source of truth for non-combat NPC types — bankers, healers, paladins, monks, guards, citizens. Personal names are NOT here; they're rolled at spawn-time from `npc-names.json`. | `data.js` → `NpcRegistry` (server) + `townspeople.js` → mobile catalog |
| **`config/monsters.json`** | All 701 hostile + ambient mobile templates in ONE file (UNIFIED 2026-05-16; previously split between `monsters.json` + `mobile-templates/*.json`). Each entry: `kind` (kebab-case key), `name`, `body`, `hp`, `str/dex/int`, `dmgMin/dmgMax`, `notoriety`, `aggroRange`, `attackInterval`, `gold`, `loot` (table name or inline array), `flags`, `ai`, optional `boss`/`peerless`/`tamable`/`rideable`/`specialAbilities`/`outfit`/`skills`. | `data.js` → `MonsterRegistry` (server) — consumed by `aggressive.js spawnAggressive` |
| `monsters.json` | Monster templates (429 entries): hostile creatures + animals + bosses. Fields: `kind`, `name`, `body`, `hp`, `str/dex/int`, `dmg`, `notoriety`, `gold`, `loot` (table name from `loot-tables.json`), `rare`, `tamable`, `controlSlots`. | `data.js` → `MonsterRegistry` (server) |
| `npc-names.json` | Random name pools — `human.male`/`human.female` (1487 / 2110), `tokuno`/`elf`/`gargoyle` + per-monster pools (daemon, ratman, lizardman, savage…). Extracted from ServUO `Data/names.xml` by `tools/extractors/extract-names.mjs`. | `server/src/world/npc-names.js#pickNameForMob` |
| `items.json` | Item templates (graphic, layer, weight, stackable, script hook). | `data.js` → `templates.registerTemplate` |
| `item-types.json` | Item-type→kind tags (`'weapon'`, `'armor'`, `'reagent'`) for filtering and crafting input lookup. | crafting system + admin gump |
| `magic-properties.json` | AOS magic-property catalog (HCI, DCI, SDI, Splintering, Velocity, …). | `loot.js` rollMagicProperties + reforging |
| `loot-tables.json` | Named drop tables (entries: `{template, chance, amount}`). Monsters point at one via `loot:` field. | `data.js` → `LootRegistry` |
| `loot-packs.json` | Tier-based loot packs (lich-rich, dragon-hoard, boss-rare-drop, …). | spawn/death pipeline |
| `recipes.json` + `magincia-recipes.json` | Crafting recipes (skill ID, ingredients, output template). | crafting dispatchers |
| `skills.json` | Skill registry (`id`, `name`, primary stat, group). **Canonical ID source — every `mob.skills[N]` lookup needs the right N here.** | `data.js` → `SkillRegistry` |
| `spells.json` | Unified spell catalog — one row per spell id with `{name, school, skillId, circle, minSkill, mana, delayMs, soundId, requiresTarget, reagents, script}`. Replaces the legacy `spell-names.json` + `spell-reagents.json` + `spell-data.json` triad (merged 2026-05-17). `script` points to the per-spell impl file under `apps/scripts/src/spells/<school>/<spell>.js`. | spell dispatcher + spellbook gump + reagent engine |
| `poison-levels.json` | Poison tier configs (Lesser/Regular/Greater/Deadly/Lethal) — dmg per tick, tick count, cure DC. | poison system + crafting |
| `vendor-inventory.json` | Stock per vendor-kind (item template, base price, max quantity). Paired with `npcs.json` `vendorKind`. | `vendor.js` VENDOR_KINDS aggregation |
| `store-catalogue.json` | UO Store premium currency item definitions. | `systems/economy/ultima-store.js` |
| `housedata.json` | House component catalog (wall pieces, doors, floors, stairs, roofs by category). | `data.js` → `housedata` accessor (shared with client) |
| `sfx-table.js` | Sound effect ID lookup (spell sfx, weapon hit, ambient). | spell + combat sfx broadcast |

---

## B) WORLD DATA — facts placed by `[createworld` and quest engines

These define **where things ARE** (or, for quests, what to do). They're
"world facts" the engines consume to populate a fresh shard or drive a
quest line. Editing them changes spawned state, not type behavior.

| File | What it defines | Consumed by |
| --- | --- | --- |
| `decorations.json` | 107 951 furniture / decoration statics across 6 facets — every chair, plant, table. | `[decorate` (stage of `[createworld`) |
| `signs.json` | 868 town sign placements (sign graphic + label + facet coords). | `[signgen` (stage of `[createworld`) |
| `teleporters.json` | 1374 teleporter pads across 5 facets. | `[telgen` (stage of `[createworld`) |
| `regional-npcs.json` | 141 named characters (Hawkins, Iolo, Sister Lana, Brom, Sandra…) — each gets a fixed personal name + region anchor + auto-offset placement. | `[createworld` → `RegionalNPCs` stage → `spawns/regional-npcs.js#placeRegionalNpcs` |
| `xmlspawners.json` | XML-driven monster spawn rectangles (group + per-rect kind list + cadence). | `[xmlload` stage + `XmlSpawner` |
| `camps.json` | Brigand / orc camp blueprints (tent statics + per-camp NPC list). | `systems/housing/camps.js` |
| `addons.json` | House addon definitions (placeable furniture sets, e.g. fountain, vendor stall). | housing placement + `[addon` admin |
| `decoratives.json` | Decorative items subset (christmas tree, banners). | `[decorate` + holiday systems |
| `artifacts.json` | Named-artifact registry (used both as loot definitions AND as drop targets for create-world bosses). | loot pipeline + `[artifact spawn` admin |
| `eodon-artifacts.json` | Eodon facet artifact subset (Sky Garden, tribes). | Eodon systems |
| `quest-chains.json` | Quest-chain definitions (id, prerequisites, ordered steps). | quest engine |
| `quest-reward-items.json` | Per-quest reward item table. | quest completion handler |
| `quests-extracted.json` | Full ServUO-port quest catalog (MLQuests, chain quests). | `mlQuests` system |
| `revamped-dungeons.json` | Dungeon revamp boss / room layout / encounter definitions. | `systems/bosses/*` |
| `seasonal-events.json` | Seasonal event windows (Halloween, Christmas, Krampus, Easter). | `systems/events/seasonal-events.js` |
| `anniversary-tiers.json` | Anniversary gift tier definitions (rewards by years played). | `systems/anniversary.js` |
| `peerless-arenas.json` | Peerless boss arena coords + teleport anchor per arena. | `systems/peerless` |
| `termur-content.json` | TerMur (Stygian Abyss) facet content (Royal City vendors, gargoyle districts). | TerMur boot |
| `books-extended.json` | Pre-written book texts (lore books placed by `[decorate`). | book item script |

---

## Quick rules

- Editing **CONFIG** changes how things work going forward; spawned
  state usually unaffected until next `[wipeworld` + `[createworld`.
- Editing **WORLD DATA** changes what `[createworld` places; existing
  world objects stay until `[deleteworld` + re-`[createworld` (or
  `[wipeworld`).
- A loader in `data.js` handles every CONFIG file. WORLD DATA is
  consumed lazily by its specific engine (often a `[createworld` stage
  in `commands/admin/createworld.js`).
- Don't put PERSONAL names in templates. Generic display names in
  `npcs.json`'s `name` field are OK; the spawn pipeline replaces them
  with a pick from `npc-names.json` keyed on body/race/gender.
- A few files straddle the line — `artifacts.json` is mostly config but
  also referenced as "spawn these on Doom altars" world data. When in
  doubt, the loader location decides: anything `data.js` registers is
  config; anything a `[createworld` stage or quest engine reads on demand
  is world data.
