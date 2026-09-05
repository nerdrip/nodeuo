import { requestTraceSnapshot } from '../systems/request-context.js';
import { scanWorldInvariants } from '../systems/state-verification.js';

function boundedInt(query, name, fallback, min, max) {
  const value = Number(query?.get?.(name));
  return Math.max(min, Math.min(max, Number.isFinite(value) ? Math.trunc(value) : fallback));
}

export function registerVerificationRoutes(routes, { sharedCtx, world } = {}) {
  const verifier = sharedCtx?.stateVerifier;
  const graph = sharedCtx?.contentDependencies;
  const ledger = sharedCtx?.economyLedger;

  routes.push({ method: 'GET', path: '/api/operations/state-verification', run: ({ query }) => (
    verifier?.snapshot?.(boundedInt(query, 'limit', 20, 1, 64)) ?? { checkpoints: [], running: false }
  ) });
  routes.push({ method: 'POST', path: '/api/operations/state-verification/checkpoint', run: ({ body }) => (
    verifier?.checkpointAsync?.(body?.label ?? 'admin') ?? { ok: false, error: 'state verifier unavailable' }
  ) });
  routes.push({ method: 'POST', path: '/api/operations/state-verification/compare', run: ({ body }) => (
    verifier?.compare?.(body?.referenceId, body?.candidateId) ?? { ok: false, error: 'state verifier unavailable' }
  ) });
  routes.push({ method: 'GET', path: '/api/operations/invariants-v2', run: () => scanWorldInvariants(world) });

  routes.push({ method: 'GET', path: '/api/content/dependencies', run: ({ query }) => {
    if (!graph) return { ok: false, error: 'content dependency graph unavailable' };
    const node = query.get('node');
    return node ? graph.impact(node, boundedInt(query, 'depth', 6, 1, 16))
      : graph.snapshot({ includeGraph: query.get('graph') === '1' });
  } });
  routes.push({ method: 'POST', path: '/api/content/dependencies/rebuild', run: () => {
    if (!graph) return { ok: false, error: 'content dependency graph unavailable' };
    graph.invalidate('admin-rebuild');
    return { ok: true, ...graph.snapshot() };
  } });

  routes.push({ method: 'GET', path: '/api/operations/economy-ledger', run: ({ query }) => ({
    ...(ledger?.snapshot?.() ?? { unavailable: true }),
    receipts: ledger?.receipts?.({ id: query.get('id') || undefined,
      account: query.get('account') || undefined,
      limit: boundedInt(query, 'limit', 100, 1, 1000) }) ?? [],
  }) });
  routes.push({ method: 'POST', path: '/api/operations/economy-ledger/reconcile', run: () => (
    ledger?.reconcile?.() ?? { ok: false, error: 'economy ledger unavailable' }
  ) });
  routes.push({ method: 'POST', path: '/api/operations/economy-ledger/verify', run: () => (
    ledger?.verify?.() ?? { ok: false, error: 'economy ledger unavailable' }
  ) });

  routes.push({ method: 'GET', path: '/api/operations/causality', run: ({ query }) => ({
    traces: requestTraceSnapshot({
      limit: boundedInt(query, 'limit', 200, 1, 2000),
      traceId: query.get('traceId') || undefined,
      correlationId: query.get('correlationId') || undefined,
    }),
  }) });
}
