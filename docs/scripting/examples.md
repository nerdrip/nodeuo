# Patterns and complete examples

These examples demonstrate the preferred API boundaries. They are deliberately
small: compose domain logic from helpers instead of growing a global script.

## Item lifecycle

Definition in `items.json`:

```json
{
  "definitionId": "daily-coin-token",
  "artId": 5360,
  "name": "daily coin token",
  "weight": 1,
  "script": "daily-coin-token"
}
```

Implementation:

```js
export default function register(api) {
  api.itemScripts.register({
    name: 'daily-coin-token',
    onUse({ item, user, state }) {
      const player = api.game.mobileRef(user);
      const reward = player?.giveItem({
        definitionId: 'gold',
        artId: 0x0EED,
        amount: 250,
        name: 'gold',
      }, { randomGrid: true });

      if (!reward) return state?.sendSystemMessage?.('You need a backpack.');
      api.game.item.destroy(item);
      state?.sendSystemMessage?.('Reward claimed.');
    },
  });

  return () => api.itemScripts.unregister('daily-coin-token');
}
```

## Targeting and teleportation

```js
export default function register(api) {
  api.lifecycle.command({
    name: 'blink',
    access: 'Player',
    run(ctx) {
      ctx.state.sendSystemMessage('Choose a location.');
      api.targeting.request(ctx.state, (target) => {
        if (!target) return;
        api.game.mobile.teleport(ctx.sender, {
          x: target.x,
          y: target.y,
          z: target.z,
          map: target.map ?? ctx.sender.map,
        }, { state: ctx.state, refresh: true });
      }, { allowGround: true });
    },
  });
}
```

The signature is `api.targeting.request(state, callback, options)`. Always
revalidate the selected target on the server.

## Safe event timer

```js
import { defineScript } from './_script.js';

export default defineScript({
  intervals: [{
    every: 30_000,
    run(api) {
      for (const player of api.game.onlineMobiles()) {
        if (!player._eventParticipant) continue;
        player._eventSeconds = (player._eventSeconds ?? 0) + 30;
      }
    },
  }],
});
```

The timer is removed during hot reload. Do not retain mobile objects in a
closure for many minutes; retain the serial when a durable reference is needed.

## Indexed queries

```js
const enemies = api.game.mobilesNear(caster, { range: 8, self: caster })
  .filter((mobile) => api.systems.combat?.canAttack?.(caster, mobile));

for (const enemy of enemies) {
  api.systems.combat?.damage?.(enemy, 10, caster, { type: 'fire' });
}
```

Do not scan `api.world.mobiles.values()` for every cast or AI tick.

## Administrator command with ACL

```js
export default function register(api) {
  api.lifecycle.command({
    name: 'event-status',
    access: 'GameMaster',
    help: '[event-status',
    run(ctx) {
      const online = api.game.onlineCount();
      ctx.state.sendSystemMessage(`Online: ${online}`);
    },
  });
}
```

The command registry checks access. World-mutating operations should also
validate the target, region, and current entity state.

## Pre-publication checklist

- use the public API instead of private engine imports;
- provide a lifecycle/disposer for every registration;
- keep `definitionId` separate from `artId` and `body`;
- persist serializable data without sockets, timers, or functions;
- use indexed spatial and inventory queries;
- enforce ACL and revalidate targeting/gump responses;
- add a regression test for inventory, persistence, targeting, or protocol behavior;
- run the full server test suite before publishing a larger change.
