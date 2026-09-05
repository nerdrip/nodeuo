# NodeUO JSON v2 and the UO compatibility contract

NodeUO has two deliberately separate application protocols on one WebSocket:

- binary frames contain only the original Ultima Online byte stream;
- text frames contain only bounded NodeUO JSON v2 envelopes;
- private JSON is enabled only when both peers select `nodeuo.json.v2`.

The original UO protocol remains authoritative for login, characters,
movement, combat, inventory, speech, vendors, gumps and world entry. NodeUO
JSON adds optional presentation, replication and tooling. It never becomes a
requirement for playing on the shard.

## Compatibility matrix

| Client | Server path | Result |
| --- | --- | --- |
| ClassicUO, Razor, UO Steam or an OSI-style client | NodeUO raw TCP listener | Original UO packets only |
| NodeUO browser client | ServUO, POL, RunUO or another emulator through the bridge | Original UO packets only |
| NodeUO browser client | NodeUO WebSocket with `nodeuo.json.v2` | Original UO binary frames plus negotiated JSON features |
| Unknown WebSocket client without a NodeUO subprotocol | NodeUO endpoint | Original UO packets only |

The generic TCP bridge rejects WebSocket subprotocol offers before opening an
upstream socket. The browser client retries once without a subprotocol. The
bridge then forwards the UO stream byte-for-byte and cannot impersonate a
NodeUO JSON server. A normal client never receives JSON, while a normal
emulator never receives a private NodeUO packet.

## Negotiation and envelope

1. The normal UO login flow enters the world.
2. On a `nodeuo.json.v2` WebSocket only, the server sends a text `hello` for
   `protocol.session` with its feature IDs and independent version ranges.
3. The client intersects the offer with implemented features and sends one
   `accept` within five seconds. A timeout leaves the UO session untouched.
4. Both peers store the accepted string-keyed feature map. Every private send
   and handler checks it again.
5. All binary frames continue through the ordinary UO decoder. There is no
   private binary NodeUO namespace or numeric capability mask.

The offer also carries an inspectable manifest: feature dependencies,
independent version ranges and stable payload-schema fingerprints. A client
may choose `full`, `enhanced`, `gameplay`, `minimal`, `editor` or `staff`;
the server still filters every feature by its own configuration and account
authorization. Administrators choose the shard default in **Operations**,
while an explicit local client choice wins for that browser.

Feature IDs such as `npc.dialog`, `world.components` and `mods.channels` are
strings, so the registry has no 32-bit ceiling. Each feature can evolve without
bumping unrelated features. Arbitrary script namespaces travel through the
negotiated `mods.channels` gateway instead of consuming global protocol IDs.

Every envelope identifies its kind, feature and feature version. Optional
fields provide message/reply IDs, sequence/ACK numbers, priority, delivery
policy, TTL, replacement key, expected/current revision and idempotency key.
The v7 contract also carries bounded `traceId`, `correlationId`, `causationId`,
`transactionId`, absolute `deadlineAt`, and typed preconditions. These fields
flow through asynchronous server handlers and result/error envelopes without
touching UO binary packets. Expired work and failed preconditions are rejected
before a feature mutates authoritative state.
Payloads are restricted to plain finite JSON: at most 512 KiB, 16 nesting
levels, bounded keys/arrays/nodes and no prototype-polluting keys.

One text frame may contain a bounded array of up to 64 independently validated
envelopes. This is only transport batching: it does not couple feature
versions, and it never changes or wraps the binary UO stream.

The catalog contains only implemented feature IDs. Its size is not a wire
limit: negotiation is a sorted list of strings, not a bit mask.

`protocol.schema-registry` serves the exact negotiated payload contracts as
JSON Schema 2020-12 documents with stable fingerprints. The same compiled,
bounded validator runs on incoming server requests. A schema mismatch removes
only that feature from negotiation; it cannot downgrade or reinterpret the UO
binary stream.

## Flow control and replication

Reliable messages retain order. `latest` messages coalesce by replacement key
under socket pressure, while stale cosmetic `loss-tolerant` messages may be
dropped. Hard queue limits close a wedged connection instead of growing memory
without a bound. ACK state, request promises, revisions and idempotency caches
are bounded and cleared with the session.

Clock synchronization uses NTP-style timestamps and smoothed RTT/offset
samples. QoS feedback exposes queue pressure and a recommended update rate.
World v2 replication uses semantic components (`position`, `appearance`,
`vitals`, `status`, `containment`) with per-entity revisions. Dirty changes
are coalesced, sorted by viewer relevance and sent in adaptive batches. Classic
peers remain on their existing UO path.

Clients can subscribe to selected components/fields with bounded entity and
update-rate, area, detail-level and per-session bandwidth limits. A token
bucket protects each connection: critical and reliable traffic has a bounded
reserve, replaceable state is deferred and stale cosmetic traffic is dropped.
The browser selects 30, 20 or 10 Hz after hysteresis based
on frame p95 and socket pressure; the server coalesces throttled movement and
always sends the final position. Every component row has a deterministic state
fingerprint. A mismatch triggers a targeted, visibility-checked repair rather
than a full reconnect, and omitted fields are merged without zeroing retained
state.

Predictive map hints warm nearby chunks and animation cycles through bounded,
frame-budgeted queues. Asset manifests use SHA-256 content addresses; large
documents use parallel HTTP byte ranges, and hot reload verifies the assembled
bytes before parsing and applying them. Persistent worker pools handle decoded
asset work instead of creating a worker for every request.

## Implemented enhanced features

- Visual Novel NPC conversations backed by authoritative scripted actions:
  quests, vendors, services, banking and paperdoll access;
- optional generated NPC lines through an administrator-configured HTTPS
  provider, with proximity, rate, time and output limits and no AI-issued game
  actions;
- semantic world deltas, timeline, effects, animations, combat, containers,
  properties, quest journal, vendor search and social snapshots;
- spell composer, specializations, housing tools and live collaborative housing
  cursors;
- structured crafting-workbench updates, build/map previews and naval cannon
  range overlays (their private v1 packets and UI sentinels are migration-only);
- tactical party/location markers, bounded staff AI inspection and redacted
  replay metadata;
- expiring tactical party pings rendered on the world map, plus a cursor-based
  world-event feed connected to the shard EventSink;
- server-synchronized personal, party and guild world-map annotations with scoped
  publication and creator/leader/staff moderation;
- atomic staff map-edit transactions with bounded staging, validation,
  durable commit, rollback-on-write-failure, proximity-scoped refresh and
  expiring sector leases/cursors that prevent two editors overwriting a region;
- signed, short-lived instance handoff and voice-service authorization;
- server-timed cinematic cues and message-format localization;
- content-addressed asset manifests, verified hot reload and the separate
  Assets workbench for decoded graphics/resources;
- safe session resume with feature/sequence/world cursors, versioned structured
  UI replacement/patch/close operations, diagnostics and extensible script/mod
  channels;
- cancellable, timeout-bounded RPC with progress and standardized errors,
  backed by the same authoritative feature handlers and schema contracts.

The current service wave adds real handlers and browser consumers for:

- a single progressive near-to-far login snapshot and cursor-based sector
  catch-up over a bounded sector change log;
- atomic, revision-checked inventory layout transactions that still emit
  standard UO container updates;
- quest graphs derived from active quest definitions, persistent NPC
  relationships, party tactics, and server-timed combat telegraphs;
- accessibility preferences, authoritative party voice positions, aggregated
  vendor-market search, and transport-path recommendations that always retain
  WebSocket for reliable UO bytes;
- Ed25519-signed content-addressed asset patchsets and versioned mod permission
  manifests;
- atomic staff configuration transactions, bounded time-travel/spectator
  diagnostics, and one-use HMAC-signed live instance handoff;
- an explicit privacy contract describing public, party, personal, staff, and
  secret fields.
- `protocol.feature-health`, with per-session degradation reports, scoped
  feature disablement and rollout health accounting instead of disconnecting
  an otherwise compatible client;
- opt-in `client.performance-hints`, which produces a bounded, cached
  replication profile and never records hints before `protocol.consent`
  grants the performance category;
- `interaction.catalog`, exposing authoritative talk, quest, vendor, bank,
  training, paperdoll and inspection actions to the Visual Novel UI without
  reimplementing their script logic on the client;
- `world.region-prefetch` and `world.sector-digest`, providing visible nearby
  body/item warm-up plus targeted state repair when a sector fingerprint
  differs;
- `content.release`, which announces only an activated, hash-validated asset
  generation, and persistent revisioned consent for performance, diagnostics,
  voice and personalization categories.
- `protocol.renegotiate`, which performs a two-phase epoch/manifest exchange
  and atomically replaces the selected map without reconnecting or changing
  the underlying UO session;
- consent-gated `assets.client-profile`, release-specific `content.preflight`,
  and bounded `diagnostics.trace`, which connect measured client cache/atlas
  state to operator decisions without collecting it from classic clients;
- `interaction.catalog` v2 presentation groups and expirations, plus
  `world.region-prefetch` v2 sector priority, lifetime and budget hints.

The current contract and verification wave adds:

- `protocol.causality`, `protocol.errors`, `protocol.preconditions`, and
  `protocol.transactions` for traceable, deadline-bound requests, a stable
  error taxonomy, optimistic state guards, and a deliberately small atomic
  preference transaction boundary;
- `protocol.command-schema`, `script.catalog`, `content.dependencies`, and
  `content.preview-session` for schema-driven tools, live script discovery,
  reverse-impact analysis, and isolated staff preview leases;
- authoritative `combat.preflight`, `inventory.views`, `crafting.plan`,
  `quest.guidance`, and tamper-evident `trade.receipts` projections;
- `world.environment`, `world.audio-scene`, and
  `accessibility.spatial-cues` as bounded semantic views for presentation and
  assistive clients;
- consent-gated `support.evidence` and `moderation.case`, where evidence omits
  packet bodies, chat, credentials, and other secret fields;
- `release.compatibility`, which combines active content validation with the
  negotiated feature set and the client's consented asset profile.

The schema v7 platform wave adds:

- `protocol.policy`, dependency-safe feature constraints and lifecycle status;
- expiring `protocol.subscription-leases` and signed,
  session-bound `protocol.resumable-streams` cursors;
- standardized `protocol.retry-policy`, measured `protocol.cost-hints`,
  explicit classic-client fallbacks and generated conformance probes;
- privacy field labels and Ed25519-signed active content-release metadata;
- consent-gated browser frame diagnostics retained only in the live session;
- server-filtered `world.layers`, so ordinary clients also cannot observe a
  different instance or event phase;
- a durable phased Live Event Director, persistent player codex entries,
  revision-safe party loot policies and server-authored safe form schemas.

All 123 catalog entries have a JSON Schema contract. TypeScript declarations
and valid probe fixtures are generated from the same definitions with
`pnpm --filter @uo/nodeuo-protocol generate`; generated artifacts must not be
edited by hand. WebGL2 remains the compatible renderer default. WebGPU is an
explicit experimental preference with automatic WebGL recovery when startup
or the device fails.

The server additionally maintains deterministic world checkpoints and
invariant scans, a lazy content dependency graph, causal request traces, and a
balanced append-only economy ledger chained with SHA-256. These are visible in
**Admin → Operations → State, content and economy verification**. Expensive
scans are operator-triggered or cached; the gameplay hot path only performs
bounded dirty-entity observation and a one-second ledger flush.

If a feature is disabled, unsupported or not accepted, its established UO
behavior remains active. For example, an NPC uses the ordinary scripted
interaction, a vendor sends the standard buy list and a tooltip uses the normal
property-list packet.

## Optional WebTransport sidecar

`transport.webtransport` is advertised only when an HTTPS endpoint exists.
The reliable UO stream always remains on WebSocket. A compatible HTTP/3
sidecar may deliver complete `latest` or `loss-tolerant` JSON envelopes as
datagrams. Association uses a short-lived resume token over the encrypted
control stream. Failure or timeout closes the sidecar and continues on the
WebSocket without interrupting play.

The repository does not embed an HTTP/3 listener. This integration is off by
default and targets an independently deployed sidecar.

## Admin and scripting

**Admin → Operations → NodeUO JSON v2 settings** controls feature advertisement,
default feature profile, theme, localization, WebTransport and optional AI, voice, instance and
cinematic services. Input is validated and atomically persisted in
`nodeuo-settings.json`. Stored credentials are redacted in API responses and
preserved across unrelated edits. Availability-changing settings publish a
two-phase renegotiation offer to capable live peers. The selected feature map
changes only after the client accepts the same epoch and manifest; an ignored
or incompatible offer leaves the old map active. Older clients continue with
their original negotiation.

The same configuration model supports revision-checked begin/stage/validate/
commit/rollback transactions for negotiated staff clients. All feature flags,
network budgets, AI/voice endpoints, themes, localization, instance routes, and
cinematic data therefore remain editable rather than compiled constants.

**Admin → Operations → NodeUO delivery cockpit** combines live per-feature
message/byte/handler costs, bounded time buckets, global fair-share traffic,
connected-session capability matrices, rollout health, content releases and
script callback ownership. Recommendations are evidence only and never mutate
configuration automatically.

Feature delivery follows `draft → validate → publish/canary → monitor →
rollback`. Every mutation uses an optimistic revision. Canary membership is a
stable hash of account/session identity, so reconnecting does not randomly move
a player between cohorts. Error-rate thresholds can install a five-minute kill
switch, while an administrator can kill or revive a single feature
immediately. Existing sessions apply an off/kill decision on every send and
receive; newly enabled features are negotiated at reconnect.

Content publication follows `hash and stage → revalidate → activate → notify`.
Activation re-reads every byte and rejects missing, resized or changed files.
The release pointer is versioned and rollbackable. Capable clients receive a
`content.release` delta; classic clients receive no private message and keep
their normal asset workflow. Preflight compares the release with consented
client cache capacity and supported formats, while the admin cockpit can diff
any staged/active pair before activation.

**Admin → Script Studio** extracts the live script inventory and generates
working item, mobile, AI, command, region, event, and scheduled-service modules.
Validation, optimistic concurrency, atomic writes, rotating backups,
dependency hot reload, rollback, recoverable archive, and lifecycle ownership
are described in [Script Studio](../scripting/script-studio.md).

Panel permissions are rank based. Counselor is read-only, Seer adds limited
live operations, GameMaster adds world/content editing, and Admin alone may
change accounts, performance budgets, rollouts, releases or script circuit
state. Sensitive mutations require authentication refreshed within five
minutes and are recorded in the audit trail.

**Admin → Platform** provides the durable moderation inbox, isolated content
preview, independent change approvals, script event-contract inventory,
phased Live Event Director and operational incident timeline. If approval
enforcement is enabled, exact one-use approvals are consumed by protocol
rollout publish/rollback, kill switches, content release activation/rollback
and protocol settings changes. See [Platform operations](platform-operations.md).

The **Assets** tab edits decoded client artwork/resources. Server and client
gump editors continue to edit scripted layouts; neither was removed or
silently replaced by the asset editor.

Scripts publish private events or register bounded namespaces through
`api.nodeUO`. Handlers still execute on the server and enforce normal gameplay
permissions. The enhanced client is a presentation/prediction layer, never a
trust boundary.

Historical `@@OPEN_*@@` script messages are intercepted by `NetState` after v2
negotiation and emitted as typed `ui.rich-gumps` or `crafting.workbench` JSON.
They are an internal script API compatibility layer, not a wire protocol. A
classic client never sees the marker: it receives a rate-limited system message
that identifies the missing optional interface and its standard UO fallback.
The server logs that first use, and **Operations → Protocol + client
compatibility** reports shown and cooldown-suppressed counts per feature.

Compatibility notices are configured live in **Operations → NodeUO JSON v2
settings**, under the advanced `compatibility` object:

```json
{
  "noticesEnabled": true,
  "noticeCooldownMs": 300000,
  "noticeTemplate": "{label} requires the NodeUO client with the negotiated {feature} feature. You can keep playing normally; only this optional enhanced interface is unavailable.{fallback}"
}
```

`noticeCooldownMs` is clamped to 5 seconds–1 hour and tracked per session and
feature. The server retains at most 64 cooldown keys per connection. Disabling
notices suppresses the explanatory message, not the standard UO fallback.

Standard spellbooks are not a private feature: they use the original UO
spellbook content packet (`0xBF/0x1B`) and continue to open on classic clients.
Only the optional visual Spell Composer/schema editor requires NodeUO; its
failure message explicitly confirms that normal spellbooks and casting remain
available.

AI remains server-authoritative. Its scheduler uses time/work budgets,
hibernation, circuit breakers, hierarchical A*, collision-revision caches,
shared route suffixes and per-pulse spatial perception caches. Packs reuse one
candidate scan and a short-lived group target while every NPC still applies
its own hostility, team, summon and control-master rules.
The staff AI inspector reads those live scheduler diagnostics and can request a
bounded preview from the actual pathfinder; it does not synthesize placeholder
AI state.

## Short regression gates

```powershell
pnpm --filter @uo/nodeuo-protocol test
pnpm --filter @uo/protocol test
pnpm --filter @uo/server test
pnpm --filter @uo/bridge test
pnpm --filter @uo/client build
pnpm audit:performance
pnpm audit:gameplay-performance
node tools/audit/architecture-budget.mjs
```

Bridge integration verifies UO byte preservation, the ServUO seed, fragmented
stateful Huffman decoding and subprotocol rejection. Protocol/server tests
cover v2 negotiation, bounded JSON, semantic components, ACK/resync and the
rule that non-NodeUO sessions receive no private feature traffic.
