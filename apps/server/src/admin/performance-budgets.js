import { runtimeGovernor } from '../systems/runtime-governor.js';
import { DEFAULT_SERVICE_LEVEL_POLICIES, runtimeServiceLevels } from '../systems/service-levels.js';

export const DEFAULT_ADMIN_PERFORMANCE_BUDGETS = Object.freeze({
  revision: 1,
  metrics: Object.fromEntries(Object.entries(DEFAULT_SERVICE_LEVEL_POLICIES).map(([name, policy]) => [name, { ...policy }])),
  client: Object.freeze({ mapChunkMs: 180, tableRows: 500 }),
  engine: Object.freeze({
    aiTicksPerPulse: 500,
    pathRequestsPerPulse: 32,
    pathNodesPerPulse: 16_000,
    spawnerGroupsPerTick: 256,
    schedulerCallbacksPerTurn: 128,
    schedulerTurnMs: 10,
    hierarchicalPathThreshold: 24,
    interestDirtyLimit: 100_000,
    admissionMaxConnections: 4096,
    admissionRejectPressure: 0.97,
    walFlushMs: 250,
    scriptCallbackMaxMs: 25,
    scriptCallbacksPerSecond: 5000,
    globalNodeUOBytesPerSecond: 16 * 1024 * 1024,
    globalNodeUOBurstSeconds: 2,
    minimumNodeUOPeerBytesPerSecond: 32 * 1024,
  }),
});

function bounded(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

export function normalizeClientBudgets(requested = {}, fallback = DEFAULT_ADMIN_PERFORMANCE_BUDGETS.client) {
  return {
    mapChunkMs: bounded(requested.mapChunkMs, fallback.mapChunkMs, 10, 10_000),
    tableRows: Math.round(bounded(requested.tableRows, fallback.tableRows, 50, 100_000)),
  };
}

export function normalizeEngineBudgets(requested = {}, fallback = DEFAULT_ADMIN_PERFORMANCE_BUDGETS.engine) {
  return {
    aiTicksPerPulse: Math.round(bounded(requested.aiTicksPerPulse, fallback.aiTicksPerPulse, 16, 10_000)),
    pathRequestsPerPulse: Math.round(bounded(requested.pathRequestsPerPulse, fallback.pathRequestsPerPulse, 1, 1_000)),
    pathNodesPerPulse: Math.round(bounded(requested.pathNodesPerPulse, fallback.pathNodesPerPulse, 400, 1_000_000)),
    spawnerGroupsPerTick: Math.round(bounded(requested.spawnerGroupsPerTick, fallback.spawnerGroupsPerTick, 1, 10_000)),
    schedulerCallbacksPerTurn: Math.round(bounded(requested.schedulerCallbacksPerTurn, fallback.schedulerCallbacksPerTurn, 4, 10_000)),
    schedulerTurnMs: bounded(requested.schedulerTurnMs, fallback.schedulerTurnMs, 1, 100),
    hierarchicalPathThreshold: Math.round(bounded(requested.hierarchicalPathThreshold, fallback.hierarchicalPathThreshold, 8, 512)),
    interestDirtyLimit: Math.round(bounded(requested.interestDirtyLimit, fallback.interestDirtyLimit, 1024, 1_000_000)),
    admissionMaxConnections: Math.round(bounded(requested.admissionMaxConnections, fallback.admissionMaxConnections, 1, 100_000)),
    admissionRejectPressure: bounded(requested.admissionRejectPressure, fallback.admissionRejectPressure, 0.5, 1),
    walFlushMs: Math.round(bounded(requested.walFlushMs, fallback.walFlushMs, 25, 60_000)),
    scriptCallbackMaxMs: bounded(requested.scriptCallbackMaxMs, fallback.scriptCallbackMaxMs, 1, 10_000),
    scriptCallbacksPerSecond: Math.round(bounded(requested.scriptCallbacksPerSecond, fallback.scriptCallbacksPerSecond, 10, 1_000_000)),
    globalNodeUOBytesPerSecond: Math.round(bounded(requested.globalNodeUOBytesPerSecond,
      fallback.globalNodeUOBytesPerSecond, 64 * 1024, 1024 * 1024 * 1024)),
    globalNodeUOBurstSeconds: bounded(requested.globalNodeUOBurstSeconds, fallback.globalNodeUOBurstSeconds, 1, 10),
    minimumNodeUOPeerBytesPerSecond: Math.round(bounded(requested.minimumNodeUOPeerBytesPerSecond,
      fallback.minimumNodeUOPeerBytesPerSecond, 4096, 4 * 1024 * 1024)),
  };
}

export function normalizePerformanceBudgets(raw = {}) {
  return {
    revision: Math.max(1, Number(raw.revision) | 0),
    metrics: runtimeServiceLevels.configure({
      ...DEFAULT_ADMIN_PERFORMANCE_BUDGETS.metrics,
      ...(raw.metrics ?? {}),
    }),
    client: normalizeClientBudgets(raw.client),
    engine: normalizeEngineBudgets(raw.engine),
  };
}

export function applyEngineBudgets(sharedCtx, engine) {
  const tuneAdaptive = (budget, limit) => {
    if (!budget) return;
    budget.base = limit;
    budget.max = limit;
    budget.min = Math.max(1, Math.min(budget.min, limit));
    budget.setPressure?.(budget.pressure);
  };
  if (sharedCtx?.ai) {
    sharedCtx.ai.maxTicksPerPulse = engine.aiTicksPerPulse;
    tuneAdaptive(runtimeGovernor.budgets.ai, engine.aiTicksPerPulse);
    if (sharedCtx.ai.pathfinding) {
      sharedCtx.ai.pathfinding.maxPathsPerPulse = engine.pathRequestsPerPulse;
      sharedCtx.ai.pathfinding.maxNodesPerPulse = engine.pathNodesPerPulse;
      sharedCtx.ai.pathfinding.hierarchicalThreshold = engine.hierarchicalPathThreshold;
    }
  }
  if (sharedCtx?.spawner) {
    sharedCtx.spawner.maxGroupsPerTick = engine.spawnerGroupsPerTick;
    tuneAdaptive(runtimeGovernor.budgets.spawners, engine.spawnerGroupsPerTick);
  }
  if (sharedCtx?.scheduler) {
    sharedCtx.scheduler.maxCallbacksPerTurn = engine.schedulerCallbacksPerTurn;
    sharedCtx.scheduler.maxTurnMs = engine.schedulerTurnMs;
  }
  if (sharedCtx?.world?.interest) sharedCtx.world.interest.maxDirty = engine.interestDirtyLimit;
  if (sharedCtx?.admission) {
    sharedCtx.admission.maxConnections = engine.admissionMaxConnections;
    sharedCtx.admission.rejectPressure = engine.admissionRejectPressure;
  }
  sharedCtx?.world?.mutationJournal?.configure?.({ flushIntervalMs: engine.walFlushMs });
  sharedCtx?.scriptRuntime?.configureExecutionLimits?.({
    maxCallbackMs: engine.scriptCallbackMaxMs,
    maxCallbacksPerSecond: engine.scriptCallbacksPerSecond,
  });
  sharedCtx?.globalTrafficGovernor?.configure?.({
    bytesPerSecond: engine.globalNodeUOBytesPerSecond,
    burstSeconds: engine.globalNodeUOBurstSeconds,
    minimumPeerBytesPerSecond: engine.minimumNodeUOPeerBytesPerSecond,
  });
}
