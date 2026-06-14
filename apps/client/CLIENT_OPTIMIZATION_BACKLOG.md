# Client Optimization Backlog

Goal: the web Ultima Online client should keep protocol compatibility and
gameplay behavior while using browser-native implementation patterns: fewer
allocations, fewer Pixi rebuilds, steadier ticks, better asset streaming, and
easier profiling. This is a working backlog, grouped around larger change
packages rather than tiny isolated tweaks.

## Status

- Done or largely done: 1, 2, 4, 5, 6, 7, 8, 11, 13, 14, 15, 18, 19, 20, 21,
  22, 24, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 40, 41, 42, 43, 44, 45,
  46, 48, 49, 50, 51, 53, 54, 55, 56, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69,
  70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 83, 84, 86, 87, 90, 91, 92, 93,
  94, 95, 97, 98, 99, 100.
- Recent movement/pathfinding work: per-pathfind standing-Z and blocker cache,
  pathfinder stats in the debug HUD, real dynamic-blocker avoidance in A*,
  movement telemetry/ring buffer with ack latency, reject/stall counters, and
  corrected local step animation timing through `walker.reserve()`.
- Recent UI work: no `localStorage` checks in hue-debug hot paths, no
  `t.map(Number)` in gump parsing hot paths, allocation-light command
  tab-complete, Journal row pooling, requestAnimationFrame redraw batching in
  Journal/Skills/AdvancedSkills, virtual rows for Journal and AdvancedSkills,
  shared fixed-row virtual lists, lazy Options tab content, and recycled
  controls in high-churn gumps.
- Recent asset/render work: positive `resolveEquipAnim` cache, numeric mobile
  frame cache keys, sampled `mobileFrameTextureSync` histograms in
  NetworkStats, idle atlas preload/prefetch queues with concurrency limits,
  true LRU for land/static/gump/texmap/equipAnim texture caches, LRU limits for
  unused atlas pages, workerized heavy manifest parsing, and KTX2 to PNG atlas
  fallback checks.
- Recent lighting work: sector-indexed `LightPoints`, nearby-only night ticks,
  equipment lights cached per serial/layer/itemId, light profile flags, quality
  limits, early attached-light culling, numeric light occlusion cache, light
  tick metrics, `light.mul` texture reuse, and typed-array sidecars for
  hot-path light sources.
- Recent world/render work: callback-based world scans for hit tests, health
  bars, AllNames, minimap/radar, equipment lights, boat riders, walkability,
  pathfinder checks, worldmap overlays, drag-select, and per-frame mobile
  rendering; generation markers in tile/mobile renderers; bucketed roof
  component grouping; local z-sort and batch add for chunk sprites.
- Recent protocol/network work: reusable `PacketReader`/`DataView` state,
  explicit mobile/item field application instead of hot-path `Object.assign`,
  batch spatial revisions for multi-entity packets, no remaining local
  `DataView` allocations in `net/handlers`, cleaner equipment reverse-index
  updates, and JSON movement trace export from NetworkStats.
- Character creation parity: modern ClassicUO/ServUO gender-race byte,
  race-aware skin/hair/horn lists, server-side appearance validation, corrected
  professions and starting equipment, and consistent race representation while
  preserving wire IDs 1/2/3 for the client.
- Visual parity work: renderer profiles for CoT, fields, tree stumps,
  vegetation, cave borders, no-color out-of-range rendering, MapGump item
  support, rare opcode stubs and fallback rendering, CoT debug overlay, weather
  temperature tint, viewport-limited storm flash, and effect renderer pooling.
- Smoke/audit coverage: `smoke:audit-parity`, `smoke:net-handlers`,
  `smoke:incoming-coverage`, `smoke:servuo-samples`, `smoke:ui-parity`,
  `smoke:asset-cache`, `smoke:map-texture-dirty`, `smoke:perf-budgets`,
  `smoke:body-coverage`, `smoke:light-points`, and `smoke:screenshot-parity`
  cover the current high-risk paths.
- Next best packages should be profile-driven product work only. CoT and light
  colors already work as a web alpha/additive/occlusion pipeline, KTX2 runtime
  fallback is in place, and worker pathfinding is opt-in through the profile.

## 100 Things To Do

1. Keep the global sprite pool as the standard for every hot `Sprite`.
2. Move remaining UI controls from local `new Sprite()` calls to `acquireSprite`.
3. Add a pool for temporary arrays used by the tile renderer.
4. Remove allocations from `resolveLocalStandingZ`.
5. Remove `filter/map/sort` from pathfinder and walkability loops.
6. Replace linear A* cheapest-node selection with a binary heap.
7. Add per-request A* timing metrics to the debug HUD.
8. Cache walkability per tile+z for the duration of one pathfind.
9. Cache statics-on-tile for chunks used by the pathfinder.
10. Split pathfinding world state from renderer state to make cache invalidation easier.
11. Standardize all world-to-screen hot paths on `worldToScreenInto`.
12. Add a scratch point/vector pool where code still creates `{ x, y }`.
13. Make `pickAtScreen` avoid creating an object on misses.
14. Reuse a UI hit-test object for repeated mousemove events.
15. Change `UIManager.destroy` so it removes gumps without cloning arrays.
16. Keep a separate visible-gumps list for hit tests.
17. Give gumps an AABB dirty flag instead of recomputing conditions on every mousemove.
18. Improve `bringToFront` so it does not rebuild children when the element is already on top.
19. Move gump ticking to a stable loop with snapshots only when the list changes.
20. Add an active gump tick counter to the debug panel.
21. Limit Journal/Skills/Options redraws to data that actually changed.
22. Replace `removeChildren` in dynamic gumps with control recycling.
23. Add a lightweight `ListView` for long UI lists.
24. Add list virtualization to Journal, Skills, and CommandPanel.
25. Standardize text fields on one bitmap text renderer.
26. Cache text measurements for repeated labels.
27. Keep a separate glyph sprite pool for bitmap text.
28. Batch UI text changes until the end of the frame.
29. Rebuild tooltip layout only when content changes, not on every mouse move.
30. Add a request cooldown for tooltips on the same serial.
31. Move overhead names to one manager with pooled Text objects.
32. Share one pool for world text, damage numbers, and chat bubbles.
33. Add lifecycle stats for the world text pool.
34. Move animated portals/statics to a shared animation clock.
35. Detect animated statics through tiledata/art metadata and cache definitions.
36. Render animated statics by swapping textures instead of destroying sprites.
37. Add an FPS limit for decorative off-screen animations.
38. Skip animation ticks entirely outside the viewport.
39. Give the mobile renderer a shared resolved-frame-key cache.
40. Run `applyHueTo` only when hue or texture changes.
41. Cache hue filters per sprite/hue where safe.
42. Remove remaining sprite destruction in renderers in favor of release.
43. Move multi ghost and previews to recycled children.
44. Improve roofs with cached building groups per roof region.
45. Improve roofs by hiding the entire active-player building group.
46. Give roofs a dirty flag after player position or map chunk changes.
47. Add a debug overlay that shows the currently hidden roof group ID.
48. Keep dynamic lights in a spatial structure instead of scanning the view.
49. Cache lights from held items per serial+layer+itemId.
50. Cache static lights per chunk.
51. Merge light points in numeric buffers instead of objects.
52. Improve dynamic light falloff for the WebGL shader.
53. Add quality scaling for lighting on weaker devices.
54. Limit light overlay updates to camera/light/time-of-day changes.
55. Keep the minimap as a dirty texture instead of fully redrawing.
56. Update the minimap incrementally after position changes.
57. Render worldmap pins as pooled sprites/labels.
58. Add worldmap pin clustering at high zoom-out.
59. Stream map chunks with movement-direction priority.
60. Reduce manifest JSON parsing on the asset-manager hot path.
61. Add negative cache entries for missing animation/body/equipment frames.
62. Add positive cache entries for `resolveEquipAnim`.
63. Keep an LRU for rarely used texture atlas pages.
64. Preload equipment assets for visible mobiles in batches.
65. Add an idle task queue for asset preloads.
66. Add a concurrency limit for image decode/load operations.
67. Add a timing histogram for `assets.mobileFrameTextureSync`.
68. Move console tracing behind compile/runtime debug flags.
69. Remove `localStorage` checks from hot movement handlers.
70. Build packet parsing around reusable DataView/read state.
71. Reduce object creation in `net/handlers` for movement and equipment.
72. Batch world mutations from one packet before renderer invalidation.
73. Improve movement resync so it distinguishes latency from real desync.
74. Add telemetry counters for movement ack/reject/desync.
75. Rate-limit the movement desync UI message.
76. Split movement prediction from render interpolation state.
77. Keep a ring buffer of recent positions for diagnosing client stalls.
78. Add an event-loop lag watchdog to the NetworkStats gump.
79. Add a frame budget panel for update, render, assets, net, and UI.
80. Move expensive render-list sorting to dirty chunks.
81. Keep stable numeric sort keys for tile/mobile draw order.
82. Limit tile chunk rebuilds to the visible margin.
83. Add door/tall-static lookup cache per chunk.
84. Reduce `Set` creation in tile renderer dirty passes.
85. Use typed arrays for visible tile serial lists.
86. Improve corpse/container item layout without full scans.
87. Keep the item parent/children index as the only inventory API.
88. Remove remaining direct `world.items` scans outside facades.
89. Add a smoke test for new Script API commands/items/mobiles.
90. Add a smoke test for UI drag, double-click, and drops after pooling work.
91. Add a pathfinder smoke test for stairs, doors, and bridges.
92. Add a smoke test for dynamic lights from held and ground items.
93. Add a smoke test for whole-building roof hiding.
94. Add a smoke test for animated statics and portals.
95. Add a smoke test for minimap/worldmap dirty redraw changes.
96. Standardize Script API imports and remove legacy helpers.
97. Add a lint rule that blocks old APIs in scripts.
98. Add a `client:profile` script that captures a browser trace.
99. Add `client:perf-smoke` with FPS and long-task thresholds.
100. Update this backlog with status and test results after every large package.
