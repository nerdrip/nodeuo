import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const baselineFile = path.join(here, 'performance-baseline.json');
const full = process.argv.includes('--full');
const update = process.argv.includes('--update');
const child = spawnSync(process.execPath, [path.join(here, 'server-load-soak.mjs'), ...(full ? ['--full'] : [])], {
  cwd: root, encoding: 'utf8', env: { ...process.env, NODEUO_SOAK_HOURS: '0' },
});
process.stdout.write(child.stdout || '');
process.stderr.write(child.stderr || '');
if (child.status !== 0) process.exit(child.status ?? 1);

const match = /movesPerSecond=(\d+) heapMiB=([\d.-]+)/.exec(child.stdout);
if (!match) throw new Error('performance audit output could not be parsed');
const current = { movesPerSecond: Number(match[1]), heapMiB: Math.max(0, Number(match[2])) };
const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
if (update) {
  baseline.quick = current;
  fs.writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`[audit:performance] baseline updated: ${JSON.stringify(current)}`);
  process.exit(0);
}
const minThroughput = baseline.quick.movesPerSecond * baseline.tolerance.throughputRatio;
const maxHeap = baseline.quick.heapMiB * baseline.tolerance.heapRatio + baseline.tolerance.heapSlackMiB;
const failures = [];
if (current.movesPerSecond < minThroughput) failures.push(`throughput ${current.movesPerSecond}/s < ${Math.round(minThroughput)}/s`);
if (current.heapMiB > maxHeap) failures.push(`heap ${current.heapMiB} MiB > ${maxHeap.toFixed(1)} MiB`);
const report = { generatedAt: new Date().toISOString(), baseline: baseline.quick, tolerance: baseline.tolerance, current, failures };
fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(root, 'artifacts', 'performance-regression.json'), `${JSON.stringify(report, null, 2)}\n`);
if (failures.length) {
  console.error(`[audit:performance] FAILED ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`[audit:performance] OK throughput=${current.movesPerSecond}/s heap=${current.heapMiB}MiB`);
