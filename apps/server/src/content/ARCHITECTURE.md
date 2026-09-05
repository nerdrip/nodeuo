# Engine and game-content boundary

NodeUO keeps reusable runtime mechanics in `apps/server` and shard-specific
gameplay in `apps/scripts`.

The practical boundary is simple: removing `apps/scripts` must still leave a
server that can accept a connection, enter the world, move and speak. Spells,
combat rules, NPC behavior, quests, loot, recipes and other shard content are
registered by scripts at startup.

## Ownership

`apps/server/src` owns:

- TCP and WebSocket transport, the original UO packet stream and optional
  negotiated NodeUO JSON services;
- accounts, world state, sectors, visibility, persistence and recovery;
- schedulers, budgets, backpressure, replication and diagnostics;
- registries and dispatch pipelines for spells, crafting, AI, quests, items,
  gumps and other gameplay domains;
- the authenticated administration API and control surfaces.

`apps/scripts/src` owns:

- commands and skill actions;
- spell effects, recipes, loot tables and item behavior;
- mobile templates, NPC AI, vendors and scripted dialog;
- quests, regions, spawns, gump layouts and shard data;
- adapters that register data-driven content with server engines.

Script code may call an engine API, but engine code must not import a concrete
shard script. Registry facades in `server/src/content` and dispatchers in
`server/src/systems` maintain that dependency direction.

## Runtime lifecycle

Every script module exports a registration function. Registration returns a
disposer for commands, event handlers, timers and registry entries created by
that generation.

```js
export default function register(api) {
  const unregister = api.commands.register('example', ({ mobile }) => {
    api.log(`Example command used by ${mobile.serial}`);
  });
  return () => unregister();
}
```

Reloads are transactional: the candidate generation is imported and activated
before the previous generation is disposed. A failed import or activation
keeps the active generation intact. File-scoped reload follows the static
import graph so changed helpers also reload their active dependants.

The script API exposes bounded facades for world state, items, targeting,
packets, gumps, combat, status effects, regions, persistence, chat, commands,
content registries and gameplay systems. Private client features go through
the negotiated `api.nodeUO` gateway and never replace standard UO behavior.

## Layout

```text
apps/server/src/
  net/        transports, parsers, sessions and protocol handlers
  world/      authoritative entities, sectors, AI and persistence
  systems/    reusable gameplay engines and registries
  content/    dependency-neutral content registry facades
  admin/      authenticated API and administration UI

apps/scripts/src/
  commands/   player, staff and diagnostic commands
  skills/     skill actions
  spells/     spell implementations and metadata adapters
  crafting/   recipe definitions
  items/      definitions, loaders and behaviors
  npcs/       templates, AI and vendors
  quests/     quest definitions and chains
  gumps/      server-authored UI layouts
  regions/    region rules
  spawns/     spawn definitions
  systems/    data-to-engine registration adapters
  data/       version-controlled shard configuration
```

## Rules for new code

1. Put reusable state transitions, validation and scheduling in the server.
2. Put names, balance values, spawn lists and shard behavior in scripts/data.
3. Import registry modules instead of importing a system entry point from a
   domain definition; this avoids registration cycles.
4. Return a disposer for every registered resource.
5. Keep all input bounded and keep authoritative decisions on the server.
6. Preserve the classic UO packet path when adding optional NodeUO behavior.

Run `pnpm --filter @uo/server test` and `pnpm lint` after changing the boundary.
