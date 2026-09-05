import { NodeUOWorldField } from '@uo/nodeuo-protocol';
import { EntityDirty } from '../world/interest-management.js';
import { trySendNodeUOEntityBatch, trySendNodeUOEntityRemoved } from '../net/handlers/nodeuo-modern.js';

function wireMask(dirty, entity) {
  if ((dirty & EntityDirty.Created) || dirty === EntityDirty.All) {
    return entity?.itemId != null
      ? NodeUOWorldField.Position | NodeUOWorldField.Appearance | NodeUOWorldField.Parent
      : NodeUOWorldField.Position | NodeUOWorldField.Appearance | NodeUOWorldField.Vitals | NodeUOWorldField.Status;
  }
  let mask = 0;
  if (dirty & EntityDirty.Position) mask |= NodeUOWorldField.Position;
  if (dirty & EntityDirty.Appearance) mask |= NodeUOWorldField.Appearance | NodeUOWorldField.Status;
  if (dirty & EntityDirty.Vitals) mask |= NodeUOWorldField.Vitals | NodeUOWorldField.Status;
  if (dirty & EntityDirty.Parent) mask |= NodeUOWorldField.Parent | NodeUOWorldField.Position;
  return mask;
}

function visibleTo(state, serial, kind) {
  if ((state.mobile?.serial >>> 0) === serial) return true;
  return kind === 'item' ? state._visibleItems?.has?.(serial) : state._visibleMobiles?.has?.(serial);
}

function candidateStates(ctx, row, entity) {
  const location = row.location ?? (entity && !entity.parent
    ? { x: entity.x, y: entity.y, map: entity.map } : null);
  if (!location || !ctx.world?._sectorIndexAuthoritative
      || !ctx.world?.sectors?.onlineMobileSerialsNear) return ctx.connections;
  const states = new Set();
  for (const serial of ctx.world.sectors.onlineMobileSerialsNear(
    location.map | 0, location.x | 0, location.y | 0, 32,
  )) {
    const state = ctx.world.mobiles.get(serial)?.client;
    if (state && ctx.connections.has(state)) states.add(state);
  }
  if (entity?.client && ctx.connections.has(entity.client)) states.add(entity.client);
  return states;
}

/** Coalesces authoritative world dirty events into per-viewer enhanced deltas. */
export function installNodeUOReplication(ctx) {
  const pending = new Map();
  const stats = { drains: 0, dirtyRows: 0, viewerRows: 0, jsonBatches: 0,
    classicSkipped: 0, candidateChecks: 0, fullFanoutScans: 0 };
  let scheduled = false;
  const drain = () => {
    scheduled = false;
    const batch = [...pending.values()].slice(0, 1024);
    for (const row of batch) pending.delete(row.serial);
    stats.drains++;
    stats.dirtyRows += batch.length;
    const byViewer = new Map();
    for (const row of batch) {
      const entity = ctx.world.mobiles.get(row.serial) ?? ctx.world.items.get(row.serial);
      const removed = !!(row.mask & EntityDirty.Removed) || !entity;
      const mask = removed ? 0 : wireMask(row.mask, entity);
      if (!removed && !mask) continue;
      const candidates = candidateStates(ctx, row, entity);
      if (candidates === ctx.connections) stats.fullFanoutScans++;
      for (const state of candidates) {
        stats.candidateChecks++;
        if (!visibleTo(state, row.serial, row.kind)) continue;
        const rows = byViewer.get(state) ?? [];
        if (!byViewer.has(state)) byViewer.set(state, rows);
        rows.push({ serial: row.serial, mask, removed });
        stats.viewerRows++;
      }
    }
    for (const [state, rows] of byViewer) {
      for (const row of rows) if (row.removed) trySendNodeUOEntityRemoved(state, row.serial);
      const updates = rows.filter((row) => !row.removed);
      if (!updates.length) continue;
      if (state.nodeUOJsonTransport) {
        const actor = state.mobile;
        updates.sort((a, b) => {
          if (!actor) return 0;
          const ea = ctx.world.mobiles.get(a.serial) ?? ctx.world.items.get(a.serial);
          const eb = ctx.world.mobiles.get(b.serial) ?? ctx.world.items.get(b.serial);
          const da = ea ? Math.max(Math.abs(ea.x - actor.x), Math.abs(ea.y - actor.y)) : 1e9;
          const db = eb ? Math.max(Math.abs(eb.x - actor.x), Math.abs(eb.y - actor.y)) : 1e9;
          return da - db;
        });
        const pressured = (Number(state.ws?.bufferedAmount) || 0) > (state.backpressureLimits?.soft ?? Infinity);
        const chunkSize = pressured ? 32 : (state.roundTripMs ?? 0) > 250 ? 64 : 128;
        for (let offset = 0; offset < updates.length; offset += chunkSize) {
          trySendNodeUOEntityBatch(state, updates.slice(offset, offset + chunkSize));
          stats.jsonBatches++;
        }
      } else {
        // The classic visibility pipeline already emitted canonical UO
        // packets for these mutations. Never duplicate them privately.
        stats.classicSkipped += updates.length;
      }
    }
    if (pending.size) { scheduled = true; setImmediate(drain); }
  };
  const unsubscribe = ctx.world.interest.onDirty((serial, mask, kind, _revision, change) => {
    const row = pending.get(serial);
    if (row) { row.mask |= mask; if (change?.location) row.location = change.location; }
    else pending.set(serial, { serial, mask, kind, location: change?.location ?? null });
    if (!scheduled) { scheduled = true; setImmediate(drain); }
  });
  return { close: unsubscribe, diagnostics: () => ({ ...stats, pending: pending.size, scheduled }) };
}
