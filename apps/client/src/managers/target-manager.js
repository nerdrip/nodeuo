// TargetManager — owns the "are we currently picking a target?" state.
// Mirrors ClassicUO's Game/Managers/TargetManager.cs.
//
// Server flow:
//   server sends 0x6C TargetCursor (cursorType, cursorId, flag)
//   we activate target mode; the next world-click / mob-click / press-Esc
//   sends 0x6C TargetResponse with the picked entity (or cancel = serial 0)

import { net } from '../net/net-client.js';
import { bus } from '../core/event-bus.js';
import { buildTargetResponse, buildAttackReq } from '../net/outgoing.js';
import { world } from '../world/world.js';

export const CursorType = { Object: 0, Position: 1, Multi: 2, Cancel: 3 };

class TargetManager {
  constructor() {
    this.active = false;
    this.cursorType = CursorType.Object;
    this.cursorId = 0;
    this.flag = 0;
    /** Last server-supplied target (used by macros: TargetLast). */
    this.lastTarget = null;
    /** Last hostile target — set by 0xAA AttackCharacter responses, used
     *  by `attack-selected` macro when there's no live target prompt. */
    this.lastAttack = null;
    /** Multi-placement state: when set, the next click drops a multi at
     *  that tile via 0x6C with cursorType=Multi + multiId echoed. */
    this.multi = null;
    /** FIFO queue of pending cursor prompts. ServUO can stack two
     *  cursors (cast → animal-lore → ...) and CUO drains them in
     *  order. The previous single-slot impl dropped the second
     *  prompt entirely — macro chains broke after the first action. */
    this._queue = [];
    this._queueHead = 0;
    /** Recent-targets ring — CUO `TargetManager.cs::TargetingNew`
     *  cycles via SelectNext / SelectPrevious / SelectNearest. We push
     *  serials here every time `pickEntity` resolves a mobile, and
     *  `cycleNext/cyclePrev` walks the ring in attack-distance order. */
    this._ring = [];                  // array of serials, most-recent first
    this._ringIdx = 0;
    this._ringCap = 16;
    /** Friendly / hostile filter for cycle helpers. CUO splits these so
     *  Tab cycles enemies, Ctrl+Tab cycles allies. */
    this._friendFilter = null;        // (mob) => boolean
    // Audit #42 client P1 #10 — clear state on disconnect. Was: stale
    // `active` + `cursorId` outlived the socket; on reconnect any
    // click sent a 0x6C reply for the OLD cursorId, ServUO answered
    // with "no pending prompt" → disconnect recursion.
    bus.on('net:close', () => {
      this.active = false;
      this.cursorId = 0;
      this.flag = 0;
      this.multi = null;
      this._queue.length = 0;
      this._queueHead = 0;
      bus.emit('target:cleared');
    });
    bus.on('combat:target', ({ serial = 0 } = {}) => this.confirmAttack(serial));
    bus.on('mobile:death', ({ serial = 0 } = {}) => {
      const s = serial >>> 0;
      if (this.lastAttack === s) this.confirmAttack(0);
      if ((this.lastTarget?.serial >>> 0) === s) {
        const m = world.mobiles.get(s);
        if (m) m._isLastTarget = false;
        this.lastTarget = null;
        bus.emit('target:last-changed', { serial: 0 });
      }
    });
    bus.on('entity:removed', ({ serial = 0 } = {}) => {
      const s = serial >>> 0;
      if (this.lastAttack === s) this.confirmAttack(0);
      if ((this.lastTarget?.serial >>> 0) === s) {
        this.lastTarget = null;
        bus.emit('target:last-changed', { serial: 0 });
      }
    });
  }

  /** Activate multi-placement mode (house/boat) from 0x99. */
  setMultiPlacement({ cursorId, multiId, offsetX, offsetY, offsetZ, hue }) {
    // Audit #40 client P2 #10 — CUO `TargetManager.cs:217 SetTargetingMulti`
    // cancels the prior prompt before swapping. Was: we silently
    // overwrote `cursorId`, so the old prompt's id was lost — the
    // server timed it out with no reply (looked like a stuck cursor).
    if (this.active && this.cursorId && this.cursorId !== cursorId) {
      try {
        net.send(buildTargetResponse({
          cursorType: this.cursorType, cursorId: this.cursorId, flag: this.flag,
        }));
      } catch { /* socket may be closed */ }
    }
    this.active = true;
    this.cursorType = CursorType.Multi;
    this.cursorId = cursorId;
    this.flag = 0;
    this.multi = { multiId, offsetX, offsetY, offsetZ, hue };
    // Mirror the `setFromServer` emit so the visual target-cursor
    // overlay shows up for multi placement too. Without this the
    // user got the tile-snapping ghost (multi-ghost.js) but no
    // explicit "you are placing a building" indicator and no
    // body-cursor change.
    bus.emit('target:active', { cursorType: this.cursorType, cursorId, flag: 0 });
  }

  /** Pick a ground tile under the cursor (for multi placement). */
  pickPosition(x, y, z, graphic = 0) {
    if (!this.active) return;
    if (this.cursorType === CursorType.Multi && this.multi) {
      x -= this.multi.offsetX | 0;
      y -= this.multi.offsetY | 0;
      z -= this.multi.offsetZ | 0;
      graphic = this.multi.multiId ?? graphic;
    }
    net.send(buildTargetResponse({
      cursorType: this.cursorType, cursorId: this.cursorId, flag: this.flag,
      x, y, z, graphic,
    }));
    // Capture as TargetLast so the user can replay a tile pick with the
    // TargetLast macro. CUO `TargetManager.cs:455 LastTargetInfo.
    // SetStatic(...)` writes static + ground picks the same way.
    this.lastTarget = { serial: 0, x, y, z, graphic };
    this.multi = null;
    this._deactivate();
  }

  setFromServer({ cursorType, cursorId, flag }) {
    if (this.active) {
      // A new prompt arrived while one is still live — queue it so we
      // can drain it after the current target resolves.
      this._queue.push({ cursorType, cursorId, flag });
      return;
    }
    this.active = true;
    this.cursorType = cursorType;
    this.cursorId = cursorId;
    this.flag = flag;
    bus.emit('target:active', { cursorType, cursorId, flag });
    // Targeting effect aura — CUO emits the 0xC0/0xC7 'targeting aura'
    // visual around the cycle target while a Harmful (flag=1) or
    // Beneficial (flag=2) prompt is live. We route through the existing
    // halo channel; renderer applies the correct hue (red/green).
    if (this.lastTarget?.serial) {
      bus.emit('target:cycle-changed', {
        serial: this.lastTarget.serial,
        kind: flag === 1 ? 'enemy' : flag === 2 ? 'friend' : 'neutral',
      });
    }
  }

  /** Pick a mobile / item / static graphic. Sends 0x6C, deactivates the cursor. */
  pickEntity({ serial = 0, x = 0, y = 0, z = 0, graphic = 0 }) {
    if (!this.active) return;
    net.send(buildTargetResponse({
      cursorType: this.cursorType, cursorId: this.cursorId, flag: this.flag,
      serial, x, y, z, graphic,
    }));
    this.lastTarget = { serial, x, y, z, graphic };
    if (serial) this._pushRing(serial >>> 0);
    this._deactivate();
  }

  // ---- recent-targets ring (CUO SelectNext/Prev/Nearest) ----

  _pushRing(serial) {
    const s = serial >>> 0;
    if (!s || s === 0xFFFFFFFF) return;
    // De-dup then prepend so the most-recent is at index 0.
    const i = this._ring.indexOf(s);
    if (i >= 0) this._ring.splice(i, 1);
    this._ring.unshift(s);
    if (this._ring.length > this._ringCap) this._ring.length = this._ringCap;
    this._ringIdx = 0;
  }

  /** Compact recent-targets in place, dropping dead/out-of-filter mobiles. */
  _compactLiveRing() {
    // Audit rev.4 P2 — apply `_friendFilter` here so cycleRing()
    // respects the ally/enemy mode set via `setFriendFilter()`. Prior
    // version applied the filter only in `_cycleNearestVisible`; the
    // ring path went through every recorded target regardless of
    // notoriety, so `target-next-enemy` and `target-next-ally`
    // cycled the same set.
    let write = 0;
    for (let read = 0; read < this._ring.length; read++) {
      const s = this._ring[read];
      const m = world.mobiles.get(s);
      if (!m || m.dead) continue;
      if (this._friendFilter && !this._friendFilter(m)) continue;
      this._ring[write++] = s;
    }
    this._ring.length = write;
    if (this._ringIdx >= write) this._ringIdx = 0;
    return write;
  }

  /** Pick the next/prev mobile in the ring, sending Attack to switch
   *  target. `kind`='next'|'prev'. Returns the picked serial or null. */
  cycleRing(kind = 'next') {
    const liveCount = this._compactLiveRing();
    if (!liveCount) return this._cycleNearestVisible(kind);
    this._ringIdx = (this._ringIdx + (kind === 'prev' ? -1 : 1) + liveCount) % liveCount;
    const s = this._ring[this._ringIdx];
    this.setLastTarget(s);
    bus.emit('target:cycled', { serial: s, kind });
    return s;
  }

  /** Pick the closest visible mobile matching the friend filter. Used
   *  as a fallback when the ring is empty, and by SelectNearest macros. */
  _cycleNearestVisible(kind = 'next') {
    const player = world.player;
    if (!player) return null;
    let nearest = null;
    let nearestD2 = Infinity;
    let farthest = null;
    let farthestD2 = -Infinity;
    const map = player.map ?? world.mapId ?? 1;
    const visit = (m) => {
      if (!m || m === player || m.dead) return undefined;
      if ((m.map ?? map) !== map) return undefined;
      if (this._friendFilter && !this._friendFilter(m)) return undefined;
      const dx = (m.x ?? 0) - (player.x ?? 0);
      const dy = (m.y ?? 0) - (player.y ?? 0);
      const dist2 = dx * dx + dy * dy;
      if (dist2 > 24 * 24) return undefined;     // CUO max view 24 tiles
      const serial = m.serial >>> 0;
      if (dist2 < nearestD2) {
        nearest = serial;
        nearestD2 = dist2;
      }
      if (dist2 >= farthestD2) {
        farthest = serial;
        farthestD2 = dist2;
      }
      return undefined;
    };
    if (world.forEachMobileNear) {
      world.forEachMobileNear(player.x, player.y, map, 24, true, visit);
    } else {
      const nearby = world.mobilesNear
        ? world.mobilesNear(player.x, player.y, map, 24, true)
        : world.mobiles.values();
      for (const m of nearby) visit(m);
    }
    const s = kind === 'prev' ? farthest : nearest;
    if (!s) return null;
    this.setLastTarget(s);
    this._pushRing(s);
    bus.emit('target:cycled', { serial: s, kind: 'nearest' });
    return s;
  }

  /** Set the friend filter for cycle helpers. Pass `null` to cycle
   *  everything. CUO equivalents: TargetType.Harmful → enemies only,
   *  TargetType.Beneficial → allies only. */
  setFriendFilter(fn) { this._friendFilter = typeof fn === 'function' ? fn : null; }

  /** Record a last-target without prompting — used when the user
   *  directly attacks via single-click. */
  setLastTarget(serial) {
    const s = serial >>> 0;
    this.selectEntity(s);
    this.lastAttack = s;
    try { net.send(buildAttackReq(s)); } catch { /* socket may be closed */ }
  }

  /** Select a mobile for TargetLast/healthbar highlighting without
   * entering combat. Used by ordinary body and healthbar clicks. */
  selectEntity(serial) {
    const s = serial >>> 0;
    if (!s) return;
    // Clear the outline flag from the prior target so two mobiles don't
    // both render highlighted.
    const prior = this.lastTarget?.serial >>> 0;
    if (prior) {
      const m = world.mobiles.get(prior);
      if (m) m._isLastTarget = false;
    }
    this.lastTarget = { serial: s, x: 0, y: 0, z: 0, graphic: 0 };
    const next = world.mobiles.get(s);
    if (next) next._isLastTarget = true;
    this._pushRing(s);
    bus.emit('target:last-changed', { serial: s });
  }

  /** Apply the server-confirmed attack focus without sending another
   *  AttackReq. Keeps health lines, mobile highlight and macros aligned
   *  with 0xAA, including explicit serial=0 clear. */
  confirmAttack(serial) {
    const s = serial >>> 0;
    const prior = this.lastAttack >>> 0;
    if (prior && prior !== s) {
      const old = world.mobiles.get(prior);
      if (old) old._isLastAttack = false;
    }
    this.lastAttack = s || null;
    if (s) {
      const next = world.mobiles.get(s);
      if (next && !next.isDead) next._isLastAttack = true;
      this._pushRing(s);
    }
    bus.emit('target:attack-changed', { serial: s });
  }

  /** Macro engine helpers — flat read accessors so the `if`/`{var}`
   *  evaluator doesn't reach into private state. */
  isActive()           { return this.active; }
  lastTargetSerial()   { return this.lastTarget?.serial >>> 0; }
  lastObjectSerial()   { return this.lastTarget?.serial >>> 0; }

  /** Cancel — send a no-op response with serial 0. */
  cancel() {
    if (!this.active) return;
    net.send(buildTargetResponse({
      cursorType: this.cursorType, cursorId: this.cursorId, flag: this.flag,
    }));
    this._deactivate();
  }

  /** Re-trigger a target prompt against the last picked target. Used by
   *  the "TargetLast" macro action. */
  pickLast() {
    if (!this.active || !this.lastTarget) return;
    this.pickEntity(this.lastTarget);
  }

  /** Self-target shortcut. */
  pickSelf(playerSerial) {
    if (!this.active) return;
    this.pickEntity({ serial: playerSerial });
  }

  _deactivate() {
    this.active = false;
    // Audit #33 P1.1 — also clear `multi` metadata. Previously ESC
    // during a house/boat/sigil placement cleared `active` but left
    // `this.multi` populated; the game-scene tick re-rendered the
    // ghost on the NEXT regular target prompt and `pickPosition`
    // fired with stale multi metadata. ServUO `TargetManager.Reset`
    // nulls both together.
    this.multi = null;
    bus.emit('target:cleared');
    // Drain the next queued prompt (if any) on the next tick so any
    // event listeners observing `target:cleared` see a consistent
    // inactive state before the next prompt activates.
    if (this._queueHead < this._queue.length) {
      const next = this._queue[this._queueHead++];
      if (this._queueHead >= this._queue.length) {
        this._queue.length = 0;
        this._queueHead = 0;
      }
      queueMicrotask(() => this.setFromServer(next));
    }
  }
}

export const targetManager = new TargetManager();
