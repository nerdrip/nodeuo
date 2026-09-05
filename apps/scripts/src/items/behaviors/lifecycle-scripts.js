// PHASE CF — facade over the per-script files under `items/scripts/`.
//
// The original file held all 11 lifecycle scripts in a single 250-line
// blob. Marcin asked for one-file-per-script so editing a single item
// doesn't drag the whole catalogue. Each script now lives at
// `items/scripts/<category>/<name>.js` and is registered via the
// auto-discovery loop in `items/scripts/index.js`.
//
// Public surface stays the same — `registerLifecycleScripts(api)` is
// what `data.js` calls; the disposer logic in data.js uses
// `allItemScripts()` from the registry to discover what to unregister.

export { registerAllItemScripts as registerLifecycleScripts } from '../scripts/index.js';
