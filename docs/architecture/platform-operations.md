# Platform operations and safety workflow

The Platform workbench joins operational workflows that must be useful from
both the admin UI and the NodeUO JSON protocol. Its durable state is stored by
`PlatformOperations` in `platform-operations.json` using an atomic temporary
file, flush and rename. It is intentionally outside gameplay hot paths.

## Admin workbench

Open **Admin → Platform** to use:

- the durable moderation inbox with ownership, optimistic revisions and a
  bounded case timeline;
- isolated content previews with an expiry, baseline fingerprint, bounded
  mutations and event simulations that have no external effects;
- independent change requests in which the requester cannot approve their own
  operation and one to three reviewers may be required;
- the cached event-contract inventory showing script producers, consumers and
  disconnected hooks;
- revisioned, phased live-event definitions and transitions;
- the bounded incident timeline produced by these operations.

Saving or transitioning a live event also emits `live-event:updated` or
`live-event:transition` on the real world event bus. Script Studio event
subscribers can therefore spawn, announce or clean up ordinary world content
for each phase; lifecycle ownership removes their listeners during reload.

GameMaster may manage cases, previews and live events. Approval and policy
mutations require Admin rank and authentication refreshed within five minutes.
The standard admin CSRF, CSP, audit and idempotency protections still apply.

## Approval enforcement

Enforcement is disabled by default so a shard cannot be locked accidentally.
Enroll at least two administrators before enabling it. An approval uses an
exact operation kind and resource:

| Action | Kind | Resource |
| --- | --- | --- |
| Activate release | `content.release.activate` | `release:<release-id>` |
| Roll back release | `content.release.rollback` | `revision:<expected-revision>` |
| Publish rollout | `protocol.rollout.publish` | `revision:<expected-revision>` |
| Roll back rollout | `protocol.rollout.rollback` | `revision:<expected-revision>` |
| Change kill switch | `protocol.kill-switch` | `feature:<feature-id>` |
| Update NodeUO settings | `protocol.settings.update` | `global` |

Approved requests are selected explicitly by ID or, when the caller omits the
ID, by the newest exact kind/resource match. They expire, are consumed once and
remain in history. Ordinary UO traffic and gameplay commands do not depend on
this workflow.

## Preview isolation

A preview stores only a bounded baseline, resource names, proposed JSON
mutations and simulation results in memory. It never imports untrusted draft
code, calls a live script callback, writes a source file or mutates the world.
Sessions are owner-bound and expire after at most 30 minutes. Script Studio is
the separate validated, revision-checked publication path.

## Protocol services

Schema v7 exposes the same useful read models to negotiated NodeUO peers:

- policy, retry, cost, privacy and compatibility descriptions;
- expiring subscription leases and session-bound HMAC resume cursors;
- generated conformance fixtures and Ed25519-signed release documents;
- consented session-only frame diagnostics;
- server-filtered world layers, phased events and persistent codex entries;
- leader-owned party loot policy and server-authored safe forms.

These services use independently versioned string feature IDs and no global
capability mask. They are text JSON only after explicit `nodeuo.json.v2`
negotiation. Binary frames remain the standard UO stream.

## Compatibility

Classic clients connected to NodeUO see normal packets only. World layers are
enforced in the shared server visibility query, so a classic client receives
only its layer without needing to understand the feature. Live events must
express authoritative effects through normal mobiles, items, weather, journal
messages and gumps; their richer metadata is optional.

The NodeUO browser client connected through the bridge to ServUO, POL, RunUO or
another emulator does not negotiate these services. It continues using the
unmodified UO byte stream. Failure or rejection of any private feature leaves
that stream active.

## Verification

Use these short checks during development:

```powershell
pnpm --filter @uo/nodeuo-protocol run generate
pnpm --filter @uo/nodeuo-protocol test
pnpm --filter @uo/server test -- platform-operations.test.js nodeuo-wave7.test.js world-layers.test.js
pnpm --filter @uo/client build
```

Long soak tests remain a release activity and are not required for ordinary
edits.
