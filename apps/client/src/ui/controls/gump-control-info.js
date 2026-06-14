// GumpControlInfo — metadata attached to server-gump controls.
// ClassicUO keeps layout metadata (tooltip, itemproperty, master gump)
// beside controls; this helper avoids sprinkling ad-hoc underscored
// fields across every parser command.

const INFO = new WeakMap();

export class GumpControlInfo {
  constructor(control = null) {
    this.control = control;
    this.tooltipText = '';
    this.itemPropertySerial = 0;
    this.masterGumpSerial = 0;
  }

  appendTooltip(text) {
    const t = String(text ?? '').trim();
    if (!t) return this.tooltipText;
    this.tooltipText = this.tooltipText ? `${this.tooltipText}\n${t}` : t;
    return this.tooltipText;
  }

  setItemPropertySerial(serial) {
    this.itemPropertySerial = (Number(serial) || 0) >>> 0;
    return this.itemPropertySerial;
  }

  setMasterGumpSerial(serial) {
    this.masterGumpSerial = (Number(serial) || 0) >>> 0;
    return this.masterGumpSerial;
  }
}

export function ensureGumpControlInfo(control) {
  if (!control || typeof control !== 'object') return new GumpControlInfo(null);
  let info = INFO.get(control);
  if (!info) {
    info = new GumpControlInfo(control);
    INFO.set(control, info);
    try {
      Object.defineProperty(control, 'gumpControlInfo', {
        value: info,
        enumerable: false,
        configurable: true,
      });
    } catch {
      control.gumpControlInfo = info;
    }
  }
  return info;
}

export function getGumpControlInfo(control) {
  return control?.gumpControlInfo ?? INFO.get(control) ?? null;
}
