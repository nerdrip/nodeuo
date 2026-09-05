# Gameplay systems

`apps/server/src/systems` contains reusable, server-authoritative engines. A
system validates requests, owns runtime state and exposes a narrow registration
or dispatch API. Concrete shard content lives in `apps/scripts` and registers
through those APIs.

Cross-cutting verification services include:

- `state-verification.js`: deterministic SHA-256 world fingerprints,
  checkpoints, comparisons, and bounded invariant scans;
- `content-dependency-graph.js`: cached forward/reverse imports and asset
  dependencies used by release review and Script Studio;
- `economy/transaction-ledger.js`: balanced gold postings with an append-only
  SHA-256 hash chain and reconciliation;
- `request-context.js`: `AsyncLocalStorage` propagation for NodeUO trace,
  correlation, causation, transaction, outcome, and duration fields.
- `platform-operations.js`: atomically persisted moderation cases, independent
  approvals, incident history and live-event definitions, plus memory-isolated
  preview sessions and cached script event-contract discovery.

They expose narrow snapshots to the admin API. None changes the classic UO
wire path, and none grants the enhanced client authority over world state.

## Domains

- `spells` and `crafting`: cast/craft pipelines, validation and registries;
- `bards`, `pvp`, `pets`, `housing` and `boats`: player-facing mechanics;
- `quests`, `bosses`, `events`, `economy` and `rewards`: durable domain state
  and event processing;
- runtime infrastructure at the systems root: service levels, load shedding,
  profiling, worker pools, replication, replay, NodeUO settings, per-feature
  protocol costs, shard-wide fair traffic, feature rollouts and content
  release validation.

Other engine modules remain at the systems root when a directory would add no
useful ownership boundary. The directory structure is descriptive, not a
requirement to split small cohesive modules.

## Registration pattern

Keep registries dependency-neutral. Definitions import a registry facade;
dispatchers may import definitions for startup registration, but a definition
must not import the dispatcher entry point.

```js
// registry.js
const definitions = new Map();
export function register(definition) {
  definitions.set(definition.id, Object.freeze({ ...definition }));
  return () => definitions.delete(definition.id);
}

// dispatcher.js
export function execute(id, context) {
  const definition = definitions.get(id);
  if (!definition) return { ok: false, error: 'unknown-definition' };
  return definition.run(context);
}
```

## Runtime requirements

- Validate permissions, ownership, range, revisions and resource costs on the
  server before mutating state.
- Bound queues, caches, per-pulse work and externally supplied collections.
- Use sector/AOI queries for nearby entities instead of scanning the world.
- Coalesce replaceable work and preserve ordering for authoritative work.
- Make partial mutations transactional or supply an explicit rollback path.
- Expose live counters for budgets, drops, retries and circuit-breaker state.
- Dispose timers, listeners, workers and registrations during reload/shutdown.
- Emit ordinary UO packets for classic behavior; negotiated NodeUO messages
  are optional enhancements only.

## Verification

System behavior is covered by focused tests under `apps/server/test`, the full
server suite and the short performance gates:

```powershell
pnpm --filter @uo/server test
pnpm audit:performance
pnpm audit:gameplay-performance
node tools/audit/architecture-budget.mjs
```

Long soak runs are separate release checks and are never required for ordinary
local development.
