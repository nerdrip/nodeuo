import crypto from 'node:crypto';
import { NodeUODelivery, NodeUOJsonKind } from '@uo/nodeuo-protocol';
import { sendNodeUOFeature } from './nodeuo-modern.js';

const leases = new Map();
const LEASE_TTL_MS = 30_000;
const MAX_LEASES = 4096;

function isStaff(state) {
  return ['gm', 'admin', 'administrator', 'seer']
    .includes(String(state?.account?.accessLevel ?? '').toLowerCase());
}

function cleanLeases(now = Date.now()) {
  for (const [resource, lease] of leases) {
    if (lease.expiresAt <= now || lease.state?._closed) leases.delete(resource);
  }
}

function normalizeResource(source) {
  const value = String(source ?? '').trim().toLowerCase();
  if (!value || value.length > 128 || !/^[a-z0-9_.:-]+$/u.test(value)) return '';
  return value;
}

export function editorResourcesForMutations(mutations = []) {
  return [...new Set(mutations.map((row) => {
    const facet = Math.max(0, Math.min(255, Number(row?.facet) | 0));
    const sectorX = Math.max(0, Number(row?.x) | 0) >> 6;
    const sectorY = Math.max(0, Number(row?.y) | 0) >> 6;
    return `map:${facet}:${sectorX}:${sectorY}`;
  }))];
}

function publicLease(lease) {
  return {
    leaseId: lease.leaseId,
    resource: lease.resource,
    owner: {
      serial: lease.state.mobile?.serial >>> 0,
      name: String(lease.state.mobile?.name ?? lease.state.accountName ?? '').slice(0, 80),
    },
    cursor: lease.cursor,
    expiresAt: lease.expiresAt,
  };
}

function publish(state) {
  cleanLeases();
  const payload = { revision: Date.now(), serverTime: Date.now(), leases: [...leases.values()].map(publicLease) };
  for (const peer of state.ctx.connections ?? []) {
    if (!isStaff(peer)) continue;
    sendNodeUOFeature(peer, {
      feature: 'editor.collaboration', kind: NodeUOJsonKind.Snapshot, payload,
      delivery: NodeUODelivery.Latest, replace: 'editor-collaboration',
    });
  }
  return payload;
}

function ownedLease(state, resource, leaseId = '') {
  const lease = leases.get(resource);
  return lease && lease.state === state && (!leaseId || lease.leaseId === leaseId) ? lease : null;
}

export function editorLeaseConflict(state, resources, leaseId = '') {
  cleanLeases();
  for (const source of resources ?? []) {
    const resource = normalizeResource(source);
    const lease = leases.get(resource);
    if (lease && (lease.state !== state || (leaseId && lease.leaseId !== leaseId))) {
      return publicLease(lease);
    }
  }
  return null;
}

export function handleEditorCollaboration(state, operation, payload = {}) {
  if (!isStaff(state)) return { ok: false, error: 'staff access required' };
  cleanLeases();
  if (operation === 'list' || operation === 'status' || !operation) return { ok: true, ...publish(state) };
  const resource = normalizeResource(payload.resource);
  if (!resource) return { ok: false, error: 'valid editor resource is required' };
  const current = leases.get(resource);
  const leaseId = String(payload.leaseId ?? '').slice(0, 96);
  if (operation === 'acquire') {
    if (current && current.state !== state) {
      return { ok: false, error: 'resource is already leased', conflict: publicLease(current) };
    }
    const now = Date.now();
    const lease = current ?? { leaseId: crypto.randomUUID(), resource, state, acquiredAt: now, cursor: null };
    lease.expiresAt = now + LEASE_TTL_MS;
    leases.set(resource, lease);
    while (leases.size > MAX_LEASES) leases.delete(leases.keys().next().value);
    return { ok: true, lease: publicLease(lease), ...publish(state) };
  }
  const lease = ownedLease(state, resource, leaseId);
  if (!lease) return { ok: false, error: 'editor lease is missing, expired, or owned by another editor' };
  if (operation === 'release') {
    leases.delete(resource);
    return { ok: true, released: resource, ...publish(state) };
  }
  if (operation === 'renew' || operation === 'cursor') {
    lease.expiresAt = Date.now() + LEASE_TTL_MS;
    if (operation === 'cursor') lease.cursor = {
      x: Number(payload.cursor?.x) | 0,
      y: Number(payload.cursor?.y) | 0,
      z: Math.max(-128, Math.min(127, Number(payload.cursor?.z) | 0)),
      tool: String(payload.cursor?.tool ?? '').slice(0, 32),
    };
    return { ok: true, lease: publicLease(lease), ...publish(state) };
  }
  return { ok: false, error: 'unknown editor collaboration operation' };
}

export function cleanupEditorCollaboration(state) {
  let changed = false;
  for (const [resource, lease] of leases) {
    if (lease.state !== state) continue;
    leases.delete(resource);
    changed = true;
  }
  if (changed) publish(state);
}
