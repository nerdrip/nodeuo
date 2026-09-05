# Multis, Housing, and Boats

This document describes the runtime invariants for Ultima Online multis,
player housing, custom foundations, and boats. These rules apply to gameplay
scripts, persistence, the asset workbench, and both classic and NodeUO clients.

## Compatibility Contract

NodeUO keeps the original UO binary protocol as the compatibility baseline.

- A classic client can connect to NodeUO. Houses are streamed as type-2 multi
  items, custom foundations use standard `0xBF/0x1D`, `0xBF/0x1E`, `0xBF/0x20`,
  `0xD7`, and compressed `0xD8` packets, and boats fall back to ordinary world
  item/mobile updates when the client does not advertise atomic boat movement.
- The NodeUO client can connect to another UO emulator. Its house designer
  emits the standard `0xD7` layouts without private bytes. Its custom-house
  decoder accepts all three classic compressed plane modes.
- NodeUO JSON v2 is optional. It adds editing history, templates, validation,
  collaboration, and structured results only after negotiation. It never
  changes the binary UO packet stream.

## Runtime Representation

A static house or custom multi is represented by one canonical anchor item.
The anchor stores the multi id and compact server-only metadata:

- `_multiCollision`: relative solid spans;
- `_multiSurfaces`: relative walkable surfaces and bridge flags;
- `_multiFootprint`: exact occupied XY cells;
- `_multiBounds`: relative bounding box;
- `_multiBlueprintHash` and `_multiComponentCount`: integrity metadata.

The client expands the anchor from `multi.json`. The server creates ordinary
world items only for interactive parts such as doors, signs, holds, and planks.
This avoids one entity, persistence row, and network update per immutable multi
tile. `MultiSpatialIndex` indexes compact collision and surfaces by facet/cell,
so movement and placement queries do not scan the world.

Authored custom-house pieces are different: the committed design is the
authoritative registry record, while collidable world items are derived
materialization. Structural items stay out of ordinary item streaming and are
rendered from the standard `0xD8` design; interactive doors and teleporters
keep serials and use normal world-item packets. At startup, one linear
reconciliation pass relinks an exact match, rebuilds missing or inconsistent
pieces transactionally, and removes orphaned derived items.

## Placement and Demolition

Placement validates the complete footprint before creating anything:

1. coordinate and facet bounds;
2. land availability, wet/impassable flags, and terrain variation;
3. map statics and restricted regions;
4. exact existing-house footprints;
5. indexed multi collision, blocking world items, and living mobiles.

Creation is transactional. A failed component or anchor creation destroys only
the objects created by that attempt. House deeds must be recursively carried by
the placing character, and the deed is consumed only after placement succeeds.

Demolition requires an exact non-null multi instance/anchor identity and the
required owner or staff role. It never treats a missing selector as zero. The
physical structure, derived custom pieces, ACL/registry entry, spatial index,
and client visibility are removed as one operation.

## House Registry and Access

The registry maintains indexes by owner, multi instance, foundation serial,
and 16x16 world sector. `houseAt` confirms the exact footprint after the sector
lookup. ACL roles are mutually exclusive, with precedence:

`owner -> banned -> co-owner -> friend -> visitor`

The owner cannot be added to another role. A ban removes subordinate roles.
Lockdown release restores the item's previous movable state rather than making
every released object movable. Lockdown and secure limits use foundation caps
with the configured SA storage scalar.

One registry clock controls decay. A house collapses only through the registry
decay handler, preventing duplicate item-decay timers. The default progression
ends after 155 days without a valid refresh.

## Custom Foundation Editing

Only the owner can acquire a house's single editor lease. The server validates
every mutation against the extracted housedata catalogue, footprint, elevation,
rate limit, and design tile cap. Undo history is bounded by both snapshot count
and aggregate tile count; the aggregate is maintained incrementally so an edit
does not rescan every retained snapshot.

Commit first validates and materializes the complete replacement. Old derived
items remain live until all replacements exist. On success the server swaps the
sets, advances the revision, persists the registry metadata, broadcasts
`0xBF/0x1D`, and exits design mode. Floors and stairs participate in movement;
doors receive door state; teleporters are paired deterministically.

`0xD8` planes use zlib compression and signed foundation-relative coordinates.
The NodeUO encoder uses explicit mode-0 chunks of at most 750 tiles, while the
client also accepts sparse mode 1 and dense mode 2 from other emulators. Packet,
plane, decompression, coordinate, and tile limits are checked before a design
is installed.

## Boats

Boat hulls are type-2 multis using their canonical facing ids. Placement and
every move/turn validate the complete future hull footprint against water,
world bounds, other multis, blocking items, and non-passenger mobiles.

A move is applied to the hull, mounted planks/cannons/tillerman, registered
riders, and loose movable deck cargo while preserving each relative offset.
Immovable structures, doors, and solids are never captured as cargo. Clients
that have sent the standard `0xBF/0x33` steering command receive atomic `0xF6`
updates; other clients receive conventional item/mobile updates.

Dry-docking requires ownership, an anchored empty hull, and a real carried
backpack. The deed is created in that backpack before the hull and its keys are
removed. If deed creation fails, the live boat is untouched. Restored legacy
static-art hull ids are normalized to canonical multi ids before streaming.

## Persistence and Asset Editing

House registry metadata is embedded in the same SQLite save generation as the
world. Multis and custom behavior fields are included in item persistence.
Legacy `houses.json` is read only as an import fallback; new saves do not split
house state across files.

The Admin Assets workbench may edit multi definitions only when the selected
id is not used by a placed house or by any facing of a placed boat. Successful
edits publish `assets:changed`, invalidating both placement and boat footprint
caches. Script gumps and resource graphics remain separate concepts even when
they share an admin navigation area.

## Verification

Use the focused checks during housing/boat work:

```text
pnpm --filter @uo/protocol test
pnpm --filter @uo/server exec vitest run test/custom-house-packets.test.js test/house-customization-wire.test.js test/house-customization.test.js test/house-tools.test.js test/multi-placement.test.js test/boats.test.js test/movement-resolve.test.js test/netstate-close.test.js --maxWorkers=1
pnpm --filter @uo/client run smoke:custom-house
pnpm --filter @uo/client run build
pnpm audit:multis:e2e
```

The restart audit verifies placement, save/load, compact metadata, exact ACL
state, collision restoration, and demolition. Keep it aligned with every
change to the multi representation or UO asset importer.
