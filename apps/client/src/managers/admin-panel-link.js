// AdminPanelLink — surfaces an "Open Admin Panel" action inside the
// staff-only Debug card for any account whose `shard:commands` reports
// accessLevel ≥ GM. Clicking it `window.open()`s the admin web panel
// (default http://<host>:2596/) in a new browser tab.
//
// The control panel co-starts the admin server alongside the Browser
// Client (`coStart: ['admin']` in apps/control-panel/src/main.cjs), so
// by the time an admin account logs in the panel is already listening
// — the user gets a one-click bridge from game ↔ admin tools without
// having to remember the URL or run a second service manually.
//
// Marcin: "jezeli zaloguje sie admin to w jednej zakladce ma gre, w
// drugiej panel admina".
//
// URL resolution:
//   1. `window.__UO_ADMIN_URL`     — explicit override (set by host page).
//   2. `localStorage['uo.adminUrl']` — sticky per-user override.
//   3. `http://${location.hostname}:2596/` — default. Honours the host
//      the player typed (so a remote shard at 10.0.0.42:5173 surfaces
//      a link to 10.0.0.42:2596 instead of localhost).

import { bus } from '../core/event-bus.js';
import { world } from '../world/world.js';

const ADMIN_ACCESS = new Set(['GM', 'GameMaster', 'Admin', 'Administrator']);

function resolveAdminUrl() {
  try {
    const override = window.__UO_ADMIN_URL
      ?? localStorage.getItem('uo.adminUrl');
    if (override) return override;
  } catch { /* localStorage disabled */ }
  const host = window.location?.hostname || 'localhost';
  return `http://${host}:2596/`;
}

export class AdminPanelLink {
  constructor() {
    this._el = null;
    this._destroyed = false;
    this._access = 'Player';
    this._unsub = bus.on('shard:commands', (data) => {
      this._access = data?.accessLevel || 'Player';
      this._refresh();
    });
    if (world.commandCatalogue) {
      this._access = world.commandCatalogue.accessLevel || 'Player';
      this._refresh();
    }
    // Reset on disconnect so a fresh login with a different account
    // doesn't inherit the previous user's admin state.
    this._unsubClose = bus.on('net:close', () => {
      this._access = 'Player';
      this._refresh();
    });
  }

  destroy() {
    this._destroyed = true;
    try { this._unsub?.(); } catch { /* ignore */ }
    try { this._unsubClose?.(); } catch { /* ignore */ }
    this._removeEl();
  }

  _refresh() {
    if (ADMIN_ACCESS.has(this._access)) this._ensureEl();
    else this._removeEl();
  }

  _ensureEl() {
    if (this._el) return;
    const el = document.createElement('a');
    el.id = 'uo-admin-link';
    el.textContent = 'Admin ↗';
    el.target = '_blank';
    el.rel = 'noopener noreferrer';
    el.href = resolveAdminUrl();
    el.title = `Open ${el.href} in a new tab (account access: ${this._access})`;
    // The Debug panel is built before this manager is installed. Keeping the
    // staff action in its title row prevents a second floating control from
    // competing with the command-panel collapse button in the upper-right.
    Object.assign(el.style, {
      position: 'static',
      display: 'inline-flex',
      alignItems: 'center',
      minHeight: '22px',
      padding: '0 8px',
      background: 'rgba(226, 180, 92, 0.10)',
      color: '#ffe0a0',
      border: '1px solid rgba(226, 180, 92, 0.34)',
      borderRadius: '4px',
      font: '700 10px/1 "Segoe UI Variable Text", "Segoe UI", sans-serif',
      textDecoration: 'none',
      letterSpacing: '0.04em',
      textTransform: 'none',
      cursor: 'pointer',
      userSelect: 'none',
      boxShadow: 'none',
    });
    el.addEventListener('mouseenter', () => { el.style.background = 'rgba(226, 180, 92, 0.20)'; });
    el.addEventListener('mouseleave', () => { el.style.background = 'rgba(226, 180, 92, 0.10)'; });
    const host = document.querySelector?.('#dom-ui .uo-hud-title')
      ?? document.querySelector?.('.uo-hud-title');
    (host ?? document.body).appendChild(el);
    this._el = el;
  }

  _removeEl() {
    if (!this._el) return;
    try { this._el.remove(); } catch { /* ignore */ }
    this._el = null;
  }
}

let _singleton = null;
export function installAdminPanelLink() {
  if (_singleton && !_singleton._destroyed) return _singleton;
  _singleton = new AdminPanelLink();
  return _singleton;
}
