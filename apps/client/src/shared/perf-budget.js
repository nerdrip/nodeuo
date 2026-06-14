export const CLIENT_PERF_BUDGETS = Object.freeze({
  lightTickMs: 6,
  uiTickMs: 8,
  movementPending: 8,
  pathfindMs: 16,
  pathfindVisited: 2048,
});

export function collectClientBudgetSnapshot({
  clientPerfStats,
  lightFrameStats,
  movementStats,
  pathfindStats,
} = {}) {
  return {
    lightTickMs: Number(lightFrameStats?.lastMs ?? 0),
    uiTickMs: Number(clientPerfStats?.tickMs ?? 0),
    movementPending: movementStats?.pending | 0,
    pathfindMs: Number(pathfindStats?.lastMs ?? 0),
    pathfindVisited: pathfindStats?.lastVisited | 0,
  };
}

export function evaluateClientPerfBudgets(snapshot, budgets = CLIENT_PERF_BUDGETS) {
  const out = [];
  const check = (key, value, limit) => {
    if (!Number.isFinite(value) || !Number.isFinite(limit)) return;
    if (value > limit) out.push({ key, value, limit });
  };
  check('lightTickMs', snapshot?.lightTickMs ?? 0, budgets.lightTickMs);
  check('uiTickMs', snapshot?.uiTickMs ?? 0, budgets.uiTickMs);
  check('movementPending', snapshot?.movementPending ?? 0, budgets.movementPending);
  check('pathfindMs', snapshot?.pathfindMs ?? 0, budgets.pathfindMs);
  check('pathfindVisited', snapshot?.pathfindVisited ?? 0, budgets.pathfindVisited);
  return out;
}
