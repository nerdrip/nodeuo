// AdminPanelLink — surfaces a small "Open Admin Panel" pill in the
// in-game UI for any account whose `shard:commands` payload reports
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
    this._access = 'Player';
    this._unsub = bus.on('shard:commands', (data) => {
      this._access = data?.accessLevel || 'Player';
      this._refresh();
    });
    // Reset on disconnect so a fresh login with a different account
    // doesn't inherit the previous user's admin state.
    this._unsubClose = bus.on('net:close', () => {
      this._access = 'Player';
      this._refresh();
    });
  }

  destroy() {
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
    el.textContent = '⚙ Admin Panel';
    el.target = '_blank';
    el.rel = 'noopener noreferrer';
    el.href = resolveAdminUrl();
    el.title = `Open ${el.href} in a new tab (account access: ${this._access})`;
    // Inline styles keep this self-contained — no CSS-import dependency
    // and no risk of an unrelated stylesheet rewrite breaking the badge.
    Object.assign(el.style, {
      position: 'fixed',
      top: '6px',
      right: '12px',
      zIndex: '9999',
      padding: '4px 10px',
      background: '#3a2c14',
      color: '#ffd070',
      border: '1px solid #7a5a20',
      borderRadius: '3px',
      font: '11px/1.3 Consolas, monospace',
      textDecoration: 'none',
      letterSpacing: '1px',
      cursor: 'pointer',
      userSelect: 'none',
      boxShadow: '0 1px 4px rgba(0,0,0,0.6)',
    });
    el.addEventListener('mouseenter', () => { el.style.background = '#4a3818'; });
    el.addEventListener('mouseleave', () => { el.style.background = '#3a2c14'; });
    document.body.appendChild(el);
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
  if (_singleton) return _singleton;
  _singleton = new AdminPanelLink();
  return _singleton;
}
