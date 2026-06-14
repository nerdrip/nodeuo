// `[door spawn` admin command — drops a runtime BaseDoor item at the
// player's feet. Doors are toggleable on double-click (0x06 useReq):
// closed ↔ open. ServUO's `BaseDoor` ships ~24 art pairs (oak/iron/bar/
// gate/etc.); for MVP we expose 4 representative kinds.
//
//   wood     0x0675 (closed)  ↔ 0x0676 (open)
//   iron     0x0824 (closed)  ↔ 0x0825 (open)
//   stone    0x086E (closed)  ↔ 0x086F (open)
//   gate     0x080B (closed)  ↔ 0x080C (open)
//
// Each door carries a `door = { closedId, openId, isOpen }` payload
// the use-handler reads to swap art. ServUO additionally has facing
// (north/south/east/west), keying / lock state, and auto-close timers
// — out of scope for this MVP but the data shape allows easy extension.

import {
  getAclLevel, bumpVisit,
  ACL_FRIEND, ACL_OWNER,
} from '../../items/behaviors/house-acl.js';
import { childrenOf, findBackpack } from '../../_inventory.js';
import { moveItem } from '../../_movement.js';
import { allItems, sendToClientsNear } from '../../_spatial.js';
import { itemBySerial } from '../../_entities.js';
import { createItem } from '../../_items.js';
// FAZA BF: each door material has FOUR (closedId, openId) pairs — one
// per facing direction. Real UO art has these adjacent in tiledata:
//   facing  closed  open
//   south   N+0     N+1   (door swings south, hinge on east jamb)
//   east    N+2     N+3
//   south2  N+4     N+5   (other-handed south door)
//   east2   N+6     N+7
// We expose a `facing` shorthand the spawn command resolves; auto-pick
// scans neighbouring tiles for walls and chooses the door direction that
// matches the gap (E if east tile is empty, S if south tile is empty).
const DOOR_FACINGS = {
  south:  { closedOff: 0, openOff: 1 },
  east:   { closedOff: 2, openOff: 3 },
  south2: { closedOff: 4, openOff: 5 },
  east2:  { closedOff: 6, openOff: 7 },
};
const DOOR_KINDS = {
  // Item id at slot 0 of each kind's 8-id run. Real UO ranges (verified
  // against ServUO `Scripts/Items/Doors/Doors.cs`):
  //   0x0675..0x067C wood (light)            BaseHouseDoor / GenericHouseDoor
  //   0x06A5..0x06AC dark wood               DarkWoodHouseDoor
  //   0x0824..0x082B metal/iron              MetalDoor
  //   0x0839..0x0840 metal short             MetalDoor short
  //   0x0866..0x086D bar door                BarDoor
  //   0x086E..0x0875 stone                   StonePillar / GenericHouseDoor
  //   0x09AD..0x09B4 strong wood             StrongWoodDoor
  //   0x080B..0x0812 iron gate (large)       IronGate
  //   0x0901..0x0908 light wood gate          LightWoodGate
  //   0x084C..0x0853 rattan                  RattanDoor
  //   0x0890..0x0897 elven (curved)           ElvenDoor
  //   0x2FE2..0x2FE9 elven secret             ElvenSecretDoor
  //   0x4AD2..0x4AD9 medium stone             MediumStoneDoor
  // We point baseId at the SOUTH-closed slot of each 8-id run.
  wood:        { baseId: 0x0675, name: 'wooden door' },
  darkwood:    { baseId: 0x06A5, name: 'dark wooden door' },
  iron:        { baseId: 0x0824, name: 'iron door'   },
  metalshort:  { baseId: 0x0839, name: 'metal door'  },
  bar:         { baseId: 0x0866, name: 'bar door'    },
  stone:       { baseId: 0x086E, name: 'stone door'  },
  strongwood:  { baseId: 0x09AD, name: 'strong wooden door' },
  gate:        { baseId: 0x080B, name: 'iron gate'   },
  lightgate:   { baseId: 0x0901, name: 'light wooden gate' },
  rattan:      { baseId: 0x084C, name: 'rattan door' },
  elven:       { baseId: 0x0890, name: 'elven door'  },
  elvensecret: { baseId: 0x2FE2, name: 'elven secret door', secret: true },
  medstone:    { baseId: 0x4AD2, name: 'medium stone door' },
  // Portcullis is a single-image vertical lift, no facing variants. We
  // synthesise an 8-id run that maps every facing to the same closed/open
  // pair so the existing facing math keeps working.
  portcullis:  { baseId: 0x0357, openId: 0x0358, name: 'portcullis', portcullis: true },
};

const AUTO_CLOSE_MS = 30_000;

/** Per-piece OPEN offset (applied closed → open, reversed on close).
 *  Indexed by our `housedata.json` pieceIdx (NOT ServUO's m_DoorData
 *  index). Wood category-0 pieces[] order:
 *    [0x679, 0x67b, 0x675, 0x677, 0x67d, 0x67f, 0x681, 0x683]
 *  while ServUO `m_DoorData` orders them:
 *    [0x675, 0x677, 0x679, 0x67b, 0x67d, 0x67f, 0x681, 0x683]
 *  → housedata's pieces[0..3] are SHUFFLED vs ServUO. Pieces 4..7
 *  match. The table below applies the ServUO `Offsets[]` value
 *  through the housedata permutation, so opening door A (pieceIdx 2,
 *  closedId 0x675 = ServUO WestCCW idx 0) gets the canonical
 *  (-1,+1) swing instead of the (-1,0) value the old aligned-with-
 *  ServUO table produced. User report 2026-05-19 "drzwi otwarte się
 *  otwierają za daleko" was exactly this off-by-one-row in the
 *  housedata vs ServUO indexing.
 *
 *  housedata pieceIdx → ServUO facing → offset:
 *    0  WestCW  (0x679 → ServUO idx 2)  → (-1,  0)
 *    1  EastCCW (0x67b → ServUO idx 3)  → (+1, -1)
 *    2  WestCCW (0x675 → ServUO idx 0)  → (-1, +1)
 *    3  EastCW  (0x677 → ServUO idx 1)  → (+1, +1)
 *    4  SouthCW (0x67d → ServUO idx 4)  → (+1, +1)
 *    5  SouthCCW(0x67f → ServUO idx 5)  → (+1, -1)
 *    6  NorthCW (0x681 → ServUO idx 6)  → ( 0,  0)
 *    7  NorthCCW(0x683 → ServUO idx 7)  → ( 0, -1)
 */
const OPEN_OFFSETS = [
  { dx: -1, dy:  0 },  // 0 — WestCW  (housedata pieces[0] = 0x679)
  { dx:  1, dy: -1 },  // 1 — EastCCW (housedata pieces[1] = 0x67b)
  { dx: -1, dy:  1 },  // 2 — WestCCW (housedata pieces[2] = 0x675)
  { dx:  1, dy:  1 },  // 3 — EastCW  (housedata pieces[3] = 0x677)
  { dx:  1, dy:  1 },  // 4 — SouthCW (housedata pieces[4] = 0x67d)
  { dx:  1, dy: -1 },  // 5 — SouthCCW(housedata pieces[5] = 0x67f)
  { dx:  0, dy:  0 },  // 6 — NorthCW (housedata pieces[6] = 0x681)
  { dx:  0, dy: -1 },  // 7 — NorthCCW(housedata pieces[7] = 0x683)
];

/** Resolve the open-swing offset for a door's closed graphic. We MUST
 *  use the housedata `pieceIdx` (0..7 inside the 8-piece run) because
 *  `(closedId & 7) >> 1` only matches the canonical pair-index when the
 *  run starts at a multiple of 8 — which most retail UO door runs do
 *  NOT (wood 0x0675 has `& 7 = 5`, darkwood 0x06A5 has `& 7 = 5`, light
 *  gate 0x0901 has `& 7 = 1`, …). With a real pieceIdx each hinge
 *  variant picks its own offset per ServUO canon.
 *  @param {number} closedId
 *  @param {{ pieceIdx: number } | null | undefined} info
 */
function getDoorOpenOffset(closedId, info) {
  if (info && Number.isFinite(info.pieceIdx)) {
    return OPEN_OFFSETS[info.pieceIdx & 7] ?? { dx: 0, dy: 0 };
  }
  // No housedata — fall back to (closedId & 7) which only works for
  // runs starting at a multiple of 8 but is better than no offset.
  return OPEN_OFFSETS[(closedId | 0) & 7] ?? { dx: 0, dy: 0 };
}

export default function register(api) {
  if (!api.commands || !api.protocol || !api.items) return () => {};

  const scopedApi = (world) => ({
    ...api,
    world: world ?? api.world,
    game: world?._scriptGame ?? api.game,
    query: world?._scriptQuery ?? api.query,
  });

  api.commands.register({
    name: 'door',
    help: '[door <wood|iron|stone|gate> [south|east|south2|east2] — spawn at feet.',
    access: 'Admin',
    run(ctx) {
      const kind = String(ctx.args[0] ?? 'wood').toLowerCase();
      const cfg = DOOR_KINDS[kind];
      if (!cfg) {
        ctx.state.sendSystemMessage(`Unknown door. Try: ${Object.keys(DOOR_KINDS).join(', ')}`);
        return;
      }
      // FAZA BF: facing — explicit 2nd arg, else auto-detect. Auto rule:
      // if the east neighbour tile has a closed-door / wall static, the
      // door faces SOUTH (door panel is the southern edge). Mirror for
      // the south neighbour. Default 'south' covers freestanding doors.
      const wantedFacing = String(ctx.args[1] ?? '').toLowerCase();
      let facing;
      if (DOOR_FACINGS[wantedFacing]) {
        facing = wantedFacing;
      } else {
        facing = autoDetectFacing(api, ctx.sender) ?? 'south';
      }
      const off = DOOR_FACINGS[facing];
      // Portcullis ignores facing — single closed/open pair. Other doors
      // use the 8-id facing layout.
      const closedId = cfg.portcullis ? cfg.baseId : (cfg.baseId + off.closedOff);
      const openId   = cfg.portcullis ? cfg.openId : (cfg.baseId + off.openOff);
      const mob = ctx.sender;
      // Optional 3rd arg: lock keyId (any number). Locked doors can't be
      // opened without `[key <keyId>` in inventory; matches ServUO
      // `BaseDoor.KeyValue` semantics.
      const keyArg = ctx.args[2];
      const keyId = keyArg ? Number(keyArg) | 0 : 0;
      const item = createItem(api, api.world, {
        itemId: closedId,
        x: mob.x, y: mob.y, z: mob.z, map: mob.map ?? 1,
        name: cfg.name, movable: false,
      });
      item.door = {
        closedId, openId, isOpen: false, facing,
        secret: !!cfg.secret,                 // hide art until detected
        portcullis: !!cfg.portcullis,         // no auto-close
        keyId: keyId,                          // 0 = unlocked
        locked: keyId !== 0,
      };
      // Broadcast spawn so existing clients see the door without a relog.
      const wi = api.protocol.worldItemSA?.({
        serial: item.serial, itemId: item.itemId, hue: item.hue,
        amount: 1, x: item.x, y: item.y, z: item.z, flags: 0x00,
      });
      // BUGFIX #22 (FAZA BF): the previous version broadcast `worldItemSA`
      // to EVERY connected client globally — 100 players in different
      // cities each got a packet for every door spawn / toggle / auto-
      // close. Filter to clients within 18-tile UO update range on the
      // same facet. (Same range visibility.nearbyClients uses.)
      if (wi) sendToClientsNear(api, item, wi);
      ctx.state.sendSystemMessage(`A ${cfg.name} appears.`);
    },
  });

  // FAZA LA / BUGFIX #140: register a pre-template useItem hook
  // instead of `api.templates.useItem = wrapper` (read-only ES module
  // export, threw at script init). The hook chain in templates.js
  // short-circuits on the first truthy return.
  // Auto-bind door behavior to any item whose graphic shows up in
  // housedata.doors (37 categories × 8 pieces = 296 graphics). Players
  // who double-click a static door from the map block get the same
  // open/close swap without us hand-curating a graphic table.
  const autoBindDoor = (item) => {
    if (item.door) return item.door;
    // UO door art convention: every category ships 8 CLOSED graphics
    // (one per facing/hinge), and the OPEN graphic of each is at
    // `closedId + 1` per ServUO `BaseDoor.cs`. Housedata's
    // `doorPiece(itemId)` only knows the CLOSED variants — looking up
    // an already-open graphic returns null. The previous parity-
    // based heuristic `(pieceIdx & 1) === 1` is wrong because
    // `pieceIdx` is the index into the 8-entry CLOSED facings array,
    // not a closed/open flag.
    //
    // Correct flow (audit 2026-05-19):
    //   1. If `doorPiece(itemId)` resolves → itemId IS the closed
    //      graphic; door state = closed.
    //   2. Else try `doorPiece(itemId - 1)` → itemId is the OPEN
    //      graphic of the previous index; door state = open.
    //   3. Else if `script === 'door'` → fall back to "even is closed"
    //      heuristic (handles dev-spawned doors with no housedata).
    //   4. Else: not a door, return null.
    let info = api.housedata?.doorPiece?.(item.itemId);
    let closedId, openId, isOpenInitially;
    if (info) {
      closedId = item.itemId;
      openId   = closedId + 1;
      isOpenInitially = false;
    } else {
      const candClosed = (item.itemId | 0) - 1;
      const candInfo = api.housedata?.doorPiece?.(candClosed);
      if (candInfo) {
        info = candInfo;
        closedId = candClosed;
        openId   = item.itemId;
        isOpenInitially = true;
      } else if (item.script === 'door') {
        const evenId = (item.itemId & 1) === 0 ? item.itemId : (item.itemId - 1);
        closedId = evenId;
        openId   = evenId + 1;
        isOpenInitially = (item.itemId & 1) === 1;
      } else {
        return null;
      }
    }
    item.door = {
      closedId, openId, isOpen: isOpenInitially,
      // pieceIdx range 0..7, two slots per facing (hinge L / hinge R).
      facing: info ? ['south','east','north','west'][(info.pieceIdx >> 1) & 3] : null,
    };
    return item.door;
  };

  /** Find the door physically paired with `item` — the second leaf of
   *  a double-door entrance. ServUO uses an explicit `Link` reference
   *  per `BaseDoor.cs`; our doorgen + autoBind don't set one, so we
   *  derive it: a partner is the closest other door on an adjacent
   *  tile (±1 in x or y) with the same facing + map + z. Returns null
   *  if no partner (single-leaf door).
   *
   *  Uses `world.sectors.itemSerialsNear` so the scan is bounded by
   *  the 3×3 sector neighbourhood around the door's tile (worst case
   *  ~64 items) instead of walking all `world.items` (~113k after
   *  `[createworld`) — without this, every door click stalled the main
   *  thread for tens of ms and rapid clicks dropped FPS into the
   *  single digits. */
  const findDoorPartner = (world, item) => {
    if (!item?.door?.facing) return null;
    // ServUO `BaseDoor.Link` is set once at house deploy and dereffed
    // forever after. We approximate by pinning `door.linkSerial` to
    // the partner found on the first scan. Future clicks check the
    // pinned ref first and only fall through to the sector scan if
    // the partner despawned — pins the pair so adjacent shops with
    // same-facing doors don't shuffle every interaction. User report
    // 2026-05-19 "drzwi się otwierają z złej strony / przeskakują".
    const pinned = item.door.linkSerial
      ? itemBySerial({ world }, item.door.linkSerial)
      : null;
    if (pinned && (pinned.door || pinned.script === 'door')) return pinned;

    const lookOriginX = item.door.closedX ?? item.x;
    const lookOriginY = item.door.closedY ?? item.y;
    const lookZ = item.door.closedZ ?? item.z;
    // Sector neighbourhood query — bounded by 3 tiles around the door.
    // Falls back to a full walk when sectors aren't indexed (test
    // fixtures, pre-build setups).
      const candidates = world.sectors?.itemSerialsNear
        ? Array.from(world.sectors.itemSerialsNear(item.map | 0, lookOriginX, lookOriginY, 3))
          .map((s) => itemBySerial({ world }, s))
          .filter(Boolean)
        : Array.from(allItems(scopedApi(world)));
    // Mirror-pair fingerprints. A canonical UO double-door is two
    // adjacent leaves with COMPLEMENTARY hinge styles at the same
    // facing axis. Per housedata pieces[]:
    //   pieces[0] WestCW  + pieces[1] EastCCW  → south-facing pair
    //   pieces[2] WestCCW + pieces[3] EastCW   → south-facing pair (mirror)
    //   pieces[4] SouthCW + pieces[5] SouthCCW → east-facing pair
    //   pieces[6] NorthCW + pieces[7] NorthCCW → east-facing pair
    // The facing STRING differs between the two leaves (WestCW vs
    // EastCCW), so the previous `partnerFacing === item.door.facing`
    // check rejected every legitimate double-door. User report
    // 2026-05-19 "trzeba klikać pojedynczo na drzwi". The fix: pair
    // by housedata pieceIdx parity instead — leaves whose pieceIdx
    // ^ 1 == partner's pieceIdx form a mirror.
    const ourInfo = api.housedata?.doorPiece?.(item.door.closedId);
    const ourPiece = ourInfo?.pieceIdx;
    for (const it of candidates) {
      if (it === item) continue;
      if (it.script !== 'door' && !it.door) continue;
      if (it.map !== item.map) continue;
      if (Math.abs((it.door?.closedZ ?? it.z) - lookZ) > 1) continue;
      const itX = it.door?.closedX ?? it.x;
      const itY = it.door?.closedY ?? it.y;
      const dx = Math.abs(itX - lookOriginX);
      const dy = Math.abs(itY - lookOriginY);
      if (dx + dy !== 1) continue;          // strict 1-tile orthogonal
      // Mirror-piece match (preferred): housedata says the two
      // leaves are an XOR-1 pair (i.e. consecutive within the
      // 8-piece run). This is how every wood/iron/stone double-door
      // in canon UO is laid out.
      const theirInfo = api.housedata?.doorPiece?.(it.door?.closedId ?? it.itemId);
      if (Number.isFinite(ourPiece) && Number.isFinite(theirInfo?.pieceIdx)
          && ourInfo.category === theirInfo.category
          && (ourPiece ^ 1) === theirInfo.pieceIdx) {
        item.door.linkSerial = it.serial;
        if (it.door) it.door.linkSerial = item.serial;
        return it;
      }
      // Fallback for doors without housedata (single-leaf custom
      // spawns, dev placements): same facing string + adjacency.
      const partnerFacing = it.door?.facing ?? autoBindDoor(it)?.facing;
      if (partnerFacing && item.door.facing && partnerFacing === item.door.facing) {
        item.door.linkSerial = it.serial;
        if (it.door) it.door.linkSerial = item.serial;
        return it;
      }
    }
    return null;
  };

  /** Mutate a door's open/closed state. Centralises the offset math
   *  + worldItemSA broadcast so `doorHook` and `findDoorPartner`-driven
   *  pair toggles share one code path. */
  const applyToggle = (world, item, open) => {
    const door = item.door;
    const next = { x: item.x, y: item.y, z: item.z, map: item.map };
    door.isOpen = !!open;
    item.itemId = door.isOpen ? door.openId : door.closedId;
    const info = api.housedata?.doorPiece?.(door.closedId);
    const offset = getDoorOpenOffset(door.closedId, info);
    if (door.isOpen) {
      if (door.closedX == null) {
        door.closedX = item.x;
        door.closedY = item.y;
        door.closedZ = item.z;
      }
      next.x = door.closedX + offset.dx;
      next.y = door.closedY + offset.dy;
    } else if (door.closedX != null) {
      next.x = door.closedX;
      next.y = door.closedY;
      if (door.closedZ != null) next.z = door.closedZ;
    }
    moveItem(api, item, next);
    const wi = api.protocol?.worldItemSA?.({
      serial: item.serial, itemId: item.itemId, hue: item.hue,
      amount: 1, x: item.x, y: item.y, z: item.z, flags: 0x00,
    });
    if (wi) sendToClientsNear(scopedApi(world), item, wi);
  };

  const doorHook = (world, item, user) => {
    if (!item.door && !autoBindDoor(item)) {
      return false;
    }
    const door = item.door;
    const distance = Math.max(Math.abs(item.x - user.x), Math.abs(item.y - user.y));
    if (distance > 2) {
      user.client?.sendSystemMessage?.('That is too far away.');
      return true;
    }
    // House ACL gate — when the door is part of a placemulti with an
    // ACL, only FRIEND+ tier mobs can toggle it. Strangers see "the
    // door is sealed". Owner / co-owner / friend / GM all pass.
    // Doors WITHOUT an ACL (dungeon doors, decoration doors, multis
    // placed by the legacy admin path) are wide open — matches retail
    // ServUO where Public houses have no door gate.
    if (item._multi != null && item._multiAcl && !item._multiAcl.isPublic) {
      const access = user?.client?.account?.accessLevel ?? 'Player';
      const tier = getAclLevel(user, item._multiAcl, access);
      if (tier < ACL_FRIEND) {
        user.client?.sendSystemMessage?.('The door is sealed by an ACL ward.');
        return true;
      }
      // Owner-visit refresh — door opens reset the decay timer same as
      // sign clicks do.
      if (tier === ACL_OWNER) bumpVisit(item._multiAcl);
    }
    // Locked doors require a matching key in the user's backpack. Keys
    // are items with `key.keyId === door.keyId`. ServUO `BaseDoor.OnDoubleClick`
    // emits cliloc 501747 ("It appears to be locked.").
    if (door.locked && door.keyId) {
      const hasKey = userHasKey(api, user, door.keyId);
      if (!hasKey) {
        user.client?.sendSystemMessage?.('It appears to be locked.');
        return true;
      }
      // Open the lock for the duration of this toggle — re-locks on close.
    }
    // Secret door — first interaction reveals it (clears the flag). Not
    // a graphic swap; just no longer hidden from "[detect" / future scans.
    if (door.secret && !door.revealed) {
      door.revealed = true;
      user.client?.sendSystemMessage?.('You discover a secret door.');
    }
    const wantOpen = !door.isOpen;
    applyToggle(world, item, wantOpen);
    // Paired-leaf sync — find a partner door (the second leaf of a
    // double-door entrance) and toggle it to the same state. Without
    // this, only one leaf opened: the user clicked door A, A swung
    // open, B stayed closed → "drzwi się źle układają" / "nie da się
    // ich zamknąć" because re-clicking the OPEN leaf flipped only
    // itself again. ServUO `BaseDoor.Link` handles this server-side.
    // `_doorPairToggleInFlight` short-circuits the partner's recursion
    // when applyToggle below calls back into this hook indirectly.
    if (!item._doorPairToggleInFlight) {
      const partner = findDoorPartner(world, item);
      if (partner) {
        if (!partner.door) autoBindDoor(partner);
        if (partner.door && partner.door.isOpen !== wantOpen) {
          partner._doorPairToggleInFlight = true;
          try { applyToggle(world, partner, wantOpen); }
          finally { partner._doorPairToggleInFlight = false; }
        }
      }
    }
    // LOS cache invalidation — door toggle changes blocked-tile shape,
    // so cached "you can see that target" results from the prior 100 ms
    // window may now be wrong (target hidden behind a now-closed door,
    // or visible through a now-open one). Cheap: drop the whole cache.
    try { api.los?.invalidate?.(); } catch { /* advisory */ }
    // BUGFIX #17 (FAZA BA): re-look up the item by serial on the
    // close timer so a destroyed door short-circuits cleanly.
    // Portcullis stays open until manually closed (or admin retoggle) —
    // skip auto-close entirely.
    if (door.isOpen && !door.portcullis) {
      if (door._closeTimer) clearTimeout(door._closeTimer);
      const doorSerial = item.serial;
      door._closeTimer = setTimeout(() => {
        const live = itemBySerial({ world }, doorSerial);
        if (!live || !live.door || !live.door.isOpen) return;
        applyToggle(world, live, false);
        // Also close the paired leaf so a double door snaps shut as a
        // unit on the timer (not just the one clicked).
        const partner = findDoorPartner(world, live);
        if (partner?.door?.isOpen) {
          partner._doorPairToggleInFlight = true;
          try { applyToggle(world, partner, false); }
          finally { partner._doorPairToggleInFlight = false; }
        }
      }, AUTO_CLOSE_MS);
    }
    return true;
  };
  api.templates?.addUseItemHook?.(doorHook);

  // Diagnostic: target a door, dump its current `door` payload + raw
  // tiledata flags. Useful when "the click does nothing" — output goes
  // to the player's chat AND the server log so a screenshot is enough
  // to debug remotely.
  api.commands.register({
    name: 'doorinfo',
    help: '[doorinfo — target a door (or any item) and show its door payload, flags, and runtime state.',
    access: 'Admin',
    run(ctx) {
      const req = api.targeting?.request ?? api.ctx?.handlers?.targeting?.request;
      if (!req) {
        ctx.state.sendSystemMessage('Targeting unavailable.');
        return;
      }
      ctx.state.sendSystemMessage('Target a door to inspect.');
      req(ctx.state, (picked) => {
        if (!picked || !picked.serial) {
          ctx.state.sendSystemMessage('No item selected.');
          return;
        }
        const it = itemBySerial(api, picked.serial >>> 0);
        if (!it) {
          ctx.state.sendSystemMessage(`No item at serial 0x${(picked.serial >>> 0).toString(16)}.`);
          return;
        }
        const lines = [
          `── doorinfo 0x${(it.serial >>> 0).toString(16)} ──`,
          `itemId=0x${(it.itemId | 0).toString(16)} pos=(${it.x},${it.y},${it.z}) facet=${it.map}`,
          `script='${it.script ?? '(none)'}' movable=${it.movable} isDecoration=${!!it.isDecoration}`,
        ];
        if (it.door) {
          lines.push(`door: closedId=0x${it.door.closedId.toString(16)} openId=0x${it.door.openId.toString(16)} isOpen=${it.door.isOpen} facing=${it.door.facing ?? 'null'}`);
        } else {
          lines.push('door: (no payload — autoBindDoor will derive on first click)');
        }
        for (const ln of lines) {
          ctx.state.sendSystemMessage(ln);
          api.log?.(`[doorinfo] ${ln}`);
        }
      }, { kind: 0 });
    },
  });

  // Companion command: spawn a key bound to a door's keyId. Drops in
  // the player's backpack. ServUO ships keys as `KeyType` (gold / iron /
  // copper / rusty / magic) — graphic 0x100E..0x1010 + 0x1F0F.
  api.commands.register({
    name: 'key',
    help: '[key <keyId> [gold|iron|copper|rusty|magic] — spawn a key in your backpack.',
    access: 'Admin',
    run(ctx) {
      const keyId = Number(ctx.args[0]) | 0;
      if (!keyId) { ctx.state.sendSystemMessage('Usage: [key <keyId> [type]'); return; }
      const variant = String(ctx.args[1] ?? 'iron').toLowerCase();
      const KEY_GFX = { gold: 0x1010, iron: 0x100F, copper: 0x100E, rusty: 0x1013, magic: 0x1F0F };
      const itemId = KEY_GFX[variant] ?? KEY_GFX.iron;
      const mob = ctx.sender;
      const key = api.game?.mobile?.giveItem?.(mob, {
        itemId,
        name: `${variant} key`,
        movable: true,
      }, { randomGrid: true });
      if (!key) { ctx.state.sendSystemMessage('You have no backpack.'); return; }
      key.key = { keyId };
      ctx.state.sendSystemMessage(`Spawned a ${variant} key (id ${keyId}).`);
    },
  });

  return () => {
    api.commands.unregister('door');
    api.commands.unregister('key');
    api.commands.unregister('doorinfo');
  };
}

/** Walk container children for a key item with matching keyId. */
function userHasKey(api, mob, keyId) {
  const pack = findBackpack(api, mob);
  if (!pack) return false;
  for (const it of childrenOf(api, pack)) {
    if (it.key && (it.key.keyId | 0) === (keyId | 0)) return true;
  }
  return false;
}

/**
 * FAZA BF: auto-detect door facing based on adjacent walls. We scan the
 * four cardinal neighbours via `api.landProvider.staticsAt` (or the
 * runtime door registry — both the static disk wall and a freshly
 * spawned door count as "wall here"). The rule:
 *
 *   wall E + wall W → door panel runs N-S → facing 'east'
 *   wall N + wall S → door panel runs E-W → facing 'south'
 *   wall E only     → door hinge on east → 'east'
 *   wall S only     → door hinge on south → 'south'
 *   nothing → default 'south'
 *
 * Static "wall-ish" detection: any static with FLAG_IMPASSABLE on the
 * neighbour tile counts as a jamb. Doors don't count (FLAG_DOOR is
 * passable per movement.js convention).
 */
function autoDetectFacing(api, mob) {
  const lp = api.landProvider;
  if (!lp || !lp.staticsAt) return null;
  const FLAG_IMPASSABLE = 1 << 6;
  const FLAG_DOOR       = 1 << 29;
  const wallish = (dx, dy) => {
    const arr = lp.staticsAt(mob.map ?? 1, mob.x + dx, mob.y + dy);
    if (!arr || arr.length === 0) return false;
    for (const s of arr) {
      const td = api.tileData?.flagsFor?.(s.tileId) | 0;
      if ((td & FLAG_IMPASSABLE) && !(td & FLAG_DOOR)) return true;
    }
    return false;
  };
  const e = wallish(1, 0);
  const w = wallish(-1, 0);
  const n = wallish(0, -1);
  const s = wallish(0, 1);
  if (e || w) return 'east';
  if (n || s) return 'south';
  return null;
}
