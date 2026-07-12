# Hotspot boundaries

The game loop still exposes the same UO protocol and scene APIs, but the three
largest runtime hotspots now act as orchestrators rather than owning every
algorithm they call.

## Ownership

| Orchestrator | Focused module | Owns | Must not own |
| --- | --- | --- | --- |
| `server/net/handlers.js` | `server/net/handlers/character-creation.js` | wire decoding, creator validation, race/body policy and outfit data | sessions, world mutation or packet sends |
| `client/scenes/game-scene.js` | `client/scenes/game-world-picker.js` | screen/world conversion and entity/item/static hit tests | Pixi display objects, input listeners or network sends |
| `client/renderer/tile-renderer.js` | `client/renderer/tall-structure.js` | roof component grouping and visibility policy | world singletons or Pixi objects |
| `client/renderer/tile-renderer.js` | `client/renderer/door-tile-index.js` | canonical door hinges and incremental suppression indexes | sprite mounting or chunk invalidation |

Dependencies point from an orchestrator to focused modules. Focused modules do
not import their orchestrator. State dependencies are constructor arguments
where practical, which keeps modules testable and avoids hidden circular
imports.

## Rendering decisions

- The isometric world remains one flat, sortable Pixi container. Land,
  statics, items, mobiles and effects require a shared depth order, so splitting
  them into many render groups would make correct cross-group sorting harder
  and add render passes.
- Visibility is chunk-driven. The renderer mounts only the visible window plus
  one warm prefetch ring, evicts distant chunks and skips animation work for
  off-screen chunks. Pixi per-object culling would duplicate this work across
  thousands of sprites.
- Burst work is frame-budgeted: streamed items enter a requestAnimationFrame
  queue, chunk invalidations are coalesced and texture resolution is batched.
- Repeated spatial queries use numeric packed keys and pooled scratch storage;
  they avoid transient strings and per-frame collection allocation.
- Static atlas resources are shared through the sprite pool. Caching a whole
  dynamic world container as a texture is deliberately avoided because doors,
  roofs, mobiles, lighting and weather change continuously.

## Guardrails

`tools/audit/architecture-budget.mjs` ratchets line ceilings for the
orchestrators and their focused modules. When a ceiling is reached, add another
cohesive module instead of raising the budget. Each extracted boundary must
have a targeted smoke/unit check and then pass the full quality suite.
