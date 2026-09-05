import { createNodeUOMessage, NodeUOJsonKind, NodeUOPriority } from './index.js';

export const NodeUORpcErrorCode = Object.freeze({
  Cancelled: 'cancelled', Conflict: 'conflict', Forbidden: 'forbidden',
  Internal: 'internal', InvalidArgument: 'invalid-argument', NotFound: 'not-found',
  RateLimited: 'rate-limited', Timeout: 'timeout', Unavailable: 'unavailable',
  Unsupported: 'unsupported',
});

const METHOD = /^[a-z][a-z0-9._/-]{0,95}$/i;

function boundedTimeout(value) {
  return Math.max(250, Math.min(30_000, Number(value) | 0 || 5000));
}

export function normalizeNodeUORpcRequest(payload = {}) {
  const targetFeature = String(payload.targetFeature ?? '').trim().toLowerCase();
  const method = String(payload.method ?? payload.operation ?? '').trim().toLowerCase();
  if (!METHOD.test(targetFeature)) throw new TypeError('RPC targetFeature is invalid');
  if (!METHOD.test(method)) throw new TypeError('RPC method is invalid');
  return Object.freeze({
    targetFeature,
    method,
    params: payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
      ? payload.params : {},
    timeoutMs: boundedTimeout(payload.timeoutMs),
    permission: payload.permission == null ? undefined : String(payload.permission).slice(0, 96),
  });
}

export function createNodeUORpcRequest({
  id, targetFeature, method, params = {}, timeoutMs = 5000,
  idempotencyKey, expectedRevision, priority = NodeUOPriority.Normal, featureVersion = 1,
} = {}) {
  const request = normalizeNodeUORpcRequest({ targetFeature, method, params, timeoutMs });
  const requestId = String(id ?? '').slice(0, 128);
  if (!requestId) throw new TypeError('RPC request id is required');
  return createNodeUOMessage({
    kind: NodeUOJsonKind.Request,
    feature: 'protocol.rpc',
    featureVersion,
    id: requestId,
    priority,
    ttlMs: request.timeoutMs,
    expectedRevision,
    idempotencyKey,
    payload: request,
  });
}

export function createNodeUORpcCancel(id, reason = '', featureVersion = 1) {
  const requestId = String(id ?? '').slice(0, 128);
  if (!requestId) throw new TypeError('RPC request id is required');
  return createNodeUOMessage({
    kind: NodeUOJsonKind.Cancel,
    feature: 'protocol.rpc',
    featureVersion,
    replyTo: requestId,
    priority: NodeUOPriority.High,
    payload: { reason: String(reason ?? '').slice(0, 256) },
  });
}

export function nodeUORpcError(code, message, details = undefined, retryAfterMs = undefined) {
  const known = Object.values(NodeUORpcErrorCode).includes(code) ? code : NodeUORpcErrorCode.Internal;
  const error = { ok: false, code: known, message: String(message ?? known).slice(0, 512) };
  if (details && typeof details === 'object') error.details = details;
  if (retryAfterMs != null) error.retryAfterMs = Math.max(0, Math.min(300_000, Number(retryAfterMs) | 0));
  return error;
}

export function nodeUORpcSuccess(result = {}, meta = undefined) {
  const response = { ok: true, result: result ?? {} };
  if (meta && typeof meta === 'object') response.meta = meta;
  return response;
}
