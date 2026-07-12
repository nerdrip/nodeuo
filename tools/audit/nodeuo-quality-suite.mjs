import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const full = process.argv.includes('--full');
const selectedArg = process.argv.find((arg) => arg.startsWith('--category='));
const selected = selectedArg ? new Set(selectedArg.slice('--category='.length).split(',').filter(Boolean)) : null;
const pnpm = 'pnpm';

const cmd = (label, args, options = {}) => ({ label, bin: pnpm, args, ...options });
const node = (label, script, args = []) => ({ label, bin: process.execPath, args: [script, ...args] });
const serverTests = (label, files) => cmd(label, ['--filter', '@uo/server', 'test', '--', ...files]);

const categories = [
  {
    id: 'visual', title: 'Playwright visual regression',
    commands: [
      cmd('client production build', ['--filter', '@uo/client', 'build']),
      cmd('10 screenshot scenarios', ['--filter', '@uo/client', 'run', 'smoke:screenshot-parity']),
      node('browser login/runtime audit', 'apps/client/scripts/audit-browser-runtime.mjs', full ? ['--full'] : []),
    ],
  },
  {
    id: 'movement', title: 'Movement and resynchronization soak',
    commands: [
      node('client prediction soak', 'apps/client/scripts/audit-movement-soak.mjs', full ? ['--full'] : []),
      serverTests('server movement/collision/resync', [
        'movement-resolve.test.js', 'resync.test.js', 'speech-movement-regressions.test.js', 'walk-events.test.js',
      ]),
      cmd('client pathfinder/camera checks', ['--filter', '@uo/client', 'run', 'smoke:pathfinder']),
    ],
  },
  {
    id: 'protocol', title: 'NodeUO / ServUO protocol differential',
    commands: [
      node('ServUO registration differential', 'tools/audit/protocol-differential.mjs'),
      cmd('protocol packet corpus', ['--filter', '@uo/protocol', 'test']),
      cmd('client outgoing packets', ['--filter', '@uo/client', 'run', 'smoke:outgoing']),
      cmd('client ServUO samples', ['--filter', '@uo/client', 'run', 'smoke:servuo-samples']),
      serverTests('extension compatibility boundary', ['nodeuo-compatibility.test.js', 'client-version.test.js', 'login-flow.test.js']),
    ],
  },
  {
    id: 'assets', title: 'Body, corpse, item and gump asset integrity',
    commands: [
      node('cross-catalog asset integrity', 'tools/audit/asset-integrity.mjs'),
      cmd('body coverage', ['--filter', '@uo/client', 'run', 'smoke:body-coverage']),
      cmd('mobile animation matrix', ['--filter', '@uo/client', 'run', 'smoke:anim']),
      cmd('static animation matrix', ['--filter', '@uo/client', 'run', 'smoke:static-anim']),
      serverTests('monster registry and animation catalog', ['monster-registry-normalization.test.js', 'animation-catalog.test.js']),
    ],
  },
  {
    id: 'combat', title: 'Combat, death, corpse and resurrection lifecycle',
    commands: [
      serverTests('combat/death lifecycle', [
        'combat-formulas.test.js', 'combat-formulas-debuffs.test.js', 'combat-health-broadcast.test.js',
        'attack-limiter.test.js', 'aggression.test.js', 'corpse-ghost.test.js', 'corpse-onunequip.test.js',
        'corpse-decay-broadcast.test.js', 'paragon-loot.test.js', 'resurrect-broadcast.test.js',
      ]),
      cmd('client damage/effect timing', ['--filter', '@uo/client', 'run', 'smoke:world-text-damage']),
    ],
  },
  {
    id: 'inventory', title: 'Inventory and drag/drop transactions',
    commands: [
      serverTests('inventory/container/trade lifecycle', [
        'containers.test.js', 'pickup.test.js', 'auto-stack.test.js', 'worn-backpack-drop.test.js',
        'trade-acl.test.js', 'trade-display.test.js', 'trade-drop.test.js', 'weight.test.js',
      ]),
      cmd('client UI drag/drop', ['--filter', '@uo/client', 'run', 'smoke:ui-drag-drop']),
      cmd('paperdoll interaction', ['--filter', '@uo/client', 'run', 'smoke:paperdoll']),
    ],
  },
  {
    id: 'gumps', title: 'Gump catalogue layout and interaction',
    commands: [
      cmd('startup UI imports', ['--filter', '@uo/client', 'run', 'smoke:startup-ui']),
      cmd('server gump parser/layout', ['--filter', '@uo/client', 'run', 'smoke:gump-layout']),
      cmd('gump protocol smoke', ['--filter', '@uo/client', 'run', 'smoke:gump']),
      cmd('UI parity', ['--filter', '@uo/client', 'run', 'smoke:ui-parity']),
      serverTests('packed and scripted gumps', ['gump-packed.test.js', 'paperdoll-body.test.js']),
    ],
  },
  {
    id: 'ai', title: 'AI, pathing and spawner behavior',
    commands: [
      serverTests('AI and spawner matrix', [
        'ai-step.test.js', 'ai-graphs.test.js', 'mage-ai.test.js', 'healer-ai.test.js',
        'vendor-ai.test.js', 'templates-ai.test.js', 'spawner.test.js', 'xml-spawner.test.js',
        'random-encounters.test.js', 'pathfind.test.js', 'path-follower.test.js',
      ]),
    ],
  },
  {
    id: 'createworld', title: 'CreateWorld content integrity',
    commands: [
      node('CreateWorld catalogue audit', 'tools/audit/createworld-integrity.mjs'),
      serverTests('CreateWorld runtime stages', ['createworld-spawners.test.js', 'world-authoring.test.js', 'telgen-visibility.test.js']),
    ],
  },
  {
    id: 'performance', title: 'Renderer, memory and cache budgets',
    commands: [
      cmd('client performance budgets', ['--filter', '@uo/client', 'run', 'smoke:perf-budgets']),
      cmd('client runtime performance', ['--filter', '@uo/client', 'run', 'smoke:client-perf']),
      cmd('asset cache lifecycle', ['--filter', '@uo/client', 'run', 'smoke:asset-cache']),
      cmd('sprite pool lifecycle', ['--filter', '@uo/client', 'run', 'smoke:sprite-pool']),
      serverTests('server operational budgets', ['operational-diagnostics.test.js']),
    ],
  },
  {
    id: 'maps', title: 'Six-facet map, statics and radar integrity',
    commands: [
      node('map/static binary audit', 'tools/audit/map-facet-integrity.mjs'),
      cmd('map coordinate/static sample', ['--filter', '@uo/client', 'run', 'smoke:map-coordinate']),
      cmd('live map texture invalidation', ['--filter', '@uo/client', 'run', 'smoke:map-texture-dirty']),
      cmd('camera pan invariants', ['--filter', '@uo/client', 'run', 'smoke:camera-pan']),
    ],
  },
  {
    id: 'persistence', title: 'Save/restart durable-state roundtrip',
    commands: [
      serverTests('persistence/restart matrix', [
        'persistence.test.js', 'save-dir.test.js', 'stable-expiration.test.js',
        'boats.test.js', 'house-customization.test.js', 'house-transfer.test.js', 'house-tools.test.js',
      ]),
    ],
  },
];

function run(command) {
  return new Promise((resolveRun) => {
    const startedAt = Date.now();
    const child = spawn(command.bin, command.args, {
      cwd: resolve('.'),
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, NODEUO_AUDIT_FULL: full ? '1' : '0' },
    });
    child.once('error', (error) => resolveRun({ ok: false, error: String(error), ms: Date.now() - startedAt }));
    child.once('exit', (code, signal) => resolveRun({
      ok: code === 0, code, signal, ms: Date.now() - startedAt,
    }));
  });
}

const report = { version: 1, mode: full ? 'full' : 'quick', startedAt: new Date().toISOString(), categories: [] };
let failed = false;
for (const category of categories) {
  if (selected && !selected.has(category.id)) continue;
  console.log(`\n=== [${category.id}] ${category.title} ===`);
  const categoryResult = { id: category.id, title: category.title, commands: [], ok: true };
  for (const command of category.commands) {
    console.log(`\n--- ${command.label} ---`);
    const result = await run(command);
    categoryResult.commands.push({ label: command.label, ...result });
    if (!result.ok) {
      categoryResult.ok = false;
      failed = true;
      break;
    }
  }
  report.categories.push(categoryResult);
}
report.finishedAt = new Date().toISOString();
report.ok = !failed;
mkdirSync(resolve('artifacts'), { recursive: true });
writeFileSync(resolve('artifacts/nodeuo-quality-audit.json'), JSON.stringify(report, null, 2));
console.log(`\n[audit:quality] ${report.ok ? 'OK' : 'FAILED'} categories=${report.categories.length} report=artifacts/nodeuo-quality-audit.json`);
process.exitCode = report.ok ? 0 : 1;
