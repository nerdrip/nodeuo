// AFKManager — idle detection that mirrors ClassicUO's
// `Game/Managers/AFKManager.cs` but lighter: instead of pinging server-
// side timers, we observe browser activity (key/mouse) and toggle the
// player's AFK flag via the existing `[afk` script command.
//
// Default threshold: 5 minutes of zero input. Returning input clears
// the flag (also via `[afk` toggle). The user can change threshold
// from the options gump (profile flag `afkThresholdMs`, set per-char).
//
// Why not server-side: ServUO has a heartbeat detector but our shard
// already pages the player's last-action timestamp on every 0x02 /
// 0xAD packet — duplicating it server-side would just spam the disk
// save. Client-only is enough; the server still receives the toggle
// command so other players see "(AFK)" in single-click LookReq.

import { net } from '../net/net-client.js';
import { buildUnicodeSpeech } from '../net/outgoing.js';
import { profile } from './profile-manager.js';

const DEFAULT_THRESHOLD_MS = 5 * 60_000;

class AFKManager {
  constructor() {
    this.threshold = DEFAULT_THRESHOLD_MS;
    this.lastActivityAt = Date.now();
    this.afk = false;
    this._poll = null;
  }

  /** Wire DOM listeners + start the 30s poll. Idempotent. */
  start() {
    if (this._poll) return;
    const bump = () => {
      this.lastActivityAt = Date.now();
      // Auto-untoggle when input returns. Send `[afk` again to flip back.
      if (this.afk) this._toggleServer();
    };
    document.addEventListener('keydown',   bump, true);
    document.addEventListener('mousemove', bump, true);
    document.addEventListener('mousedown', bump, true);
    document.addEventListener('wheel',     bump, true);
    this._cleanup = () => {
      document.removeEventListener('keydown',   bump, true);
      document.removeEventListener('mousemove', bump, true);
      document.removeEventListener('mousedown', bump, true);
      document.removeEventListener('wheel',     bump, true);
    };
    this._poll = setInterval(() => this._tick(), 30_000);
  }

  stop() {
    if (this._poll) clearInterval(this._poll);
    this._poll = null;
    if (this._cleanup) { this._cleanup(); this._cleanup = null; }
  }

  /** Read the user's threshold preference (per-char profile). */
  setThresholdMs(ms) {
    this.threshold = Math.max(60_000, ms | 0);
  }

  _tick() {
    const userMs = (profile?.data?.afkThresholdMs | 0) || this.threshold;
    if (this.afk) return;
    if (Date.now() - this.lastActivityAt < userMs) return;
    this._toggleServer();
  }

  /** Send `[afk` via the speech channel — the same path the user types
   *  manually. We avoid wiring a dedicated opcode for what is, on the
   *  server, just a toggle command. */
  _toggleServer() {
    try { net.send(buildUnicodeSpeech('[afk', { type: 0x00 })); }
    catch { /* socket transient */ }
    this.afk = !this.afk;
  }
}

export const afkManager = new AFKManager();
