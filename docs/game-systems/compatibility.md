# Game-system client compatibility

NodeUO always keeps the standard Ultima Online binary protocol independent from the private JSON protocol. A normal client can connect to this shard, and the NodeUO client can connect to an ordinary ServUO, RunUO, POL, or compatible UO shard. Negotiation never changes or consumes a classic UO opcode.

## Compatibility rule

Use the oldest presentation layer that can express the feature:

1. Implement game rules on the server.
2. Use standard UO packets, speech, targeting, and server gumps whenever they are sufficient.
3. Add a NodeUO JSON view only for interactions the classic client does not have.
4. Never silently hide an enhanced-only activity. Show a standard gump with: **This system requires the NodeUO client. You can continue playing without it.**

## Catalog modes

| `clientMode` | Classic UO client | NodeUO client |
| --- | --- | --- |
| `classic` | Full standard-gump experience | Same standard mechanics; an enhanced shell is optional |
| `hybrid` | Full mechanics through UO gumps, commands, speech, and world objects | Same mechanics plus the searchable live workbench |
| `enhanced` | Informational fallback gump; join/action buttons are withheld | Full specialized interaction |

Only use `enhanced` when a usable version truly needs a client surface absent from UO. The shipped catalog uses it for the collectible card table, deckbuilding expedition, music studio, painting/mosaic canvas, player-authored adventure graph, and chronicle replay timeline. The other 94 systems remain playable by normal clients.

## Negotiation

The enhanced client and server negotiate the string-keyed `game.systems` feature in NodeUO JSON v2. It depends on `ui.structured` and `world.events`. Feature IDs are not bit flags and do not share a fixed-size mask. Adding another feature does not require changing the standard UO protocol.

When negotiation is absent:

- the server never sends NodeUO JSON;
- the `[activities` command opens a normal UO gump;
- standard combat, movement, crafting, vendors, spells, quests, housing, boats, and NPC behavior continue unchanged;
- an enhanced-only selection opens the explicit compatibility message;
- unknown UO servers see no private frames from the NodeUO client.

When negotiation succeeds, `game.systems` requests support `open`, `list`, `get`, `instances`, `profile`, `join`, `leave`, `action`, `special`, and `leaderboard`. `special` accepts a bounded command name and structured `data` for the six dedicated engines. Server events use `open` and `update`. Every payload passes the protocol schema and the server remains authoritative.

## Author checklist

- Can standard targeting, speech, a menu, or a server gump express it? Choose `hybrid`.
- Does the activity still have a useful complete loop without animation overlays or a custom canvas? Choose `hybrid`.
- Does the classic fallback explain the missing client requirement? Verify with `[activities` on a non-negotiated session.
- Does the server reject forged actions, excessive rates, wrong actions, non-members, full parties, and expired instances? Use the runtime rather than client state.
- Does a world save and restart retain the instance and personal reward profile? Include it in the runtime rather than a browser store.
