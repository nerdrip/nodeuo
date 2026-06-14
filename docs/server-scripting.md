# Server Scripting API

This document describes the current way to write server scripts in
`apps/scripts`. The goal is to make content work comfortable in Node.js without
falling back to the old style of editing raw world maps directly. Scripts should
be readable, hot-reload-safe, and consistent with the server indexes.

## Mental Model

`apps/server/src` is the engine:

- networking and protocol;
- world state, indexes, and persistence;
- sectors, movement, visibility, and pathfinding;
- system dispatchers: combat, spells, crafting, housing, pets, quests,
  rewards, economy, PvP, and events;
- admin panel and runtime diagnostics.

`apps/scripts/src` is gameplay content:

- commands;
- item and mobile definitions;
- NPCs, vendors, and AI;
- skills, spells, crafting, and loot;
- quests, regions, events, and spawns;
- item behavior through lifecycle scripts.

A script should not import runtime modules from `apps/server/src` when the
engine can expose the needed behavior through `api.systems`, `api.game`, or a
script helper.

## Where To Add Things

| Need | Directory |
| --- | --- |
| Player/admin command | `apps/scripts/src/commands/` |
| Item template | `apps/scripts/src/items/definitions/` or `data/config/items.json` |
| Item behavior | `apps/scripts/src/items/scripts/` or `items/behaviors/` |
| Mobile/NPC template | `apps/scripts/src/npcs/templates/` or `data/config/npcs.json` |
| Vendor/dialog NPC | `apps/scripts/src/npcs/vendors/` |
| AI | `apps/scripts/src/npcs/ai/` |
| Skill | `apps/scripts/src/skills/` and `data/config/skills.json` |
| Spell | `apps/scripts/src/spells/` and `data/config/spells.json` |
| Crafting recipe | `apps/scripts/src/crafting/` or extracted JSON |
| Quest | `apps/scripts/src/quests/` or `data/world/quest-chains.json` |
| Spawn | `apps/scripts/src/spawns/` or `data/world/spawns/` |
| System bridge | `apps/scripts/src/systems/` |
| Plain data | `apps/scripts/src/data/` |

## Module Shape

The simplest module exports `register(api)` and may return a disposer:

```js
export default function register(api) {
  api.lifecycle.command({
    name: 'ping',
    access: 'Player',
    help: '[ping',
    run(ctx) {
      ctx.state.sendSystemMessage('pong');
    },
  });

  return () => {
    api.log('ping script disposed');
  };
}
```

Prefer `defineScript` for simple modules:

```js
import { defineScript } from '../_script.js';

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

  events: {
    'scripts:reloaded': (_payload, api) => {
      api.log('scripts reloaded');
    },
  },

  intervals: [
    {
      every: 60_000,
      run(api) {
        api.log('minute tick');
      },
    },
  ],
});
```

`defineScript` fits files that mostly register commands, events, timers, and
boot-time setup. For more complex systems, plain `register(api)` is still fine.

## Main API Layers

| Layer | When to use it |
| --- | --- |
| `api.game` | primary gameplay operations and indexed reads |
| `api.lifecycle` | commands, events, and timers cleaned up on hot reload |
| `api.systems` | engine domains: spells, crafting, rewards, housing, and so on |
| `api.commands` | legacy command registry; scoped, but new modules should prefer lifecycle |
| `api.itemScripts` | item behavior registry |
| `api.templates` | item templates |
| `api.catalog` | item/mobile catalogs |
| `api.protocol` | packet builders for the client |
| `api.targeting` | client target selection |
| `api.gumps` | server-side gumps |
| `api.landProvider` | land/static lookup |
| `api.housedata` | house and door role/piece indexes |
| `api.query` / `api.ops` | lower-level access when `api.game` is not enough |
| `api.world` | escape hatch for administration, global reports, and engine-like code |

## `api.game`

This is the default facade for new code.

Indexed reads:

```js
api.game.clientsNear(center, { range, self });
api.game.mobilesNear(center, { range, self });
api.game.itemsNear(center, { range });
api.game.mobilesAt(center, { self });
api.game.itemsAt(center);
api.game.allMobiles(predicate);
api.game.allItems(predicate);
api.game.onlineMobiles();
api.game.onlineCount();
api.game.findOnline(predicate);
api.game.findOnlineByName(name);
api.game.findMobile(predicate);
api.game.findItem(predicate);
api.game.findClientNear(center, predicate, { range, self });
api.game.findMobileNear(center, predicate, { range, self });
api.game.findItemNear(center, predicate, { range });
```

Broadcast:

```js
api.game.sendToClientsNear(center, packet, { range, self });
api.game.sendToOnline(packet, predicate);
```

Serial lookup:

```js
api.game.mobileBySerial(serial);
api.game.itemBySerial(serial);
api.game.entityBySerial(serial);
```

Inventory:

```js
api.game.inventory.childrenOf(parent);
api.game.inventory.descendantsOf(parent);
api.game.inventory.packItems(mobile);
api.game.inventory.equipped(mobile);
api.game.inventory.findBackpack(mobile);
api.game.inventory.findEquipped(mobile, layerOrPredicate);
api.game.inventory.findChild(parent, predicate);
api.game.inventory.findDescendant(parent, predicate);
api.game.inventory.findInPack(mobile, predicate);
api.game.inventory.isInPack(item, mobile);
api.game.inventory.isContainedBy(child, parent);
```

Mobile operations:

```js
api.game.mobile.create(data);
api.game.mobile.move(mobile, dest);
api.game.mobile.teleport(mobile, dest, { state, refresh });
api.game.mobile.giveItem(mobile, data, options);
api.game.mobile.destroy(mobileOrSerial);
```

Item operations:

```js
api.game.item.create(data);
api.game.item.move(item, dest);
api.game.item.setParent(item, parentOrSerial);
api.game.item.destroy(itemOrSerial);
```

Movement helpers:

```js
api.game.movement.resolveStandingZ(map, x, y, requestedZ);
```

## Entity Refs

For readable workflows you can use refs:

```js
const player = api.game.mobileRef(ctx.sender);
player.sendSystemMessage('Welcome back.');

const pack = player.backpack();
const regs = player.packItems((it) => it.reagent);

const reward = player.giveItem({
  itemId: 0x0EED,
  amount: 100,
  name: 'gold',
}, { randomGrid: true });

player.teleport(
  { x: 1496, y: 1624, z: 10, map: 1 },
  { state: ctx.state, refresh: true },
);

const chest = api.game.itemRef(reward);
chest.move({ parent: pack.serial });
```

Available:

```js
api.game.ref(entityOrSerial);
api.game.mobileRef(mobileOrSerial);
api.game.itemRef(itemOrSerial);
api.game.refs.EntityRef;
api.game.refs.MobileRef;
api.game.refs.ItemRef;
```

A ref resolves the entity by serial on each call. If the item/mobile disappears
after reload or deletion, methods fail softly instead of holding a stale object.

## Script Helpers

New scripts should prefer local helpers instead of duplicating runtime logic:

| Helper | Role |
| --- | --- |
| `_inventory.js` | backpack, equipment, descendants, containment |
| `_movement.js` | move/teleport mobile, move item, standing Z |
| `_spatial.js` | nearby clients/items/mobiles, online state, broadcast |
| `_entities.js` | mobile/item/entity lookup by serial |
| `_rules.js` | skill math and small gameplay rules |
| `_script.js` | `defineScript` |

Example:

```js
import { findBackpack, findInPack } from '../_inventory.js';
import { moveItem } from '../_movement.js';

export default function register(api) {
  api.lifecycle.command({
    name: 'sampleloot',
    access: 'Player',
    run(ctx) {
      const pack = findBackpack(api, ctx.sender);
      if (!pack) return ctx.state.sendSystemMessage('No backpack.');

      const gold = findInPack(api, ctx.sender, (it) => it.itemId === 0x0EED);
      if (gold) moveItem(api, gold, { parent: pack.serial, x: 70, y: 70, z: 0 });
    },
  });
}
```

## Commands

Preferred style:

```js
export default function register(api) {
  api.lifecycle.command({
    name: 'hello',
    access: 'Player',
    help: '[hello <text>',
    run(ctx, args) {
      const text = args.join(' ') || 'hello';
      ctx.state.sendSystemMessage(text);
    },
  });
}
```

`api.commands.register(spec)` still works and is scoped by the runtime, but
`api.lifecycle.command(spec)` makes registration ownership clearer and cleans up
on reload.

## Item Templates

Keep data-driven items in:

```text
apps/scripts/src/data/config/items.json
```

Typical fields:

```json
{
  "name": "torch",
  "itemId": 2578,
  "displayName": "torch",
  "amount": 1,
  "weight": 1,
  "script": "torch",
  "light": { "radius": 7, "color": "#ffd28a" }
}
```

Register in code only when the template needs logic or a generator:

```js
export default function register(api) {
  api.templates.registerTemplate({
    name: 'reward-token',
    itemId: 0x14F0,
    displayName: 'reward token',
    weight: 1,
    script: 'reward-token',
  });

  return () => api.templates.unregisterTemplate('reward-token');
}
```

## Item Lifecycle Scripts

An item with `script: 'name'` runs a named script from `api.itemScripts`.

```js
export default function register(api) {
  api.itemScripts.register({
    name: 'reward-token',

    onUse({ item, user, state }) {
      const player = api.game.mobileRef(user);
      player?.giveItem({ itemId: 0x0EED, amount: 1000, name: 'gold' });
      api.game.item.destroy(item);
      state?.sendSystemMessage?.('You claim the reward.');
    },

    onDestroy({ item }) {
      api.log(`reward token destroyed: ${item.serial}`);
    },
  });

  return () => api.itemScripts.unregister('reward-token');
}
```

The common pattern is always the same: keep logic in the script, keep
serializable data on the item, and delete through `api.game.item.destroy`.

## Mobiles And NPCs

Keep data-driven mobiles/NPCs in:

```text
apps/scripts/src/data/config/monsters.json
apps/scripts/src/data/config/npcs.json
apps/scripts/src/npcs/templates/
```

For spawns and rewards, do not create manual dependencies on raw world maps.
Use the API:

```js
const mob = api.game.mobile.create({
  kind: 'healer',
  name: 'a healer',
  body: 0x190,
  x: 1498,
  y: 1626,
  z: 10,
  map: 1,
});
```

For speech-based NPC lookup:

```js
const banker = api.game.findMobileNear(speaker, (m) => {
  return m.npcRole === 'banker' || /banker/i.test(m.name ?? '');
}, { range: 4, self: speaker });
```

## Skills

A skill should have:

- an entry in `data/config/skills.json` if it is publicly visible;
- an implementation in `apps/scripts/src/skills/`;
- a command/test hook if there is no full client support yet;
- a test or smoke check if it touches persistence, targeting, or inventory.

For skill math, use `_rules.js` instead of importing formulas from the engine.

## Spells

Spell metadata is data-driven:

```text
apps/scripts/src/data/config/spells.json
```

Implementations live in:

```text
apps/scripts/src/spells/
```

Spell effects should use domain helpers and `api.systems.spells` instead of
locally recreating the whole cast pipeline.

General rules:

- reagent, mana, delay, and disturb logic belongs to the spell system;
- a spell effect should not broadcast packets globally;
- AOE should use indexed nearby helpers;
- summons/pets should store serializable fields and register cleanup with the
  system.

## Crafting

Keep recipe data in `apps/scripts/src/crafting/` or extracted JSON. The craft
pipeline in `api.systems.crafting` should decide skill checks, materials,
success/failure, and product creation.

A recipe script should not manually remove backpack items if the pipeline
already has a consumption helper.

## Quests And Events

Quests may be code-driven or data-driven, but runtime should:

- keep progress in serializable character/account fields;
- use `api.lifecycle.event` for subscriptions;
- use `api.game.mobile.giveItem` for rewards;
- avoid timers without cleanup.

Seasonal and shard events should prefer systems in `api.systems.events` or a
bridge in `apps/scripts/src/systems`.

## Persistence

Only store serializable data in world saves:

- number/string/boolean/null;
- plain arrays and objects;
- entity serials instead of references;
- script names instead of functions.

Do not store:

- functions;
- timer handles;
- runtime classes;
- client/socket objects;
- caches that can be rebuilt on startup.

If an item/mobile needs runtime state after load, create a named script and
restore state in a hook or a boot-time sweep.

## Hot Reload

Scripts are reloaded by the runtime. Use lifecycle helpers:

```js
api.lifecycle.setInterval(tick, 10_000);
api.lifecycle.setTimeout(work, 500);
api.lifecycle.event('combat:hit', onHit);
api.lifecycle.onDispose(cleanup);
api.lifecycle.command(spec);
```

Do not use raw `setInterval` in boot-time scripts without cleanup.

Legacy `api.commands.register` is automatically scoped, but new code should
prefer `api.lifecycle.command`.

## Performance

Preferred patterns:

- nearby lookups through `api.game.*Near`;
- inventory through `api.game.inventory` or `_inventory.js`;
- item movement through `api.game.item.move`;
- teleport through `api.game.mobile.teleport`;
- broadcast through `api.game.sendToClientsNear`;
- grouped system timers with reasonable intervals;
- batched effects and no global scans in ticks.

Acceptable global scans:

- admin/debug commands;
- one-shot bootstraps;
- save/load/migrations;
- audit reports;
- rare sweeps with long intervals.

## What Not To Do

Avoid this:

```js
for (const item of api.world.items.values()) {
  if (item.parent === mob.serial) doSomething(item);
}

mob.x = x;
mob.y = y;
item.parent = pack.serial;
setInterval(tick, 1000);
```

Do this:

```js
for (const item of api.game.inventory.packItems(mob)) {
  doSomething(item);
}

api.game.mobile.teleport(mob, { x, y, z, map }, { state, refresh: true });
api.game.item.move(item, { parent: pack.serial, x: 60, y: 60, z: 0 });
api.lifecycle.setInterval(tick, 1000);
```

## Doors And Houses

House data is shared with the client through:

```text
apps/client/src/shared/housedata.js
```

For doors from house data, treat the list as closed variants. The open variant
is resolved by the accessor and current style, not by a simple even/odd item ID
rule. This matters for correct door closing and house rendering.

When creating a house/multi:

- use `api.housedata` to determine the tile role;
- do not assume `itemId % 2`;
- store serializable house metadata;
- move and destroy items through the game API so indexes stay consistent.

## Light

Items may carry light data through a template or runtime fields. The script
should set light data on the item; the renderer/engine should collect it as
world or equipment light.

Practical rules:

- torches, lanterns, and similar items should have named scripts;
- decay/light consumption should go through a cleanup-safe system or tick;
- do not send a global refresh when a nearby broadcast is enough.

## Testing

Minimum after script changes:

```powershell
pnpm --filter @uo/server test
```

For API, inventory, movement, or item lifecycle changes:

```powershell
pnpm --filter @uo/server test -- useitem-hooks.test.js
```

For client-server/protocol changes:

```powershell
pnpm --filter @uo/client run smoke:incoming-coverage
pnpm --filter @uo/client run smoke:outgoing
```

For ServUO audit changes:

```powershell
pnpm audit:servuo:map:check
```

## New Script Checklist

- Does the module export `register(api)` or `defineScript(...)`?
- Do registrations go through `api.lifecycle`?
- Are items/mobiles created and moved through `api.game`?
- Does inventory access go through a helper/API instead of raw scans?
- Do nearby/broadcast operations go through indexed helpers?
- Is entity data serializable?
- Does a disposer clean up manual registrations when lifecycle is not used?
- Does the code avoid importing runtime modules from `apps/server/src`?
- Is there a test or smoke check for regressions that are easy to break?

## Short Complete Example

```js
import { defineScript } from '../../_script.js';

export default defineScript({
  commands: (api) => [
    {
      name: 'dailycoin',
      access: 'Player',
      help: '[dailycoin',
      run(ctx) {
        const player = ctx.sender;
        const ref = api.game.mobileRef(player);
        const last = player._dailyCoinAt ?? 0;
        const now = Date.now();

        if (now - last < 24 * 60 * 60 * 1000) {
          ctx.state.sendSystemMessage('You already claimed this today.');
          return;
        }

        const item = ref?.giveItem({
          itemId: 0x0EED,
          amount: 250,
          name: 'gold',
        }, { randomGrid: true });

        if (!item) {
          ctx.state.sendSystemMessage('You need a backpack.');
          return;
        }

        player._dailyCoinAt = now;
        ctx.state.sendSystemMessage('Daily coins claimed.');
      },
    },
  ],
});
```
