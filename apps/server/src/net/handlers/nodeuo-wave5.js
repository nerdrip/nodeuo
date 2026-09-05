import crypto from 'node:crypto';
import { acceptNodeUORenegotiation } from './nodeuo-session.js';

const traces = [];
const MAX_TRACES = 2048;
const FORMAT = new Set(['png', 'ktx2', 'basis', 'webp', 'avif']);

function hasConsent(state, category) {
  return state?.mobile?._nodeUOConsent?.categories?.[category] === true;
}

function clientProfile(state, payload) {
  if (!hasConsent(state, 'performance')) {
    return { ok: false, consentRequired: 'performance', error: 'performance consent is required' };
  }
  const atlas = payload.atlas && typeof payload.atlas === 'object' ? payload.atlas : {};
  const cache = payload.cache && typeof payload.cache === 'object' ? payload.cache : {};
  const profile = {
    revision: String(payload.revision ?? '').slice(0, 128),
    formats: [...new Set((Array.isArray(payload.formats) ? payload.formats : [])
      .map((value) => String(value).toLowerCase()).filter((value) => FORMAT.has(value)))],
    cache: {
      active: String(cache.active ?? '').slice(0, 128), previous: String(cache.previous ?? '').slice(0, 128),
      staging: String(cache.staging ?? '').slice(0, 128), usage: Math.max(0, Number(cache.usage) || 0),
      quota: Math.max(0, Number(cache.quota) || 0), pressure: Math.max(0, Math.min(1, Number(cache.pressure) || 0)),
    },
    atlas: {
      pages: Math.max(0, Number(atlas.pages) | 0), used: Math.max(0, Number(atlas.used) | 0),
      unused: Math.max(0, Number(atlas.unused) | 0), estimatedBytes: Math.max(0, Number(atlas.estimatedBytes) || 0),
      transferredBytes: Math.max(0, Number(atlas.transferredBytes) || 0),
      wastedPrefetches: Math.max(0, Number(atlas.wastedPrefetches) | 0),
      hotPages: (Array.isArray(atlas.hotPages) ? atlas.hotPages : []).slice(0, 64).map((row) => ({
        key: String(row?.key ?? '').slice(0, 96), kind: String(row?.kind ?? '').slice(0, 24),
        page: Number(row?.page) | 0, touches: Math.max(0, Number(row?.touches) | 0),
        transferredBytes: Math.max(0, Number(row?.transferredBytes) || 0),
        loadMs: Math.max(0, Math.min(60_000, Number(row?.loadMs) || 0)),
        format: FORMAT.has(String(row?.format)) ? String(row.format) : 'unknown',
        prefetched: row?.prefetched === true,
      })),
    },
    receivedAt: Date.now(),
  };
  state._nodeUOAssetProfile = profile;
  return { ok: true, acceptedAt: profile.receivedAt };
}

function findRelease(manager, id) {
  const snapshot = manager?.snapshot?.();
  if (!snapshot) return { snapshot: null, release: null };
  const releaseId = String(id ?? '');
  const release = releaseId
    ? snapshot.staged?.[releaseId] ?? (snapshot.active?.id === releaseId ? snapshot.active : null)
      ?? snapshot.history?.find?.((entry) => entry.id === releaseId)
    : snapshot.active;
  return { snapshot, release };
}

function contentPreflight(state, payload) {
  const { snapshot, release } = findRelease(state.ctx.contentReleases, payload.releaseId);
  if (!snapshot || !release) return { ok: false, error: 'release not found' };
  const profile = state._nodeUOAssetProfile;
  const bytes = (release.files ?? []).reduce((sum, row) => sum + (Number(row.bytes) || 0), 0);
  const available = Math.max(0, Number(payload.availableBytes) || (profile?.cache?.quota - profile?.cache?.usage) || 0);
  const formats = new Set([...(profile?.formats ?? []), ...(payload.formats ?? []).map(String)]);
  const requiresKtx2 = (release.files ?? []).some((row) => /\.ktx2$/i.test(row.name));
  const warnings = [];
  if (available && bytes > available) warnings.push('release exceeds reported available browser storage');
  if (requiresKtx2 && !formats.has('ktx2')) warnings.push('client will use PNG fallbacks for KTX2 atlas pages');
  return { ok: warnings.every((warning) => !warning.includes('exceeds')), releaseId: release.id,
    fingerprint: release.fingerprint, revision: snapshot.revision, files: release.files?.length ?? 0,
    bytes, availableBytes: available, cachePressure: profile?.cache?.pressure ?? null,
    requires: { ktx2: requiresKtx2 }, warnings, estimatedDownloadBytes: bytes };
}

function diagnosticTrace(state, payload) {
  if (!hasConsent(state, 'diagnostics')) {
    return { ok: false, consentRequired: 'diagnostics', error: 'diagnostics consent is required' };
  }
  const operation = String(payload.operation ?? 'capture').toLowerCase();
  if (operation === 'get') {
    const trace = traces.find((entry) => entry.traceId === String(payload.traceId));
    return trace && trace.sessionId === state.id ? { ok: true, trace } : { ok: false, error: 'trace not found' };
  }
  const startedAt = Date.now();
  const trace = {
    traceId: crypto.randomUUID(), sessionId: state.id, startedAt, durationMs: 0,
    context: {
      label: String(payload.context?.label ?? 'client-capture').slice(0, 96),
      feature: String(payload.context?.feature ?? '').slice(0, 128),
    },
    spans: [
      { name: 'transport.queue', at: startedAt, value: (Number(state.ws?.bufferedAmount) || 0) + (state._nodeUOJsonReliableBytes ?? 0), unit: 'bytes' },
      { name: 'world.visible-mobiles', at: startedAt, value: state._visibleMobiles?.size ?? 0, unit: 'entities' },
      { name: 'world.visible-items', at: startedAt, value: state._visibleItems?.size ?? 0, unit: 'entities' },
      { name: 'assets.cache-pressure', at: startedAt, value: state._nodeUOAssetProfile?.cache?.pressure ?? 0, unit: 'ratio' },
      { name: 'client.frame-p95', at: startedAt, value: state._nodeUOPerformanceHints?.frameP95Ms ?? 0, unit: 'ms' },
    ],
  };
  trace.durationMs = Math.max(0, Date.now() - startedAt);
  traces.push(trace);
  if (traces.length > MAX_TRACES) traces.splice(0, traces.length - MAX_TRACES);
  return { ok: true, trace };
}

export function protocolTraceSnapshot(limit = 100) {
  return traces.slice(-Math.max(1, Math.min(1000, Number(limit) | 0 || 100)));
}

export function handleNodeUOWave5Feature(state, message) {
  const payload = message.payload ?? {};
  switch (message.feature) {
    case 'protocol.renegotiate': return acceptNodeUORenegotiation(state, payload);
    case 'assets.client-profile': return clientProfile(state, payload);
    case 'content.preflight': return contentPreflight(state, payload);
    case 'diagnostics.trace': return diagnosticTrace(state, payload);
    default: return undefined;
  }
}

export function cleanupNodeUOWave5State(state) {
  delete state?._nodeUOAssetProfile;
  delete state?._nodeUORenegotiation;
}
