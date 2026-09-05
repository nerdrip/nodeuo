#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { World } from '../../apps/server/src/world/world.js';
import { GameSystemRuntime } from '../../apps/server/src/systems/game-systems.js';

const full = process.argv.includes('--full');
const systemCount = 100;
const instanceCount = 256;
const playerCount = full ? 2_048 : 512;
const actionCount = full ? 250_000 : 50_000;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-game-system-bench-'));
const sourceFile = path.join(temp, 'systems.json');
const catalog = Array.from({ length: systemCount }, (_, index) => ({
  id: `bench-system-${index}`, version: 1, name: `Benchmark ${index}`, summary: 'Maximum-load activity benchmark.',
  category: 'world', archetype: 'competition', difficulty: 5, skill: 'Tactics', durationMinutes: 60,
  cooldownSeconds: 0, staminaCost: 0, clientMode: 'hybrid', party: { min: 1, max: 256, teams: 2 },
  antiExploit: { maxActionsPerMinute: 600, maxEventContribution: 1000, minParticipationPercent: 0 },
  reward: { gold: 0, tokens: 1 }, stages: [0, 1, 2].map((stage) => ({ id: `stage-${stage}`,
    name: `Stage ${stage}`, goal: 1_000_000, event: 'activity:action', actions: ['compete'], contributionCap: 1000 })),
}));
fs.writeFileSync(sourceFile, JSON.stringify(catalog));

const world = new World();
const runtime = new GameSystemRuntime({ world, sourceFile, random: () => 0 });
const before = process.memoryUsage().heapUsed;
const started = performance.now();
for (let index = 0; index < instanceCount; index++) runtime.start(`bench-system-${index % systemCount}`, { allowParallel: true });
const mobiles = Array.from({ length: playerCount }, (_, index) => {
  const mobile = world.createMobile({ name: `Load Player ${index}`, stam: 1_000_000, str: 100, dex: 100, int: 100, skills: { Tactics: 100 } });
  mobile.isPlayer = true;
  runtime.join(mobile, `bench-system-${index % systemCount}`, { allowEnhanced: true });
  mobile._benchmarkSystemId = `bench-system-${index % systemCount}`;
  return mobile;
});
const setupMs = performance.now() - started;
const actionStarted = performance.now();
let accepted = 0;
for (let index = 0; index < actionCount; index++) {
  const mobile = mobiles[index % mobiles.length];
  if (runtime.act(mobile, mobile._benchmarkSystemId, 'compete').ok) accepted++;
}
const actionMs = performance.now() - actionStarted;
const heapMiB = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
const operationsPerSecond = Math.round(actionCount * 1000 / Math.max(1, actionMs));
const snapshot = runtime.serialize();
const result = { full, systems: systemCount, instances: runtime.instances.size, players: playerCount,
  actions: actionCount, accepted, setupMs: Number(setupMs.toFixed(2)), actionMs: Number(actionMs.toFixed(2)),
  operationsPerSecond, heapDeltaMiB: Number(heapMiB.toFixed(2)), snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)) };
console.log(JSON.stringify(result, null, 2));
runtime.dispose();
fs.rmSync(temp, { recursive: true, force: true });
if (runtime.instances.size > instanceCount || accepted !== actionCount || operationsPerSecond < 5_000 || heapMiB > 128) process.exitCode = 1;
