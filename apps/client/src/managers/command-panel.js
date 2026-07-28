// CommandPanel — right-edge floating list of shard chat commands the
// player has access to. Populated by the 0xBF 0xA0 `shard:commands`
// payload the server pushes at LoginComplete (see net/handlers.js).
//
// Layout:
//   • Fixed to the right-side diagnostics rail, just left of Debug.
//   • Default expanded (260 px wide). Header shows account access pill
//     + minimise chevron.
//   • Minimised state collapses to a 36×36 icon at the same edge; click
//     to re-expand. Persisted via `localStorage['uo.cmdPanel.collapsed']`.
//   • Filter input at the top — substring match against command name or
//     help text.
//   • Each row: command name (cream + stroke) + access pill + help
//     tooltip on hover. Click → inserts `[<name> ` into the chat input
//     so the user can finish typing args.
//
// Doesn't reach into Pixi at all — pure DOM mounted via `gc.domMount`.

import { bus } from '../core/event-bus.js';
import { world } from '../world/world.js';
import { calculateVirtualWindow } from '../shared/virtual-list.js';

const COLLAPSE_KEY = 'uo.cmdPanel.collapsed';
const COMMAND_ROW_H = 26;
const COMMAND_OVERSCAN = 8;
const ACCESS_HUE = {
  Player:        '#cdd',
  Counselor:     '#9ad9ff',
  Counsellor:    '#9ad9ff',
  Seer:          '#a9ff8b',
  GM:            '#ffd070',
  GameMaster:    '#ffd070',
  Admin:         '#ff8a5a',
  Administrator: '#ff8a5a',
};
const ACCESS_ORDER = ['Player', 'Counselor', 'Counsellor', 'Seer', 'GameMaster', 'GM', 'Administrator', 'Admin'];
const ACCESS_INDEX = new Map(ACCESS_ORDER.map((name, index) => [name, index]));

function escAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeCommand(c) {
  const name = String(c?.name ?? '');
  const help = String(c?.help ?? '');
  const access = String(c?.access ?? 'Admin');
  return {
    ...c,
    name,
    help,
    access,
    _lcName: name.toLowerCase(),
    _lcHelp: help.toLowerCase(),
  };
}

export class CommandPanel {
  constructor(gc) {
    this.gc = gc;
    this._commands = [];
    this._commandsRev = 0;
    this._access = 'Player';
    this._filter = '';
    this._collapsed = false;
    try { this._collapsed = localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { /* ignore */ }
    this._buildDom();
    this._unsubs = [];
    this._unsubs.push(bus.on('shard:commands', (data) => this._applyCatalogue(data)));
    // The shard can push this before GameScene mounts. Hydrate immediately
    // from the session snapshot instead of showing a false Player catalogue.
    if (world.commandCatalogue) this._applyCatalogue(world.commandCatalogue);
    // Repaint on net reset so a relog cleanly drops the previous
    // catalogue before the new one arrives.
    this._unsubs.push(bus.on('net:close', () => {
      this._commands = [];
      this._access = 'Player';
      this._commandsRev++;
      this._render();
    }));
  }

  destroy() {
    for (const u of this._unsubs) u();
    if (this._unmount) this._unmount();
  }

  _buildDom() {
    const el = document.createElement('div');
    el.id = 'uo-cmd-panel';
    el.className = 'uo-panel uo-command-panel';
    el.style.cssText = `
      position: fixed; top: 8px; right: 8px; bottom: calc(50vh + 4px); z-index: 9300;
      width: 300px; max-height: none;
      box-sizing: border-box;
      background: linear-gradient(180deg, rgba(24, 27, 31, 0.96), rgba(12, 14, 17, 0.94));
      border: 1px solid rgba(226, 180, 92, 0.42);
      border-radius: 8px;
      box-shadow: -10px 12px 28px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255,255,255,0.06);
      backdrop-filter: blur(5px);
      font-family: 'Consolas', monospace; color: #fff0c0; font-size: 12px;
      transition: width 0.18s ease, height 0.18s ease, border-radius 0.18s ease;
      user-select: none;
      overflow: hidden;
    `;
    el.innerHTML = `
      <div id="uo-cmd-head" style="display:flex;align-items:center;padding:8px 10px;border-bottom:1px solid rgba(226,180,92,.22);cursor:pointer;background:linear-gradient(180deg,rgba(57,48,32,.82),rgba(16,17,20,.72))">
        <span style="flex:1;font-weight:bold;letter-spacing:0.5px">Commands</span>
        <span id="uo-cmd-access" class="uo-pill" style="font-size:10px;padding:2px 7px;border-radius:999px;background:rgba(255,208,112,.12);border:1px solid rgba(255,208,112,.28);color:#ffd070;margin-right:6px">Player</span>
        <span id="uo-cmd-collapse" aria-hidden="true" style="display:grid;place-items:center;font-size:14px;line-height:1;width:18px;height:18px;text-align:center">▶</span>
      </div>
      <div id="uo-cmd-body" style="display:flex;flex-direction:column;height:calc(100% - 36px);min-height:0">
        <input id="uo-cmd-filter" type="text" placeholder="filter…"
          style="margin:9px 10px 7px;padding:7px 8px;background:rgba(6,9,13,.88);border:1px solid rgba(226,180,92,.36);border-radius:4px;color:#fff0c0;font-family:inherit;font-size:11px;outline:none" />
        <div id="uo-cmd-list" style="overflow-y:auto;flex:1;min-height:0;padding:0 7px 10px;scrollbar-color:rgba(226,180,92,.55) rgba(0,0,0,.2)"></div>
      </div>
    `;
    this._el = el;
    this._head = el.querySelector('#uo-cmd-head');
    this._title_el = this._head.querySelector('span');
    this._access_el = el.querySelector('#uo-cmd-access');
    this._collapse_el = el.querySelector('#uo-cmd-collapse');
    this._body = el.querySelector('#uo-cmd-body');
    this._filter_el = el.querySelector('#uo-cmd-filter');
    this._list_el = el.querySelector('#uo-cmd-list');
    this._head.addEventListener('click', () => this._toggle());
    this._filter_el.addEventListener('input', () => {
      this._filter = this._filter_el.value.trim().toLowerCase();
      this._render();
    });
    // Stop key events from bubbling to game canvas (so typing in the
    // filter doesn't trigger walk / hotkeys).
    this._filter_el.addEventListener('keydown', (e) => e.stopPropagation());
    this._list_el.addEventListener('scroll', () => this._renderVirtualList());
    this._list_el.addEventListener('click', (e) => {
      const row = e.target?.closest?.('[data-cmd]');
      if (!row) return;
      bus.emit('chat:insert', { text: `[${row.getAttribute('data-cmd')} ` });
    });
    this._unmount = this.gc.domMount(el);
    this._applyCollapsed();
    this._render();
  }

  _toggle() {
    this._collapsed = !this._collapsed;
    try { localStorage.setItem(COLLAPSE_KEY, this._collapsed ? '1' : '0'); } catch { /* ignore */ }
    this._applyCollapsed();
  }

  _applyCatalogue(data) {
    this._access = String(data?.accessLevel || 'Player');
    this._commands = Array.isArray(data?.commands) ? data.commands.map(normalizeCommand) : [];
    this._commandsRev++;
    this._lastRenderKey = '';
    if (this._collapsed && this._head) this._head.title = `Open commands (${this._access})`;
    this._render();
  }

  _applyCollapsed() {
    if (!this._el) return;
    if (this._collapsed) {
      this._el.classList.add('is-collapsed');
      this._el.style.width = '44px';
      this._el.style.height = '44px';
      this._el.style.bottom = 'auto';
      this._el.style.borderRadius = '10px';
      this._head.style.height = '42px';
      this._head.style.boxSizing = 'border-box';
      this._head.style.padding = '0';
      this._head.style.justifyContent = 'center';
      this._head.style.borderBottom = '0';
      this._head.title = `Open commands (${this._access})`;
      this._body.style.display = 'none';
      this._collapse_el.textContent = '⌘';
      this._collapse_el.style.width = '42px';
      this._collapse_el.style.height = '42px';
      this._collapse_el.style.fontSize = '18px';
      // Reduce header to just the icon when minimised.
      this._title_el.style.display = 'none';
      this._access_el.style.display = 'none';
    } else {
      this._el.classList.remove('is-collapsed');
      this._el.style.width = '300px';
      this._el.style.height = '';
      this._el.style.bottom = 'calc(50vh + 4px)';
      this._el.style.borderRadius = '8px';
      this._head.style.height = '';
      this._head.style.padding = '8px 10px';
      this._head.style.justifyContent = '';
      this._head.style.borderBottom = '1px solid rgba(226,180,92,.22)';
      this._head.title = 'Collapse commands';
      this._body.style.display = 'flex';
      this._collapse_el.textContent = '▶';
      this._collapse_el.style.width = '18px';
      this._collapse_el.style.height = '18px';
      this._collapse_el.style.fontSize = '14px';
      this._title_el.style.display = '';
      this._access_el.style.display = '';
    }
  }

  _render() {
    if (!this._el) return;
    this._access_el.textContent = this._access;
    this._access_el.style.color = ACCESS_HUE[this._access] ?? '#fff0c0';
    if (this._collapsed) return;
    const filter = this._filter;
    const renderKey = `${this._commandsRev}:${this._access}:${filter}`;
    if (renderKey === this._lastRenderKey) return;
    this._lastRenderKey = renderKey;
    const buckets = this._buckets ?? (this._buckets = ACCESS_ORDER.map(() => []));
    for (const b of buckets) b.length = 0;
    const other = this._otherBucket ?? (this._otherBucket = []);
    other.length = 0;
    for (const c of this._commands) {
      if (!this._matchesFilter(c, filter)) continue;
      const idx = ACCESS_INDEX.get(c.access ?? 'Admin');
      if (idx == null) other.push(c);
      else buckets[idx].push(c);
    }
    let matchingCount = other.length;
    for (const b of buckets) matchingCount += b.length;
    if (matchingCount === 0) {
      this._virtualRows = null;
      this._lastVirtualKey = '';
      this._list_el.innerHTML = '<div style="opacity:.6;padding:10px;text-align:center;font-style:italic">— no commands —</div>';
      return;
    }
    const rows = [];
    const addBucket = (access, bucket) => {
      const count = bucket.length;
      if (count === 0) return;
      const tint = ACCESS_HUE[access] ?? '#fff0c0';
      rows.push({ kind: 'header', access, count, tint });
      for (const c of bucket) {
        rows.push({ kind: 'command', command: c });
      }
    };
    for (let i = 0; i < ACCESS_ORDER.length; i++) addBucket(ACCESS_ORDER[i], buckets[i]);
    addBucket('Other', other);
    this._virtualRows = rows;
    this._lastVirtualKey = '';
    this._renderVirtualList(true);
  }

  _renderVirtualList(force = false) {
    const rows = this._virtualRows;
    if (!this._list_el || !rows) return;
    const viewH = this._list_el.clientHeight || 260;
    const win = calculateVirtualWindow({
      scrollY: this._list_el.scrollTop || 0,
      viewportSize: viewH,
      itemSize: COMMAND_ROW_H,
      itemCount: rows.length,
      overscan: COMMAND_OVERSCAN,
    });
    const key = `${this._lastRenderKey}:${win.start}:${win.end}:${rows.length}`;
    if (!force && key === this._lastVirtualKey) return;
    this._lastVirtualKey = key;
    let html = `<div class="uo-cmd-spacer" style="height:${win.before}px"></div>`;
    for (let i = win.start; i < win.end; i++) {
      const row = rows[i];
      if (row.kind === 'header') {
        const access = escAttr(row.access);
        html += `<div class="uo-cmd-section"
                   style="height:${COMMAND_ROW_H}px;box-sizing:border-box;padding:7px 4px 3px;color:${row.tint};font-size:10px;letter-spacing:0.5px;text-transform:uppercase;opacity:.9">
                   ${access} (${row.count})
                 </div>`;
        continue;
      }
      const c = row.command;
      const name = escAttr(c.name);
      const help = escAttr(c.help || '');
      html += `<div class="uo-cmd-row" data-cmd="${name}" title="${help}"
                 style="height:${COMMAND_ROW_H}px;box-sizing:border-box;padding:6px 8px;cursor:pointer;border-radius:4px;transition:background .1s, color .1s;font-family:inherit;color:#f6e7bd"
                 onmouseover="this.style.background='rgba(117,213,255,.12)';this.style.color='#ffffff'"
                 onmouseout="this.style.background='';this.style.color='#f6e7bd'"
                 >[${name}</div>`;
    }
    html += `<div class="uo-cmd-spacer" style="height:${win.after}px"></div>`;
    this._list_el.innerHTML = html;
  }

  _matchesFilter(command, filter) {
    if (!filter) return true;
    return command._lcName.includes(filter)
      || command._lcHelp.includes(filter);
  }
}
