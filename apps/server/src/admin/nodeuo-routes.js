import {
  buildNodeUOManifest,
  NODEUO_FEATURE_CATALOG,
  NODEUO_FEATURE_DEPENDENCIES,
  NODEUO_FEATURE_LIFECYCLE,
  NODEUO_FEATURE_PROFILES,
  NODEUO_JSON_SUBPROTOCOL,
  NodeUODelivery,
  NodeUOJsonKind,
  profileFeatureIds,
  pruneFeatureDependencies,
} from '@uo/nodeuo-protocol';
import { broadcastNodeUOSettings, sendNodeUOFeature } from '../net/handlers/nodeuo-modern.js';
import { offerNodeUORenegotiation } from '../net/handlers/nodeuo-session.js';
import { protocolTraceSnapshot } from '../net/handlers/nodeuo-wave5.js';

function renegotiateConnections(sharedCtx, reason) {
  let offered = 0;
  for (const state of sharedCtx.connections ?? []) offered += offerNodeUORenegotiation(state, reason) ? 1 : 0;
  return offered;
}

function authorizeChange(sharedCtx, body, session, kind, resource) {
  return sharedCtx.platformOperations?.authorizeApproval?.(body?.approvalId, {
    kind, resource, actor: session?.account ?? 'unknown',
  }) ?? { ok: true, advisory: true };
}

export function registerNodeUORoutes(routes, sharedCtx) {
  routes.push({ method: 'GET', path: '/api/operations/protocol-costs', run: ({ query }) => ({
    ...sharedCtx?.protocolCosts?.snapshot?.({
      historyLimit: Math.max(1, Math.min(360, Number(query?.get?.('history')) || 120)),
    }),
    traffic: sharedCtx?.globalTrafficGovernor?.snapshot?.() ?? null,
  }) });
  routes.push({
    method: 'GET', path: '/api/operations/rbac',
    run: ({ session }) => ({
      current: { account: session?.account ?? null, accessLevel: session?.accessLevel ?? null },
      roles: [
        { role: 'Counselor', rank: 1, permissions: ['view diagnostics, content and sessions'] },
        { role: 'Seer', rank: 2, permissions: ['Counselor', 'broadcast, teleport and kick'] },
        { role: 'GameMaster', rank: 3, permissions: ['Seer', 'world, script and asset editing'] },
        { role: 'Admin', rank: 4, permissions: ['GameMaster', 'accounts, budgets, rollouts, releases and script control'] },
      ],
      freshAuthenticationMs: 5 * 60_000,
      protectedMutations: [
        '/api/operations/scripts/control', '/api/nodeuo/rollouts/*', '/api/nodeuo/releases/*',
        '/api/assets/editor/*', '/api/accounts/*', '/api/backups/restore', '/api/migrations/apply',
      ],
    }),
  });
  routes.push({
    method: 'GET',
    path: '/api/operations/features',
    run: () => {
      const manifest = buildNodeUOManifest(NODEUO_FEATURE_CATALOG);
      return ({
      protocol: `standard UO binary + negotiated ${NODEUO_JSON_SUBPROTOCOL} text JSON`,
      manifest,
      profiles: NODEUO_FEATURE_PROFILES,
      transportSeparation: {
        binaryFrames: 'standard UO only',
        textFrames: 'NodeUO JSON v2 only',
        unnegotiatedSessions: 'standard UO only',
      },
      features: NODEUO_FEATURE_CATALOG.map((feature) => ({
        ...feature,
        dependencies: NODEUO_FEATURE_DEPENDENCIES[feature.id] ?? [],
        schema: manifest.features.find((entry) => entry.id === feature.id)?.schema,
        lifecycle: NODEUO_FEATURE_LIFECYCLE[feature.id] ?? { status: 'stable', since: '2.0', replacement: null },
        enabled: sharedCtx.nodeUOSettings?.value?.features?.[feature.id] !== false,
      })),
      server: {
        huffmanOutgoing: !!sharedCtx?.config?.huffmanOutgoing,
        protocolMode: sharedCtx?.config?.protocolMode,
        scriptWatch: /^(1|true|yes)$/i.test(String(process.env.UO_SCRIPT_WATCH ?? '')),
      },
      });
    },
  });
  routes.push({
    method: 'GET', path: '/api/nodeuo/rollouts',
    run: () => sharedCtx.featureRollouts?.snapshot?.() ?? { ok: false, unavailable: true },
  });
  routes.push({
    method: 'POST', path: '/api/nodeuo/rollouts/draft',
    run: ({ body }) => sharedCtx.featureRollouts?.draft?.(body?.rules ?? {}) ?? { ok: false, error: 'rollout controller unavailable' },
  });
  routes.push({
    method: 'POST', path: '/api/nodeuo/rollouts/validate',
    run: ({ body }) => sharedCtx.featureRollouts?.validate?.(body?.rules) ?? { ok: false, error: 'rollout controller unavailable' },
  });
  routes.push({
    method: 'POST', path: '/api/nodeuo/rollouts/publish',
    run: ({ body, session }) => {
      const approval = authorizeChange(sharedCtx, body, session, 'protocol.rollout.publish',
        `revision:${Number(body?.expectedRevision) || 0}`);
      if (!approval.ok) return approval;
      const result = sharedCtx.featureRollouts?.publish?.(body?.expectedRevision);
      const renegotiated = result?.ok ? renegotiateConnections(sharedCtx, 'rollout-published') : 0;
      return result ? { ...result, renegotiationRequired: false, renegotiationOffered: renegotiated }
        : { ok: false, error: 'rollout controller unavailable' };
    },
  });
  routes.push({
    method: 'POST', path: '/api/nodeuo/rollouts/rollback',
    run: ({ body, session }) => {
      const approval = authorizeChange(sharedCtx, body, session, 'protocol.rollout.rollback',
        `revision:${Number(body?.expectedRevision) || 0}`);
      if (!approval.ok) return approval;
      const result = sharedCtx.featureRollouts?.rollback?.(body?.expectedRevision);
      const renegotiated = result?.ok ? renegotiateConnections(sharedCtx, 'rollout-rolled-back') : 0;
      return result ? { ...result, renegotiationRequired: false, renegotiationOffered: renegotiated }
        : { ok: false, error: 'rollout controller unavailable' };
    },
  });
  routes.push({
    method: 'POST', path: '/api/nodeuo/rollouts/kill-switch',
    run: ({ body, session }) => {
      const approval = authorizeChange(sharedCtx, body, session, 'protocol.kill-switch',
        `feature:${String(body?.feature ?? '')}`);
      if (!approval.ok) return approval;
      const result = body?.enabled === false
        ? sharedCtx.featureRollouts?.revive?.(body?.feature)
        : sharedCtx.featureRollouts?.kill?.(body?.feature, { durationMs: Number(body?.durationMs) || 0 });
      return result?.ok ? { ...result,
        renegotiationOffered: renegotiateConnections(sharedCtx, 'kill-switch-updated') } : result;
    },
  });
  routes.push({
    method: 'GET', path: '/api/nodeuo/sessions',
    run: () => ({ sessions: [...(sharedCtx.connections ?? [])].map((state) => ({
      id: state.id, account: state.accountName, character: state.mobile?.name ?? null,
      transport: state.nodeUOJsonTransport ? NODEUO_JSON_SUBPROTOCOL
        : state.transportKind === 'tcp' ? 'uo.tcp' : 'uo.websocket',
      protocol: state.nodeUOProtocol, clientVersion: state.clientVersionString,
      features: state.nodeUOFeatures?.size ?? 0,
      disabledFeatures: [...(state._nodeUODisabledFeatures ?? [])],
      performanceHints: state._nodeUOPerformanceHints ?? null,
      frameDiagnostics: state._nodeUOFrameDiagnostics ?? null,
      assetProfile: state._nodeUOAssetProfile ?? null,
      renegotiation: state._nodeUORenegotiation ? {
        epoch: state._nodeUORenegotiation.epoch, reason: state._nodeUORenegotiation.reason,
        expiresAt: state._nodeUORenegotiation.expiresAt,
      } : null,
      queuedBytes: (Number(state.ws?.bufferedAmount) || 0) + (state._nodeUOJsonReliableBytes ?? 0),
      stats: state.nodeUOJsonStats,
    })) }),
  });
  routes.push({
    method: 'POST', path: '/api/nodeuo/compatibility-lab',
    run: ({ body }) => {
      const available = NODEUO_FEATURE_CATALOG.filter((entry) =>
        sharedCtx.nodeUOSettings?.value?.features?.[entry.id] !== false);
      const profile = String(body?.profile ?? 'enhanced');
      const requested = Array.isArray(body?.features)
        ? body.features.map((id) => ({ id: String(id) }))
        : profileFeatureIds(profile, available).map((id) => ({ id }));
      const selected = pruneFeatureDependencies(requested.filter((entry) =>
        available.some((candidate) => candidate.id === entry.id)));
      const ids = new Set(selected.map((entry) => entry.id));
      return { ok: true, dryRun: true, profile, selected: [...ids].sort(),
        rejected: requested.map((entry) => entry.id).filter((id) => !ids.has(id)),
        classicClient: { compatible: true, enhancedFeatures: 0, transport: 'standard UO binary' },
        nodeUOClient: { compatible: true, enhancedFeatures: ids.size, transport: NODEUO_JSON_SUBPROTOCOL } };
    },
  });
  routes.push({ method: 'GET', path: '/api/nodeuo/traces',
    run: ({ query }) => ({ traces: protocolTraceSnapshot(query?.get?.('limit')) }) });
  routes.push({
    method: 'GET', path: '/api/nodeuo/releases',
    run: () => sharedCtx.contentReleases?.snapshot?.() ?? { ok: false, unavailable: true },
  });
  routes.push({ method: 'GET', path: '/api/nodeuo/releases/preflight', run: ({ query }) => {
    const profiles = [...(sharedCtx.connections ?? [])].map((state) => state._nodeUOAssetProfile).filter(Boolean);
    const result = sharedCtx.contentReleases?.preflight?.(query?.get?.('releaseId'), profiles);
    return result ?? { ok: false, error: 'content release manager unavailable' };
  } });
  routes.push({ method: 'GET', path: '/api/nodeuo/releases/compare', run: ({ query }) =>
    sharedCtx.contentReleases?.compare?.(query?.get?.('left'), query?.get?.('right'))
      ?? { ok: false, error: 'content release manager unavailable' } });
  routes.push({
    method: 'POST', path: '/api/nodeuo/releases/stage',
    run: ({ body }) => sharedCtx.contentReleases?.stage?.(body ?? {}) ?? { ok: false, error: 'content release manager unavailable' },
  });
  const publishRelease = (result) => {
    if (!result) return { ok: false, error: 'content release manager unavailable' };
    if (!result.ok) return result;
    for (const state of sharedCtx.connections ?? []) sendNodeUOFeature(state, {
      feature: 'content.release', kind: NodeUOJsonKind.Delta,
      delivery: NodeUODelivery.Reliable, payload: result,
    });
    return result;
  };
  routes.push({
    method: 'POST', path: '/api/nodeuo/releases/activate',
    run: async ({ body, session }) => {
      const approval = authorizeChange(sharedCtx, body, session, 'content.release.activate',
        `release:${String(body?.releaseId ?? '')}`);
      if (!approval.ok) return approval;
      return publishRelease(await sharedCtx.contentReleases?.activate?.(body?.releaseId, body?.expectedRevision));
    },
  });
  routes.push({
    method: 'POST', path: '/api/nodeuo/releases/rollback',
    run: ({ body, session }) => {
      const approval = authorizeChange(sharedCtx, body, session, 'content.release.rollback',
        `revision:${Number(body?.expectedRevision) || 0}`);
      if (!approval.ok) return approval;
      return publishRelease(sharedCtx.contentReleases?.rollback?.(body?.expectedRevision));
    },
  });
  routes.push({
    method: 'GET',
    path: '/api/nodeuo/settings',
    run: () => sharedCtx.nodeUOSettings?.adminSnapshot?.()
      ?? sharedCtx.nodeUOSettings?.snapshot?.() ?? {},
  });
  routes.push({
    method: 'PUT',
    path: '/api/nodeuo/settings',
    run: ({ body, session }) => {
      try {
        const approval = authorizeChange(sharedCtx, body, session, 'protocol.settings.update', 'global');
        if (!approval.ok) return approval;
        const result = sharedCtx.nodeUOSettings.update(body);
        broadcastNodeUOSettings(sharedCtx.connections, result);
        const renegotiationOffered = renegotiateConnections(sharedCtx, 'settings-updated');
        return { ok: true, ...(sharedCtx.nodeUOSettings.adminSnapshot?.() ?? result), renegotiationOffered };
      } catch (error) {
        return { error: error.message };
      }
    },
  });
}
