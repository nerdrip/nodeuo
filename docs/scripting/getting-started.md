# NodeUO Scriptbook

This guide describes how to write content for the NodeUO server. Engine code
lives in `apps/server/src`; world rules, commands, items, mobiles, AI, spells,
quests, and events belong in `apps/scripts/src`.

> The most important rule: a script uses the public `api`; it does not import
> private engine modules. This keeps it hot-reloadable, easy to test, and on
> the indexed world-access paths.

## First script

The smallest module exports a content registration function:

```js
export default function register(api) {
  api.lifecycle.command({
    name: 'hello',
    access: 'Player',
    help: '[hello',
    run(ctx) {
      ctx.state.sendSystemMessage(`Hello ${ctx.sender.name}!`);
    },
  });
}
```

`defineScript` is convenient for modules made mostly of commands, events, and
timers:

```js
import { defineScript } from './_script.js';

export default defineScript({
  commands: [{
    name: 'ping',
    access: 'Player',
    run: (ctx) => ctx.state.sendSystemMessage('pong'),
  }],
  events: {
    'scripts:reloaded': (_event, api) => api.log('scripts ready'),
  },
  intervals: [{ every: 60_000, run: (api) => api.log('minute tick') }],
});
```

## Where a feature belongs

| Feature | Canonical location |
| --- | --- |
| Command | `apps/scripts/src/commands/` |
| Item definition | `data/config/items.json` |
| Item behavior | `items/scripts/` or `items/behaviors/` |
| Mobile or NPC | `data/config/monsters.json`, `npcs.json` |
| AI | `apps/scripts/src/npcs/ai/` |
| Spell | `data/config/spells.json` + `apps/scripts/src/spells/` |
| Skill | `data/config/skills.json` + `apps/scripts/src/skills/` |
| Crafting | `data/config/recipes.json` + `apps/scripts/src/crafting/` |
| Spawn or world content | `data/world/` + `apps/scripts/src/spawns/` |
| Gump | `data/config/gumps.json` or code using `api.gumps` |

## Public API layers

| API | Purpose |
| --- | --- |
| `api.game` | creation, movement, equipment, and indexed queries |
| `api.lifecycle` | commands, events, and timers cleaned up on reload |
| `api.systems` | engine domains: spells, combat, housing, quests, and others |
| `api.gumps` | standard UO protocol gumps |
| `api.targeting` | client target selection |
| `api.itemScripts` | item lifecycle and use behavior |
| `api.templates` | item templates |
| `api.protocol` | standard UO client packets |
| `api.game.*Near` | efficient spatial queries |

`api.world` is an escape hatch for migrations, administration, and rare global
reports. Do not perform full-world scans in AI ticks.

## Admin panel workflow

1. Open **Content Studio** and select a domain such as Items, Mobiles, or Spells.
2. Edit the record and, when linked, open its script with **Edit bound script**.
3. Run validation and inspect the diff.
4. Publishing creates a backup and hot-reloads scripts.
5. Restart the server for engine changes; reloading is enough for most content changes.

## Hot-reload rules

- use `api.lifecycle.setInterval`, not raw `setInterval`;
- use `api.lifecycle.event` so the subscription is removed;
- register commands through `api.lifecycle.command`;
- retain entity serials, not runtime objects;
- manual registrations must return a disposer.

## Minimum validation

```powershell
pnpm --filter @uo/server test
```

Client/server or protocol changes additionally require the client smoke tests.
NodeUO extensions must remain negotiated; the standard Ultima Online protocol
must behave identically with third-party emulators.
