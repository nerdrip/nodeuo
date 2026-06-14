// AnchorManager — magnetic snapping between draggable gumps. Mirrors
// CUO `Game/Managers/AnchorManager.cs`.
//
// CUO uses an "AnchorGroup" tree: when gump B is dragged within
// `SNAP_DIST` of gump A's edge it attaches to A's group, then dragging
// A moves the whole group. Edges N/E/S/W are tested via triangle hit
// against the edge midpoint.
//
// Our implementation is intentionally minimal: we keep a flat registry
// of "anchored" pairs. While dragging we check the dragged gump's
// edges against every other registered gump and snap when within
// SNAP_DIST (12 px). Snap commits a parent → child relation so the
// child follows when the parent moves.

import { bus } from '../core/event-bus.js';

const SNAP_DIST = 12;

class AnchorManager {
  constructor() {
    /** registry of every anchorable gump (by ref) */
    this._gumps = new Set();
    /** child → parent map */
    this._parent = new Map();
    /** parent → Set<child> */
    this._children = new Map();
    this._installed = false;
  }
  install() {
    if (this._installed) return;
    this._installed = true;
    bus.on('gump:dragged', (info) => this._onDrag(info));
    bus.on('gump:dropped', (info) => this._onDrop(info));
    bus.on('gump:disposed', (info) => this._unregister(info?.gump));
  }
  register(gump) {
    if (gump?.anchorable !== false) this._gumps.add(gump);
  }
  _unregister(gump) {
    if (!gump) return;
    this._gumps.delete(gump);
    const parent = this._parent.get(gump);
    if (parent) this._children.get(parent)?.delete(gump);
    this._parent.delete(gump);
    const kids = this._children.get(gump);
    if (kids) {
      for (const k of kids) this._parent.delete(k);
      this._children.delete(gump);
    }
  }
  _rect(g) {
    return { x: g.x, y: g.y, w: g.width, h: g.height };
  }
  _onDrag({ gump, dx, dy }) {
    // Translate every descendant child by the same delta so the group moves together.
    const kids = this._children.get(gump);
    if (!kids) return;
    for (const k of kids) {
      k.setPosition(k.x + dx, k.y + dy);
      this._onDrag({ gump: k, dx, dy });
    }
  }
  _onDrop({ gump }) {
    if (!gump || !this._gumps.has(gump)) return;
    // Detach from previous parent.
    const oldParent = this._parent.get(gump);
    if (oldParent) this._children.get(oldParent)?.delete(gump);
    this._parent.delete(gump);

    const a = this._rect(gump);
    let bestParent = null;
    let bestDist = SNAP_DIST + 1;
    for (const other of this._gumps) {
      if (other === gump) continue;
      // Skip if `other` is a descendant of `gump` (would create a cycle).
      if (this._isDescendant(gump, other)) continue;
      const b = this._rect(other);
      // Test alignment to each side of `b`.
      // Snap right side of `gump` to left side of `b`.
      const candidates = [
        // gump on left of other
        { dx: b.x - (a.x + a.w), edge: 'L' },
        // gump on right of other
        { dx: (b.x + b.w) - a.x, edge: 'R' },
      ];
      for (const c of candidates) {
        const dist = Math.abs(c.dx);
        const overlapY = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        if (overlapY > 8 && dist < bestDist) { bestDist = dist; bestParent = other; bestParent._snap = c; }
      }
      const vCandidates = [
        { dy: b.y - (a.y + a.h), edge: 'T' },
        { dy: (b.y + b.h) - a.y, edge: 'B' },
      ];
      for (const c of vCandidates) {
        const dist = Math.abs(c.dy);
        const overlapX = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        if (overlapX > 8 && dist < bestDist) { bestDist = dist; bestParent = other; bestParent._snap = c; }
      }
    }
    if (bestParent && bestParent._snap) {
      // Apply snap.
      if (bestParent._snap.dx != null) {
        gump.setPosition(gump.x + bestParent._snap.dx, gump.y);
      } else if (bestParent._snap.dy != null) {
        gump.setPosition(gump.x, gump.y + bestParent._snap.dy);
      }
      this._parent.set(gump, bestParent);
      let kids = this._children.get(bestParent);
      if (!kids) { kids = new Set(); this._children.set(bestParent, kids); }
      kids.add(gump);
      bestParent._snap = null;
    }
  }
  _isDescendant(possibleAncestor, target) {
    let cur = this._parent.get(possibleAncestor);
    while (cur) {
      if (cur === target) return true;
      cur = this._parent.get(cur);
    }
    return false;
  }
}

export const anchorManager = new AnchorManager();
