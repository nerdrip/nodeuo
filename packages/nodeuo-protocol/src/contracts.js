/**
 * Shared, dependency-free request contracts for NodeUO JSON v2.
 * Classic UO packets never pass through this module.
 */

const SAFE_CONTEXT_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const SAFE_PRECONDITION = /^[a-z][a-z0-9._-]{0,63}$/i;

export const NodeUOErrorCode = Object.freeze({
  InvalidArgument: 'invalid-argument',
  Unauthenticated: 'unauthenticated',
  PermissionDenied: 'permission-denied',
  NotFound: 'not-found',
  Conflict: 'conflict',
  PreconditionsFailed: 'preconditions-failed',
  RateLimited: 'rate-limited',
  Overloaded: 'overloaded',
  Timeout: 'timeout',
  Cancelled: 'cancelled',
  Unsupported: 'unsupported',
  Unavailable: 'unavailable',
  Internal: 'internal',
});

const ERROR_CODES = new Set(Object.values(NodeUOErrorCode));

function boundedId(value) {
  const id = String(value ?? '').trim();
  return SAFE_CONTEXT_ID.test(id) ? id : undefined;
}

export function normalizeNodeUOCausality(value = {}) {
  const traceId = boundedId(value.traceId);
  const correlationId = boundedId(value.correlationId) ?? traceId;
  const causationId = boundedId(value.causationId);
  const transactionId = boundedId(value.transactionId);
  const result = {};
  if (traceId) result.traceId = traceId;
  if (correlationId) result.correlationId = correlationId;
  if (causationId) result.causationId = causationId;
  if (transactionId) result.transactionId = transactionId;
  return Object.freeze(result);
}

export function normalizeNodeUOPreconditions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({});
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 32)) {
    const key = String(rawKey).trim();
    if (!SAFE_PRECONDITION.test(key)) continue;
    if (typeof rawValue === 'string') out[key] = rawValue.slice(0, 256);
    else if (typeof rawValue === 'boolean' || rawValue === null) out[key] = rawValue;
    else if (Number.isSafeInteger(rawValue)) out[key] = rawValue;
  }
  return Object.freeze(out);
}

export function checkNodeUOPreconditions(expected = {}, current = {}) {
  const failed = [];
  for (const [key, value] of Object.entries(normalizeNodeUOPreconditions(expected))) {
    if (!Object.is(current?.[key], value)) failed.push(Object.freeze({
      key, expected: value, actual: current?.[key] ?? null,
    }));
  }
  return Object.freeze({ ok: failed.length === 0, failed: Object.freeze(failed) });
}

export function createNodeUOError(code, message, {
  retryable = false, retryAfterMs, details, recovery, traceId, correlationId,
} = {}) {
  const normalizedCode = ERROR_CODES.has(code) ? code : NodeUOErrorCode.Internal;
  const error = {
    ok: false,
    code: normalizedCode,
    error: String(message ?? normalizedCode).slice(0, 512),
    retryable: retryable === true,
  };
  if (retryAfterMs != null) error.retryAfterMs = Math.max(0, Math.min(300_000, Number(retryAfterMs) | 0));
  if (details !== undefined) error.details = details;
  if (recovery != null) error.recovery = String(recovery).slice(0, 128);
  const context = normalizeNodeUOCausality({ traceId, correlationId });
  if (context.traceId) error.traceId = context.traceId;
  if (context.correlationId) error.correlationId = context.correlationId;
  return Object.freeze(error);
}

export function isNodeUOError(value) {
  return value?.ok === false && ERROR_CODES.has(value?.code) && typeof value?.error === 'string';
}
