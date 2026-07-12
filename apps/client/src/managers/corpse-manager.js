// CorpseManager — tracks freshly-spawned corpses and their owning mobile.
//
// Mirrors ClassicUO's `Game/Managers/CorpseManager.cs`. The tile renderer
// uses `getCorpseDirection(corpseSerial)` to pick the right animation frame
// for the corpse art (corpses on the ground keep the facing of the mobile
// at the moment of death, packed into `Item.layer` per CUO convention:
// low 3 bits = direction, +0x80 = running variant).
//
// Lifecycle:
//   - `add(corpseSerial, mobileSerial, direction, isRunning)` — called from
//     0x2C / 0xAF death handlers.
//   - `remove(corpseSerial, mobileSerial)` — when 0x1D removes the corpse,
//     the dying mobile, or both. We commit `Item.layer` ON the corpse Item
//     so subsequent renders pick the correct facing even after the manager
//     forgets the entry.
//   - `getCorpseFacing(serial)` — renderer queries this; falls back to the
//     stamped layer if the manager has already cleaned up.
//   - `existsForMobile(mobile)` — used by the renderer to know whether a
//     death animation is still in flight (during which the *mobile* sprite
//     plays the death cycle and the corpse Item is ghost-rendered).

import { world } from '../world/world.js';
import { bus } from '../core/event-bus.js';
import { profile } from './profile-manager.js';
import { net } from '../net/net-client.js';
import { buildUseReq } from '../net/outgoing.js';

class CorpseManager {
  constructor() {
    /** @type {{corpse:number, obj:number, dir:number, run:boolean}[]} */
    this._entries = [];
    /** Facing retained until the corpse item itself arrives. 0xAF, 0x1D
     * and 0x1A may be reordered across network flushes. */
    this._pendingFacing = new Map();
    /** Auto-opened corpses (so we don't re-trigger on every world tick). */
    this._autoOpened = new Set();
    /** Wait until the user is in-game (we get `world:login-complete`).
     *  Subscribing earlier would risk firing on a stale corpse set from
     *  a previous session. */
    bus.on('world:login-complete', () => this._installAutoOpen());
    bus.on('net:close', () => this.clear());
  }

  /** @param {number} corpse @param {number} obj @param {number} dir @param {boolean} run */
  add(corpse, obj, dir, run = false) {
    const cs = corpse >>> 0, os = obj >>> 0;
    if (this._entries.some((c) => c.corpse === cs)) return;
    const facing = { dir: dir & 0x7, run: !!run };
    this._entries.push({ corpse: cs, obj: os, ...facing });
    this._pendingFacing.set(cs, facing);
    const existing = world.items.get(cs);
    if (existing) {
      existing.layer = (facing.dir & 0x7) | (facing.run ? 0x80 : 0);
      existing._deathRevealAt = performance.now() + 240;
      bus.emit('corpse:facing-changed', { serial: cs, facing });
    }
    // Auto-open immediately if the player is already standing close
    // enough (Corpse spawned right next to us — e.g. a kill we just made).
    this._maybeAutoOpen(cs);
  }

  _installAutoOpen() {
    if (this._autoOpenInstalled) return;
    this._autoOpenInstalled = true;
    bus.on('player:moved',    () => this._scanRange());
    bus.on('item:placed', (it) => {
      const serial = it?.serial >>> 0;
      const facing = this._pendingFacing.get(serial);
      if (facing && it) it.layer = (facing.dir & 0x7) | (facing.run ? 0x80 : 0);
      this._scanRange();
    });
  }

  /** Iterate all known corpses and open any within autoOpenRange tiles. */
  _scanRange() {
    if (!profile.get('corpse.autoOpen')) return;
    for (const e of this._entries) this._maybeAutoOpen(e.corpse);
  }

  _maybeAutoOpen(corpseSerial) {
    if (!profile.get('corpse.autoOpen')) return;
    if (this._autoOpened.has(corpseSerial)) return;
    const it = world.items.get(corpseSerial);
    const p = world.player;
    if (!it || !p) return;
    const dx = (it.x ?? 0) - (p.x ?? 0);
    const dy = (it.y ?? 0) - (p.y ?? 0);
    const range = profile.get('corpse.autoOpenRange') ?? 2;
    if (Math.max(Math.abs(dx), Math.abs(dy)) > range) return;
    if (profile.get('corpse.skipInnocent') && it.lootNoto === 1) return;
    if (profile.get('corpse.skipEmpty') && it.contentsCount === 0) return;
    this._autoOpened.add(corpseSerial);
    // Auto-open by sending 0x06 UseReq just like a double-click would.
    try { net.send(buildUseReq(corpseSerial)); } catch { /* socket */ }
    bus.emit('corpse:auto-opened', { serial: corpseSerial });
  }

  /** Remove the entry (called when the corpse Item is finalised or the
   *  dying mobile is despawned). Also stamps `Item.layer` on the corpse
   *  so the renderer keeps the right facing after we forget. */
  remove(corpse = 0, obj = 0) {
    const cs = corpse >>> 0, os = obj >>> 0;
    for (let i = this._entries.length - 1; i >= 0; i--) {
      const c = this._entries[i];
      if ((cs && c.corpse === cs) || (os && c.obj === os)) {
        const it = world.items.get(c.corpse);
        if (it) it.layer = (c.dir & 0x7) | (c.run ? 0x80 : 0);
        // Removing only the mobile must not discard facing before its
        // corpse item arrives. Removing the corpse ends the lifecycle.
        if (cs && c.corpse === cs) this._pendingFacing.delete(c.corpse);
        this._entries.splice(i, 1);
      }
    }
  }

  exists(corpse = 0, obj = 0) {
    const cs = corpse >>> 0, os = obj >>> 0;
    return this._entries.some(
      (c) => (cs && c.corpse === cs) || (os && c.obj === os)
    );
  }

  /** Returns the corpse Item that belongs to a given dying mobile, or null
   *  if no death is in progress. */
  getCorpseObject(mobileSerial) {
    const os = mobileSerial >>> 0;
    const e = this._entries.find((c) => c.obj === os);
    return e ? world.items.get(e.corpse) : null;
  }

  /** Renderer query. Returns { dir, run } or stamped layer info if the
   *  manager has already cleaned up. */
  getCorpseFacing(serial) {
    const cs = serial >>> 0;
    const e = this._entries.find((c) => c.corpse === cs);
    if (e) return { dir: e.dir & 0x7, run: e.run };
    const pending = this._pendingFacing.get(cs);
    if (pending) return { dir: pending.dir & 0x7, run: pending.run };
    const it = world.items.get(cs);
    if (it && typeof it.layer === 'number' && it.layer > 0) {
      return { dir: it.layer & 0x7, run: (it.layer & 0x80) !== 0 };
    }
    return { dir: 0, run: false };
  }

  clear() { this._entries.length = 0; this._pendingFacing.clear(); this._autoOpened.clear(); }
}

export const corpseManager = new CorpseManager();
