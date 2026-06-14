// Optional KTX2/Basis post-processor for extracted atlas PNGs.
//
// The client already tries `<kind>-atlas-XX.ktx2` before `.png`.
// This script generates those files with Khronos `toktx` when the CLI
// is installed, while keeping PNG as the guaranteed fallback.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { findToktx, ktx2InstallHint } from './ktx2-tool.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const DEFAULT_OUT = join(REPO_ROOT, 'apps', 'client', 'public', 'assets');
const DEFAULT_KINDS = new Set(['land', 'static', 'gump', 'mobiles', 'texmap']);

const args = parseArgs(process.argv.slice(2));
const outDir = resolve(args.out ?? DEFAULT_OUT);
const only = new Set(String(args.only ?? [...DEFAULT_KINDS].join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean));
const force = args.force === true;
const dryRun = args['dry-run'] === true;
const limit = Number.isFinite(Number(args.limit)) ? Math.max(0, Number(args.limit) | 0) : 0;
const toktxArg = String(args.toktx || process.env.KTX2_TOKTX || '');
const zcmp = String(args.zcmp ?? '19');

if (!existsSync(outDir)) {
  console.error(`[ktx2] output dir does not exist: ${outDir}`);
  process.exit(2);
}

const jobs = collectAtlasJobs(outDir, only, force);
const selected = limit > 0 ? jobs.slice(0, limit) : jobs;

if (!selected.length) {
  console.log(`[ktx2] nothing to do in ${outDir}`);
  process.exit(0);
}

console.log(`[ktx2] out: ${outDir}`);
console.log(`[ktx2] jobs: ${selected.length}${jobs.length !== selected.length ? `/${jobs.length}` : ''}`);
console.log(`[ktx2] mode: UASTC + zstd ${zcmp}`);

if (dryRun) {
  for (const job of selected) {
    console.log(`[ktx2] dry ${job.kind}: ${job.inputName} -> ${job.outputName}`);
  }
  process.exit(0);
}

const toktx = findToktx(toktxArg);
if (!toktx.command) {
  console.error(ktx2InstallHint());
  process.exit(2);
}
console.log(`[ktx2] toktx: ${toktx.command}`);

let converted = 0;
for (const job of selected) {
  const cliArgs = [
    '--t2',
    '--uastc',
    '--zcmp', zcmp,
    job.output,
    job.input,
  ];
  console.log(`[ktx2] ${job.kind}: ${job.inputName} -> ${job.outputName}`);
  const r = spawnSync(toktx.command, cliArgs, { stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    console.error(`[ktx2] failed: ${job.inputName}`);
    process.exit(r.status || 1);
  }
  converted++;
}

console.log(`[ktx2] done: ${converted} file(s)`);

function collectAtlasJobs(dir, kindFilter, forceAll) {
  const out = [];
  const names = readdirSync(dir).sort();
  for (const name of names) {
    const m = /^(land|static|gump|mobiles|texmap)-atlas-\d+\.png$/i.exec(name);
    if (!m) continue;
    const kind = m[1].toLowerCase();
    if (!kindFilter.has(kind)) continue;
    const input = join(dir, name);
    const outputName = name.replace(/\.png$/i, '.ktx2');
    const output = join(dir, outputName);
    if (!forceAll && existsSync(output)) {
      const srcStat = statSync(input);
      const outStat = statSync(output);
      if (outStat.mtimeMs >= srcStat.mtimeMs) continue;
    }
    out.push({ kind, input, output, inputName: name, outputName });
  }
  return out;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    out[k] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
  }
  return out;
}
