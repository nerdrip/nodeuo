import assert from 'node:assert/strict';

import {
  CLIENT_PERF_BUDGETS,
  collectClientBudgetSnapshot,
  evaluateClientPerfBudgets,
} from '../src/shared/perf-budget.js';

const ok = collectClientBudgetSnapshot({
  clientPerfStats: { tickMs: 3.5 },
  lightFrameStats: { lastMs: 2.0 },
  movementStats: { pending: 2 },
  pathfindStats: { lastMs: 4.0, lastVisited: 120 },
});

assert.deepEqual(evaluateClientPerfBudgets(ok), []);

const bad = collectClientBudgetSnapshot({
  clientPerfStats: { tickMs: CLIENT_PERF_BUDGETS.uiTickMs + 1 },
  lightFrameStats: { lastMs: CLIENT_PERF_BUDGETS.lightTickMs + 1 },
  movementStats: { pending: CLIENT_PERF_BUDGETS.movementPending + 1 },
  pathfindStats: {
    lastMs: CLIENT_PERF_BUDGETS.pathfindMs + 1,
    lastVisited: CLIENT_PERF_BUDGETS.pathfindVisited + 1,
  },
});

const violations = evaluateClientPerfBudgets(bad);
assert.deepEqual(violations.map((v) => v.key).sort(), [
  'lightTickMs',
  'movementPending',
  'pathfindMs',
  'pathfindVisited',
  'uiTickMs',
]);

for (const v of violations) {
  assert.ok(v.value > v.limit, `${v.key} should report value over budget`);
}

console.log('[smoke:perf-budgets] ok');
