import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as operational from '../systems/operational-diagnostics.js';

function machineIdentity() {
  const cpu = os.cpus()?.[0]?.model ?? 'unknown';
  const description = `${process.platform}|${process.arch}|${os.cpus()?.length ?? 1}|${cpu}|${Math.round(os.totalmem() / 1073741824)}`;
  return { id: crypto.createHash('sha256').update(description).digest('hex').slice(0, 16),
    platform: process.platform, arch: process.arch, cores: os.cpus()?.length ?? 1,
    cpu, memoryGiB: Number((os.totalmem() / 1073741824).toFixed(1)), node: process.version };
}

function safeHistory(file, machineId) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value.machineId === machineId && Array.isArray(value.samples) ? value.samples.slice(-1440) : [];
  } catch { return []; }
}

function atlasInsights(connections) {
  const profiles = [...(connections ?? [])].map((state) => ({ id: state.id,
    account: state.accountName ?? null, profile: state._nodeUOAssetProfile })).filter((row) => row.profile);
  const pages = new Map();
  for (const { profile } of profiles) {
    for (const page of profile.atlas?.hotPages ?? []) {
      const key = String(page.key ?? '');
      if (!key) continue;
      const row = pages.get(key) ?? { key, kind: page.kind, page: page.page, touches: 0,
        clients: 0, transferredBytes: 0, loadMs: 0, prefetched: 0 };
      row.touches += Number(page.touches) || 0; row.clients++;
      row.transferredBytes += Number(page.transferredBytes) || 0;
      row.loadMs += Number(page.loadMs) || 0; row.prefetched += page.prefetched ? 1 : 0;
      pages.set(key, row);
    }
  }
  return { reportingClients: profiles.length,
    cachePressure: profiles.length ? Number((profiles.reduce((sum, row) => sum + (Number(row.profile.cache?.pressure) || 0), 0) / profiles.length).toFixed(4)) : 0,
    wastedPrefetches: profiles.reduce((sum, row) => sum + (Number(row.profile.atlas?.wastedPrefetches) || 0), 0),
    formats: profiles.reduce((out, row) => { for (const format of row.profile.formats ?? []) out[format] = (out[format] ?? 0) + 1; return out; }, {}),
    heatmap: [...pages.values()].sort((a, b) => b.touches - a.touches).slice(0, 128) };
}

function worldHeatmap(world, ai, cellSize = 64) {
  const cells = new Map();
  const add = (entity, kind) => {
    if (!entity) return;
    const key = `${entity.map | 0}:${Math.floor((entity.x | 0) / cellSize)}:${Math.floor((entity.y | 0) / cellSize)}`;
    const row = cells.get(key) ?? { key, map: entity.map | 0,
      x: Math.floor((entity.x | 0) / cellSize) * cellSize,
      y: Math.floor((entity.y | 0) / cellSize) * cellSize, players: 0, ai: 0 };
    row[kind]++; cells.set(key, row);
  };
  for (const mobile of world?.onlineMobiles?.() ?? []) add(mobile, 'players');
  for (const serial of ai?.bindings?.keys?.() ?? []) add(world?.mobiles?.get?.(serial), 'ai');
  return [...cells.values()].sort((a, b) => (b.players * 50 + b.ai) - (a.players * 50 + a.ai)).slice(0, 256);
}

function recommendations(runtime, atlas, aiSnapshot) {
  const rows = [];
  const lag = Number(runtime.eventLoop?.currentLagMs) || 0;
  const pathP95 = Number(aiSnapshot?.pathfinding?.p95Ms) || Number(aiSnapshot?.pathfinding?.maxMs) || 0;
  if (lag > 30) rows.push({ id: 'event-loop-headroom', severity: 'high', title: 'Reduce main-loop background budget',
    evidence: `Current event-loop lag is ${lag.toFixed(1)} ms.`, draft: { engine: { backgroundBudgetMs: 2 } } });
  if (atlas.wastedPrefetches > 8) rows.push({ id: 'prefetch-waste', severity: 'medium', title: 'Tighten region prefetch radius',
    evidence: `${atlas.wastedPrefetches} prefetched atlas pages were never touched.`, draft: { feature: 'world.region-prefetch', radius: 16 } });
  if (atlas.cachePressure > 0.85) rows.push({ id: 'cache-pressure', severity: 'high', title: 'Lower atlas residency budget',
    evidence: `Average reporting-client cache pressure is ${(atlas.cachePressure * 100).toFixed(1)}%.`, draft: { client: { atlasPages: 64 } } });
  if (pathP95 > 4) rows.push({ id: 'path-worker-candidate', severity: 'medium', title: 'Profile worker pathfinding candidate',
    evidence: `Pathfinding p95/max is ${pathP95.toFixed(2)} ms.`, draft: { experiment: 'pathfinding.worker', enabled: false } });
  if (!rows.length) rows.push({ id: 'healthy', severity: 'info', title: 'Keep the current runtime policy',
    evidence: 'No measured threshold justifies a structural optimization.', draft: null });
  return rows;
}

export function registerOperationsInsightRoutes(routes, { sharedCtx, world, scriptRuntime, saveDir }) {
  const machine = machineIdentity();
  const file = path.join(saveDir, 'admin-performance-history.json');
  const samples = safeHistory(file, machine.id);
  let lastSampleAt = samples.at(-1)?.at ?? 0;
  let writes = 0;

  const sample = () => {
    const now = Date.now();
    if (now - lastSampleAt < 30_000) return samples.at(-1) ?? null;
    lastSampleAt = now;
    const runtime = operational.runtimeSnapshot();
    const ai = sharedCtx?.ai?.runtimeSnapshot?.() ?? {};
    const row = { at: now, rssMB: Number((process.memoryUsage().rss / 1048576).toFixed(1)),
      heapMB: Number((process.memoryUsage().heapUsed / 1048576).toFixed(1)),
      eventLoopLagMs: Number(runtime.eventLoop?.currentLagMs) || 0,
      online: [...(world?.onlineMobiles?.() ?? [])].length,
      mobiles: world?.mobiles?.size ?? 0, items: world?.items?.size ?? 0,
      aiPulseMs: Number(ai.lastPulseMs) || 0, aiBudgetYields: Number(ai.budgetYields) || 0 };
    samples.push(row); if (samples.length > 1440) samples.splice(0, samples.length - 1440);
    if (++writes % 5 === 0) {
      const temporary = `${file}.tmp-${process.pid}`;
      fs.promises.mkdir(path.dirname(file), { recursive: true })
        .then(() => fs.promises.writeFile(temporary, `${JSON.stringify({ schema: 1, machineId: machine.id, machine, samples })}\n`))
        .then(() => fs.promises.rename(temporary, file))
        .catch(() => {});
    }
    return row;
  };

  const snapshot = () => {
    sample();
    const runtime = operational.runtimeSnapshot();
    const ai = sharedCtx?.ai?.runtimeSnapshot?.() ?? {};
    const atlas = atlasInsights(sharedCtx?.connections);
    const online = [...(world?.onlineMobiles?.() ?? [])].length;
    const rss = process.memoryUsage().rss;
    const memoryLimit = Math.max(rss, os.totalmem() * 0.75);
    const bytesPerEntity = rss / Math.max(1, (world?.mobiles?.size ?? 0) + (world?.items?.size ?? 0));
    const lag = Number(runtime.eventLoop?.currentLagMs) || 0;
    const cpuHeadroom = Math.max(0, Math.min(1, (50 - lag) / 50));
    const memoryHeadroom = Math.max(0, memoryLimit - rss);
    const capacity = { online, cpuHeadroom: Number(cpuHeadroom.toFixed(3)),
      memoryHeadroomMB: Number((memoryHeadroom / 1048576).toFixed(1)),
      bytesPerEntity: Math.round(bytesPerEntity),
      estimatedAdditionalEntities: Math.max(0, Math.floor(memoryHeadroom / Math.max(1, bytesPerEntity))),
      confidence: samples.length >= 30 ? 'measured' : 'warming-up', samples: samples.length };
    const scripts = (scriptRuntime?.diagnostics?.().owners ?? []).map((owner) => ({ file: owner.file,
      callbacks: owner.resources?.callbacks ?? [] }))
      .flatMap((owner) => owner.callbacks.map((callback) => ({ file: owner.file, ...callback })))
      .sort((a, b) => (b.maxMs ?? 0) - (a.maxMs ?? 0)).slice(0, 30);
    return { generatedAt: Date.now(), machine, runtime: { eventLoop: runtime.eventLoop,
      memory: process.memoryUsage() }, capacity, atlas, world: { cellSize: 64,
      heatmap: worldHeatmap(world, sharedCtx?.ai) }, scripts,
      recommendations: recommendations(runtime, atlas, ai) };
  };

  routes.push({ method: 'GET', path: '/api/operations/insights', run: snapshot });
  routes.push({ method: 'GET', path: '/api/operations/performance-history', run: ({ query }) => ({
    machine, samples: samples.slice(-Math.max(1, Math.min(1440, Number(query?.get?.('limit')) | 0 || 240))),
  }) });
  routes.push({ method: 'GET', path: '/api/operations/evidence-bundle', run: () => ({
    schema: 1, insights: snapshot(), protocol: operational.protocolSnapshot(),
    runtime: operational.runtimeSnapshot(), generatedAt: new Date().toISOString(),
  }) });
  routes.push({ method: 'POST', path: '/api/operations/insights/recommendation-draft', run: ({ body }) => {
    const current = snapshot();
    const recommendation = current.recommendations.find((row) => row.id === String(body?.id));
    return recommendation ? { ok: true, recommendation, draft: recommendation.draft,
      applied: false, note: 'Review this evidence-backed draft before publishing it in the relevant budget or rollout editor.' }
      : { error: 'recommendation not found' };
  } });
}
