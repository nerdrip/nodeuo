# Performance SLO and adaptive quality

NodeUO treats performance as a live service-level policy rather than a set of
unrelated constants. The standard Ultima Online packet stream is unchanged;
all controls operate inside the server, browser renderer and authenticated
admin HTTP API.

## Server

The rolling registry measures event-loop lag, world tick duration, incoming
packet handler duration and admin request duration. Recording uses bounded,
preallocated rings. Percentiles are calculated only for diagnostics snapshots,
so collecting telemetry does not add sorting or allocation to gameplay ticks.

Each policy defines:

- `target`: the normal upper bound;
- `critical`: the immediate safety boundary;
- `objective`: required share of samples within the target;
- `windowMs`: rolling observation window.

The report exposes p50, p95, p99, maximum, violation rate and error-budget burn.
The worst metric determines the aggregate `warming`, `healthy`, `degraded` or
`critical` state. Degraded pressure caps background visibility, AI and spawner
budgets; healthy observations let their existing adaptive controllers recover
gradually.

NPC AI uses a stable, allocation-light binding order and distance LOD. Active
combatants and pets run at full cadence, NPCs 25–48 tiles away run at a reduced
cadence, and NPCs outside player interest hibernate. Player movement and damage
wake affected NPCs immediately. Repeated failures open a bounded per-behavior
circuit and are visible through `AIScheduler.runtimeSnapshot()`.

Pathfinding has a per-pulse request/node budget and a short LRU of positive and
negative results. Cache keys include the collision revision of every sector
crossed by the route, so moving a door or blocking ground item invalidates only
affected paths. Long routes first use cheap validated straight segments; when a
macro obstacle defeats that route, a lazily cached regional portal graph finds
another sequence of tactical windows. Every emitted step still passes through
the normal `resolveStep` predicate. AI and spawners query the connected-player
subset of the sector index rather than walking all mobiles.

Visibility candidate arrays are conservative and shared by every observer in
the same 8x8 sector, then filtered at the exact requested range. Per-client
known sets still produce authoritative enter/leave diffs. Encoded item and
remove packets use a bounded shared LRU. WebSocket batches use one frame; raw
TCP batches use cork/scatter-gather writes where Huffman is not active. Neither
path changes packet boundaries in the UO byte stream.

Each mutation is also appended to a bounded per-sector change log. Replication
fan-out starts from connected mobiles in nearby sectors instead of every
connection, while a reconnecting v2 client can catch up from its cursor. An
overflow explicitly requests a new progressive snapshot; it never guesses at
missing state. Login snapshots are emitted once in near-to-far phases, avoiding
a duplicate all-at-once baseline.

NodeUO v2 traffic also passes through a shard-wide token bucket with bounded
per-active-peer fair shares and traffic-class weights. Critical control traffic
has a reserved pool, reliable state is deferred, and expired loss-tolerant work
is dropped. This governor is downstream of each connection budget and is never
called for classic UO packets or bridge TCP bytes.

The protocol cost registry records messages, bytes, handler/send time, errors,
deferrals and drops per negotiated feature in ten-second bounded buckets. It
does not stringify a message a second time and calculates sorting/averages only
when diagnostics are requested. The Operations cockpit exposes the history and
dry-run recommendations.

Spawner definitions are scheduled in a deadline min-heap. A pulse therefore
visits only due groups instead of scanning the full CreateWorld catalogue
(currently 6,788 groups). Mobile death and taming release slots immediately;
admin edits to `nextSpawnAt` remain live because the deadline property queues a
new versioned entry. `Spawner.runtimeSnapshot()` exposes heap, spawn, stale-row
and compaction counters.

Engine periodic work uses one deadline scheduler instead of dozens of native
intervals. Each wake has a callback/time budget and missed periods are skipped
after an event-loop stall, preventing catch-up storms. World-index validation is
incremental and locally repairing (2,048 entities per background pass), never a
full-world scan in the movement path. Property-list invalidation uses a bounded
object-to-client observer index.

World saves use SQLite WAL. Dirty mobiles/items are coalesced by serial and
committed in bounded transactions on a dedicated worker, so routine autosave
cost scales with mutations rather than total population. SQLite provides
atomic crash recovery; overlapping save requests collapse into one trailing
commit. A complete reconciliation is reserved for bootstrap, tests and clean
shutdown.

Full script reloads import the entire candidate generation before disposing the
active one. File-watch and per-file admin reload build a static import graph and
activate only the changed script plus active transitive dependents. Versioned
sibling modules propagate ESM cache busting into changed helpers. Import or
activation failures preserve/restore the previous initializers. Script timers,
events and commands have timing telemetry and a three-error circuit breaker,
and graceful shutdown disposes every script-owned resource before the final
world snapshot.

Every script-owned callback is timed at the shared lifecycle boundary. The
diagnostics view attributes calls, skips, errors, total and maximum time to its
file and resource kind. Admins can dry-run imports, pause for five minutes,
quarantine, resume or clear statistics. Pause/quarantine retains the ownership
graph and rejects work at the common gate, so recovery does not require a full
reload. Existing three-error circuit breakers remain active.

Endpoints:

- `GET /api/operations/service-levels` returns the live bounded snapshot;
- `GET /api/operations/budgets` combines SLO, API and admin-client budgets;
- `PUT /api/operations/budgets` validates, applies and atomically persists the
  policy and live AI/pathfinding/spawner/scheduler limits in
  `admin-performance-budgets.json` under the configured save folder;
- `GET /api/operations/insights` combines a machine fingerprint, capacity
  estimate, world/atlas heatmaps, guarded callback costs and evidence-backed
  recommendations;
- `GET /api/operations/performance-history` returns up to 1,440 samples for
  the current CPU/architecture/memory profile;
- `GET /api/operations/evidence-bundle` exports the bounded runtime and
  protocol evidence used to make an optimization decision.

Changing budgets requires an administrator session with fresh authentication.
The same controls are available under **Admin → Operations → Alerts &
performance budgets**.

Alert thresholds and optional webhook delivery are editable in the same view.
Webhook URLs require HTTPS, except for loopback development endpoints, and
each alert key has a configurable 10-second to 24-hour cooldown. Delivery is
best effort with a three-second timeout and never blocks an admin snapshot or
the world tick. Recommendations create reviewable drafts only; no measured
condition silently rewrites a production budget or feature rollout.

## Browser client

The adaptive quality controller samples a fixed-size frame ring and evaluates
it once per 60 frames. A slow p95/p99 or repeated long frames immediately moves
the runtime to `degraded` or `critical`. Recovery requires consecutive healthy
windows and passes through `degraded`, preventing rapid quality oscillation.

The pressure state scales chunk population, sprite mounting and weather
particles. Effects switch to their bounded low-cost path when an option is set
to `Automatic`. Explicit user choices remain authoritative and are never
rewritten in the saved profile.

Chunk/decode queues are bounded, keyed, coalesced and priority ordered. Assets
needed by the current view and PNG overrides run before speculative atlas
prefetch. Unordered renderer queues and sprite/mesh pools use constant-time swap
removal; obsolete async generations cannot mount after a facet or scene change.
Browser long-task observation complements scene update/draw timers. Supported
browsers also report JS heap, measured memory and storage quota in the exported
diagnostic bundle.

Mobile animation metadata is no longer a mandatory ~53 MiB startup document.
The Ultima importer still emits the complete `mobiles-atlas.json` compatibility
fallback, and additionally publishes a small `mobiles-atlas-index.json`, fixed
64-body metadata shards, and content-addressed PNG pages. SHA-256 and byte size
are computed while each PNG is encoded, avoiding a second multi-gigabyte read.
The index is committed last; new clients therefore see one complete generation.

The browser loads only the shards for common login-area bodies and then fetches
alias/fallback shards on demand. JSON parsing and SHA-256 verification run in a
worker, concurrent requests coalesce by immutable filename, and the Service
Worker caches hashed shards/pages for one generation. Rendering remains
synchronous after metadata arrives; a miss schedules one bounded load instead
of blocking the frame. The Animation Inspector, Assets workbench, body-coverage
report and integrity audit read the same index with monolithic fallback.

## Classic protocol and proxy

These optimizations do not introduce or alter any standard Ultima Online wire
packet. NodeUO extensions require the negotiated `nodeuo.json.v2` WebSocket
subprotocol and use text frames. Classic clients and third-party servers stay
on their original binary protocol path.
The browser bridge preserves client bytes, supplies the legacy ServUO seed, and
uses a stateful Huffman decoder across arbitrary TCP fragmentation. Both bridge
directions have soft/hard backpressure limits, bounded pre-connect buffering,
and per-message WebSocket compression is disabled to avoid double compression.
`GET /health` on the bridge exposes connection, byte, pause and overflow counts.

The bridge can be supervised across CPU cores with `UO_BRIDGE_WORKERS` and
abandons stalled target connections after `UO_BRIDGE_CONNECT_TIMEOUT_MS`.
Worker mode, TCP keepalive, `TCP_NODELAY`, queue limits and timeout handling do
not reinterpret the UO stream: opcode order and packet bytes stay unchanged.

## Profiling, replay and recovery

The server keeps bounded p50/p95/p99 samples for scheduler subsystems, event-loop
delay, event-loop utilization and GC pauses. The Operations admin page can take
a short V8 CPU profile. Automatic capture is opt-in through
`UO_AUTO_CPU_PROFILE=1`; its p99 trigger and duration are controlled by
`UO_AUTO_CPU_PROFILE_P99_MS` and `UO_AUTO_CPU_PROFILE_DURATION_MS`.

The profiler publishes opt-in `node:diagnostics_channel` events on
`nodeuo.runtime.sample`, `nodeuo.runtime.system`, and
`nodeuo.runtime.cpu-profile`. An OpenTelemetry agent or another diagnostics
subscriber can bridge these events without putting a telemetry SDK or an
allocation on the unsubscribed gameplay hot path.

Packet replay metadata is disabled by default (`UO_REPLAY_ENABLED=1` enables
it). Payload recording requires the separate `UO_REPLAY_PAYLOADS=1` opt-in.
Account and game login opcodes are always redacted even in payload mode. Replay
buffers are bounded and exports are available from the authenticated admin API.

Incremental persistence uses SQLite's native write-ahead log. It coalesces dirty
entities and flushes batches every `UO_WAL_FLUSH_MS` (default 250 ms).
`UO_SQLITE_BATCH_SIZE` defaults to 2,048 rows, `UO_SQLITE_WAL_PAGES` controls
automatic checkpoint size, and `UO_SQLITE_SYNCHRONOUS=FULL` opts into a disk
sync on every commit. The default `NORMAL` mode keeps transactions consistent
and durable across application crashes while favoring throughput.

`pnpm audit:performance` executes the short regression gate and writes
`artifacts/performance-regression.json`. Baseline replacement is an explicit
maintenance action (`node tools/audit/performance-regression.mjs --update`), not
part of normal CI.

`pnpm audit:gameplay-performance` measures dense area-of-interest queries,
hot structure-of-arrays updates, dirty-state coalescing, NodeUO JSON batching
and per-connection QoS admission. It writes a machine-readable report to
`artifacts/nodeuo-gameplay-performance.json` and uses five-pass medians to
reduce one-off scheduler noise.

The diagnostics export contains the current pressure state, percentiles,
long-frame rate and transition count. Use these checks after changes:

```powershell
pnpm --filter @uo/client run smoke:runtime-wave2
pnpm --filter @uo/server test -- service-levels.test.js runtime-governor-wave2.test.js operational-diagnostics.test.js admin-routes.test.js
pnpm --filter @uo/client build
pnpm audit:performance
pnpm audit:gameplay-performance
node tools/audit/asset-integrity.mjs
```

Multi-hour soak suites are optional release-candidate jobs, not part of this
short feedback gate.
