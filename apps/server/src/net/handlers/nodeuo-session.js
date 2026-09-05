import {
  advertisedFeatureList,
  buildNodeUOManifest,
  isNodeUOMessageExpired,
  negotiateFeatures,
  NODEUO_JSON_NEGOTIATION_TIMEOUT_MS,
  NODEUO_JSON_PROTOCOL,
  NodeUOJsonKind,
  parseNodeUOFrame,
  pruneFeatureDependencies,
  schemaFingerprintForFeature,
} from '@uo/nodeuo-protocol';
import * as diagnostics from '../../systems/operational-diagnostics.js';
import { withNodeUORequestContext } from '../../systems/request-context.js';
import { handleNodeUOJsonMessage, initializeNodeUOModern } from './nodeuo-modern.js';

export const NODEUO_NEGOTIATION_TIMEOUT_MS = NODEUO_JSON_NEGOTIATION_TIMEOUT_MS;

function cancelScheduled(handle) {
  if (typeof handle?.cancel === 'function') return handle.cancel();
  if (handle) clearTimeout(handle);
  return false;
}

function scheduleStateOnce(state, name, delayMs, callback) {
  return state?.ctx?.scheduler?.once
    ? state.ctx.scheduler.once(`${name}:${state.id}`, delayMs, callback)
    : setTimeout(callback, delayMs);
}

function isStaff(state) {
  return ['gm', 'admin', 'administrator', 'seer']
    .includes(String(state?.account?.accessLevel ?? '').toLowerCase());
}

export function availableV2Features(state, settings = state.ctx?.nodeUOSettings?.snapshot?.()
  ?? state.ctx?.nodeUOSettings?.value ?? {}) {
  const webTransport = !!(settings.webTransportUrl || state.ctx?.config?.nodeUOWebTransportUrl);
  return pruneFeatureDependencies(advertisedFeatureList({ webTransport }).filter((entry) => {
    if (settings.features?.[entry.id] === false) return false;
    if (state.ctx?.featureRollouts?.allowed?.(state, entry.id) === false) return false;
    if (entry.id === 'npc.generative') return settings.ai?.enabled === true && !!settings.ai?.endpoint;
    if (entry.id === 'voice.authorization' || entry.id === 'voice.spatial-state') {
      return settings.voice?.enabled === true && !!settings.voice?.endpoint && !!settings.voice?.secret;
    }
    if (entry.id === 'instance.handoff' || entry.id === 'instance.live-handoff') {
      return settings.instances?.some?.((route) => route.enabled !== false && route.secret);
    }
    if (entry.id === 'cinematic.timeline') return Object.keys(settings.cinematics ?? {}).length > 0;
    if (entry.id === 'ai.inspector' || entry.id === 'spectator.replay'
        || entry.id === 'spectator.full-stream' || entry.id === 'debug.time-travel'
        || entry.id === 'admin.config-transactions' || entry.id === 'editor.transactions') return isStaff(state);
    return true;
  }));
}

/** Two-phase feature renegotiation for live JSON sessions. The current map
 * remains authoritative until the client accepts the new manifest, so a
 * rollout edit cannot leave half-updated sessions. Classic clients are
 * intentionally untouched. */
export function offerNodeUORenegotiation(state, reason = 'configuration-changed') {
  if (!state?.nodeUOJsonTransport || !state.nodeUOProtocol
      || !state.supportsNodeUO?.('protocol.renegotiate')) return false;
  const features = availableV2Features(state);
  const manifest = buildNodeUOManifest(features);
  const epoch = (Number(state._nodeUORenegotiationEpoch) || 0) + 1;
  state._nodeUORenegotiationEpoch = epoch;
  state._nodeUORenegotiation = { epoch, features, manifest,
    reason: String(reason).slice(0, 128), expiresAt: Date.now() + NODEUO_NEGOTIATION_TIMEOUT_MS };
  return state.sendNodeUOMessage({
    kind: NodeUOJsonKind.Event, feature: 'protocol.renegotiate',
    featureVersion: state.nodeUOFeatures.get('protocol.renegotiate') ?? 1,
    delivery: 'reliable', requiresAck: true,
    payload: { operation: 'prepare', epoch, reason: state._nodeUORenegotiation.reason,
      features, manifest },
  });
}

export function acceptNodeUORenegotiation(state, payload = {}) {
  const pending = state?._nodeUORenegotiation;
  if (!pending || pending.epoch !== Number(payload.epoch) || pending.expiresAt < Date.now()) {
    return { ok: false, conflict: true, error: 'renegotiation offer is missing or expired' };
  }
  const schemas = payload.manifest?.schemas;
  const selected = pruneFeatureDependencies(negotiateFeatures(pending.features, payload.features).filter((entry) => {
    const claimed = schemas && typeof schemas === 'object' ? schemas[entry.id] : null;
    return !claimed || claimed === schemaFingerprintForFeature(entry.id);
  }));
  if (!selected.some((entry) => entry.id === 'protocol.renegotiate')) {
    return { ok: false, error: 'renegotiation control feature was not accepted' };
  }
  state.nodeUOFeatures = new Map(selected.map((entry) => [entry.id, entry.version]));
  state._nodeUODisabledFeatures?.clear?.();
  state._nodeUORenegotiation = null;
  diagnostics.connectionUpdated(state);
  return { ok: true, operation: 'activate', epoch: pending.epoch,
    reason: pending.reason, features: selected, manifest: buildNodeUOManifest(selected) };
}

/** Offer private features only on the explicitly selected NodeUO transport. */
export function offerNodeUOSession(state, now = Date.now()) {
  if (!state?.nodeUOJsonTransport || state._closed) return false;
  cancelScheduled(state._nodeUOSessionTimer);
  state.nodeUOProtocol = null;
  state.nodeUOFeatures?.clear?.();
  const settings = state.ctx?.nodeUOSettings?.snapshot?.() ?? state.ctx?.nodeUOSettings?.value ?? {};
  const features = availableV2Features(state, settings);
  const manifest = buildNodeUOManifest(features);
  state._nodeUOSessionOffer = {
    protocol: NODEUO_JSON_PROTOCOL,
    features,
    sentAt: now,
    expiresAt: now + NODEUO_NEGOTIATION_TIMEOUT_MS,
    acceptedAt: null,
  };
  state.sendNodeUOMessage({
    kind: NodeUOJsonKind.Hello,
    feature: 'protocol.session',
    payload: {
      protocol: NODEUO_JSON_PROTOCOL,
      server: { name: state.ctx?.config?.shardName ?? 'NodeUO', transport: 'text-json' },
      defaultProfile: settings.defaultProfile ?? 'full',
      features,
      manifest,
      profiles: manifest.profiles,
      limits: {
        maxMessageBytes: 512 * 1024,
        negotiationTimeoutMs: NODEUO_NEGOTIATION_TIMEOUT_MS,
      },
    },
  }, { allowBeforeNegotiation: true });
  state._nodeUOSessionTimer = scheduleStateOnce(
    state,
    'nodeuo-json-capability',
    NODEUO_NEGOTIATION_TIMEOUT_MS,
    () => {
      state._nodeUOSessionTimer = null;
      const offer = state._nodeUOSessionOffer;
      if (offer && offer.acceptedAt == null) {
        state.nodeUOProtocol = null;
        state.nodeUOFeatures.clear();
        offer.expired = true;
        diagnostics.connectionUpdated(state);
      }
    },
  );
  state._nodeUOSessionTimer.unref?.();
  return true;
}

/** Text frames are reserved for the private NodeUO v2 protocol. */
export function handleNodeUOSessionText(state, text, {
  vendors,
  pushCommandCatalogue,
  pushMovementHint,
} = {}) {
  if (!state?.nodeUOJsonTransport || state._closed) return false;
  let messages;
  try { messages = parseNodeUOFrame(text); }
  catch (error) {
    if (state.nodeUOJsonStats) state.nodeUOJsonStats.rejected++;
    console.warn(`[net#${state.id}] rejected NodeUO JSON: ${error?.message ?? error}`);
    return false;
  }
  if (state.nodeUOJsonStats && messages.length > 1) {
    state.nodeUOJsonStats.received += messages.length - 1;
    state.nodeUOJsonStats.batchedMessages += messages.length;
  }
  let handled = false;
  const estimatedMessageBytes = Math.max(1, Math.ceil(Buffer.byteLength(text) / Math.max(1, messages.length)));
  for (const message of messages) {
    const costStarted = performance.now();
    if (isNodeUOMessageExpired(message)) {
      if (state.nodeUOJsonStats) state.nodeUOJsonStats.expired++;
      continue;
    }
    if (message.kind === NodeUOJsonKind.Accept && message.feature === 'protocol.session') {
      const offer = state._nodeUOSessionOffer;
      const now = Date.now();
      if (!offer || offer.protocol !== NODEUO_JSON_PROTOCOL || offer.acceptedAt != null
          || offer.expired || now > offer.expiresAt
          || Number(message.payload?.protocol) !== NODEUO_JSON_PROTOCOL) return false;
      const clientSchemas = message.payload?.manifest?.schemas;
      const selected = pruneFeatureDependencies(negotiateFeatures(offer.features, message.payload?.features).filter((entry) => {
        const claimed = clientSchemas && typeof clientSchemas === 'object' ? clientSchemas[entry.id] : null;
        return !claimed || claimed === schemaFingerprintForFeature(entry.id);
      }));
      offer.acceptedAt = now;
      cancelScheduled(state._nodeUOSessionTimer);
      state._nodeUOSessionTimer = null;
      state.nodeUOProtocol = { major: NODEUO_JSON_PROTOCOL, minor: 0, json: true };
      state.nodeUOFeatures = new Map(selected.map((entry) => [entry.id, entry.version]));
      state.nodeUOProfile = String(message.payload?.profile ?? 'full').slice(0, 32);
      diagnostics.connectionUpdated(state);
      pushCommandCatalogue?.(state);
      pushMovementHint?.(state);
      initializeNodeUOModern(state);
      state.ctx.protocolCosts?.record?.('protocol.session', 'inbound', {
        bytes: estimatedMessageBytes, ms: performance.now() - costStarted, outcome: 'handled',
      });
      handled = true;
      continue;
    }
    let messageHandled = false;
    try {
      messageHandled = withNodeUORequestContext(state, message,
        () => handleNodeUOJsonMessage(state, message, { vendors }));
      handled = messageHandled || handled;
      state.ctx.protocolCosts?.record?.(message.feature, 'inbound', {
        bytes: estimatedMessageBytes, ms: performance.now() - costStarted,
        outcome: messageHandled ? 'handled' : 'rejected',
      });
      state.ctx.featureRollouts?.observe?.(message.feature, messageHandled === true);
    } catch (error) {
      state.ctx.protocolCosts?.record?.(message.feature, 'inbound', {
        bytes: estimatedMessageBytes, ms: performance.now() - costStarted, outcome: 'error',
      });
      state.ctx.featureRollouts?.observe?.(message.feature, false);
      throw error;
    }
  }
  return handled;
}
