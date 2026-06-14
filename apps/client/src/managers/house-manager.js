// HouseManager — registry of player-built houses with revision tracking.
// Mirrors ClassicUO `Game/Managers/HouseManager.cs`.
//
// Server emits 0xBF subop 0x1D HouseRevisionState ({ serial, revision }).
// If our cached revision doesn't match the server's we request the full
// custom-house design via 0xBF subop 0x1E. Once we have the design,
// 0xD8 CustomHouse delivers the component list per floor.
//
// What this MVP delivers:
//   - `getHouse(serial)` / `add(...)` / `remove(...)` registry
//   - revision compare so we don't refetch the same design twice
//   - `entityIntoHouse(houseSerial, entity)` — bounds test used by the
//     renderer's roof-cut-off path so a house's roof fades only when the
//     player actually stands inside its footprint
//
// Custom-house parsing is not done here (CUO ports a 30-subcommand
// state machine in HouseCustomizationManager); we just stash the raw
// 0xD8 payload until that lands.

import { bus } from '../core/event-bus.js';
import { world } from '../world/world.js';
import { net } from '../net/net-client.js';
import { buildCustomHouseDataRequest } from '../net/outgoing.js';

class HouseManager {
  constructor() {
    /** @type {Map<number, { serial:number, revision:number, payload?:Uint8Array, bounds?:{x0:number,y0:number,x1:number,y1:number} }>} */
    this._houses = new Map();
    this._installed = false;
  }

  install() {
    if (this._installed) return;
    this._installed = true;
    bus.on('house:revision', ({ payload }) => {
      // payload after `op + len + sub` is u32 serial + u32 revision.
      if (!payload || payload.length < 8) return;
      const serial   = ((payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3]) >>> 0;
      const revision = ((payload[4] << 24) | (payload[5] << 16) | (payload[6] << 8) | payload[7]) >>> 0;
      const cur = this._houses.get(serial);
      if (cur && cur.revision === revision) return;
      this._houses.set(serial, { ...(cur ?? { serial }), serial, revision });
      try { net.send(buildCustomHouseDataRequest(serial)); }
      catch { /* socket transient */ }
    });
    bus.on('house:custom', ({ raw }) => {
      // 0xD8 CustomHouse — we don't parse components yet, just stash.
      if (!raw || raw.length < 17) return;
      const serial = ((raw[3] << 24) | (raw[4] << 16) | (raw[5] << 8) | raw[6]) >>> 0;
      const h = this._houses.get(serial) ?? { serial, revision: 0 };
      h.payload = raw.slice();
      // Bounds: CUO reads a multi from the foundation Item to derive
      // x0/y0/x1/y1. With our existing assets.multiTiles we can do that
      // when the foundation Item lands; for now leave bounds undefined
      // and let entityIntoHouse fall back to a 32×32 generous box.
      this._houses.set(serial, h);
      bus.emit('house:design', { serial, payload: h.payload });
    });
  }

  add(serial, revision = 0) {
    serial >>>= 0;
    const cur = this._houses.get(serial);
    if (!cur) this._houses.set(serial, { serial, revision });
    else cur.revision = revision;
  }
  remove(serial) { this._houses.delete(serial >>> 0); }

  /** Return `{serial, revision, payload?}` or null. */
  get(serial) { return this._houses.get(serial >>> 0) ?? null; }

  /** True when there is any registered house within `range` tiles of the
   *  given entity (used by renderer's roof-cut-off heuristic). */
  isHouseInRange(serial, range = 18) {
    const h = this._houses.get(serial >>> 0);
    if (!h) return false;
    const it = world.items.get(h.serial);
    const p = world.player;
    if (!it || !p) return false;
    return Math.abs(it.x - p.x) <= range && Math.abs(it.y - p.y) <= range;
  }

  /** True when `entity` (an item or mobile) sits inside `houseSerial`'s
   *  multi footprint. Conservative fallback (32×32) when we don't have
   *  parsed bounds yet. */
  entityIntoHouse(houseSerial, entity) {
    if (!entity) return false;
    const h = this._houses.get(houseSerial >>> 0);
    if (!h) return false;
    const foundation = world.items.get(h.serial);
    if (!foundation) return false;
    const x0 = h.bounds?.x0 ?? (foundation.x - 16);
    const y0 = h.bounds?.y0 ?? (foundation.y - 16);
    const x1 = h.bounds?.x1 ?? (foundation.x + 16);
    const y1 = h.bounds?.y1 ?? (foundation.y + 16);
    return entity.x >= x0 && entity.x <= x1 && entity.y >= y0 && entity.y <= y1;
  }

  clear() { this._houses.clear(); }
}

export const houseManager = new HouseManager();
