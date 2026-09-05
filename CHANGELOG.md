# Changelog

All notable NodeUO changes are documented here. Application releases use
[Semantic Versioning](https://semver.org/). The independently negotiated
`@uo/nodeuo-protocol` package keeps its own schema-package version.

## [1.0.0] - 2026-09-05

First tagged end-to-end release.

### Added

- A catalog of 100 server-authoritative, persistent game systems with 300
  editable stages, Classic UO fallbacks, NodeUO views, rewards, teams,
  telemetry, anti-exploit limits, and account-wide progression.
- Dedicated engines for collectible cards, deckbuilding expeditions, music,
  mosaics and painting, player-authored adventures, and chronicle replays.
- The string-keyed `game.systems` NodeUO JSON feature and generated protocol
  schemas, without allocating another classic UO opcode or capability bit.
- Game-system authoring and operations workbenches in the admin panel.
- A transactional ISO world editor with Z-floor slicing, selection transforms,
  paths, prefab rotation and mirroring, map painting, runtime statics, spawners,
  canonical houses, custom multis, and operational undo.
- English authoring, compatibility, runtime API, and world-editor documentation.

### Changed

- House and multi placement is atomic across physical components and the house
  registry. Boats placed from staff and admin tools use the authoritative boat
  runtime rather than decorative multi stamps.
- Map and static editing validate complete batches before mutation, persist
  before broadcast, and restore sparse overlays after failed writes.
- Prefab export uses exact rectangular sector queries and block-level baked
  static reads instead of scanning the complete world or each cell repeatedly.
- Activity actions now have execute, support, and prepare tactics with bounded
  focus, momentum, streaks, stamina costs, team scores, and winner settlement.
- Client builds embed their package version, so `/version` reports the release
  instead of a development placeholder.

### Compatibility

- Unmodified UO clients can connect to the NodeUO server and use all standard
  gameplay, receiving classic gumps when an enhanced presentation is absent.
- The NodeUO browser client can connect through the bridge to compatible
  ServUO, RunUO, POL, and other classic UO shards without sending private JSON.
- Enhanced-only activities remain visible to classic users through an explicit
  informational gump and never block the rest of the game.

### Verification

- 1,504 automated tests across the workspace, including 1,375 server tests.
- Production client build, repository lint, 12-category quality audit, asset
  integrity audit, admin browser E2E, and live client-server E2E.
- The standard game-system performance audit processes over 300,000 actions per
  second on the release verification host.

[1.0.0]: https://github.com/nerdrip/nodeuo/releases/tag/v1.0.0
