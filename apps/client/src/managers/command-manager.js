// CommandManager — local client-side slash commands.
//
// Mirrors ClassicUO `Game/Managers/CommandManager.cs`. Commands prefixed
// with `/` are intercepted by the chat dispatcher and run locally rather
// than being sent to the server as speech. Use cases:
//
//   /resync         — re-fetch the world block + nearby mobiles
//   /lighten        — force overall light level brighter (cheat / dev)
//   /darken         — force overall light level darker
//   /where          — print client coordinates to the journal
//   /version        — print client build info
//   /help           — list all registered commands
//   /clear          — clear the on-screen journal
//   /reload-ui      — re-create the HUD overlay (debug)
//
// Each command is registered as `{ name, help, run(args, ctx) }`.
// Returning `false` from a callback re-emits the raw text as speech
// (so a `/foo` that doesn't match falls back to a server-bound message).

import { bus } from '../core/event-bus.js';

class CommandManager {
  constructor() {
    /** @type {Map<string, {help:string, run:(args:string[], ctx:any)=>any}>} */
    this._cmds = new Map();
    this._registerBuiltins();
  }

  register(name, help, run) {
    if (!name || typeof run !== 'function') return;
    this._cmds.set(name.toLowerCase(), { help, run });
    this._sortedCommandRows = null;
  }

  unregister(name) {
    if (this._cmds.delete(String(name).toLowerCase())) this._sortedCommandRows = null;
  }

  has(name) { return this._cmds.has(String(name).toLowerCase()); }

  /** Audit rev.4 P2 — `[ObjectName]` bracket resolver. CUO parses
   *  `[ObjectName]` inside speech and pre-selects the matching world
   *  object as the current target before forwarding the cleaned-up
   *  speech. We do the same: find a mobile by case-insensitive name
   *  match within `CLIENT_VIEW_RANGE`, emit `target:select` with the
   *  serial, and return the rewritten text (or null when no bracket
   *  was found). */
  resolveBracket(raw, ctx = {}) {
    if (typeof raw !== 'string') return null;
    const m = raw.match(/\[([^\]]{2,40})\]/);
    if (!m) return null;
    const needle = m[1].toLowerCase();
    const p = ctx?.world?.player;
    let bestSerial = 0;
    let bestDist = 99;
    const visit = (mob) => {
      if (!mob?.name || mob.serial === p?.serial) return;
      if (!mob.name.toLowerCase().startsWith(needle)) return;
      const dx = (mob.x - (p?.x ?? 0));
      const dy = (mob.y - (p?.y ?? 0));
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      if (d < bestDist) { bestSerial = mob.serial >>> 0; bestDist = d; }
    };
    const w = ctx?.world;
    if (p && typeof w?.forEachMobileNear === 'function') {
      w.forEachMobileNear(p.x, p.y, p.map ?? w.mapId ?? 1, 18, true, visit);
    } else {
      for (const mob of (w?.mobiles?.values?.() ?? [])) visit(mob);
    }
    if (!bestSerial) return null;
    bus.emit('target:select', { serial: bestSerial });
    return raw.replace(m[0], '').replace(/\s{2,}/g, ' ').trim();
  }

  /** Try to handle a raw chat line. Returns true when consumed. */
  handle(raw, ctx = {}) {
    if (typeof raw !== 'string') return false;
    if (!raw.startsWith('/')) return false;
    const trimmed = raw.slice(1).trim();
    if (!trimmed) return false;
    const parts = trimmed.split(/\s+/);
    const name = parts[0].toLowerCase();
    const args = parts.slice(1);
    const cmd = this._cmds.get(name);
    if (!cmd) {
      bus.emit('message:journal', {
        text: `Unknown command: /${name} (try /help)`,
        textType: 1, hue: 0xff4040,
      });
      return true;       // consumed even on miss — slashes never become speech
    }
    try {
      const r = cmd.run(args, ctx);
      if (r === false) return false;     // explicit fall-through
    } catch (e) {
      bus.emit('message:journal', {
        text: `Error in /${name}: ${e?.message ?? e}`,
        textType: 1, hue: 0xff4040,
      });
    }
    return true;
  }

  _registerBuiltins() {
    this.register('help', 'list all client commands', () => {
      const lines = ['Client commands:'];
      let rows = this._sortedCommandRows;
      if (!rows) {
        rows = [];
        for (const [name, def] of this._cmds) rows.push({ name, help: def.help });
        rows.sort((a, b) => a.name.localeCompare(b.name));
        this._sortedCommandRows = rows;
      }
      for (const row of rows) {
        lines.push(`/${row.name} — ${row.help}`);
      }
      for (const t of lines) bus.emit('message:journal', { text: t, textType: 1, hue: 0xc0e0ff });
    });
    this.register('where', 'print your current world coordinates', (_args, ctx) => {
      const p = ctx?.world?.player;
      if (!p) {
        bus.emit('message:journal', { text: 'Player not in world.', textType: 1, hue: 0xff8080 });
        return;
      }
      bus.emit('message:journal', {
        text: `You are at ${p.x}, ${p.y}, ${p.z} on facet ${p.map ?? 0}.`,
        textType: 1, hue: 0xc0ffc0,
      });
    });
    this.register('version', 'print client build info', () => {
      const v = (typeof __APP_VERSION__ !== 'undefined') ? __APP_VERSION__ : 'dev';
      bus.emit('message:journal', { text: `UO web client ${v}`, textType: 1, hue: 0xc0e0ff });
    });
    this.register('clear', 'clear the journal', () => {
      bus.emit('journal:clear');
    });
    this.register('resync', 'request a full world resync from the server', () => {
      bus.emit('command:resync');
    });
    this.register('lighten', 'force the world to full daylight (client-only)', () => {
      bus.emit('command:overall-light', { level: 0 });
    });
    this.register('darken', 'force the world to night (client-only)', () => {
      bus.emit('command:overall-light', { level: 28 });
    });
    this.register('credits', 'show the credits roll', () => {
      bus.emit('gump:credits');
    });
    this.register('inspector', 'open the entity inspector', () => {
      bus.emit('gump:inspector');
    });
    this.register('chat', 'open the chat channel manager', () => {
      bus.emit('gump:chat');
    });
    this.register('netstats', 'open the network stats panel', () => {
      bus.emit('gump:network-stats');
    });
    this.register('mark', 'edit a worldmap marker at your location', (_args, ctx) => {
      const p = ctx?.world?.player;
      bus.emit('gump:user-marker', {
        marker: { name: '', x: p?.x ?? 0, y: p?.y ?? 0, map: p?.map ?? 0 },
      });
    });
  }
}

export const commandManager = new CommandManager();
