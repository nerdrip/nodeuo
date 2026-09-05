import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeNodeUOCausality } from '@uo/nodeuo-protocol';

const storage = new AsyncLocalStorage();
const traces = [];
const MAX_TRACES = 4096;

function appendTrace(context) {
  traces.push(context);
  if (traces.length > MAX_TRACES) traces.splice(0, traces.length - MAX_TRACES);
}

/** Run one negotiated NodeUO request in a causality scope. Promise callbacks
 * created inside the handler retain this scope through AsyncLocalStorage. */
export function withNodeUORequestContext(state, message, callback) {
  const inbound = normalizeNodeUOCausality(message);
  const traceId = inbound.traceId ?? crypto.randomUUID();
  const context = {
    traceId,
    correlationId: inbound.correlationId ?? traceId,
    causationId: inbound.causationId ?? message?.id ?? null,
    transactionId: inbound.transactionId ?? null,
    requestId: message?.id ?? null,
    feature: String(message?.feature ?? '').slice(0, 128),
    sessionId: String(state?.id ?? '').slice(0, 128),
    account: String(state?.accountName ?? '').slice(0, 128) || null,
    startedAt: Date.now(),
    durationMs: null,
    outcome: 'started',
  };
  appendTrace(context);
  return storage.run(context, () => {
    try {
      const result = callback();
      if (result === false) finishNodeUORequestContext('unhandled');
      return result;
    } catch (error) {
      finishNodeUORequestContext('error', error);
      throw error;
    }
  });
}

export function currentNodeUORequestContext() {
  return storage.getStore() ?? null;
}

export function finishNodeUORequestContext(outcome = 'handled', error = null) {
  const context = storage.getStore();
  if (!context || context.durationMs != null) return context ?? null;
  context.durationMs = Math.max(0, Date.now() - context.startedAt);
  context.outcome = String(outcome).slice(0, 32);
  if (error) context.error = String(error?.message ?? error).slice(0, 256);
  return context;
}

export function requestTraceSnapshot({ limit = 200, traceId, correlationId } = {}) {
  const count = Math.max(1, Math.min(2000, Number(limit) | 0 || 200));
  return traces.filter((entry) => (!traceId || entry.traceId === traceId)
    && (!correlationId || entry.correlationId === correlationId)).slice(-count).reverse()
    .map((entry) => ({ ...entry }));
}

export function clearRequestTraces() {
  traces.length = 0;
}
