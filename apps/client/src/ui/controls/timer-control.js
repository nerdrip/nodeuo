// TimerControl — small countdown label used by buff/debuff icons and
// other short-lived gump elements. Mirrors CUO's tiny timer controls:
// seconds under a minute, minutes under an hour, hours after that.

import { Control } from '../control.js';
import { Label } from './label.js';

export function formatTimerDuration(seconds) {
  const s = Math.max(0, Math.ceil(Number(seconds) || 0));
  if (s <= 0) return '';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export class TimerControl extends Control {
  constructor({ durationS = 0, expiresAt = 0, fontSize = 9, hue = 0xfff0c0 } = {}) {
    super();
    this.acceptMouseInput = false;
    this._label = new Label('', { fontSize, hue });
    this.add(this._label);
    this._expiresAt = 0;
    this._lastSeconds = null;
    if (expiresAt > 0) this.setExpiresAt(expiresAt);
    else if (durationS > 0) this.setDuration(durationS);
  }

  get expiresAt() { return this._expiresAt; }

  setDuration(seconds, now = nowMs()) {
    const s = Math.max(0, Number(seconds) || 0);
    this.setExpiresAt(s > 0 ? now + s * 1000 : 0, now);
  }

  setExpiresAt(expiresAt, now = nowMs()) {
    this._expiresAt = Math.max(0, Number(expiresAt) || 0);
    this._lastSeconds = null;
    return this.tick(now);
  }

  tick(now = nowMs()) {
    if (!this._expiresAt) {
      this._setSeconds(0);
      return true;
    }
    const remain = Math.max(0, Math.ceil((this._expiresAt - now) / 1000));
    this._setSeconds(remain);
    return remain > 0;
  }

  _setSeconds(seconds) {
    if (seconds === this._lastSeconds) return;
    this._lastSeconds = seconds;
    this._label.setText(formatTimerDuration(seconds));
    this.width = this._label.width;
    this.height = this._label.height;
  }
}

function nowMs() {
  return (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
}
