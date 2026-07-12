import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Legacy hotspots are split incrementally. These ceilings turn the current
// extraction work into a ratchet: new code must go into focused modules rather
// than growing the orchestration/parser monoliths again.
const budgets = new Map([
  ['apps/server/src/net/handlers.js', 7_650],
  ['apps/client/src/scenes/game-scene.js', 3_800],
  ['apps/client/src/renderer/tile-renderer.js', 2_200],
  ['apps/server/src/net/handlers/character-creation.js', 300],
  ['apps/client/src/scenes/game-world-picker.js', 220],
  ['apps/client/src/renderer/door-tile-index.js', 160],
  ['apps/client/src/renderer/tall-structure.js', 160],
  ['apps/client/src/net/handlers.js', 2_250],
  ['apps/client/src/assets/asset-manager.js', 2_200],
  ['apps/server/src/admin/routes.js', 2_000],
  ['apps/server/src/main.js', 1_850],
  ['apps/client/src/scenes/login-scene.js', 1_800],
]);

const results = [];
for (const [file, maxLines] of budgets) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).length;
  results.push({ file, lines, maxLines });
  assert.ok(lines <= maxLines, `${file} grew to ${lines} lines (budget ${maxLines}); extract a focused module`);
}
assert.ok(readFileSync('apps/server/src/main.js', 'utf8').includes("./content/world-event-registry.js"),
  'world event catalogue drifted back into main.js');

console.log(`[audit:architecture] ok files=${results.length} largest=${Math.max(...results.map((entry) => entry.lines))}`);
