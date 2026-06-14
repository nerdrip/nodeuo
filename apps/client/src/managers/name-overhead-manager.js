// NameOverheadManager — floating name + notoriety-tinted label that
// appears over a mobile when the user single-clicks (LookReq) or has
// "All names" macro toggled. Mirrors ClassicUO
// Game/Managers/NameOverHeadManager.cs.
//
// Why a separate manager from HealthLines: names are short-lived
// (a few seconds per click) while health bars are persistent. Names
// also need text rendering which is cheaper to do as Pixi Text per
// label than redrawing every frame from a single Graphics.
//
// Lifecycle:
//   - `show(serial, name, notoriety, ms = 5000)` — pin a label for `ms`
//   - `showAll(ms = 5000)` — pin every visible mobile (Macro: AllNames)
//   - `clear(serial)` — remove just one
//   - `clearAll()` — wipe (e.g. on map switch)
//   - `tick(now)` — expire stale entries; call from the main loop

import { Text } from 'pixi.js';
import { worldToScreenX, worldToScreenY } from '../renderer/iso.js';
import { world } from '../world/world.js';
import { NOTORIETY_HUE } from '../shared/notoriety-hues.js';
import { profile } from './profile-manager.js';
import { UoBitmapText } from '../ui/controls/uo-bitmap-text.js';
import { assets } from '../assets/asset-manager.js';
import { bus } from '../core/event-bus.js';

class NameOverheadManager {
  constructor() {
    /** @type {Map<number, { text:Text, expiresAt:number }>} */
    this._labels = new Map();
    this._parent = null;
    /** when true, every nearby mobile gets a permanent label until toggled off. */
    this.allNames = false;
    this._nextAllNamesScanAt = 0;
    /** Notoriety filter for AllNames + handler-gump. Default: everything.
     *  Bit i set = show notoriety i. Mirrors CUO `NameOverheadHandlerGump`
     *  which lets the player pick which classes of mob get a label
     *  (e.g. only enemies + criminals while raiding a champ). */
    this.filter = 0xFE; // bits 1..7 set, bit 0 unused
    /** Optional item-name overhead toggle (CUO supports labelling
     *  containers / corpses / items; default off to avoid clutter). */
    this.includeItems = false;
    // Restore persisted filter (CUO Profile.cs::NameOverheadFilter +
    // NameOverheadShowOwn) so the user's last-set view survives logout.
    const saved = profile.get?.('nameOverhead');
    if (saved && typeof saved === 'object') {
      if (typeof saved.bitfield === 'number') this.filter = saved.bitfield | 0;
      if (typeof saved.showItems === 'boolean') this.includeItems = saved.showItems;
    }
  }

  /** Persist current filter to the per-character profile so it survives
   *  reopen. Called from every mutator below. */
  _persist() {
    try {
      profile.set?.('nameOverhead', {
        ...(profile.get('nameOverhead') ?? {}),
        bitfield: this.filter,
        showItems: this.includeItems,
      });
    } catch { /* noop */ }
  }

  /** Toggle a single notoriety bit on/off (1..7). */
  setNotorietyVisible(noto, visible) {
    if (noto < 1 || noto > 7) return;
    if (visible) this.filter |= (1 << noto);
    else         this.filter &= ~(1 << noto);
    this._persist();
    if (!this.allNames) return;
    // re-prune currently pinned entries that no longer match.
    for (const [serial] of this._labels) {
      const m = world.mobiles.get(serial);
      if (!m) continue;
      if (!((this.filter >> (m.notoriety ?? 1)) & 1)) this.clear(serial);
    }
  }

  /** Show / hide the player's own name. CUO `Profile.cs::ShowOwnNameOverhead`. */
  setShowOwn(on) {
    try {
      profile.set?.('nameOverhead', { ...(profile.get('nameOverhead') ?? {}), showOwn: !!on });
    } catch { /* noop */ }
    if (on && world.player) this.show(world.player.serial, world.player.name ?? '?', 1, Infinity);
    else if (world.player) this.clear(world.player.serial);
  }

  setShowItems(on) {
    this.includeItems = !!on;
    this._persist();
  }

  isNotorietyVisible(noto) {
    return ((this.filter >> noto) & 1) === 1;
  }

  /** Attach to a Pixi Container (typically the world layer). */
  install(parent) {
    this._parent = parent;
  }

  show(serial, name, notoriety = 1, ms = 5000) {
    if (!this._parent) return;
    let entry = this._labels.get(serial);
    const hue = NOTORIETY_HUE[notoriety] ?? 0xFFFFFF;
    // Audit rev.4 P3 — pet suffix. CUO renders "Bob (Owner's pet)" on
    // controlled mobiles so the user knows the leash chain. We append
    // " (Owner's pet)" when the mob has a controlMaster other than
    // the local player, since the player's own pets are obvious.
    let displayName = String(name ?? '');
    try {
      const mob = world.mobiles?.get(serial);
      if (mob?.controlMaster && mob.controlMaster !== world.player?.serial) {
        displayName += " (Owner's pet)";
      }
    } catch { /* world singleton race — fall back to plain name */ }
    if (!entry) {
      // Audit #46 P2 — prefer the UO bitmap font atlas (canonical
      // overhead chrome). Fall back to Pixi `Text` if the atlas hasn't
      // bound yet. We track whether the label is bitmap so update
      // paths know which API to use (`bmp.setText` vs `text.text =`).
      const useBitmap = !!assets.fontsTexture && !!assets.fonts?.fonts?.length;
      let text;
      let bmp = null;
      if (useBitmap) {
        bmp = new UoBitmapText(displayName, { hue, fontIndex: 0 });
        bmp.node.anchor?.set?.(0.5, 1);
        this._parent.addChild(bmp.node);
        text = bmp.node;
      } else {
        text = new Text({
          text: displayName,
          style: { fill: hue, fontSize: 12, fontFamily: 'Consolas, monospace',
                   stroke: { color: 0x000000, width: 3, join: 'round' } },
        });
        text.anchor.set(0.5, 1);
        this._parent.addChild(text);
      }
      // Audit rev.9 P2 #7 — make the overhead label clickable: a single
      // click pops the NameOverheadPopupGump (4 quick actions atk/use/
      // look/menu — same handlers CUO ships). Pixi-v8 uses `eventMode`
      // to enable hit testing on display objects in the scene graph.
      try {
        text.eventMode = 'static';
        text.cursor = 'pointer';
        text.on?.('pointerdown', (e) => {
          // Left-click only — RMB / middle should bubble to world picker
          // (right-click = popup menu, middle = no-op).
          if ((e.button ?? 0) !== 0) return;
          e.stopPropagation?.();
          bus.emit('name-overhead:click', { serial });
        });
      } catch { /* legacy Pixi → click ignored, no regression */ }
      entry = { text, bmp, expiresAt: 0, _hue: hue, _last: displayName };
      this._labels.set(serial, entry);
    } else {
      if (entry.bmp) {
        if (entry._last !== displayName) entry.bmp.setText?.(displayName);
        if (entry._hue !== hue) entry.bmp.setHue?.(hue);
        entry._last = displayName;
      } else {
        if (entry._last !== displayName) entry.text.text = displayName;
        if (entry._hue !== hue) entry.text.style.fill = hue;
      }
      entry._last = displayName;
      entry._hue = hue;
    }
    entry.expiresAt = ms === Infinity ? Infinity : performance.now() + ms;
  }

  /** Pin everyone visible. Use Infinity expiry; cleared on next showAll(false). */
  showAll(visibleMobs, ms = 5000) {
    for (const m of visibleMobs) {
      this.show(m.serial, m.name ?? '?', m.notoriety ?? 1, ms);
    }
  }

  toggleAllNames() {
    this.allNames = !this.allNames;
    this._nextAllNamesScanAt = 0;
    if (!this.allNames) this.clearAll();
    return this.allNames;
  }

  clear(serial) {
    const e = this._labels.get(serial);
    if (!e) return;
    this._destroyEntry(e);
    this._labels.delete(serial);
  }

  clearAll() {
    for (const e of this._labels.values()) {
      this._destroyEntry(e);
    }
    this._labels.clear();
  }

  _destroyEntry(e) {
    if (!e) return;
    if (e.bmp) {
      try { e.text.parent?.removeChild(e.text); } catch { /* ignore */ }
      try { e.bmp.dispose?.(); } catch { /* ignore */ }
      return;
    }
    try {
      e.text.parent?.removeChild(e.text);
      e.text.destroy({ children: true });
    } catch { /* ignore */ }
  }

  hasActive() {
    return this.allNames || this._labels.size > 0;
  }

  /** Per-frame: re-position labels and prune expired. */
  tick(now = performance.now()) {
    if (!this.hasActive()) return;
    for (const [serial, entry] of this._labels) {
      const m = world.mobiles.get(serial);
      if (!m || (m.hp ?? 0) <= 0) {
        this.clear(serial); continue;
      }
      if (entry.expiresAt !== Infinity && now > entry.expiresAt) {
        this.clear(serial); continue;
      }
      const spX = worldToScreenX(m.x, m.y);
      const spY = worldToScreenY(m.x, m.y, m.z);
      // Audit #39 client P1 #4 — CUO `NameOverHeadManager.Draw` anchors
      // to `Mobile.RealScreenPosition + Mobile.FrameInfo.Y` so the label
      // sits above the actual sprite top. mobile-renderer publishes the
      // live head offset on `m._spriteHeadOffset` (accounts for mount
      // height + body shape). Was: flat -70 px → mounted riders had the
      // name inside the horse saddle and large mobs (dragons / Gargoyles
      // sat in chairs) clipped the body.
      const headY = (typeof m._spriteHeadOffset === 'number') ? m._spriteHeadOffset : -70;
      const px = (spX + (m.offsetX | 0) + 0.5) | 0;
      const py = ((spY + (m.offsetY | 0) + headY - 6) + 0.5) | 0;
      if (entry._x !== px || entry._y !== py) {
        entry._x = px; entry._y = py;
        entry.text.position.set(px, py);
      }
      // Audit #46 P3 — pulse the label when the mob is the player's
      // current target. CUO `NameOverHeadManager` lerps alpha 0.6 ↔
      // 1.0 at ~220ms cycle on the active target.
      if (m._isLastTarget) {
        const alpha = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(now / 220));
        if (entry.text.alpha !== alpha) entry.text.alpha = alpha;
      } else if (entry.text.alpha !== 1) {
        entry.text.alpha = 1;
      }
    }
    // AllNames mode: refresh visible nearby mobs every tick. Honour the
    // notoriety filter — handler-gump can hide e.g. innocents to declutter
    // a busy champ-spawn fight.
    if (this.allNames && world.player && now >= this._nextAllNamesScanAt) {
      this._nextAllNamesScanAt = now + 250;
      const px = world.player.x, py = world.player.y;
      const map = world.player.map ?? world.mapId ?? 1;
      const visitMobile = (m) => {
        if (m === world.player) return;
        if ((m.map ?? map) !== map) return;
        if (Math.abs(m.x - px) > 18 || Math.abs(m.y - py) > 18) return;
        const noto = m.notoriety ?? 1;
        if (!((this.filter >> noto) & 1)) return;
        if (!this._labels.has(m.serial)) {
          this.show(m.serial, m.name ?? '?', noto, Infinity);
        }
      };
      if (typeof world.forEachMobileNear === 'function') {
        world.forEachMobileNear(px, py, map, 18, true, visitMobile);
      } else {
        const nearby = world.mobilesNear
          ? world.mobilesNear(px, py, map, 18, true)
          : world.mobiles.values();
        for (const m of nearby) visitMobile(m);
      }
    }
  }
}

export const nameOverheadManager = new NameOverheadManager();
