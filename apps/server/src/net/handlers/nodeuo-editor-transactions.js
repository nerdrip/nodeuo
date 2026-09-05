import crypto from 'node:crypto';
import path from 'node:path';
import { NodeUOFeature, NodeUOJsonKind } from '@uo/nodeuo-protocol';
import { invalidateLosCache } from '../../world/los.js';
import { sendNodeUOFeature } from './nodeuo-modern.js';
import { editorLeaseConflict, editorResourcesForMutations } from './nodeuo-editor-collaboration.js';

const providerRevisions = new WeakMap();

function isStaff(state) {
  return ['gm', 'admin', 'administrator', 'seer']
    .includes(String(state?.account?.accessLevel ?? '').toLowerCase());
}

function normalizeLandMutations(source) {
  if (!Array.isArray(source) || source.length === 0) throw new Error('at least one mutation is required');
  if (source.length > 4096) throw new Error('too many mutations (max 4096)');
  const mutations = [];
  for (const row of source) {
    if ((row?.kind ?? 'land') !== 'land' || !Number.isFinite(Number(row?.x))
        || !Number.isFinite(Number(row?.y)) || !Number.isFinite(Number(row?.tileId))) {
      throw new Error('only valid land mutations are supported');
    }
    const mutation = {
      kind: 'land', facet: Math.max(0, Math.min(5, Number(row.facet) | 0)),
      x: Number(row.x) | 0, y: Number(row.y) | 0,
      tileId: Number(row.tileId) & 0x3fff,
      z: Math.max(-128, Math.min(127, Number(row.z) | 0)),
    };
    if (mutation.x < 0 || mutation.y < 0 || mutation.x > 0xffff || mutation.y > 0xffff) {
      throw new Error('land mutation coordinate is outside the map');
    }
    mutations.push(mutation);
  }
  return mutations;
}

function broadcastLandMutations(state, mutations) {
  let sent = 0;
  const byFacet = new Map();
  for (const mutation of mutations) {
    const rows = byFacet.get(mutation.facet) ?? [];
    if (!byFacet.has(mutation.facet)) byFacet.set(mutation.facet, rows);
    rows.push(mutation);
  }
  for (const [facet, rows] of byFacet) {
    const minX = Math.min(...rows.map((row) => row.x));
    const maxX = Math.max(...rows.map((row) => row.x));
    const minY = Math.min(...rows.map((row) => row.y));
    const maxY = Math.max(...rows.map((row) => row.y));
    for (const peer of state.ctx.connections ?? []) {
      if (!peer.mobile || peer.mobile.map !== facet
          || peer.mobile.x < minX - 32 || peer.mobile.x > maxX + 32
          || peer.mobile.y < minY - 32 || peer.mobile.y > maxY + 32) continue;
      if (peer.supportsNodeUO?.(NodeUOFeature.WorldEditing)) sent += !!sendNodeUOFeature(peer, {
        feature: NodeUOFeature.WorldEditing, kind: NodeUOJsonKind.Delta,
        payload: { operation: 'map-edits', facet, edits: rows },
      });
    }
  }
  return sent;
}

export function handleEditorTransaction(state, operation, payload) {
  if (!isStaff(state)) return { ok: false, error: 'staff access required' };
  const provider = state.ctx.landProvider;
  const saveDir = state.ctx.saveDir ?? state.ctx.persistence?.saveDir;
  if (!provider?.setLandTile || !provider?.saveEditsSync || !saveDir) {
    return { ok: false, error: 'map editor storage is unavailable' };
  }
  const transactions = state._nodeUOEditorTransactions ??= new Map();
  const currentRevision = providerRevisions.get(provider) ?? 0;
  const now = Date.now();
  for (const [id, transaction] of transactions) if (transaction.expiresAt <= now) transactions.delete(id);
  const requestedId = String(payload.transactionId ?? '').slice(0, 96);
  if (operation === 'begin') {
    const transactionId = requestedId || crypto.randomUUID();
    if (transactions.has(transactionId)) return { ok: false, error: 'transaction already exists' };
    while (transactions.size >= 8) transactions.delete(transactions.keys().next().value);
    transactions.set(transactionId, { id: transactionId, mutations: [], createdAt: now,
      baseRevision: currentRevision,
      expiresAt: now + 5 * 60_000 });
    return { ok: true, transactionId, staged: 0, baseRevision: currentRevision,
      expiresAt: now + 5 * 60_000 };
  }
  const transaction = transactions.get(requestedId);
  if (!transaction) return { ok: false, error: 'transaction not found or expired' };
  if (operation === 'rollback') {
    transactions.delete(requestedId);
    return { ok: true, transactionId: requestedId, rolledBack: transaction.mutations.length };
  }
  if (operation === 'status') return { ok: true, transactionId: requestedId,
    staged: transaction.mutations.length, baseRevision: transaction.baseRevision,
    currentRevision, conflicted: transaction.baseRevision !== currentRevision,
    expiresAt: transaction.expiresAt };
  if (operation === 'stage') {
    let incoming;
    try { incoming = normalizeLandMutations(payload.mutations); }
    catch (error) { return { ok: false, error: error.message }; }
    if (transaction.mutations.length + incoming.length > 4096) {
      return { ok: false, error: 'transaction mutation limit exceeded' };
    }
    transaction.mutations.push(...incoming);
    transaction.expiresAt = now + 5 * 60_000;
    return { ok: true, transactionId: requestedId, staged: transaction.mutations.length,
      expiresAt: transaction.expiresAt };
  }
  if (operation !== 'commit') return { ok: false, error: 'unknown transaction operation' };
  if (!transaction.mutations.length) return { ok: false, error: 'transaction has no mutations' };
  const resources = editorResourcesForMutations(transaction.mutations);
  const leaseConflict = editorLeaseConflict(state, resources, String(payload.leaseId ?? ''));
  if (leaseConflict) return {
    ok: false, error: 'editor lease conflict', resource: leaseConflict.resource,
    conflict: leaseConflict,
  };
  if (transaction.baseRevision !== currentRevision) return {
    ok: false, error: 'map revision conflict', baseRevision: transaction.baseRevision, currentRevision,
  };
  const existing = new Map([...(provider.iterEdits?.() ?? [])].map((row) => [
    `${row.facet}|${row.x}|${row.y}`, row,
  ]));
  const originals = transaction.mutations.map((row) => ({
    ...row, previous: provider.landAt(row.facet, row.x, row.y),
    hadOverlay: existing.has(`${row.facet}|${row.x}|${row.y}`),
  }));
  try {
    for (const row of transaction.mutations) provider.setLandTile(row.facet, row.x, row.y, row.tileId, row.z);
    const persisted = provider.saveEditsSync(path.join(saveDir, 'map-edits.json'));
    if (persisted?.error) throw new Error(persisted.error);
    invalidateLosCache();
    const broadcast = broadcastLandMutations(state, transaction.mutations);
    const revision = currentRevision + 1;
    providerRevisions.set(provider, revision);
    transactions.delete(requestedId);
    return { ok: true, transactionId: requestedId, committed: transaction.mutations.length,
      revision, broadcast, persist: persisted, resources };
  } catch (error) {
    for (const row of originals) {
      if (row.hadOverlay && row.previous) {
        provider.setLandTile(row.facet, row.x, row.y, row.previous.tileId, row.previous.z);
      } else provider.clearLandTile?.(row.facet, row.x, row.y);
    }
    provider.saveEditsSync(path.join(saveDir, 'map-edits.json'));
    return { ok: false, error: `transaction commit failed: ${error.message}` };
  }
}

export function cleanupEditorTransactions(state) {
  state?._nodeUOEditorTransactions?.clear?.();
}
