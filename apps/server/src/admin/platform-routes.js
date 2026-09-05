import crypto from 'node:crypto';
import { NodeUODelivery, NodeUOJsonKind } from '@uo/nodeuo-protocol';
import { sendNodeUOFeature } from '../net/handlers/nodeuo-modern.js';

function actor(session) {
  return String(session?.account ?? 'unknown').slice(0, 128);
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

/** Admin workflows for the durable operational service. Route authorization,
 * CSRF and fresh-auth checks remain centralized in admin-server.js. */
export function registerPlatformRoutes(routes, { sharedCtx }) {
  const platform = sharedCtx?.platformOperations;
  const unavailable = () => ({ ok: false, error: 'platform operations service unavailable' });
  const publishLiveEvent = (result) => {
    if (!result?.ok) return result;
    for (const state of sharedCtx.connections ?? []) sendNodeUOFeature(state, {
      feature: 'world.live-event-director', kind: NodeUOJsonKind.Delta,
      delivery: NodeUODelivery.Reliable, payload: result,
    });
    return result;
  };

  routes.push({ method: 'GET', path: '/api/platform/overview', run: () => platform?.snapshot?.() ?? unavailable() });
  routes.push({ method: 'PUT', path: '/api/platform/policy', run: ({ body, session }) =>
    platform?.updatePolicy?.({ ...body, actor: actor(session) }) ?? unavailable() });

  routes.push({ method: 'GET', path: '/api/platform/moderation', run: ({ query }) =>
    platform?.listModerationCases?.({ status: query.get('status') ?? '', category: query.get('category') ?? '',
      query: query.get('query') ?? '', limit: query.get('limit'), offset: query.get('offset') }) ?? unavailable() });
  routes.push({ method: 'POST', path: '/api/platform/moderation/create', run: ({ body, session }) =>
    platform?.createModerationCase?.({ ...body, reporter: actor(session) }) ?? unavailable() });
  routes.push({ method: 'POST', path: '/api/platform/moderation/update', run: ({ body, session }) =>
    platform?.updateModerationCase?.(body?.caseId,
      { ...body, owner: body?.status === 'investigating' && !body?.owner ? actor(session) : body?.owner },
      actor(session)) ?? unavailable() });

  routes.push({ method: 'GET', path: '/api/platform/approvals', run: ({ query }) =>
    platform?.listApprovals?.({ status: query.get('status') ?? '', limit: query.get('limit') }) ?? unavailable() });
  routes.push({ method: 'POST', path: '/api/platform/approvals/request', run: ({ body, session }) =>
    platform?.requestApproval?.({ ...body, payloadFingerprint: body?.payloadFingerprint || fingerprint(body?.payload) }, actor(session))
      ?? unavailable() });
  routes.push({ method: 'POST', path: '/api/platform/approvals/decide', run: ({ body, session }) =>
    platform?.decideApproval?.(body?.approvalId, body?.decision, actor(session), body?.note) ?? unavailable() });

  routes.push({ method: 'GET', path: '/api/platform/preview', run: ({ query }) =>
    platform?.preview?.(query.get('sessionId')) ?? unavailable() });
  routes.push({ method: 'POST', path: '/api/platform/preview/start', run: ({ body, session }) => {
    const resources = Array.isArray(body?.resources) ? body.resources : [];
    const impacts = resources.slice(0, 256).map((resource) =>
      sharedCtx.contentDependencies?.impact?.(resource, 4) ?? { ok: false, node: resource });
    const missing = impacts.filter((entry) => entry.ok === false).map((entry) => entry.node);
    if (missing.length) return { ok: false, error: 'one or more preview resources do not exist', missing };
    return platform?.startPreview?.({ actor: actor(session), resources, ttlMs: body?.ttlMs,
      baseline: { world: { mobiles: sharedCtx.world?.mobiles?.size ?? 0, items: sharedCtx.world?.items?.size ?? 0 },
        dependencies: impacts.map((entry) => ({ node: entry.node, affected: entry.affected?.length ?? 0 })) } }) ?? unavailable();
  } });
  routes.push({ method: 'POST', path: '/api/platform/preview/mutate', run: ({ body, session }) =>
    platform?.mutatePreview?.(body?.sessionId, body?.mutations, actor(session)) ?? unavailable() });
  routes.push({ method: 'POST', path: '/api/platform/preview/simulate', run: ({ body, session }) =>
    platform?.simulatePreview?.(body?.sessionId, body?.event, body?.payload, actor(session)) ?? unavailable() });
  routes.push({ method: 'POST', path: '/api/platform/preview/end', run: ({ body, session }) =>
    platform?.endPreview?.(body?.sessionId, actor(session)) ?? unavailable() });

  routes.push({ method: 'POST', path: '/api/platform/impact', run: ({ body }) => {
    const resources = [...new Set((Array.isArray(body?.resources) ? body.resources : [])
      .map(String).filter(Boolean))].slice(0, 256);
    const impacts = resources.map((resource) => sharedCtx.contentDependencies?.impact?.(resource, body?.depth ?? 4)
      ?? { ok: false, node: resource, error: 'dependency graph unavailable' });
    return { ok: impacts.every((entry) => entry.ok !== false), dryRun: true, resources, impacts,
      fingerprint: fingerprint(impacts) };
  } });
  routes.push({ method: 'GET', path: '/api/platform/event-contracts', run: ({ query }) =>
    platform?.eventContracts?.({ query: query.get('query') ?? '', refresh: query.get('refresh') === 'true' }) ?? unavailable() });
  routes.push({ method: 'GET', path: '/api/platform/incidents', run: ({ query }) =>
    platform?.incidents?.({ kind: query.get('kind') ?? '', limit: query.get('limit') }) ?? unavailable() });
  routes.push({ method: 'GET', path: '/api/platform/live-events', run: ({ query }) =>
    platform?.listLiveEvents?.({ status: query.get('status') ?? '', includeCompleted: query.get('completed') === 'true' })
      ?? unavailable() });
  routes.push({ method: 'POST', path: '/api/platform/live-events/upsert', run: ({ body, session }) =>
    publishLiveEvent(platform?.upsertLiveEvent?.(body, actor(session)) ?? unavailable()) });
  routes.push({ method: 'POST', path: '/api/platform/live-events/transition', run: ({ body, session }) =>
    publishLiveEvent(platform?.transitionLiveEvent?.(body?.eventId, body, actor(session)) ?? unavailable()) });
}
