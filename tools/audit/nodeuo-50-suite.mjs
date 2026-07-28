import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pnpmProcess } from './subprocess.mjs';

const full = process.argv.includes('--full');
const soakArg = process.argv.find((arg) => arg.startsWith('--soak-hours='));
const soakHours = soakArg ? Math.max(0, Number(soakArg.slice('--soak-hours='.length)) || 0) : 0;
const node = (script, args = []) => ({ bin: process.execPath, args: [script, ...args] });
const command = (...args) => pnpmProcess(args);

const groups = new Map([
  ['core', [node('tools/audit/nodeuo-quality-suite.mjs', full ? ['--full'] : [])]],
  ['e2e', [
    node('tools/audit/client-server-browser-e2e.mjs'),
    node('tools/audit/multis-restart-e2e.mjs'),
  ]],
  ['network', [
    node('tools/audit/network-chaos-replay.mjs', full ? ['--full'] : []),
    command('--filter', '@uo/server', 'test', '--', 'netstate-close.test.js', 'tcp-adapter.test.js', 'login-flow.test.js'),
  ]],
  ['load', [node('tools/audit/server-load-soak.mjs', full ? ['--full'] : [])]],
  ['browser', [node('apps/client/scripts/audit-browser-matrix.mjs', full ? ['--full'] : [])]],
  ['gameplay', [command('--filter', '@uo/server', 'test', '--',
    'combat-formulas.test.js', 'corpse-ghost.test.js', 'cast-reagents.test.js', 'spell-reagents.test.js',
    'spells-circle-3-4.test.js', 'spells-circle-5-8.test.js', 'skill-gain.test.js', 'skill-wire.test.js',
    'ai-step.test.js', 'templates-ai.test.js', 'spawner.test.js', 'xml-spawner.test.js', 'vendor-ai.test.js',
    'loot.test.js', 'paragon-loot.test.js', 'house-customization.test.js', 'boats.test.js', 'pet-stable.test.js',
    'pet-training.test.js', 'mlquests.test.js', 'quest-conversation.test.js', 'regions.test.js', 'day-night.test.js',
    'world-event-registry.test.js', 'world-boss.test.js', 'power-scrolls.test.js')]],
  ['admin', [
    node('tools/audit/admin-browser-e2e.mjs'),
    command('--filter', '@uo/server', 'test', '--', 'admin-server.test.js', 'admin-routes.test.js', 'world-authoring.test.js'),
  ]],
  ['architecture', [
    node('tools/audit/architecture-budget.mjs'),
    command('--filter', '@uo/server', 'test', '--', 'operational-diagnostics.test.js', 'ops-api.test.js', 'accounts.test.js'),
  ]],
]);

const item = (id, title, groupsForItem, evidence) => ({ id, title, groups: groupsForItem, evidence });
const items = [
  item(1, 'Browser-to-server gameplay flow', ['e2e', 'gameplay'], ['tools/audit/client-server-browser-e2e.mjs']),
  item(2, 'Long configurable client/server soak', ['core', 'load'], ['apps/client/scripts/audit-movement-soak.mjs', 'tools/audit/server-load-soak.mjs']),
  item(3, 'Disconnect, reconnect and state recovery', ['network', 'e2e'], ['apps/server/test/netstate-close.test.js', 'tools/audit/multis-restart-e2e.mjs']),
  item(4, 'Network fragmentation and malformed-tail chaos', ['network'], ['tools/audit/network-chaos-replay.mjs']),
  item(5, 'Concurrent world load budget', ['load'], ['tools/audit/server-load-soak.mjs']),
  item(6, 'Deterministic network replay artifact', ['network'], ['artifacts/network-chaos-replay.json']),
  item(7, 'NodeUO and ServUO protocol differential', ['core'], ['tools/audit/protocol-differential.mjs']),
  item(8, 'Pixel-exact visual baselines', ['core'], ['apps/client/scripts/visual-baselines.json']),
  item(9, 'Known-coordinate map regression', ['core'], ['apps/client/scripts/smoke-map-coordinate.mjs']),
  item(10, 'Asset/body/static/gump contact integrity', ['core'], ['tools/audit/asset-integrity.mjs']),
  item(11, 'Body/action/direction animation matrix', ['core'], ['apps/client/scripts/smoke-mobile-animation.mjs']),
  item(12, 'Death and corpse lifecycle', ['core', 'gameplay'], ['apps/server/test/corpse-ghost.test.js']),
  item(13, 'War/peace movement transitions', ['core'], ['apps/client/scripts/audit-movement-soak.mjs']),
  item(14, 'Equipment animation continuity', ['core'], ['apps/client/scripts/body-coverage-report.mjs']),
  item(15, 'Body/equip conversion validation', ['core'], ['tools/audit/asset-integrity.mjs']),
  item(16, 'Paperdoll race/body interaction', ['core'], ['apps/client/scripts/smoke-paper-doll-interactable.mjs']),
  item(17, 'Container drag/drop stress paths', ['core'], ['apps/client/scripts/smoke-ui-drag-drop.mjs']),
  item(18, 'Authoritative drag/drop conflict handling', ['core'], ['apps/server/test/pickup.test.js']),
  item(19, 'Gump malformed-layout defenses', ['core'], ['apps/client/scripts/smoke-gump-layout.mjs']),
  item(20, 'Responsive 720p/1080p/4K UI', ['browser'], ['apps/client/scripts/audit-browser-matrix.mjs']),
  item(21, 'Chromium Firefox WebKit matrix', ['browser'], ['apps/client/scripts/audit-browser-matrix.mjs']),
  item(22, 'DPI-safe bitmap and fallback fonts', ['browser', 'core'], ['apps/client/src/ui/controls/uo-bitmap-text.js']),
  item(23, 'Unicode cliloc and text rendering', ['core'], ['apps/client/src/ui/controls/html-control.js']),
  item(24, 'Keyboard mouse and touch input paths', ['browser', 'core'], ['apps/client/scripts/smoke-hotkeys.mjs']),
  item(25, 'Weather seasons light and effect soak', ['core'], ['apps/client/scripts/smoke-light-overlay.mjs']),
  item(26, 'Audio lifecycle and regional playback', ['core'], ['apps/client/src/managers/audio-manager.js']),
  item(27, 'GPU texture and sprite lifecycle budgets', ['core'], ['apps/client/scripts/smoke-sprite-pool.mjs']),
  item(28, 'Corrupt/missing IndexedDB cache fallback', ['core'], ['apps/client/scripts/smoke-asset-cache.mjs']),
  item(29, 'Versioned asset cache/service worker', ['core'], ['apps/client/public/sw.js']),
  item(30, 'Accessible labels focus and target sizes', ['browser'], ['apps/client/scripts/audit-browser-matrix.mjs']),
  item(31, 'ServUO combat-formula matrix', ['gameplay'], ['apps/server/test/combat-formulas.test.js']),
  item(32, 'Spell cost target range and interruption matrix', ['gameplay'], ['apps/server/test/cast-reagents.test.js']),
  item(33, 'Normalized reagent consumption', ['gameplay'], ['apps/server/src/systems/spells/reagents.js']),
  item(34, 'Spell/power/transcendence scroll behavior', ['gameplay'], ['apps/server/test/power-scrolls.test.js']),
  item(35, 'Skill gain and wire-level skill matrix', ['gameplay'], ['apps/server/test/skill-gain.test.js']),
  item(36, 'AI pursuit casting recovery simulation', ['gameplay'], ['apps/server/test/templates-ai.test.js']),
  item(37, 'Spawner limits and respawn ecology', ['gameplay'], ['apps/server/test/xml-spawner.test.js']),
  item(38, 'Vendor behavior/economy simulation', ['gameplay'], ['apps/server/test/vendor-ai.test.js']),
  item(39, 'Loot distribution and paragon fallbacks', ['gameplay'], ['apps/server/test/loot.test.js']),
  item(40, 'Durable customized-house state', ['core', 'gameplay', 'e2e'], ['apps/server/src/world/persistence.js', 'tools/audit/multis-restart-e2e.mjs']),
  item(41, 'Click-to-place custom-house tiles', ['core'], ['apps/client/src/managers/house-customization-manager.js']),
  item(42, 'Boat collision/passenger persistence', ['gameplay', 'e2e'], ['apps/server/test/boats.test.js', 'tools/audit/multis-restart-e2e.mjs']),
  item(43, 'Pet tame/stable/training lifecycle', ['gameplay'], ['apps/server/test/pet-training.test.js']),
  item(44, 'Quest progression/conversation safety', ['gameplay'], ['apps/server/test/quest-conversation.test.js']),
  item(45, 'Data-driven world bosses and sigils', ['gameplay'], ['apps/server/src/content/world-event-registry.js']),
  item(46, 'Playwright admin and ISO editor E2E', ['admin'], ['tools/audit/admin-browser-e2e.mjs']),
  item(47, 'Admin pending edit undo/redo transactions', ['admin'], ['apps/server/src/admin/editor.html']),
  item(48, 'Admin CSP CSRF sessions RBAC and throttling', ['admin'], ['apps/server/src/admin/admin-server.js']),
  item(49, 'Architecture size ratchet and extracted registries', ['architecture'], ['tools/audit/architecture-budget.mjs']),
  item(50, 'Production diagnostics metrics integrity and audit log', ['architecture'], ['apps/server/src/systems/operational-diagnostics.js']),
];

function run(spec) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(spec.bin, spec.args, {
      cwd: resolve('.'), stdio: 'inherit',
      env: { ...process.env, NODEUO_AUDIT_FULL: full ? '1' : '0', NODEUO_SOAK_HOURS: String(soakHours) },
    });
    child.once('error', (error) => done({ ok: false, error: String(error), ms: Date.now() - started }));
    child.once('exit', (code, signal) => done({ ok: code === 0, code, signal, ms: Date.now() - started }));
  });
}

const groupResults = {};
for (const [name, commands] of groups) {
  console.log(`\n=== [50:${name}] ===`);
  groupResults[name] = { ok: true, commands: [] };
  for (const spec of commands) {
    const result = await run(spec);
    groupResults[name].commands.push(result);
    if (!result.ok) { groupResults[name].ok = false; break; }
  }
}

const results = items.map((entry) => {
  const missingEvidence = entry.evidence.filter((file) => !existsSync(resolve(file)));
  const failedGroups = entry.groups.filter((group) => !groupResults[group]?.ok);
  return { ...entry, ok: missingEvidence.length === 0 && failedGroups.length === 0, missingEvidence, failedGroups };
});
const report = {
  version: 1, mode: soakHours > 0 ? `soak-${soakHours}h` : (full ? 'full' : 'quick'), generatedAt: new Date().toISOString(),
  ok: results.every((entry) => entry.ok), passed: results.filter((entry) => entry.ok).length,
  total: results.length, groups: groupResults, items: results,
};
mkdirSync(resolve('artifacts'), { recursive: true });
writeFileSync(resolve('artifacts/nodeuo-50-audit.json'), JSON.stringify(report, null, 2));
console.log(`\n[audit:50] ${report.ok ? 'OK' : 'FAILED'} ${report.passed}/${report.total} report=artifacts/nodeuo-50-audit.json`);
process.exitCode = report.ok ? 0 : 1;
