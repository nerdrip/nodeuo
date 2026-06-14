// DelayedObjectClickManager — discriminate single-click (SingleClickAction)
// from double-click (DC) on world objects.
//
// Mirrors ClassicUO `Game/Managers/DelayedObjectClickManager.cs`. Without
// this, every left-click on a mobile / item in the world fires 0x09
// LookReq immediately, and the renderer can't tell whether the user meant
// "show the name" or "open paperdoll/use". The CUO heuristic is:
//
//   1. On LMB-down over an entity, register a pending SingleClick at
//      Time.Ticks + Mouse.MOUSE_DELAY_DOUBLE_CLICK (350 ms).
//   2. If a *second* LMB-down on the same target arrives before the
//      timer fires → cancel and dispatch a DoubleClick instead.
//   3. If the timer expires → dispatch SingleClick (look-name request).
//
// In our codebase the gump-side already has this for paperdoll & inventory
// (UIManager._isDoubleClick). What was missing is the *world*-side variant
// for mobiles and items on the ground.

import { bus } from '../core/event-bus.js';
import { net } from '../net/net-client.js';
import { buildLookReq, buildUseReq, buildBatchQueryProperties } from '../net/outgoing.js';

// Audit #32 P2 #1 — CUO `Input/Mouse.cs:10` MOUSE_DELAY_DOUBLE_CLICK=350.
// Was 250 here while UIManager used 350 — fast double-clicks on world
// items counted as two single-clicks but the same speed on a paperdoll
// counted as one double-click. Unified at the CUO canon value.
const DOUBLE_CLICK_MS = 350;

class DelayedClickManager {
  constructor() {
    this._pending = null;     // { serial, mx, my, deadline }
    this._lastClick = null;   // { serial, t } — for DC detection
    this._installed = false;
  }

  install() {
    if (this._installed) return;
    this._installed = true;
    // Per-frame tick driven by GameController. We hook on a bus event so
    // we don't need a direct reference to the loop.
    bus.on('frame:tick', (now) => this._tick(now));
  }

  /** Called from world-input on LMB-down over an entity. */
  scheduleSingleClick(serial, mx, my) {
    const now = performance.now();
    // Did we click the same entity within the DC window?
    if (
      this._lastClick &&
      this._lastClick.serial === (serial >>> 0) &&
      now - this._lastClick.t < DOUBLE_CLICK_MS
    ) {
      this._pending = null;
      this._lastClick = null;
      this._fireDoubleClick(serial);
      return 'double';
    }
    // Client audit #7 #3 — if a different entity click comes in while a
    // single-click is pending, fire the old one now (don't drop it).
    if (this._pending && this._pending.serial !== (serial >>> 0)) {
      const old = this._pending.serial;
      this._pending = null;
      this._fireSingleClick(old);
    }
    this._lastClick = { serial: serial >>> 0, t: now };
    this._pending = {
      serial: serial >>> 0,
      mx, my,
      deadline: now + DOUBLE_CLICK_MS,
    };
    return 'pending';
  }

  /** Called when the cursor moves far enough to mean "drag, not click",
   *  or when ESC is pressed. Cancels the pending single-click. */
  cancel() { this._pending = null; }

  _tick(now) {
    if (!this._pending) return;
    if (now < this._pending.deadline) return;
    const s = this._pending.serial;
    this._pending = null;
    this._fireSingleClick(s);
  }

  _fireSingleClick(serial) {
    try {
      net.send(buildLookReq(serial));
      // Tooltip refresh — server sends 0xD6 mega cliloc back which our
      // tooltipManager listens to.
      net.send(buildBatchQueryProperties([serial]));
    } catch { /* socket transient */ }
    bus.emit('world:single-click', { serial });
  }

  _fireDoubleClick(serial) {
    try { net.send(buildUseReq(serial)); }
    catch { /* socket transient */ }
    bus.emit('world:double-click', { serial });
  }
}

export const delayedClickManager = new DelayedClickManager();
