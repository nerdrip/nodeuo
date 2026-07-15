// ContextMenuControl — right-click popup menu. Mirrors ClassicUO
// `Game/UI/Controls/ContextMenuControl.cs`.
//
// Usage:
//   contextMenu.show(screenX, screenY, [
//     { label: 'Open', onClick: () => openIt() },
//     { label: 'Discard', onClick: () => discard() },
//     { label: 'Cancel' },                  // no onClick = close-only
//   ]);
//
// The menu is a DOM overlay so it composites over Pixi gumps without
// needing z-order plumbing. Closes on outside click or Escape.

class ContextMenu {
  constructor() {
    this._el = null;
  }

  show(x, y, items) {
    this.hide();
    const div = document.createElement('div');
    div.setAttribute('role', 'menu');
    div.setAttribute('aria-label', 'Context menu');
    div.tabIndex = -1;
    div.style.cssText = `
      position:fixed; left:${x | 0}px; top:${y | 0}px;
      z-index:9999; background:#1f1a12; border:1px solid #6e5520;
      box-shadow:0 4px 12px rgba(0,0,0,0.7);
      padding:2px 0; min-width:120px;
      font:500 13px/1.35 "Segoe UI Variable Text", "Segoe UI", Inter, system-ui, sans-serif; color:#eee4d0;
    `;
    const enabledRows = [];
    for (const it of items.filter((entry) => entry && entry.visible !== false && entry.allowed !== false)) {
      const row = document.createElement('div');
      row.setAttribute('role', 'menuitem');
      row.tabIndex = it.disabled ? -1 : 0;
      row.style.cssText = `padding:4px 14px; cursor:pointer;`;
      row.textContent = it.shortcut ? `${it.label}    ${it.shortcut}` : it.label;
      if (it.disabled) {
        row.setAttribute('aria-disabled', 'true');
        row.style.color = '#6a5b3a';
        row.style.cursor = 'default';
      } else {
        enabledRows.push(row);
        row.onmouseenter = () => { row.style.background = '#3a2a14'; };
        row.onmouseleave = () => { row.style.background = 'transparent'; };
        row.onclick = () => {
          try { it.onClick?.(); } catch (e) { console.warn('[context] handler failed', e); }
          this.hide();
        };
      }
      div.appendChild(row);
    }
    document.body.appendChild(div);
    this._el = div;
    // Clamp to viewport.
    const rect = div.getBoundingClientRect();
    if (rect.right > window.innerWidth) div.style.left = `${window.innerWidth - rect.width - 4}px`;
    if (rect.bottom > window.innerHeight) div.style.top = `${window.innerHeight - rect.height - 4}px`;
    // Auto-close on outside click / Escape.
    setTimeout(() => {
      const close = (ev) => {
        if (!div.contains(ev.target)) this.hide();
      };
      const esc = (ev) => { if (ev.key === 'Escape') this.hide(); };
      const keyboard = (ev) => {
        if (!enabledRows.length || !['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(ev.key)) return;
        ev.preventDefault();
        const current = enabledRows.indexOf(document.activeElement);
        let next = current;
        if (ev.key === 'ArrowDown') next = (current + 1 + enabledRows.length) % enabledRows.length;
        else if (ev.key === 'ArrowUp') next = (current - 1 + enabledRows.length) % enabledRows.length;
        else if (ev.key === 'Home') next = 0;
        else if (ev.key === 'End') next = enabledRows.length - 1;
        else return document.activeElement?.click?.();
        enabledRows[next]?.focus?.();
      };
      this._close = close; this._esc = esc;
      document.addEventListener('mousedown', close, true);
      document.addEventListener('keydown', esc, true);
      div.addEventListener('keydown', keyboard);
      this._keyboard = keyboard;
      enabledRows[0]?.focus?.();
    }, 0);
  }

  hide() {
    if (this._el && this._keyboard) this._el.removeEventListener('keydown', this._keyboard);
    this._keyboard = null;
    if (this._el) { this._el.remove(); this._el = null; }
    if (this._close) { document.removeEventListener('mousedown', this._close, true); this._close = null; }
    if (this._esc)   { document.removeEventListener('keydown', this._esc, true); this._esc = null; }
  }
}

export const contextMenu = new ContextMenu();
