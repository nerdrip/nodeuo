// ContainerManager — per-graphic container layout data + cursor cascade.
// Mirrors ClassicUO `Game/Managers/ContainerManager.cs`.
//
// What it does:
//   - Looks up ContainerData by gump id (where can items sit on the bag,
//     what background art, what open/close sounds).
//   - Tracks a "next position" cursor so opening multiple containers
//     cascades them down/right instead of stacking on top of each other
//     at (40,40) — addressing the "container scaling" bug from memory.
//   - Provides `calculateOpenPosition({ gumpId, serial })` for the
//     ContainerGump so it doesn't need to hard-code defaults.
//
// Container art bounds come from `ContainerData` — a tiny per-graphic
// table embedded here (CUO loads it from `ContainerData.txt`; we ship
// the most common entries inline since the table is short and bug-free
// data beats async loading for an MVP).

const DEFAULT = { x: 44, y: 65, w: 142, h: 94, openSound: 0x48, closeSound: 0x58 };

// Common container types: graphic → bounds. Values from CUO
// `ContainerData.cs::ContainerData` defaults + the CUO ContainerData.txt
// dump. x/y/w/h are the rectangle inside the gump where items can sit;
// the gump itself is fetched by graphic.
const TABLE = new Map([
  // Backpack (0x003C) — most common.
  [0x003C, { x: 44, y: 65, w: 142, h: 94, openSound: 0x48, closeSound: 0x58 }],
  // Pouches.
  [0x003E, { x: 19, y: 47, w: 132, h: 64, openSound: 0x48, closeSound: 0x58 }],
  [0x003F, { x: 16, y: 51, w: 168, h: 73, openSound: 0x48, closeSound: 0x58 }],
  // Wood / metal box.
  [0x0040, { x: 16, y: 51, w: 168, h: 84, openSound: 0x4f, closeSound: 0x59 }],
  [0x0041, { x: 18, y: 105, w: 144, h: 56, openSound: 0x4f, closeSound: 0x59 }],
  // Crate (paragon). Wider rectangle.
  [0x0042, { x: 16, y: 51, w: 168, h: 84, openSound: 0x4f, closeSound: 0x59 }],
  [0x0043, { x: 16, y: 51, w: 168, h: 84, openSound: 0x4f, closeSound: 0x59 }],
  [0x0044, { x: 16, y: 51, w: 168, h: 84, openSound: 0x4f, closeSound: 0x59 }],
  // Picnic basket.
  [0x0045, { x: 19, y: 47, w: 132, h: 64, openSound: 0x4f, closeSound: 0x59 }],
  // Crystal / fancy chest.
  [0x0048, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4f, closeSound: 0x59 }],
  [0x0049, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4f, closeSound: 0x59 }],
  [0x004A, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4f, closeSound: 0x59 }],
  // Drawer.
  [0x051A, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4f, closeSound: 0x59 }],
  // Bookcase.
  [0x004C, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4f, closeSound: 0x59 }],
  // Heart-shaped chest (Valentine).
  [0x09B7, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4f, closeSound: 0x59 }],
  // Banker box.
  [0x003D, { x: 18, y: 105, w: 144, h: 56, openSound: 0x4f, closeSound: 0x59 }],
  // Corpse.
  [0x2006, { x: 20, y: 85, w: 195, h: 110, openSound: 0x48, closeSound: 0x58 }],

  // ====================================================================
  //  Extended set — mirrors CUO ContainerData.txt entries that ship with
  //  the canonical client. Ranges + values are drawn from CUO source +
  //  community ContainerData.txt dumps. Each entry is the rect inside
  //  the gump where items can sit.
  // ====================================================================

  // ---- Pouches & bags additional ------------------------------------
  [0x0046, { x: 14, y: 50, w: 144, h: 90, openSound: 0x48, closeSound: 0x58 }],
  [0x0047, { x: 14, y: 50, w: 144, h: 90, openSound: 0x48, closeSound: 0x58 }],
  [0x004B, { x: 16, y: 50, w: 168, h: 73, openSound: 0x4F, closeSound: 0x59 }],
  [0x004D, { x: 16, y: 50, w: 168, h: 73, openSound: 0x4F, closeSound: 0x59 }],
  [0x004E, { x: 16, y: 50, w: 168, h: 73, openSound: 0x4F, closeSound: 0x59 }],
  [0x004F, { x: 16, y: 50, w: 168, h: 73, openSound: 0x4F, closeSound: 0x59 }],

  // ---- Pots, kegs, barrels ------------------------------------------
  [0x09A8, { x: 19, y: 47, w: 152, h: 64, openSound: 0x42, closeSound: 0x42 }],
  [0x09AA, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4F, closeSound: 0x59 }],
  [0x09AB, { x: 18, y: 105, w: 144, h: 56, openSound: 0x4F, closeSound: 0x59 }],

  // ---- Coffins / sarcophagi -----------------------------------------
  [0x0009, { x: 20, y: 85, w: 195, h: 110, openSound: 0x4D, closeSound: 0x4D }],
  [0x000A, { x: 20, y: 85, w: 195, h: 110, openSound: 0x4D, closeSound: 0x4D }],

  // ---- Picnic baskets ----------------------------------------------
  // Client audit #7 #4 — was 0x09B7 dup with heart-shaped chest above
  // (Map.set silently overwrote, picnic basket dimensions won + heart
  // chest got wrong content rect). 0x09B8 is the picnic-basket variant.
  [0x09B8, { x: 19, y: 47, w: 132, h: 64, openSound: 0x4F, closeSound: 0x59 }],

  // ---- Specialty deco containers (chests of varied art) ------------
  [0x0050, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4F, closeSound: 0x59 }],
  [0x0051, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4F, closeSound: 0x59 }],
  [0x0052, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4F, closeSound: 0x59 }],
  [0x0053, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4F, closeSound: 0x59 }],
  [0x0054, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4F, closeSound: 0x59 }],
  [0x0055, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4F, closeSound: 0x59 }],

  // ---- Specialty trapped chests (uses 0x0049 family) ---------------
  [0x0058, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4F, closeSound: 0x59 }],
  [0x0059, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4F, closeSound: 0x59 }],
  [0x005A, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4F, closeSound: 0x59 }],

  // ---- ML / SA Bone / Crystal containers ---------------------------
  [0x09BC, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4F, closeSound: 0x59 }],
  [0x09BD, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4F, closeSound: 0x59 }],
  [0x09BE, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4F, closeSound: 0x59 }],
  [0x09BF, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4F, closeSound: 0x59 }],

  // ---- Dragon turtle / chicken coop / aquarium ---------------------
  [0x4910, { x: 14, y: 50, w: 144, h: 90, openSound: 0x48, closeSound: 0x58 }],
  [0x3062, { x: 18, y: 70, w: 250, h: 130, openSound: 0x40, closeSound: 0x40 }],

  // ---- Jewelry / seed / commodity boxes ----------------------------
  [0x9AA1, { x: 18, y: 60, w: 188, h: 100, openSound: 0x4F, closeSound: 0x59 }],
  [0x4B23, { x: 20, y: 80, w: 200, h: 100, openSound: 0x4F, closeSound: 0x59 }],
  [0xA2C5, { x: 18, y: 60, w: 188, h: 100, openSound: 0x4F, closeSound: 0x59 }],

  // ---- Quivers (treated as containers in cloak slot) ---------------
  [0x108,  { x: 16, y: 50, w: 110, h: 60,  openSound: 0x48, closeSound: 0x58 }],
  [0x10A,  { x: 16, y: 50, w: 110, h: 60,  openSound: 0x48, closeSound: 0x58 }],

  // ---- Vendor backpacks (NPCs use 0x003C usually but some unique) --
  [0x4011, { x: 44, y: 65, w: 142, h: 94,  openSound: 0x48, closeSound: 0x58 }],

  // ---- Small specialty bags ----------------------------------------
  [0x080,  { x: 14, y: 50, w: 144, h: 90, openSound: 0x48, closeSound: 0x58 }],
  [0x081,  { x: 14, y: 50, w: 144, h: 90, openSound: 0x48, closeSound: 0x58 }],
  [0x082,  { x: 14, y: 50, w: 144, h: 90, openSound: 0x48, closeSound: 0x58 }],
  [0x083,  { x: 14, y: 50, w: 144, h: 90, openSound: 0x48, closeSound: 0x58 }],
  [0x084,  { x: 14, y: 50, w: 144, h: 90, openSound: 0x48, closeSound: 0x58 }],
  [0x085,  { x: 14, y: 50, w: 144, h: 90, openSound: 0x48, closeSound: 0x58 }],

  // ---- ML reagent satchels -----------------------------------------
  [0x4D7B, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4F, closeSound: 0x59 }],

  // ---- Arena / event chests (used for prize spawn) -----------------
  [0x09AC, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4F, closeSound: 0x59 }],
  [0x09AD, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4F, closeSound: 0x59 }],
  [0x09AE, { x: 16, y: 51, w: 168, h: 73, openSound: 0x4F, closeSound: 0x59 }],

  // ---- Paragon / treasure chests (5 levels share art 0x09AB) -------
  // (Already handled by the loot system — same gumpId, different bounds
  // not required at the gump level. Listed for clarity.)

  // ---- Player vendor pack (player-vendor-gump opens its own panel
  //  but sometimes the server replies with 0x24 + 0x003C anyway) ----
  // (handled by 0x003C above — no override needed.)
]);

class ContainerManager {
  constructor() {
    this.defaultX = 40;
    this.defaultY = 40;
    this._cursorX = 40;
    this._cursorY = 40;
    this._cascadeStep = 30;
    this._max = 360;
    /** Audit rev.4 P2 — per-gumpId position memo. Cached at gump
     *  close (`rememberPosition`) and consulted by
     *  `calculateOpenPosition`. */
    this._posMemo = new Map();
  }

  /** Look up the ContainerData for a gump graphic. Falls back to a sane
   *  rectangle that matches a generic backpack when the table doesn't
   *  know `gumpId` — this mirrors CUO's `Get()` behaviour. */
  get(gumpId) {
    return TABLE.get(gumpId & 0xffff) ?? DEFAULT;
  }

  /** Pick a screen position for a new container window. Cascades.
   *
   *  When `serial` already has a remembered position (from a previous
   *  open/close cycle in the same session), the caller can pass it via
   *  `lastPosition` and we'll reuse it. Otherwise we cascade off the
   *  cursor and bump it for the next opener.
   *
   *  Audit rev.4 P2 — second-chance lookup by gumpId. CUO ships a
   *  per-gump position memo that survives the open/close cycle even
   *  if the caller forgot to stash `lastPosition`. We add the same:
   *  `rememberPosition(gumpId, x, y)` is called by the container gump
   *  on close, `calculateOpenPosition({ gumpId })` retrieves the
   *  cached pos before falling back to the cascade. */
  calculateOpenPosition({ lastPosition, gumpId } = {}) {
    if (lastPosition && Number.isFinite(lastPosition.x) && Number.isFinite(lastPosition.y)) {
      return { x: lastPosition.x, y: lastPosition.y };
    }
    if (gumpId != null) {
      const memo = this._posMemo.get(gumpId & 0xffff);
      if (memo) return { x: memo.x, y: memo.y };
    }
    const x = this._cursorX;
    const y = this._cursorY;
    this._cursorX += this._cascadeStep;
    this._cursorY += this._cascadeStep;
    if (this._cursorX > this._max) this._cursorX = this.defaultX;
    if (this._cursorY > this._max) this._cursorY = this.defaultY;
    return { x, y };
  }

  /** Audit rev.4 P2 — stash the closed position keyed on gumpId. The
   *  next time a container of the same kind opens, calculateOpenPosition
   *  returns this memo before resorting to the cascade. */
  rememberPosition(gumpId, x, y) {
    if (gumpId == null) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this._posMemo.set(gumpId & 0xffff, { x: x | 0, y: y | 0 });
  }

  resetCascade() {
    this._cursorX = this.defaultX;
    this._cursorY = this.defaultY;
  }
}

export const containerManager = new ContainerManager();
