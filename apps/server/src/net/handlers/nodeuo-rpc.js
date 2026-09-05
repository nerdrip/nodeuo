import {
  NodeUOJsonKind,
  NodeUORpcErrorCode,
  nodeUORpcError,
  nodeUORpcSuccess,
  normalizeNodeUORpcRequest,
} from '@uo/nodeuo-protocol';

const MAX_IN_FLIGHT_RPC = 32;

function codeFor(error) {
  if (error?.name === 'AbortError') return NodeUORpcErrorCode.Cancelled;
  if (error?.code === 'FORBIDDEN') return NodeUORpcErrorCode.Forbidden;
  if (error?.code === 'NOT_FOUND') return NodeUORpcErrorCode.NotFound;
  if (error?.code === 'CONFLICT') return NodeUORpcErrorCode.Conflict;
  if (error?.code === 'RATE_LIMITED') return NodeUORpcErrorCode.RateLimited;
  if (error?.code === 'TIMEOUT') return NodeUORpcErrorCode.Timeout;
  if (error instanceof TypeError || error instanceof RangeError) return NodeUORpcErrorCode.InvalidArgument;
  return NodeUORpcErrorCode.Internal;
}

function abortError(reason = 'RPC cancelled') {
  const error = new Error(reason);
  error.name = 'AbortError';
  return error;
}

/** Dispatch one negotiated RPC with bounded concurrency, timeout,
 * cancellation and progress. `resolve` remains the authoritative feature
 * implementation and must perform normal gameplay permission checks. */
export function dispatchNodeUORpc(state, message, { resolve, send }) {
  state._nodeUORpcTasks ??= new Map();
  if (message.kind === NodeUOJsonKind.Cancel) {
    const requestId = String(message.replyTo ?? message.payload?.requestId ?? '');
    const active = state._nodeUORpcTasks.get(requestId);
    if (!active) return false;
    active.controller.abort(abortError(String(message.payload?.reason ?? 'RPC cancelled').slice(0, 256)));
    return true;
  }
  if (message.kind !== NodeUOJsonKind.Request) return false;
  const requestId = String(message.id ?? '');
  if (!requestId) return false;
  if (state._nodeUORpcTasks.size >= MAX_IN_FLIGHT_RPC) {
    send(message, nodeUORpcError(NodeUORpcErrorCode.RateLimited, 'too many RPC requests in flight', undefined, 250), true);
    return true;
  }
  let request;
  try { request = normalizeNodeUORpcRequest(message.payload); }
  catch (error) {
    send(message, nodeUORpcError(NodeUORpcErrorCode.InvalidArgument, error.message), true);
    return true;
  }
  if (!state.supportsNodeUO?.(request.targetFeature)) {
    send(message, nodeUORpcError(NodeUORpcErrorCode.Unsupported,
      `feature is not negotiated: ${request.targetFeature}`), true);
    return true;
  }
  const idempotencyKey = message.idempotencyKey
    ? `${state.accountName ?? ''}:${request.targetFeature}:${request.method}:${message.idempotencyKey}` : '';
  if (idempotencyKey) {
    state._nodeUORpcIdempotency ??= new Map();
    state._nodeUORpcSingleFlight ??= new Map();
    const now = Date.now();
    for (const [key, cached] of state._nodeUORpcIdempotency) {
      if (cached.expiresAt <= now) state._nodeUORpcIdempotency.delete(key);
    }
    const cached = state._nodeUORpcIdempotency.get(idempotencyKey);
    if (cached) {
      send(message, cached.outcome.payload, cached.outcome.error);
      return true;
    }
    const active = state._nodeUORpcSingleFlight.get(idempotencyKey);
    if (active) {
      active.then((outcome) => send(message, outcome.payload, outcome.error)).catch(() => {});
      return true;
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    const error = new Error(`RPC timed out after ${request.timeoutMs} ms`);
    error.code = 'TIMEOUT';
    controller.abort(error);
  }, request.timeoutMs);
  timeout.unref?.();
  const progress = (value = {}) => {
    if (controller.signal.aborted) return false;
    return state.sendNodeUOMessage?.({
      kind: NodeUOJsonKind.Progress,
      feature: 'protocol.rpc',
      replyTo: requestId,
      payload: {
        targetFeature: request.targetFeature,
        method: request.method,
        ...value,
      },
    }) ?? false;
  };
  const outcome = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw controller.signal.reason ?? abortError();
    return resolve(request, { signal: controller.signal, progress });
  }).then((result) => {
    if (controller.signal.aborted) throw controller.signal.reason ?? abortError();
    if (result?.ok === false) {
      return { payload: nodeUORpcError(result.code ?? NodeUORpcErrorCode.InvalidArgument,
        result.error ?? result.message ?? 'RPC rejected', result.details), error: true };
    }
    return { payload: nodeUORpcSuccess(result ?? {}), error: false };
  }).catch((error) => {
    const reason = controller.signal.aborted && controller.signal.reason instanceof Error
      ? controller.signal.reason : error;
    return { payload: nodeUORpcError(codeFor(reason), reason?.message ?? reason), error: true };
  });
  if (idempotencyKey) state._nodeUORpcSingleFlight.set(idempotencyKey, outcome);
  const task = outcome.then((resolved) => {
    send(message, resolved.payload, resolved.error);
    if (idempotencyKey) {
      state._nodeUORpcIdempotency.set(idempotencyKey, {
        outcome: resolved, expiresAt: Date.now() + 5 * 60_000,
      });
      while (state._nodeUORpcIdempotency.size > 512) {
        state._nodeUORpcIdempotency.delete(state._nodeUORpcIdempotency.keys().next().value);
      }
    }
    return resolved;
  }).finally(() => {
    clearTimeout(timeout);
    if (state._nodeUORpcTasks.get(requestId)?.task === task) state._nodeUORpcTasks.delete(requestId);
    if (idempotencyKey && state._nodeUORpcSingleFlight.get(idempotencyKey) === outcome) {
      state._nodeUORpcSingleFlight.delete(idempotencyKey);
    }
  });
  state._nodeUORpcTasks.set(requestId, { controller, task, request, startedAt: Date.now() });
  return true;
}

export function cleanupNodeUORpc(state) {
  for (const active of state?._nodeUORpcTasks?.values?.() ?? []) {
    active.controller.abort(abortError('session closed'));
  }
  state?._nodeUORpcTasks?.clear?.();
  state?._nodeUORpcSingleFlight?.clear?.();
  state?._nodeUORpcIdempotency?.clear?.();
}

export function nodeUORpcDiagnostics(state) {
  return [...(state?._nodeUORpcTasks?.values?.() ?? [])].map((entry) => ({
    targetFeature: entry.request.targetFeature,
    method: entry.request.method,
    elapsedMs: Math.max(0, Date.now() - entry.startedAt),
  }));
}
