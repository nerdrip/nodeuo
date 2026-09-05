# Game-system runtime API

The live service is available to first-party scripts as `api.systems.gameSystems`, packet handlers as `state.ctx.systems.gameSystems`, administration as `sharedCtx.systems.gameSystems`, and persistence as `world._gameSystemRuntime`.

## Read operations

```js
const catalog = api.systems.gameSystems.catalogSnapshot({
  category: 'pve',
  query: 'raid',
});
const definition = api.systems.gameSystems.definition('multiplayer-raids');
const live = api.systems.gameSystems.activeForSystem('multiplayer-raids');
const available = api.systems.gameSystems.joinableForSystem('multiplayer-raids');
const membership = api.systems.gameSystems.instanceForPlayer(mobile, 'multiplayer-raids');
const board = api.systems.gameSystems.leaderboard('multiplayer-raids', 20);
const player = api.systems.gameSystems.playerSnapshot(mobile);
const telemetry = api.systems.gameSystems.telemetrySnapshot('multiplayer-raids');
const delivered = api.systems.gameSystems.claimPendingRewards(mobile);
```

Snapshots are detached presentation objects. Do not mutate them to change the runtime.

## Mutations

```js
const started = api.systems.gameSystems.start('multiplayer-raids', {
  startedBy: mobile.serial,
});

const joined = api.systems.gameSystems.join(mobile, 'multiplayer-raids', {
  allowEnhanced: mobile.client?.supportsNodeUO?.('game.systems') === true,
});

const result = api.systems.gameSystems.act(
  mobile,
  joined.instance.id,
  'engage',
  { amount: 1, source: 'raid-script' },
);

api.systems.gameSystems.leave(mobile, joined.instance.id);

const enhanced = api.systems.gameSystems.special(
  mobile,
  joined.instance.id,
  'play-card',
  { handIndex: 0, targetSerial: '1234' },
);
```

Do not increment `instance.progress`, player gold, tokens, or scores directly. `act` performs membership, status, action, cooldown, stamina, and skill checks. `_advance` and `_reward` are internal implementation details.

The action order is mechanical, not cosmetic. Index zero executes for the highest immediate contribution and spends focus, index one supports and builds bounded team momentum, and indexes two through seven prepare at half stamina cost while building focus. Success streaks, focus, team scores, and the settled winning team are persisted and returned in player snapshots. Network requests never control `amount`; the NodeUO handler always uses one authoritative base unit. The `amount` option above is reserved for trusted first-party server scripts.

## Event-driven progress

Prefer a world event when an existing mechanic is the source of truth:

```js
api.events.emit('artifact:authenticated', {
  player: ctx.sender,
  artifactId: item.definitionId,
  gameSystemId: 'lost-observatory',
});
```

Then author the current stage as:

```json
{
  "name": "Authenticate the recovered artifact",
  "goal": 3,
  "event": "artifact:authenticated",
  "skill": "Item Identification",
  "actions": ["study", "compare", "publish"]
}
```

For a custom event to advance automatically, register a bridge in the producing script:

```js
const unsubscribe = api.events.on('artifact:authenticated', (payload) => {
  api.systems.gameSystems.recordEvent('artifact:authenticated', payload);
});
return unsubscribe;
```

Keep the player mobile under `player`, `killer`, `attacker`, `mobile`, `crafter`, `speaker`, or `source`. Add `gameSystemId` (alias `activityId`) to target one definition, or `gameSystemInstanceId` (alias `activityInstanceId`) to target one run. The runtime uses the participant and event indexes, so it never scans unrelated instances or players.

## Administration

The authenticated admin API exposes:

- `GET /api/game-systems/catalog`
- `GET /api/game-systems/catalog/:id`
- `GET /api/game-systems/instances`
- `GET /api/game-systems/telemetry`
- `POST /api/game-systems/reload`
- `POST /api/game-systems/instances`
- `POST /api/game-systems/instances/:id/transition`
- `POST /api/game-systems/simulate`

Use Content Studio for durable definition edits. The Game Systems tab is for live operation and read-only balance simulation. All mutations inherit the panel's session, CSRF, rank, and audit protections.

## Persistence and limits

`serializeWorldMeta` stores live instances, their immutable normalized definition snapshots, specialized state, telemetry, and bounded account-wide cooldown/daily counters once in the transactional world save. `MOBILE_EXT_KEYS` stores personal tokens, completion counts, titles, reputation, unlocks, character-scoped limits, cooldowns, and deferred item rewards with each character. Deferred items are retried idempotently when the profile is opened or an activity is joined. Restoring validates snapshots and rebuilds participant and event indexes instead of persisting caches.

Hard runtime limits protect the shard: 256 retained instances, 256 participants per instance, 12 stages, 8 actions per stage, 8 teams, and bounded histories. Values from JSON and network requests are normalized before use.

Completed, failed, and cancelled instances leave the hot participant and event indexes immediately. Parallel runs are created only when existing instances cannot accept another player, and all index rebuilds happen on lifecycle boundaries rather than on the main simulation path.
