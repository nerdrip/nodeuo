# Assets workbench

**Admin → Assets** is the shared entry point for content tools, but it does not
merge their data models. The distinction is intentional:

- **Content Studio / scripted gumps** edits the layout, controls, text, and
  logic of interfaces sent by the server;
- **Gump graphics** in Assets edits the client image assigned to a numeric ID;
- **Data Editor** edits server script data;
- **Iso World Editor** edits terrain and statics placed in the world.

No existing tool was removed. The workbench links directly to those tools and
exposes client resources separately.

## Scope

The feature set is inspired by
[UOFiddler](https://github.com/polserver/UOFiddler), but works with NodeUO's
native, already-decoded files. It does not contain a MUL/UOP decoding layer.

| Area | Tool |
| --- | --- |
| Land art, statics, gumps, texmaps | preview by ID and reversible PNG import |
| TileData | filtering and safe record-field editing |
| Hues, AnimData, Multi, RadarCol | structured browsing and editing |
| Cliloc | text search and editing |
| Sounds, music | metadata and preview without loading all of `sounds.bin` |
| Mobile animations | Assets catalog and the existing Animation Inspector |
| Fonts, cursors, lights | catalog and preview; cursor hotspots are editable |
| World maps/statics | existing Iso World Editor |
| Verdata/runtime remaps | `patches.json` under Runtime remaps |
| Skills, speech, professions, NPC/quest/gump scripts | Content Studio / Data Editor |

## Graphic overrides

Importing a PNG creates `assets/overrides/<kind>-<id>.png` and updates
`asset-overrides.json`. The client downloads the manifest during world
initialization and prefers an override over its atlas entry. Supported kinds
are `land`, `static`, `gump`, and `texmap`.

This path is deliberately independent of atlas repacking:

- a change is immediately reversible;
- the server does not perform a multi-minute atlas rebuild;
- deleting an override restores the original asset;
- a new ID can be added with the **ID** button even when it is absent from the atlas.

After a change, re-enter the world or refresh the application to load the new
manifest. A later asset build can fold accepted overrides into atlases/KTX2 as
a separate, controlled publication step.

## Safety and consistency

- Reading requires a panel role, writing requires GameMaster, and every Assets
  mutation requires fresh administrator authentication.
- JSON writes use `expectedMtime`; a concurrent modification returns a conflict
  instead of overwriting another editor's version.
- A `.bak.<timestamp>` copy is created before a write; the five most recent
  versions are retained.
- IDs, names, numbers, music paths, Multi component counts, and PNG dimensions
  are validated by the server.
- Large manifest parsing and serialization run in Worker Threads outside the
  world tick. Listings are paginated to at most 250 records.
- Sound preview reads only the declared `offset/size` range from `sounds.bin`.
- **Validate manifests** creates a cancellable background job. Persistent
  Worker Threads parse every collection and stream progress while the game
  loop remains available.
- Mobile animation validation checks the importer-generated SHA-256 and byte
  size for every 64-body metadata shard and content-addressed PNG page. Optional
  content-addressed KTX2 pages are indexed and validated too, and the modern
  client prefers them while numeric PNG/KTX2 names remain available to older
  clients. Hashes are streamed in 1 MiB chunks; unchanged file fingerprints
  skip repeat hashing. The full manifest remains available for older tools.

The API lives under `/api/assets/editor/*`; static images are still served by
the authenticated `/assets/*` routes.

The Ultima importer is the only writer of the generated mobile atlas graph. It
updates full compatibility metadata, the sharded index, conversion tables,
hashed pages and stale-file cleanup together, and commits the index last. The
client, Animation Inspector, panel validation and command-line audits all use
that same graph; no secondary hand-maintained body catalog exists.

Existing decoded deployments can be upgraded without the original MUL/UOP
files with `pnpm extract:mobile-atlas:migrate`. The migration validates the
monolithic manifest, streams page hashes, hard-links immutable PNG/KTX2 names
where supported, publishes shards atomically and keeps all numeric names.

NodeUO-to-NodeUO sessions can additionally negotiate `assets.patchsets`.
Patchset manifests contain only changed/removed content-addressed files and are
signed with a shard Ed25519 key. The client exposes a Web Crypto verifier so
patch consumers can reject untrusted metadata before applying it. Classic clients continue to use
their normal asset files and never receive this extension.

The Service Worker stages an asset generation in a separate cache, warms it
with bounded concurrency, and switches the active pointer only after success.
The previous generation is retained for one-step rollback. Quota pressure
removes staging first and the previous generation only at the emergency
threshold; immutable assets remain cache-first while mutable control files are
network-first. Byte-range requests bypass the cache to preserve range
semantics.

With performance consent, the browser periodically reports only bounded atlas
statistics: formats, transfer/decode time, cache pressure, used pages and the
hottest 32 pages. Operations aggregates these into an atlas heatmap and flags
prefetch waste. The telemetry is never required for asset loading.
