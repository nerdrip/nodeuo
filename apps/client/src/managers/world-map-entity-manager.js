// WorldMapEntityManager — tracks party / guild member positions for the
// WorldMapGump pin overlay. Mirrors CUO `Game/Managers/WorldMapEntityManager.cs`.
//
// Sources:
//   - Party member 0x77 / 0x78 broadcasts (we already get these via the
//     'mobile:moving' / 'mobile:incoming' bus events when in range).
//   - 0xF0 Krrios assist API (out-of-range party / guild positions).
//     The CUO loop emits 0xF0 sub 0x00 every second to request the
//     latest positions, server replies with sub 0x01.
//
// The gump asks `getPins()` each frame for the current snapshot.

import { bus } from '../core/event-bus.js';
import { world } from '../world/world.js';
import { net } from '../net/net-client.js';
import { PacketWriter } from '@uo/protocol';
import { party } from './party-manager.js';

const TICK_MS = 1000;
const STALE_MS = 8000;        // drop entries we haven't heard from in 8 s

/** 0xF0 Krrios sub 0x00 — request world-map positions. Canonical CUO
 *  layout is 4 bytes total: `op + len(2)=4 + sub(1)`. The previous
 *  declaration of len=6 with only 4 bytes written caused the server-
 *  side framer to read size=6 and consume 2 bytes from the FOLLOWING
 *  outgoing packet (typically a 0x02 MovementReq), drifting every
 *  subsequent opcode by 2 bytes. User report 2026-05-18: dozens of
 *  "Unknown incoming opcode" warnings per second while walking after
 *  a moongate teleport (which spins up the WorldMapEntityManager poll
 *  → buildKrriosRequest every 1s). */
function buildKrriosRequest() {
  const w = new PacketWriter(4);
  w.writeU8(0xF0); w.writeU16(4);
  w.writeU8(0x00);             // sub: party world-map state request
  return w.bytes();
}

class WorldMapEntityManager {
  constructor() {
    /** @type {Map<number, { serial:number, x:number, y:number, hp:number, map:number, isGuild:boolean, name:string, updatedAt:number }>} */
    this._entries = new Map();
    this._enabled = false;
    this._lastTickAt = 0;
    this._installed = false;
    this.revision = 0;
  }

  _bumpRevision() {
    this.revision = (this.revision + 1) >>> 0;
  }

  install() {
    if (this._installed) return;
    this._installed = true;
    bus.on('mobile:moving',   (m) => this._addOrUpdateFromMobile(m));
    bus.on('mobile:incoming', (m) => this._addOrUpdateFromMobile(m));
    bus.on('frame:tick',      (now) => this._tick(now));
    bus.on('party:roster',    () => { /* drop stale entries on roster change */
      const now = performance.now();
      let changed = false;
      for (const [k, v] of this._entries) {
        if (now - v.updatedAt > STALE_MS) {
          this._entries.delete(k);
          changed = true;
        }
      }
      if (changed) this._bumpRevision();
    });
  }

  setEnabled(on) { this._enabled = !!on; }
  /** @returns {ReadonlyArray<{serial:number,x:number,y:number,hp:number,map:number,isGuild:boolean,name:string}>} */
  getPins() { return [...this._entries.values()]; }
  forEachPin(fn) {
    for (const ent of this._entries.values()) fn(ent);
  }

  _addOrUpdateFromMobile(m) {
    if (!m) return;
    // Add only party / guild members. We don't have a guild API yet, so
    // for now: party + the local player.
    const isPlayer = world.player && (m.serial >>> 0) === world.player.serial;
    if (!isPlayer && !this._isPartyMember(m.serial)) return;
    const serial = m.serial >>> 0;
    const hp = m.hpMax ? Math.round((m.hp / m.hpMax) * 100) : 100;
    const prev = this._entries.get(serial);
    this._entries.set(serial, {
      serial: m.serial >>> 0,
      x: m.x, y: m.y,
      hp,
      map: world.mapId | 0,
      isGuild: false,
      name: m.name || '',
      updatedAt: performance.now(),
    });
    if (!prev
        || prev.x !== m.x || prev.y !== m.y || prev.hp !== hp
        || prev.map !== (world.mapId | 0) || prev.name !== (m.name || '')) {
      this._bumpRevision();
    }
  }

  _isPartyMember(serial) {
    return party?.isMember?.(serial) ?? false;
  }

  _tick(now) {
    if (!this._enabled) return;
    if (now - this._lastTickAt < TICK_MS) return;
    this._lastTickAt = now;
    // Stale eviction.
    let changed = false;
    for (const [k, v] of this._entries) {
      if (now - v.updatedAt > STALE_MS) {
        this._entries.delete(k);
        changed = true;
      }
    }
    if (changed) this._bumpRevision();
    // Krrios request — server may answer with broader-range positions.
    // Skip the send entirely when the socket isn't open (e.g. login
    // screen, mid-reconnect) to avoid spamming the dropped-opcode log.
    // Also skip when the player isn't in-world yet — Krrios is a
    // post-LoginConfirm packet.
    if (!net.isOpen) return;
    if (!world.player) return;
    try { net.send(buildKrriosRequest()); }
    catch { /* socket transient */ }
  }
}

export const worldMapEntities = new WorldMapEntityManager();
