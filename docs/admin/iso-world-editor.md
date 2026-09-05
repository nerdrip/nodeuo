# ISO world editor

The full-screen ISO editor at **Admin → World → ISO editor** uses the same isometric transform, tile metadata, static atlas, multi catalog, collision rules, and canonical world mutation APIs as the game. It does not modify Ultima Online client files. Runtime statics, houses, boats, and mobiles are visible to standard and NodeUO clients through normal UO world packets. Terrain overrides are a negotiated NodeUO extension; an unmodified Classic client continues to use its local map files and therefore does not render those land-only overrides.

## Everyday workflow

1. Select a facet or known location, then pan with WASD/middle drag and zoom with the wheel.
2. Search the complete land/static tile catalog by name, decimal ID, or hexadecimal ID. Filter static art by category and save favorites.
3. Choose a brush, hue, Z policy, exact brush size, and path spacing.
4. Paint continuously, click individual statics, Shift-drag a rectangle, or use **Draw path** for roads, walls, hedges, rivers, and decoration lines.
5. Use **Select / transform** to mark a rectangle. Move, rotate, mirror, copy, or delete editable statics. Runtime items are converted into an atomic remove-plus-add draft when moved.
6. Review the green pending overlay and red removals. Undo/redo operates on complete gestures rather than individual mousemove events.
7. Select **Save all**, review the transaction modal, and commit. Large drafts are split into validated 4,096-operation server transactions; an uncommitted remainder stays queued after any rejection.

Unsaved work is debounced into browser storage and recovered after an accidental reload when it fits the browser quota. Export a patch for review or transfer between environments. Discard uses an explicit destructive confirmation.

## Paths and area brushes

**Draw path** begins with one anchor click. A normal second click completes a gap-free Bresenham segment; Alt-click commits a waypoint and keeps the path active for another segment. Escape cancels the uncommitted segment. `Spacing` intentionally skips points for fences, lamps, trees, and other repeated decorations. The selected land/static brush, exact footprint size, hue, floor slice, and Z behavior are reused. Every segment is capped before expansion so a large brush cannot freeze the browser.

Rectangles and server mutations are capped at 4,096 entries. This keeps validation, rollback, broadcasts, persistence, and the browser responsive.

## Prefabs

Shift-drag/select a rectangle and choose **Save selection**. The modal can include baked statics as portable editable copies. Version 2 prefabs store Z relative to the selection origin, so buildings remain aligned when placed on a different elevation.

The prefab library shows dimensions, tile count, and save time. Choose rotation/mirroring and enter placement mode. A cyan footprint follows the cursor; click to add the transformed prefab to the normal pending transaction. Prefabs never bypass undo, review, or the static batch validator.

## Houses, boats, and custom multis

Choose **Houses & multis**, select an online owner, and search or page through the complete imported Ultima multi catalog. Filters separate houses, boats, and custom/other structures. The cyan footprint preview is bounded for rendering performance. House placement uses the same `canPlaceMultiAt`, compact anchor, collision/surface data, interactive door/sign components, broadcast, ACL bridge, and `HouseRegistry` registration as deeds and `[placemulti`. Boat IDs route through the authoritative boat engine and create a sail-able hull with facing, anchoring, planks, health, armor, collision, and optional cannon state instead of a decorative shell.

The server validates terrain, water, existing structures, mobiles, and ownership restrictions before committing. Failed stamping or registration rolls back every created part and its registry row. Successful placement produces an operations-audit undo token; undo removes that exact multi instance and registry row rather than every structure sharing its graphic ID. A changed or occupied boat is deliberately refused by audit undo so live cargo, keys, crew, or passengers cannot be destroyed accidentally.

## Layers and inspection

Terrain, baked statics, runtime items, multis, mobiles, spawners, and regions have independent visibility/opacity controls. Hover shows the complete tile stack. **Pick** samples the top runtime item, baked static, or land. Baked source statics remain read-only; copy them into a prefab if an editable version is needed.

**Floor slice** isolates a chosen Z plane with a configurable tolerance and makes new placements snap to that plane. Page Up and Page Down move the slice in five-Z floor steps. Rectangle transforms affect only editable statics visible in the active slice. Selection controls support XY nudging, rotation, mirroring, copy/delete, one-Z elevation steps, and a transactional properties modal for relative elevation and hue changes.

Spawner editing remains a separate server-authoritative modal with schedule, population, area, roaming, team, and creature-kind controls. The world editor visualizes both the spawn rectangle and current spawned positions.

## Keyboard reference

- `M`: paint land
- `B`: place static
- `R`: remove
- `P`: pick
- `I`: inspect
- `T`: teleport
- `V`: select/transform
- `L`: draw path
- `F`: prefab placement/library
- `H`: house/multi placement/library
- `Ctrl+Z`, `Ctrl+Shift+Z`, `Ctrl+Y`: undo/redo
- `Alt+click` while drawing: commit a waypoint and continue the path
- `Page Up`, `Page Down`: enable floor slice and move it by five Z
- `Escape`: cancel the current path or clear the selection
- `1` through `6`: switch facet while no field is focused

All destructive world actions remain behind admin authentication, rank checks, CSRF protection, audit logging, bounds validation, and safe rollback paths.
