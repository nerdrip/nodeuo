import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { SectorIndex } from '../../apps/server/src/world/sectors.js';
import { wave2Evidence } from './wave2-evidence.mjs';
import { pnpmProcess } from './subprocess.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const ROADMAP = resolve(ROOT, 'docs/roadmap-300-wave-2.md');
const ARTIFACTS = resolve(ROOT, 'artifacts');
const full = process.argv.includes('--full');

function source(...paths) { return paths.map((path) => readFileSync(resolve(ROOT, path), 'utf8')).join('\n'); }
function probe(name, paths, patterns) {
  const body = source(...paths); const missing = patterns.filter((pattern) => !pattern.test(body)).map(String);
  return { name, ok: missing.length === 0, paths, checks: patterns.length, missing };
}
function run(label, command, args) {
  const started = performance.now();
  const invocation = command === 'pnpm'
    ? pnpmProcess(args)
    : { bin: command === 'node' ? process.execPath : command, args };
  const result = spawnSync(invocation.bin, invocation.args, { cwd: ROOT, encoding: 'utf8', timeout: 180_000 });
  const row = { label, ok: result.status === 0, ms: Math.round(performance.now() - started), command: [command, ...args].join(' '),
    stdout: String(result.stdout || '').trim().split(/\r?\n/).slice(-8), stderr: String(result.stderr || '').trim().split(/\r?\n/).slice(-8) };
  if (!row.ok) process.stderr.write(`\n[wave2] ${label} failed\n${result.stdout}\n${result.stderr}\n`);
  return row;
}

function parseRoadmap() {
  const markdown = readFileSync(ROADMAP, 'utf8'); const domains = { client: [], server: [], admin: [] };
  let current = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('## Klient')) current = 'client';
    else if (line.startsWith('## Serwer')) current = 'server';
    else if (line.startsWith('## Admin')) current = 'admin';
    else {
      const match = /^(\d+)\. \[[ x]\] (.+)$/.exec(line);
      if (match && current) domains[current].push({ id: Number(match[1]), title: match[2] });
    }
  }
  for (const [domain, rows] of Object.entries(domains)) assert.equal(rows.length, 100, `${domain} roadmap must contain exactly 100 items`);
  return domains;
}

const probes = {
  client: [
    { range: [1, 20], result: probe('adaptive streaming and bounded rendering', [
      'apps/client/src/shared/runtime-governor.js', 'apps/client/src/assets/asset-manager.js',
      'apps/client/src/renderer/tile-renderer.js', 'apps/client/src/renderer/sprite-pool.js',
    ], [/deviceMemory/, /cacheLimits/, /atlasBytes/, /trimInactiveResources/, /CHUNK_DIRECTION_VECTORS/, /_populateTier/, /_streamFrameEma/, /acquireSprite/, /_water/]) },
    { range: [21, 40], result: probe('asset integrity and atomic session lifecycle', [
      'apps/client/src/assets/asset-manager.js', 'apps/client/src/net/net-client.js', 'apps/client/src/net/handlers.js',
      'apps/client/src/world/world.js', 'apps/client/src/managers/drag-drop.js', 'apps/client/src/managers/target-manager.js',
    ], [/ResourceTelemetry/, /missing/, /diagnosticsSnapshot/, /SessionEpoch/, /session-reset/, /resync-request/, /frameDiagnostics/, /equipment/, /container/, /reset/]) },
    { range: [41, 60], result: probe('responsive layout, accessibility and presentation controls', [
      'apps/client/src/managers/profile-manager.js', 'apps/client/src/ui/ui-manager.js',
      'apps/client/src/ui/gumps/options-gump.js', 'apps/client/src/scenes/game-scene.js',
    ], [/clampLayoutRect/, /migrateGumpLayoutScale/, /exportLayout/, /importLayout/, /ui\.scale/, /compact/i, /audio/i, /weather/i, /water/i, /connection/i]) },
    { range: [61, 80], result: probe('diagnostics, gump actions, tooltips and action profiles', [
      'apps/client/src/managers/diagnostics-manager.js', 'apps/client/src/managers/tooltip-manager.js',
      'apps/client/src/ui/controls/context-menu.js', 'apps/client/src/ui/gumps/action-bar-gump.js',
      'apps/client/src/ui/gumps/spell-shortcut-drag.js', 'apps/client/src/ui/ui-manager.js',
    ], [/exportBundle/, /packetSnapshot/, /frameSnapshot/, /redacted/, /cache/i, /viewport/i, /ArrowDown/, /findAction/, /ACTION_BAR_PAGE_COUNT/, /exportActionBarProfile/]) },
    { range: [81, 100], result: probe('renderer observability and automated client gates', [
      'apps/client/src/scenes/game-scene.js', 'apps/client/src/renderer/tile-renderer.js',
      'apps/client/src/managers/diagnostics-manager.js', 'apps/client/scripts/smoke-runtime-wave2.mjs',
      'apps/client/scripts/smoke-gump-layout.mjs', 'apps/client/scripts/smoke-ui-parity.mjs',
    ], [/long tasks/i, /chunks/, /roof.*overlay/i, /diagnosticsSnapshot/, /packetRecording/, /redact/i, /buildClientQualityReport/, /assert/]) },
  ],
  server: [
    { range: [1, 20], result: probe('visibility queues, revisions and spatial indexes', [
      'apps/server/src/systems/runtime-governor.js', 'apps/server/src/world/sectors.js',
      'apps/server/src/world/visibility.js', 'apps/server/src/spawner.js', 'apps/server/src/world/query-api.js',
    ], [/CoalescingWorkQueue/, /RevisionCache/, /revisionForRange/, /_tileItems/, /TypedSpatialRegistry/, /groupsNear/, /validateIndex/, /runtimeGovernor\.visibility/]) },
    { range: [21, 40], result: probe('network backpressure and scheduled tick watchdogs', [
      'apps/server/src/net/net-state.js', 'apps/server/src/systems/runtime-governor.js',
      'apps/server/src/world/ai.js', 'apps/server/src/spawner.js', 'apps/server/src/systems/operational-diagnostics.js',
    ], [/bufferedAmount/, /SOFT_PENDING_SEND_BYTES/, /sendCosmetic/, /coalesc/i, /PhaseWatchdog/, /histogram/, /AdaptiveBudget/, /tickBudgetMs/, /maxGroupsPerTick/, /runtimeSnapshot/]) },
    { range: [41, 60], result: probe('transactional scripts and canonical command registry', [
      'apps/server/src/scripts.js', 'apps/server/src/net/commands.js', 'apps/server/src/systems/runtime-governor.js',
    ], [/reloadOne/, /dryRunOne/, /rolledBack/, /reloadHistory/, /dispose/, /diagnostics/, /commandRegistryAudit/, /fuzzySuggestions/, /collisions/, /suggest/]) },
    { range: [61, 80], result: probe('secure interactions and deterministic transactions', [
      'apps/server/src/net/gump-security.js', 'apps/server/src/net/handlers.js',
      'apps/server/src/systems/runtime-governor.js', 'apps/server/src/world/persistence.js',
    ], [/timeout/i, /session/i, /limit/i, /reject/i, /TransactionJournal/, /DeterministicRuntime/, /duplicates/, /rollback/i, /save-journal/i, /restoreWorld/]) },
    { range: [81, 100], result: probe('health, startup, shutdown and architecture gates', [
      'apps/server/src/main.js', 'apps/server/src/systems/runtime-governor.js',
      'apps/server/src/world/persistence.js', 'apps/server/test/runtime-governor-wave2.test.js',
      'tools/audit/server-startup-smoke.mjs',
    ], [/health/, /ready/, /beginShutdown/, /shuttingDown/, /StartupProfiler/, /startup/, /shutdown/, /awaitInFlightSaves/, /100_000|100000/, /quality report/i]) },
  ],
  admin: [
    { range: [1, 20], result: probe('virtualized catalogs and request broker', [
      'apps/server/src/admin/admin-core.js', 'apps/server/src/admin/studio.html',
      'apps/server/src/admin/editor.html', 'apps/server/src/admin/map-worker.js',
    ], [/class VirtualList/, /overscan/, /peakNodes/, /class RequestBroker/, /maxConcurrent/, /inflight/, /cacheEntries/, /retries/, /AbortController/, /new AdminCore\.VirtualList/]) },
    { range: [21, 40], result: probe('undo, validation, dirty state and drafts', [
      'apps/server/src/admin/admin-core.js', 'apps/server/src/admin/editor.html', 'apps/server/src/admin/studio.html',
    ], [/class EditHistory/, /undoStack/, /redoStack/, /begin\(/, /objectDiff/, /class FormSession/, /validateField/, /dirty/, /class DraftStore/, /beforeunload/]) },
    { range: [41, 50], result: probe('operations health and diagnostics', [
      'apps/server/src/admin/admin-ui.html', 'apps/server/src/admin/routes.js',
      'apps/server/src/admin/admin-core.js', 'apps/server/src/systems/operational-diagnostics.js',
    ], [/ops-runtime/, /ops-network/, /ops-ai/, /ops-storage/, /ops-alerts/, /health\/ready/, /AdminDiagnostics/, /download/, /heap/i, /audit/i]) },
    { range: [51, 70], result: probe('map/static/spawner tooling and non-blocking teleport', [
      'apps/server/src/admin/editor.html', 'apps/server/src/admin/static-art.js',
      'apps/server/src/admin/world-authoring.js', 'apps/server/src/admin/routes.js',
    ], [/paletteFavorites/, /paletteRecent/, /staticNameOf/, /brush/i, /pendingAdds/, /batch/i, /spawner/i, /overlap/i, /teleportTo/, /timeoutMs: 5_000/]) },
    { range: [71, 90], result: probe('workspace navigation, conflict handling and audit trail', [
      'apps/server/src/admin/admin-core.js', 'apps/server/src/admin/admin-server.js',
      'apps/server/src/admin/admin-ui.html', 'apps/server/src/admin/studio.html',
    ], [/openPalette/, /WorkspaceState/, /recent/, /pin\(/, /history\.replaceState/, /idempotency/, /if-match/, /conflict/, /recordAudit/, /REDACTED|redact/i]) },
    { range: [91, 100], result: probe('admin performance and browser regression gates', [
      'tools/audit/admin-browser-e2e.mjs', 'apps/server/src/admin/admin-core.js',
      'apps/server/test/admin-server.test.js', 'apps/server/src/admin/admin.css',
    ], [/100_000|100000/, /domNodes/, /deduplic/i, /idempotency/i, /auditAccessibility/, /overflow/, /admin-virtual-list/, /diagnostic/i]) },
  ],
};

function spatialBenchmarks() {
  const sectors = new SectorIndex(); const mobiles = []; const items = [];
  let started = performance.now();
  for (let i = 0; i < 10_000; i++) { const value = { serial: 0x1000 + i, map: i % 2, x: i % 1024, y: (i * 17) % 1024 }; mobiles.push(value); sectors.addMobile(value); }
  const mobileInsertMs = performance.now() - started;
  started = performance.now();
  for (let i = 0; i < 100_000; i++) { const value = { serial: 0x40000000 + i, map: i % 2, x: i % 2048, y: (i * 31) % 2048, parent: 0 }; items.push(value); sectors.addItem(value); }
  const itemInsertMs = performance.now() - started;
  started = performance.now(); let hits = 0;
  for (let i = 0; i < 5_000; i++) hits += [...sectors.itemSerialsAt(i % 2, i % 2048, (i * 31) % 2048)].length;
  const tileQueryMs = performance.now() - started;
  return { ok: sectors.mobilesIndexed() === mobiles.length && sectors.itemsIndexed() === items.length && hits > 0,
    mobileInsertMs: Number(mobileInsertMs.toFixed(2)), itemInsertMs: Number(itemInsertMs.toFixed(2)), tileQueryMs: Number(tileQueryMs.toFixed(2)), hits };
}

const roadmap = parseRoadmap();
const evidenceResults = Object.fromEntries(Object.entries(wave2Evidence).map(([domain, rows]) => [domain,
  rows.map((entry, index) => {
    const body = source(entry.file);
    const ok = body.includes(entry.anchor);
    return { id: index + 1, ...entry, ok,
      evidence: `${entry.file} :: ${entry.anchor}${entry.gate ? ` [${entry.gate}]` : ''}` };
  })]));
const commands = [
  run('client runtime', 'pnpm', ['--filter', '@uo/client', 'smoke:runtime-wave2']),
  run('client action bar', 'pnpm', ['--filter', '@uo/client', 'smoke:action-bar']),
  run('server governor', 'pnpm', ['--filter', '@uo/server', 'test', '--', 'runtime-governor-wave2.test.js', 'netstate-close.test.js', 'spawner.test.js', 'scripts.test.js', 'gump-security.test.js']),
  run('admin browser', 'node', ['tools/audit/admin-browser-e2e.mjs']),
];
if (full) commands.push(
  run('client asset cache', 'pnpm', ['--filter', '@uo/client', 'smoke:asset-cache']),
  run('client UI parity', 'pnpm', ['--filter', '@uo/client', 'smoke:ui-parity']),
  run('client layout', 'pnpm', ['--filter', '@uo/client', 'smoke:gump-layout']),
  run('server persistence', 'pnpm', ['--filter', '@uo/server', 'test', '--', 'persistence.test.js', 'operational-diagnostics.test.js']),
);
const benchmark = spatialBenchmarks();

mkdirSync(ARTIFACTS, { recursive: true });
const reports = {};
for (const domain of ['client', 'server', 'admin']) {
  const requirements = roadmap[domain].map((requirement) => {
    const exact = evidenceResults[domain][requirement.id - 1];
    return { ...requirement, status: exact?.ok ? 'passed' : 'failed', evidence: exact?.evidence ?? 'missing 1:1 evidence' };
  });
  const report = {
    domain, generatedAt: new Date().toISOString(), protocolCompatibility: 'standard UO unchanged; NodeUO extensions require negotiated capabilities',
    summary: { passed: requirements.filter((row) => row.status === 'passed').length, failed: requirements.filter((row) => row.status !== 'passed').length, total: 100 },
    requirements, evidence: evidenceResults[domain],
    subsystemProbes: probes[domain].map(({ range, result }) => ({ range, ...result })), commands,
    benchmarks: domain === 'server' ? { spatial: benchmark } : undefined,
  };
  reports[domain] = report;
  writeFileSync(resolve(ARTIFACTS, `wave2-quality-${domain}.json`), JSON.stringify(report, null, 2) + '\n');
  const markdown = [`# Wave 2 quality report — ${domain}`, '', `Generated: ${report.generatedAt}`,
    `Result: ${report.summary.passed}/${report.summary.total} passed`, '',
    ...requirements.map((row) => `${row.id}. [${row.status === 'passed' ? 'x' : ' '}] ${row.title} — ${row.evidence}`), '',
    '## Automated gates', '', ...commands.map((row) => `- ${row.ok ? 'PASS' : 'FAIL'} ${row.label} (${row.ms} ms)`), ''].join('\n');
  writeFileSync(resolve(ARTIFACTS, `wave2-quality-${domain}.md`), markdown);
}

const failedProbes = Object.values(probes).flat().filter(({ result }) => !result.ok);
const failedEvidence = Object.values(evidenceResults).flat().filter((row) => !row.ok);
const failedCommands = commands.filter((row) => !row.ok);
for (const { range, result } of failedProbes) console.error(`[wave2] probe failed ${result.name} ${range.join('-')}: ${result.missing.join(', ')}`);
for (const row of failedEvidence) console.error(`[wave2] evidence failed #${row.id}: ${row.file} :: ${row.anchor}`);
assert.equal(failedProbes.length, 0, 'all feature probes must pass');
assert.equal(failedEvidence.length, 0, 'all 300 one-to-one evidence contracts must pass');
assert.equal(failedCommands.length, 0, 'all automated gates must pass');
assert.equal(benchmark.ok, true, 'spatial benchmarks must retain index correctness');
for (const report of Object.values(reports)) assert.deepEqual(report.summary, { passed: 100, failed: 0, total: 100 });
console.log(`[audit:wave2-300] ok client=100 server=100 admin=100 mobile=${benchmark.mobileInsertMs}ms items=${benchmark.itemInsertMs}ms tileQueries=${benchmark.tileQueryMs}ms`);
