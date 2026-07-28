# Script API v1

The canonical, current guide for writing server scripts now lives here:

```text
../../docs/server-scripting.md
```

This file stays in `apps/scripts/` because contributors naturally look for
script documentation near script code. Treat it as a quick pointer and compact
summary.

## Main Rule

New gameplay code should prefer high-level APIs:

- `api.game` for movement, inventory, nearby lookups, creation, and deletion;
- `api.lifecycle` for hot-reload-safe commands, events, and timers;
- `api.systems` for engine domains;
- `_inventory.js`, `_movement.js`, `_spatial.js`, and `_entities.js`;
- `defineScript` from `_script.js` for simple modules.

Raw `api.world`, `world.items`, `world.mobiles`, and private indexes are escape
hatches for administration, migrations, save/load, and rare global sweeps. Do
not use them in hot paths or normal gameplay logic.

## Minimal Pattern

```js
import { defineScript } from './_script.js';

export default defineScript({
  commands: [
    {
      name: 'ping',
      access: 'Player',
      help: '[ping',
      run(ctx) {
        ctx.state.sendSystemMessage('pong');
      },
    },
  ],
});
```

Larger modules may keep using:

```js
export default function register(api) {
  api.lifecycle.command({
    name: 'hello',
    access: 'Player',
    run(ctx) {
      ctx.state.sendSystemMessage('hello');
    },
  });
}
```

## Quick Cheatsheet

```js
api.game.inventory.packItems(mob);
api.game.inventory.findBackpack(mob);
api.game.mobile.giveItem(mob, data, { randomGrid: true });
api.game.mobile.teleport(mob, dest, { state, refresh: true });
api.game.item.move(item, { parent, x, y, z });
api.game.itemsNear(center, { range });
api.game.mobilesNear(center, { range, self });
api.game.sendToClientsNear(center, packet, { range, self });
api.lifecycle.setInterval(tick, 1000);
api.lifecycle.event('combat:hit', onHit);
api.lifecycle.command(spec);
```

Full rules, item lifecycle examples, persistence notes, doors/house data,
lights, spells, skills, and checklists are in `../../docs/server-scripting.md`.

## Gump Authoring

The visual/server/client gump model is documented in:

```text
../../docs/scripting/gumps.md
```

Use a stable `definitionId` for every first-party `api.gumps.send` call. Server
JSON overrides live in `data/config/gumps.json` and
`data/config/server-gump-catalog.json`; local client overrides live in
`apps/client/public/client-gumps.json`. These layers preserve the standard UO
protocol and fall back to the code-authored layout when an override is absent.
