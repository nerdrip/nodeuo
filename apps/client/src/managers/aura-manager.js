// AuraManager — under-feet aura ring colour controller. Mirrors CUO
// `Game/Managers/AuraManager.cs`. Decides WHICH mobiles get an aura ring
// painted around their feet by the mobile-renderer.
//
// Modes (CUO `AuraUnderFeetType` profile field):
//   0 = off (always)
//   1 = warMode only
//   2 = ctrl+shift held
//   3 = always on
//
// The renderer queries `auraManager.shouldPaint(mob, isPlayer, isParty)`
// once per frame to decide whether to draw the ring. Colour comes from
// the canonical UO notoriety hue table.

import { bus } from '../core/event-bus.js';
import { profile } from './profile-manager.js';
import { world } from '../world/world.js';

const NOTO_HUE = {
  1: 0x4caa4c, 2: 0x4ca06e, 3: 0x808080,
  4: 0xc8a040, 5: 0xb04040, 6: 0xa83030, 7: 0xd0c060,
};

class AuraManager {
  constructor() {
    this._mode = 1;            // default: war-mode only
    this._ctrlShift = false;
    this._installed = false;
  }

  install() {
    if (this._installed) return;
    this._installed = true;
    this._mode = profile.get('ui.auraUnderFeet') ?? 1;
    bus.on('profile:changed', ({ path, value }) => {
      if (path === 'ui.auraUnderFeet') this._mode = value | 0;
    });
    // Capture-phase keydown / keyup so a target prompt or chat input can
    // still suppress the aura preview by stopPropagation.
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey) this._ctrlShift = true;
    }, true);
    window.addEventListener('keyup', (e) => {
      if (!e.ctrlKey || !e.shiftKey) this._ctrlShift = false;
    }, true);
    window.addEventListener('blur', () => { this._ctrlShift = false; });
  }

  setMode(mode) {
    this._mode = mode | 0;
    try { profile.set?.('ui.auraUnderFeet', this._mode); } catch { /* noop */ }
  }
  cycleMode() { this.setMode((this._mode + 1) % 4); }

  /** Should the renderer paint an aura under this mob? */
  shouldPaint(_mob, _isPlayer, _isParty) {
    if (this._mode === 0) return false;
    if (this._mode === 3) return true;
    if (this._mode === 2) return this._ctrlShift;
    // mode 1: war mode only
    return !!(world.player && world.player.warMode);
  }

  /** Colour for `mob`. Party always blue, player always gold, otherwise
   *  notoriety table. */
  colorFor(mob, isPlayer, isParty) {
    if (isPlayer) return 0xfff0a0;
    if (isParty) return 0x40c0ff;
    return NOTO_HUE[mob?.notoriety | 0] ?? 0xc0c0c0;
  }
}

export const auraManager = new AuraManager();
