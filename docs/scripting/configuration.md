# Configuration and world data

JSON files in `apps/scripts/src/data` are divided into type configuration and
facts placed in the world. This distinction determines whether a reload is
enough or world content must be regenerated.

## Config versus world

| Kind | Directory | Meaning |
| --- | --- | --- |
| Config | `data/config/` | what an item, mobile, spell, skill, loot table, or recipe is |
| World | `data/world/` | where content is placed, what spawns, and how a quest/event proceeds |

A config change affects new instances and systems that read their definition
live. It does not necessarily rewrite an existing item. A world-data change
does not automatically remove objects that were placed previously.

## Item identity

Do not mix a stable definition with its graphic:

```json
{
  "definitionId": "golden-hunt-ticket",
  "artId": 5359,
  "name": "golden hunt ticket",
  "hue": 2213,
  "weight": 1,
  "script": "golden-hunt-ticket"
}
```

- `definitionId` identifies gameplay and persisted data; it must be stable and unique.
- `artId`/`itemId` selects an Ultima graphic. Many definitions can share it.
- `name` is the displayed name.
- `hue` changes the palette without changing the graphic.
- `script` binds the item's lifecycle behavior.

Changing an existing `definitionId` is a data migration. Changing `artId` is
only a presentation change unless a script incorrectly relies on the graphic.

## Mobiles and AI

```json
{
  "kind": "ember-wolf",
  "name": "an ember wolf",
  "body": 225,
  "hue": 1259,
  "hp": 180,
  "str": 220,
  "dex": 140,
  "int": 60,
  "dmgMin": 8,
  "dmgMax": 14,
  "ai": "predator",
  "loot": "fire-creature"
}
```

`kind` is the stable definition; `body` is only an animation/graphic ID. `ai`
should name a behavior from the `npcs/ai` catalog. Do not copy AI code into
JSON: JSON stores the selection and parameters, while JavaScript implements
the behavior.

## Spells

```json
{
  "id": 17,
  "name": "Fireball",
  "school": "magery",
  "circle": 3,
  "skillId": 25,
  "minSkill": 300,
  "mana": 9,
  "delayMs": 1000,
  "requiresTarget": true,
  "reagents": ["Black Pearl"],
  "script": "magery/circle3/fireball.js"
}
```

Casting metadata lives in `spells.json`; effects live in modules under
`spells/`. Content Studio can open the assigned script, select another module,
and validate the casting lifecycle without executing the spell in the world.

## Main config files

| File | Responsibility |
| --- | --- |
| `items.json` | item definitions, graphics, layers, weight, and script |
| `item-types.json` | item tags and families |
| `monsters.json` | monsters, animals, bosses, and tameables |
| `npcs.json` | NPC, vendor, and resident archetypes |
| `skills.json` | canonical skill IDs and metadata |
| `spells.json` | every spell school and its linked modules |
| `recipes.json` | crafting requirements, materials, and results |
| `loot-tables.json` | named loot tables |
| `vendor-inventory.json` | vendor stock, prices, and restocking |
| `gumps.json` | visually described server gumps |

## Main world-data files

| File | Responsibility |
| --- | --- |
| `decorations.json` | map decorations |
| `signs.json` | signs and town labels |
| `teleporters.json` | transitions between locations/facets |
| `regional-npcs.json` | named NPCs at specific locations |
| `xmlspawners.json` | spawn groups and rectangles |
| `quest-chains.json` | quest steps, conditions, and rewards |
| `seasonal-events.json` | event windows and settings |

## Publishing

- Content Studio validates, shows a diff, creates a backup, and writes safely.
- Raw Data Editor handles files that do not yet have a specialized UI.
- Do not edit generated files when their header identifies a generator.
- After changing the gump catalog, run its generator instead of manually
  appending discovered records.
- Create a snapshot before changing world data. `wipeworld` is destructive.

## World lifecycle

Use the Admin **World** page or the equivalent commands for bulk world
maintenance:

- `createworld` populates every deterministic stage once and stamps the current
  content version. This includes physical faction sigils and script-owned
  landmarks/controllers such as champion altars, Doom mechanisms, Stygian
  Abyss links, Despise pillars and canonical service NPCs. Repeating it is
  explicitly refused until an operator removes or recreates the content.
- `deleteworld` removes every generated stage, despawns actors owned by its
  spawner definitions and cascades their nested inventory. It preserves
  accounts, player characters and player-owned item trees.
- `wipeworld` removes every NPC, top-level world item, house and dynamic
  side-registry entry. Accounts, player mobiles and their nested
  carried/equipped possessions are preserved. Spawner definitions remain but
  stay dormant until creation succeeds.
- `recreateworld` performs removal and population as one operator action.

All commands accept optional facet numbers in-game. Runtime-landmark and
spawner teardown honors the same facet filter as decorations, doors and
teleporters. A clean restart does not auto-seed world entities: content remains
dormant until a successful full `createworld` reopens the population gate.

Before a destructive operation, create a verified backup through the admin
workflow. Core world entities and accounts live in `world.sqlite`; routine
autosaves commit only dirty rows through SQLite WAL. A wipe also queues the
small auxiliary house, bazaar, bulletin-board and world-state snapshots. Use
graceful shutdown from the panel; it drains pending transactions, performs a
complete reconciliation and checkpoints the WAL. After restart,
**Operations → Readiness** must report a valid database, no command collisions
and zero integrity errors.

Persistence tuning:

- `UO_WAL_FLUSH_MS` — dirty-queue flush cadence; default `250` ms.
- `UO_SQLITE_BATCH_SIZE` — maximum rows per worker transaction; default `2048`.
- `UO_SQLITE_WAL_PAGES` — automatic SQLite checkpoint threshold; default `2048` pages.
- `UO_SQLITE_SYNCHRONOUS=FULL` — maximum power-loss durability at higher write latency.
- `UO_BOOTSTRAP_ADMIN_PASSWORD` with optional `UO_ADMIN_USER` — securely creates
  the first durable Admin account when the account table is empty. No default
  password is generated.
