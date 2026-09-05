# Game systems

NodeUO ships a data-driven activity layer for one hundred complete game-loop definitions. The layer does not replace the existing boss, crafting, housing, economy, quest, PvP, or world systems. It coordinates them behind one catalog, one persistence contract, one Classic UO facade, and one enhanced NodeUO workbench.

## Architecture

The server is authoritative. Joining, contribution checks, resource costs, stage progress, deadlines, teams, scores, rewards, and persistence are always evaluated by `GameSystemRuntime`. Neither client may award progress or rewards.

The catalog is `apps/scripts/src/data/config/game-systems.json`. It is a plain JSON array so Content Studio can add, copy, edit, validate, and publish individual records. The shipped catalog stores full stage objects and all operational rules explicitly. Compact stage strings remain a backwards-compatible import format, not the production authoring format.

The runtime maintains bounded indexes instead of scanning the world:

- player serial to active instance IDs;
- current world-event name to interested instance IDs;
- at most 256 live or retained instances;
- at most 256 participants per instance;
- a 256-entry operational history ring;
- per-system counters for starts, joins, progress, rejects, completions, rewards, and completion rate.

Only affected participants receive a NodeUO update. Missed scheduler periods are skipped by the shared deadline scheduler, preventing catch-up storms after event-loop stalls.

## Complete lifecycle

Every definition supports the same reliable outer lifecycle:

1. An administrator starts it, or the first player creates an instance. Activities with a minimum party size recruit before becoming active.
2. Players join up to the configured limit. Competitive systems assign the least populated team, and a full instance does not prevent another party from forming a parallel run.
3. The current stage accepts its configured actions and world events.
4. The server checks availability, prerequisites, entry cost, account uniqueness, primary skill, stamina, cooldown, rate limits, event filters, and action validity.
5. Successful contributions advance the shared stage, team score, and participant score. Ordered manual actions have real tactical roles: the first is **execute** (highest immediate progress and consumes stored focus), the second is **support** (builds shared team momentum), and later actions are **prepare** (half stamina cost and build personal focus). Consecutive success builds a bounded streak.
6. Reaching the goal moves to the next stage. The final stage completes the instance.
7. Eligible contributors receive gold, activity tokens, reputation, unlocks, titles, and rolled unique items exactly once. Competitive runs settle the unique highest-scoring team; losing-team currency is reduced while ties remain neutral. An item is queued when no backpack is available and delivered automatically when a later snapshot or join finds one.
8. Personal progression, account-wide cooldown/daily history, telemetry, immutable rule snapshots, specialized mode state, and live instances survive a world save and restart.

An expired active or recruiting activity fails cleanly. Paused time is excluded from the deadline. Operators can pause, resume, complete, or cancel it from the admin panel. `[wipeworld` removes live instances while retaining player-earned progression; a full profile reset is available through the runtime API.

## World integration

Stages may advance from explicit activity actions or real server events. Built-in bridges cover:

| Event | Typical systems |
| --- | --- |
| `mobile:killed` | invasions, raids, hunts |
| `combat:damage` | defenses and PvP |
| `speech` | narrative and social systems |
| `craft:completed` | crafting and research |
| `bod:turnedIn` | economy and delivery systems |
| `region:enter` | exploration and expeditions |

Stage records select an event, skill, explicit goal, manual actions, contribution cap, maps, regions, source/target kinds, unique-target requirement, and optional action branches. A world-event objective cannot be advanced with a UI button when `allowManual` is false. Producers may include `gameSystemId`/`activityId` or `gameSystemInstanceId`/`activityInstanceId` in an event payload to route it to exactly one definition or run. Unscoped core events retain normal quest-style behavior and can count for every matching activity the player explicitly joined.

## Existing-system adapters

The optional `adapter` field is a validated link to an established subsystem. Examples include `worldBosses`, `champion`, `peerless`, `quests`, `crafting`, `boats`, `factions`, `pvpArena`, `fireCasino`, and `communityCollections`. Missing services reject catalog reload. Linked engines may implement the explicit `gameSystemHook` lifecycle contract; adapter availability, calls, failures, and opt-in status are visible in the admin panel.

## Specialized engines

Six enhanced-only systems have bounded, persistent server engines rather than generic progress buttons:

- the collectible card game owns validated custom decks, copy limits, hands, mana, armor, health, turn order, drawing, private opponent state, card resolution, and victory;
- deckbuilding expeditions own routes, non-repeatable rest stops, encounters, enemy turns, health, energy, armor, card drafts, decks, relics, and run completion;
- the music studio owns tempo, instruments, bounded tracks and notes, editing, validation, and scored performances;
- painting and mosaics own a bounded UO-hue palette canvas, pixel updates, resizing, revision tracking, and non-duplicable publication;
- player-authored adventures own a bounded editable node graph, typed nodes, start selection, links, deletion, reachability validation, and non-duplicable published revisions;
- chronicle replays own a bounded event timeline, event selection, cursor stepping, playback speed, viewpoint, bookmarks, and validated publication.

Clients send commands and parameters only. The workbench supplies safe context-aware values for ordinary clicks (the JSON field is an optional power-user override), and the server validates and mutates every mode state. Specialized commands are phase-aware: editing actions cannot accidentally complete a later stage, while validated milestones advance the appropriate stage and only a real win/publication completes the activity.

## Shipped catalog

The catalog contains seven groups:

- World: 15 systems, including regional invasions, disasters, megaprojects, caravans, rifts, festivals, and the world chronicle.
- PvE: 15 systems, including roguelite dungeons, raids, puzzle temples, heists, the spirit realm, naval expeditions, rescues, and titan hunts.
- Narrative: 15 systems, including NPC relationships and memory, detective cases, campaigns, politics, courts, mentors, contracts, dynasties, and origins.
- Economy: 15 systems, including exchanges, companies, commissions, research, workshops, geology, farming, restaurants, enchanting, museums, smuggling, and ports.
- PvP: 14 systems, including arenas, battlegrounds, extraction, bounties, sieges, tournaments, races, relic warfare, and commander war.
- Culture: 15 systems, including cards, tavern games, racing, fishing, theatre, art, newspapers, contests, fashion, and team sport.
- Progression: 11 systems, including the atlas, bestiary, languages, mastery, legacy, dream realm, cartography, authored adventures, event direction, and replays.

The canonical names, descriptions, rules, stages, compatibility mode, view, and adapter are displayed in Content Studio and in the Game Systems admin tab. This avoids maintaining a stale copied table in documentation.

## Player entry points

- `[activities` or `[gamesystems` opens the best UI supported by the connected client.
- `[activity <id>` opens one definition.
- `[activity <id> join|leave|act|leaderboard` provides keyboard-friendly access.

The Classic gump and enhanced workbench call the same runtime methods and therefore produce identical authoritative outcomes.
