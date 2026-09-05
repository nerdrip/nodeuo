// Optional KTX2/Basis post-processor for extracted atlas PNGs.
//
// The client already tries `<kind>-atlas-XX.ktx2` before `.png`.
// This script generates those files with Khronos `toktx` when the CLI
// is installed, while keeping PNG as the guaranteed fallback.

import { existsSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { findToktx, ktx2InstallHint } from './ktx2-tool.js';
import { publishMobileKtx2Index } from './mobile-atlas-ktx2.js';

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
const defaultJobs = Math.max(1, Math.min(4, availableParallelism() - 1));
const parallelJobs = Number.isFinite(Number(args.jobs))
  ? Math.max(1, Math.min(16, Number(args.jobs) | 0))
  : defaultJobs;
const toktxArg = String(args.toktx || process.env.KTX2_TOKTX || '');
const zcmp = String(args.zcmp ?? '19');

if (!existsSync(outDir)) {
  console.error(`[ktx2] output dir does not exist: ${outDir}`);
  process.exit(2);
}

const jobs = collectAtlasJobs(outDir, only, force);
const selected = limit > 0 ? jobs.slice(0, limit) : jobs;

console.log(`[ktx2] out: ${outDir}`);
console.log(`[ktx2] jobs: ${selected.length}${jobs.length !== selected.length ? `/${jobs.length}` : ''}`);
console.log(`[ktx2] mode: UASTC + zstd ${zcmp}`);
console.log(`[ktx2] parallel jobs: ${parallelJobs}`);

if (dryRun) {
  for (const job of selected) {
    console.log(`[ktx2] dry ${job.kind}: ${job.inputName} -> ${job.outputName}`);
  }
  process.exit(0);
}

const toktx = selected.length ? findToktx(toktxArg) : { command: null };
if (selected.length && !toktx.command) {
  console.error(ktx2InstallHint());
  process.exit(2);
}
if (toktx.command) console.log(`[ktx2] toktx: ${toktx.command}`);

let converted = 0;
let cursor = 0;
let failure = null;

async function convertNext() {
  while (!failure) {
    const job = selected[cursor++];
    if (!job) return;
    try {
      await convertJob(job);
      converted++;
    } catch (error) {
      failure = error;
    }
  }
}

async function convertJob(job) {
  const cliArgs = [
    '--t2',
    '--uastc',
    '--zcmp', zcmp,
    job.tempOutput,
    job.input,
  ];
  console.log(`[ktx2] ${job.kind}: ${job.inputName} -> ${job.outputName}`);
  try { unlinkSync(job.tempOutput); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const result = await new Promise((complete) => {
    const child = spawn(toktx.command, cliArgs, { stdio: 'inherit', windowsHide: true });
    child.once('error', (error) => complete({ error, status: null }));
    child.once('exit', (status, signal) => complete({ error: null, status, signal }));
  });
  if (result.error || result.status !== 0) {
    try { unlinkSync(job.tempOutput); } catch { /* best effort */ }
    throw new Error(`failed: ${job.inputName} (${result.error?.message ?? result.signal ?? `exit ${result.status}`})`);
  }
  if (!existsSync(job.tempOutput) || statSync(job.tempOutput).size <= 0) {
    throw new Error(`empty output: ${job.outputName}`);
  }
  replaceFileSync(job.tempOutput, job.output);
}

await Promise.all(Array.from({ length: Math.min(parallelJobs, selected.length) }, () => convertNext()));
if (failure) {
  console.error(`[ktx2] ${failure.message}`);
  process.exit(1);
}

const mobileIndex = only.has('mobiles')
  ? await publishMobileKtx2Index(outDir)
  : { published: 0, skipped: true };
console.log(`[ktx2] done: ${converted} file(s)`);
if (!mobileIndex.skipped) console.log(`[ktx2] mobile index: ${mobileIndex.published} immutable page(s), revision=${mobileIndex.revision}`);

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
    out.push({ kind, input, output, tempOutput: `${output}.next`, inputName: name, outputName });
  }
  return out;
}

function replaceFileSync(from, to) {
  try { renameSync(from, to); }
  catch (error) {
    if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
    try { unlinkSync(to); } catch (nested) { if (nested?.code !== 'ENOENT') throw nested; }
    renameSync(from, to);
  }
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
