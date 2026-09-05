# Script Studio

**Admin → Script Studio** is the high-level authoring surface for live server
scripts. It complements Content Studio and the decoded Assets workbench; it
does not replace either data editor or the scripted/client gump editors.

The studio discovers the current `apps/scripts/src` tree and extracts command,
item-script, AI, event, region, timer, and lifecycle registrations. Existing
files can be searched, inspected, edited, validated, and hot-reloaded. New
files can be generated from working templates for:

- item behaviors and their use/equip/unequip/walk/drop/pick-up/create/destroy/tick hooks;
- mobile event handlers;
- scheduled AI behaviors;
- player or staff commands with access level and aliases;
- region enter/leave hooks;
- world-event subscribers;
- periodic services owned by the script lifecycle.

Generated code calls the same runtime APIs as handwritten scripts. AI is
registered in the real scheduler, commands in the command registry, item
callbacks in `itemScripts`, region callbacks in the region system, and events
in the world event bus. These are executable templates, not metadata stubs.

## Safe publish workflow

1. Choose a type, stable ID, hook, and target fields.
2. Generate a template or open an existing source file.
3. Review the source, live diagnostics, and dependency graph.
4. Use **Validate** or press `Ctrl+Shift+V` without changing the live module.
5. Use **Validate and publish** or press `Ctrl+S`.
6. Confirm the live activation result and runtime resources.

The server imports a temporary sibling module before changing the target. It
requires a default registration function and rejects syntax/import failures.
Static diagnostics flag missing registration exports, unowned timers,
unbounded loops, and event subscriptions that need lifecycle review. They link
to the relevant source line. Writes use both an expected modification time and
SHA-256 source identity to detect concurrent edits, an atomic
rename, and five rotating backups. Activation uses the per-file dependency
hot-reloader; a failed initializer restores both the previous file and its
previous live registrations.

Archiving is recoverable. A deleted script is moved below
`.script-studio-archive` and the runtime manifest is explicitly invalidated so
the next generation cannot retain a stale file. The **Archives** dialog can
validate, restore, and reactivate a retained version. Local drafts are saved
periodically in browser storage and offered after reopening the same path.
New, archived, and restored files therefore work even if the operating system
coalesces watcher events.

The editor provides line numbers, cursor/size status, tab and shift-tab block
indentation, trailing-whitespace formatting, debounced validation, clickable
diagnostics, dirty-state navigation protection, and searchable live command,
AI, item, event, and region inventories. It intentionally keeps source as
plain JavaScript and uses the runtime's real registration APIs; generation
never creates a decorative metadata record that the server cannot execute.

Every generated callback is owned by `api.lifecycle`. Timers, commands, event
listeners, and guarded item callbacks are disposed on reload. Runtime timing,
errors, skipped calls, circuit-breaker state, pause, quarantine, and resume are
available under **Admin → Operations**.

**Admin → Platform → Script event contracts** scans the actual script sources
for event producers and consumers. Use it after generating an event subscriber
to find an unconnected hook. The isolated preview in the same tab accepts
bounded draft mutations and simulates an event against that inventory without
writing a script, changing the world or invoking external effects. This is a
review aid; normal Script Studio validation and activation remain required to
publish executable code.

Publishing or archiving requires Admin rank and authentication refreshed in
the last five minutes. Reading and preview generation do not mutate files.
Source size is capped at 1 MiB and paths are confined to the scripts root.

## Editing related content

Use the links in Script Studio to keep data and behavior connected:

| Concern | Editor |
| --- | --- |
| Item definitions and bindings | Content Studio → Items |
| NPC/mobile definitions | Content Studio → Mobiles |
| Regions, spawns, quests | Content Studio → World |
| Scripted gump layouts and logic | Content Studio / gump editors |
| Decoded gump artwork and other client resources | Assets |
| Callback costs and circuit state | Operations |

Classic UO clients execute these server behaviors through the ordinary UO
packets they already understand. NodeUO-only presentation, such as Visual
Novel NPC dialogue, is negotiated separately and always has a standard UO
fallback.
