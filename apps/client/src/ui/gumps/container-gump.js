// ContainerGump — pixel-true free placement, mirroring CUO's classic
// container behaviour. Items live at exactly the (gridX, gridY) pixel
// the user dropped them at, inside the bag's interior. No fixed slot
// grid; drops do NOT snap. Server still owns the canonical coords and
// merges stackables on its side via `findMergeableStack`.
//
// Items arriving with no stored coords (loot, [give, vendor purchase
// pre-(0,0) sentinel) are auto-placed via a small left-to-right
// cascade so they don't pile up on the corner.
//
// Wire layout unchanged: (gridX, gridY) carry pixel offsets relative
// to the content area. Server stores them, we round-trip them.

import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { ItemPic } from '../controls/item-pic.js';
import { Button, ButtonAction } from '../controls/button.js';
import { bus } from '../../core/event-bus.js';
import { world } from '../../world/world.js';
import { dragDrop } from '../../managers/drag-drop.js';
import { assets } from '../../assets/asset-manager.js';
import { net } from '../../net/net-client.js';
import { buildSecureTrade, buildPopupMenuRequest } from '../../net/outgoing.js';
import { profile } from '../../managers/profile-manager.js';
import { targetManager } from '../../managers/target-manager.js';
import { Control } from '../control.js';
import { SplitMenuGump } from './split-menu-gump.js';
import { uiManagerInstance } from '../ui-manager-singleton.js';
import { containerManager } from '../../managers/container-manager.js';
import { displayItemIdForAmount } from '../../shared/stack-graphics.js';
import { tooltips } from '../../managers/tooltip-manager.js';

// Slot grid sizing. Cell is 1 px larger than the item box to leave a
// visible gutter between adjacent slots. CONTENT_W/H derived so the
// chrome auto-fits the grid.
const SLOT_W   = 32;
const SLOT_H   = 32;
const ITEM_BOX = 30;
const GRID_COLS = 7;
const GRID_ROWS = 6;
const CONTENT_W = GRID_COLS * SLOT_W;
const CONTENT_H = GRID_ROWS * SLOT_H;
const PAD       = 8;
const HEADER_H  = 28;

// The classic 0x24 packet carries only serial + gump id, not a caption. Use
// the canonical role for container arts whose purpose is unambiguous when
// the container item itself is intentionally hidden from the world mirror.
const CONTAINER_TITLE_BY_GUMP = new Map([
  [0x003C, 'Backpack'],
  [0x003D, 'Bag'],
  [0x003E, 'Pouch'],
  [0x0040, 'Wooden Box'],
  [0x0041, 'Wooden Crate'],
  [0x0043, 'Metal Chest'],
  [0x0048, 'Wooden Chest'],
  [0x004A, 'Bank Box'],
  [0x0009, 'Corpse'],
]);

// Per-gump interior rect — the rectangular area inside each container
// art where items are visually allowed to sit. Mirrors CUO's
// `ContainerManager.cs` `_data` table. Coordinates are LOCAL to the
// container's gump sprite (top-left of the art at 0,0). Containers
// not listed fall back to the full chrome rect (legacy behaviour);
// `_resolveInterior()` also has heuristics for unknown ids. User
// asked to "dostosuj inne kontenery: skrzynia, bank, woreczek" so
// every container art now sets its drop area to the visible bag/bin
// interior, not the wood frame / lid / handles.
const CONTAINER_INTERIOR = {
  // Backpack / cloth bag family ----------------------------------------
  0x003C: { x: 44, y: 65,  w: 142, h: 94 },   // standard backpack
  0x003D: { x: 29, y: 34,  w: 108, h: 94 },   // small bag
  0x003E: { x: 33, y: 36,  w: 109, h: 58 },   // pouch
  0x003F: { x: 19, y: 47,  w: 163, h: 60 },   // square cloth pouch
  0x004A: { x: 18, y: 105, w: 142, h: 65 },   // leather / cloth bag (wide)
  0x004B: { x: 16, y: 51,  w: 159, h: 54 },   // book / journal container
  // Wooden / metal chest + box family ---------------------------------
  0x0040: { x: 16, y: 51,  w: 145, h: 79 },   // wooden box (small)
  0x0041: { x: 35, y: 38,  w: 110, h: 80 },   // small wooden crate
  0x0042: { x: 18, y: 105, w: 162, h: 65 },   // wooden box (large)
  0x0043: { x: 16, y: 51,  w: 168, h: 73 },   // metal chest
  0x0044: { x: 20, y: 10,  w: 170, h: 100 },  // metal locked chest
  0x0048: { x: 16, y: 51,  w: 168, h: 73 },   // wooden chest
  0x0049: { x: 20, y: 10,  w: 150, h: 90 },   // small chest / gold chest
  0x004C: { x: 18, y: 105, w: 162, h: 65 },   // covered chest
  0x004D: { x: 18, y: 105, w: 162, h: 65 },   // drawer
  0x004E: { x: 16, y: 47,  w: 147, h: 60 },   // drawer
  0x004F: { x: 16, y: 47,  w: 147, h: 60 },   // armoire / drawer
  0x0050: { x: 18, y: 105, w: 162, h: 65 },   // chess board container
  0x0051: { x: 18, y: 105, w: 162, h: 65 },   // jewelry / chess
  0x009B: { x: 18, y: 105, w: 145, h: 75 },   // generic chest (custom shards)
  0x09A8: { x: 18, y: 105, w: 127, h: 55 },   // metal chest (gold-rim)
  0x09AA: { x: 18, y: 105, w: 127, h: 55 },   // wooden chest (alt)
  // Bank box — most shards send 0x003C (backpack art), some use 0x09B6
  // (vault). Both rects below match CUO's BankGump bounds.
  0x09B6: { x: 18, y: 30,  w: 175, h: 100 },  // bank-vault style
  // Corpse art — CUO ships 0x0009 as the body container; some shards
  // use 0x009B as a "decay corpse" alt sprite.
  0x0009: { x: 20, y: 85,  w: 104, h: 111 },
};

/** Resolve the interior rect for a given container gump id. Falls
 *  back to a sensible inset when the id isn't in the table — most
 *  unknown server-shipped containers use a roughly-centred interior
 *  with ~16 px chrome padding on all sides. */
function resolveContainerInterior(gumpId, naturalW, naturalH) {
  const explicit = CONTAINER_INTERIOR[gumpId];
  if (explicit) return explicit;
  if (!naturalW || !naturalH) return null;
  const inset = 16;
  return {
    x: inset,
    y: inset,
    w: Math.max(0, naturalW  - inset * 2),
    h: Math.max(0, naturalH - inset * 2),
  };
}

/** Single positioned item entry. Sized to ITEM_BOX × ITEM_BOX, holds the
 *  ItemPic + amount label, and forwards drag/drop to the host gump. */
class ItemEntry extends Control {
  constructor(item) {
    super();
    this.width = ITEM_BOX;
    this.height = ITEM_BOX;
    this.acceptMouseInput = true;
    this.item = item;
    /** @type {ItemPic | null} */
    this.tile = null;
    /** @type {Label | null} */
    this.amount = null;
    /** Slot column / row this entry occupies. Set by the host gump. */
    this.col = 0;
    this.row = 0;
    this._render();
  }

  _render() {
    if (this.tile) { this.tile.dispose(); this.tile = null; }
    if (this.amount) { this.amount.dispose(); this.amount = null; }
    const it = this.item;
    if (!it) return;
    this.width = ITEM_BOX;
    this.height = ITEM_BOX;
    const tile = new ItemPic(it.itemId, {
      hue: it.hue,
      amount: it.amount,
      maxWidth: ITEM_BOX,
      maxHeight: ITEM_BOX,
    });
    tile.setPosition(0, 0);
    tile.acceptMouseInput = false;
    this.add(tile);
    this.tile = tile;
    this._syncAmount();
  }

  _syncAmount() {
    const n = this.item?.amount ?? 1;
    if (n > 1) {
      const text = `×${n}`;
      if (this.amount) {
        this.amount.setText(text);
      } else {
        const lbl = new Label(text, { fontSize: 9, hue: 0xffe0a0, stroke: true });
        lbl.setPosition(0, ITEM_BOX - 12);
        lbl.acceptMouseInput = false;
        this.add(lbl);
        this.amount = lbl;
      }
    } else if (this.amount) {
      this.amount.dispose();
      this.amount = null;
    }
  }

  setItem(item) {
    const prev = this.item;
    const prevDisplay = displayItemIdForAmount(prev?.itemId ?? 0, prev?.amount ?? 1);
    const nextDisplay = displayItemIdForAmount(item?.itemId ?? 0, item?.amount ?? 1);
    const sameArt = !!this.tile && !!prev && !!item
      && prevDisplay === nextDisplay
      && (prev.hue | 0) === (item.hue | 0);
    this.item = item;
    if (sameArt) {
      this._syncAmount();
      return;
    }
    this._render();
  }

  onMouseEnter(e) {
    const it = this.item;
    if (!it?.serial) return;
    // Container packets do not carry a display name. Ask for the full OPL,
    // but give immediate useful feedback from the local item/tiledata name
    // instead of showing nothing until the network round-trip completes.
    const tileName = (assets.tiledata?.statics?.[it.itemId | 0]?.name ?? '').trim();
    const name = (it.name ?? '').trim() || tileName || `item 0x${(it.itemId | 0).toString(16)}`;
    tooltips.showImmediate?.(
      it.serial >>> 0,
      e?.global?.x ?? e?.clientX ?? 0,
      e?.global?.y ?? e?.clientY ?? 0,
      name,
    );
  }

  onMouseLeave() { tooltips.scheduleHide?.(280); }
}

export class ContainerGump extends WindowGump {
  constructor(containerSerial, gumpId = 0x003C, x = 100, y = 100) {
    const containerItem = world.items.get(containerSerial >>> 0);
    const explicitName = String(containerItem?.name ?? '').trim();
    const tileName = containerItem
      ? String(assets.tiledata?.statics?.[containerItem.itemId]?.name ?? '').trim()
      : '';
    const containerName = explicitName || CONTAINER_TITLE_BY_GUMP.get(gumpId) || tileName || 'Container';
    // Prefer the real container art (backpack 0x003C, pouch 0x003D, etc).
    // Size the chrome to the larger of (slot grid + chrome padding) or
    // (natural sprite size) so the bag art shows fully and the slot
    // grid still fits inside. Falls back to the parchment 9-patch when
    // the atlas hasn't loaded the requested gump id yet.
    const natural = assets.gumpSize?.(gumpId);
    const gridW = PAD * 2 + CONTENT_W;
    const gridH = HEADER_H + PAD * 2 + CONTENT_H;
    const gridMode = profile.get?.('containers.layoutMode') === 'grid';
    const useNative = !!natural && !gridMode;
    const useContainerArt = !!natural;
    // When we have native art, render at the sprite's NATURAL size —
    // never stretched. Stretching invalidates the per-gump interior
    // bounds (which are in native pixel space), so a 174-px backpack
    // blown up to 240 wide would put items off the visible bag area.
    // Fallback path (no native art) keeps the parchment 9-patch + grid.
    const w = useNative ? natural.w : gridW;
    const h = useNative ? natural.h : gridH;
    super({
      // Native UO container art already contains the visual chrome.
      // Drawing a generic text title over the backpack reads like a
      // duplicate label and, worse, lands on top of the bag art.
      title: useNative ? '' : containerName.charAt(0).toUpperCase() + containerName.slice(1),
      width:  w,
      height: h,
      x, y,
      // Grid mode keeps its regular slot geometry, but the real bag/chest
      // art remains the backdrop instead of a generic gray "Container".
      backgroundId: useContainerArt ? gumpId : 0x0A28,
      singleSprite: useContainerArt,
    });
    this.containerSerial = containerSerial >>> 0;
    this._gumpId = gumpId;
    this._gridMode = gridMode;
    /** Interior rect inside which items live. Resolved against the
     *  per-gump table; falls back to a centred rect with ~16 px
     *  chrome inset for unknown ids (custom-shard containers etc).
     *  When we couldn't load the native art, use the slot grid. */
    this._interior = useNative
      ? (resolveContainerInterior(gumpId, w, h) ??
         { x: PAD, y: HEADER_H + PAD, w: w - PAD * 2, h: h - HEADER_H - PAD * 2 })
      : { x: PAD, y: HEADER_H + PAD, w: CONTENT_W, h: CONTENT_H };
    /** @type {Map<number, ItemEntry>} item serial → entry control */
    this._byItem = new Map();
    this._contentsSeen = new Set();
    /** Auto-place cascade cursor — incremented on each "no stored
     *  coords" item arrival. Reset on full container refresh. */
    this._autoX = null;
    this._autoY = null;
    // Grid layout is coordinate-backed, never list-order-backed.  Each item
    // keeps an absolute slot derived from its server gridX/gridY so removing
    // gold or equipping a robe cannot compact every item after it.  This is
    // the Tibia-style behaviour requested by the profile option: where the
    // user drops an item is where it remains.
    this._gridSlotBySerial = new Map();
    this._gridScrollRow = 0;
    if (this._gridMode) {
      // A clean Tibia-style slot matrix. It is presentation-only: the UO
      // packet format and server-side gridX/gridY remain unchanged, keeping
      // compatibility with every emulator.
      this._gridDecor = new Graphics();
      this._drawGridDecor();
      this.node.addChildAt(this._gridDecor, Math.min(1, this.node.children.length));
    }
    this.restorePosition();
    // Audit #39 client P2 #9 — `ui.containerScale` profile flag is the
    // CUO `ContainerScale` slider (Options → Gumps & Cursor). Was set
    // but never applied. Clamp to 0.5..2.0 to keep the gump useable.
    try {
      const s = Math.max(0.5, Math.min(2.0, profile.get?.('ui.containerScale') ?? 1.0));
      if (s !== 1.0) this.scale.set(s, s);
    } catch { /* profile optional */ }

    // Weight footer — sums tiledata weight × amount of every child
    // item every refresh. CUO `ContainerGump.cs DrawingState` paints
    // the same readout under the backpack art so the user can see
    // available capacity at a glance. Center it along the bottom edge
    // of the chrome and re-render on every contents / update event.
    this._weightLbl = new Label('weight: -', { fontSize: 11, hue: 0xfff0c0, stroke: true });
    this._weightLbl.acceptMouseInput = false;
    this.add(this._weightLbl);
    this._refreshWeight();

    this._unsubs = [
      bus.on('container:contents',    (info) => this._onContents(info)),
      bus.on('container:item-update', (info) => this._onUpdate(info)),
      bus.on('entity:removed', ({ serial }) => this._removeItem(serial)),
      bus.on('trade:event', (ev) => this._onTradeEvent(ev)),
    ];
    this._tradeMode = false;
    this._ourAccept = false;
    this._theirAccept = false;
  }

  get type() { return 'container'; }
  get positionKey() { return `container:${this.containerSerial}`; }

  dispose() {
    // Audit #46 P1 — remember per-graphic gump position so re-opening
    // the same container type lands where the user last placed it.
    // Without this `_posMemo` Map stayed permanently empty (rev.5
    // wired the API but no caller invoked `rememberPosition`).
    try {
      if (Number.isFinite(this._gumpId)) {
        containerManager.rememberPosition(this._gumpId, this.x, this.y);
      }
    } catch { /* ignore */ }
    for (const u of this._unsubs) u();
    super.dispose();
  }

  /** Auto-place cascade for items that arrive with no stored coords
   *  (loot, [give, vendor purchase). CUO uses a small left-to-right
   *  walk inside the bag interior; we approximate with a SLOT_W step
   *  per call so a stack of fresh loot doesn't pile up on one pixel.
   *  Walks within the per-gump interior rect (CONTAINER_INTERIOR). */
  _autoPlaceCursor() {
    const inset = 4;
    const maxX = Math.max(inset, this._interior.w - ITEM_BOX - inset);
    const maxY = Math.max(inset, this._interior.h - ITEM_BOX - inset);
    if (this._autoX == null) { this._autoX = inset; this._autoY = inset; }
    const r = { x: this._autoX, y: this._autoY };
    this._autoX += SLOT_W;
    if (this._autoX > maxX) {
      this._autoX = inset;
      this._autoY += SLOT_H;
      if (this._autoY > maxY) this._autoY = inset;
    }
    return r;
  }

  /** Convert gump-local pixel coords (where the user clicked inside
   *  the gump) to interior-local gridX/gridY values for the server.
   *  Clamped to the visible interior so a click on the flap or
   *  handles still snaps inside the bag. */
  _gridForPixel(lx, ly) {
    const ix = (lx | 0) - this._interior.x;
    const iy = (ly | 0) - this._interior.y;
    if (this._gridMode) {
      const col = Math.max(0, Math.min(GRID_COLS - 1, Math.floor(ix / SLOT_W)));
      const visibleRow = Math.max(0, Math.min(GRID_ROWS - 1, Math.floor(iy / SLOT_H)));
      const row = visibleRow + (this._gridScrollRow | 0);
      return { gx: col * SLOT_W, gy: row * SLOT_H };
    }
    const gx = Math.max(0, Math.min(Math.max(0, this._interior.w - ITEM_BOX), ix));
    const gy = Math.max(0, Math.min(Math.max(0, this._interior.h - ITEM_BOX), iy));
    return { gx, gy };
  }

  _placeEntryAtPixel(entry, gx, gy) {
    entry.gridX = gx;
    entry.gridY = gy;
    entry.setPosition(this._interior.x + gx, this._interior.y + gy);
  }

  _positionEntryAtPixel(entry, gx, gy) {
    entry.setPosition(this._interior.x + gx, this._interior.y + gy);
  }

  _preferredGridSlot(it) {
    const col = Math.max(0, Math.min(GRID_COLS - 1, Math.floor(Math.max(0, it.gridX | 0) / SLOT_W)));
    const row = Math.max(0, Math.floor(Math.max(0, it.gridY | 0) / SLOT_H));
    return row * GRID_COLS + col;
  }

  _assignGridSlot(it) {
    const serial = it.serial >>> 0;
    const occupied = new Set();
    for (const [otherSerial, slot] of this._gridSlotBySerial) {
      if ((otherSerial >>> 0) !== serial) occupied.add(slot | 0);
    }
    let slot = this._preferredGridSlot(it);
    while (occupied.has(slot)) slot++;
    this._gridSlotBySerial.set(serial, slot);
    return slot;
  }

  _gridTotalRows() {
    let maxSlot = -1;
    for (const slot of this._gridSlotBySerial.values()) maxSlot = Math.max(maxSlot, slot | 0);
    return Math.max(GRID_ROWS, Math.floor(maxSlot / GRID_COLS) + 1);
  }

  _wireEntry(entry) {
    // Item RMB is an intentional context-menu gesture, not the generic
    // "close this gump" gesture. UIManager checks this marker before closing
    // the parent window.
    entry.contextMenuOnRightClick = true;
    entry.onDragStart = (btn) => {
      if (btn !== 0 || !entry.item || dragDrop.isHolding()) return;
      const layer = assets.tiledata?.statics?.[entry.item.itemId]?.layer | 0;
      // Shift-drag on a stackable (amount > 1) pops the CUO
      // `StackedSelectionGump` so the user can lift a partial
      // amount. The split menu calls dragDrop.tryLift({ amount })
      // on accept; cancel keeps the whole stack untouched.
      const ui = uiManagerInstance.get();
      const pressed = ui?._pressed;
      const isStackable = (entry.item.amount | 0) > 1;
      if (isStackable && pressed?.shift) {
        const it = entry.item;
        const gump = new SplitMenuGump({
          itemId: it.itemId,
          maxAmount: it.amount | 0,
          onPick: (amount) => {
            const n = Math.max(1, Math.min(it.amount | 0, amount | 0));
            dragDrop.tryLift({
              serial: it.serial, itemId: it.itemId,
              hue: it.hue, amount: n, layer,
            });
          },
        });
        ui.addGump(gump);
        return;
      }
      dragDrop.tryLift({
        serial: entry.item.serial, itemId: entry.item.itemId,
        hue: entry.item.hue, amount: entry.item.amount, layer,
      });
    };
    // Click-on-item while holding = drop ONTO this item's pixel coord.
    // Server will auto-merge if the held item is a stackable of the
    // same id+hue.
    entry.onClick = (btn) => {
      if (btn === 2 && entry.item?.serial) {
        net.send(buildPopupMenuRequest(entry.item.serial >>> 0));
        return;
      }
      if (btn !== 0) return;
      // While a target cursor is active, route a single click on this
      // item to `pickEntity` so commands like `[itemgump` can target
      // items inside containers. Was: only the drop / drag path ran,
      // so clicking on a sword in a pack while in target mode did
      // nothing. CUO's `ItemGumpDraggable.OnMouseClick` does the same
      // short-circuit when `TargetManager.IsTargeting` is true.
      if (targetManager?.active && entry.item?.serial && !dragDrop.canDrop()) {
        targetManager.pickEntity({
          serial: entry.item.serial >>> 0,
          graphic: entry.item.itemId | 0,
        });
        return;
      }
      if (!dragDrop.canDrop()) return;
      this._dropAtPixel(entry.gridX, entry.gridY);
    };
    entry.onDrop = (btn) => {
      if (btn !== 0 || !dragDrop.isHolding()) return;
      this._dropAtPixel(entry.gridX, entry.gridY);
    };
    entry.onDoubleClick = (btn) => {
      if (btn !== 0 || !entry.item) return;
      // Audit #39 client P2 #9 — CUO option `DoubleClickToLootInsideContainers`
      // re-routes a double-click on a nested item to "move to my
      // backpack" instead of opening it. Useful when looting a corpse
      // or stacked chest. Was: flag exposed in options but no handler
      // checked it.
      const wantLoot = !!profile.get?.('ui.doubleClickToLootInsideContainers');
      const pack = world.player?.equipment?.get?.(21);
      if (wantLoot && pack && pack.serial !== this.containerSerial && !dragDrop.isHolding()) {
        if (dragDrop.tryLift({
          serial: entry.item.serial,
          itemId: entry.item.itemId,
          hue: entry.item.hue ?? 0,
          amount: entry.item.amount ?? 1,
        })) {
          dragDrop.dropToContainer(pack.serial >>> 0, 0, 0, 0);
          return;
        }
      }
      bus.emit('item:use', { serial: entry.item.serial });
    };
  }

  _dropAtPixel(gx, gy) {
    dragDrop.dropToContainer(this.containerSerial, gx | 0, gy | 0, 0);
  }

  _addOrUpdate(it, posPref = null) {
    let entry = this._byItem.get(it.serial >>> 0);
    if (entry) {
      entry.setItem(it);
    } else {
      entry = new ItemEntry(it);
      this._wireEntry(entry);
      this.add(entry);
      this._byItem.set(it.serial >>> 0, entry);
    }
    if (this._gridMode) {
      this._assignGridSlot(it);
      this._reflowGrid();
      return;
    }
    let { gx, gy } = posPref ?? { gx: it.gridX | 0, gy: it.gridY | 0 };
    // Items with no stored coords (gridX = gridY = 0) get the
    // auto-place cascade so loot doesn't pile up at the corner.
    if (!gx && !gy) {
      const r = this._autoPlaceCursor();
      gx = r.x; gy = r.y;
    }
    // Clamp to interior so a corrupted/legacy gridX outside the bag
    // bounds still renders inside the visible area.
    const maxX = Math.max(0, this._interior.w - ITEM_BOX);
    const maxY = Math.max(0, this._interior.h - ITEM_BOX);
    gx = Math.max(0, Math.min(maxX, gx));
    gy = Math.max(0, Math.min(maxY, gy));
    this._placeEntryAtPixel(entry, gx, gy);
  }

  _onContents({ containerSerial, items }) {
    if (containerSerial !== this.containerSerial) return;
    const seen = this._contentsSeen;
    seen.clear();
    this._autoX = null; this._autoY = null;     // reset auto-place cascade
    if (this._gridMode) {
      // Rebuild from persisted packet coordinates, not packet ordering.
      this._gridSlotBySerial.clear();
      // A deterministic serial tiebreak only matters for legacy items that
      // occupy the exact same coordinate; non-colliding user placement is
      // never reordered.
      for (const it of [...items].sort((a, b) => (a.serial >>> 0) - (b.serial >>> 0))) {
        this._assignGridSlot(it);
      }
    }
    for (const it of items) {
      const serial = it.serial >>> 0;
      seen.add(serial);
      this._addOrUpdate(it);
      const entry = this._byItem.get(serial);
      if (entry?.parent === this && this.children[this.children.length - 1] !== entry) {
        this.remove(entry);
        this.add(entry);
      }
    }
    for (const [serial, entry] of this._byItem) {
      if (seen.has(serial)) continue;
      entry.dispose();
      this._byItem.delete(serial);
    }
    seen.clear();
    if (this._gridMode) this._reflowGrid();
    this._refreshWeight();
  }

  _onUpdate(it) {
    if ((it.parent >>> 0) !== this.containerSerial) return;
    this._addOrUpdate(it);
    if (this._gridMode) this._reflowGrid();
    this._refreshWeight();
  }

  _removeItem(serial) {
    const entry = this._byItem.get(serial >>> 0);
    if (!entry) return;
    entry.dispose();
    this._byItem.delete(serial >>> 0);
    if (this._gridMode) {
      this._gridSlotBySerial.delete(serial >>> 0);
      this._reflowGrid();
    }
    this._refreshWeight();
  }

  _reflowGrid() {
    if (!this._gridMode) return;
    const totalRows = this._gridTotalRows();
    const maxScroll = Math.max(0, totalRows - GRID_ROWS);
    this._gridScrollRow = Math.max(0, Math.min(maxScroll, this._gridScrollRow | 0));
    const firstVisible = this._gridScrollRow * GRID_COLS;
    const lastVisible = firstVisible + GRID_COLS * GRID_ROWS;
    const placed = [...this._gridSlotBySerial.entries()].sort((a, b) => a[1] - b[1]);
    for (const [serial, absolute] of placed) {
      const entry = this._byItem.get(serial >>> 0);
      if (!entry) continue;
      const visible = absolute >= firstVisible && absolute < lastVisible;
      entry.visible = visible;
      entry.node.visible = visible;
      if (!visible) continue;
      const local = absolute - firstVisible;
      const col = local % GRID_COLS;
      const row = Math.floor(local / GRID_COLS);
      const absoluteRow = Math.floor(absolute / GRID_COLS);
      entry.gridX = col * SLOT_W;
      entry.gridY = absoluteRow * SLOT_H;
      this._positionEntryAtPixel(entry, col * SLOT_W, row * SLOT_H);
    }
    this._drawGridDecor();
  }

  _drawGridDecor() {
    if (!this._gridDecor) return;
    const g = this._gridDecor;
    g.clear();
    for (let row = 0; row < GRID_ROWS; row++) {
      for (let col = 0; col < GRID_COLS; col++) {
        g.roundRect(
          this._interior.x + col * SLOT_W,
          this._interior.y + row * SLOT_H,
          ITEM_BOX, ITEM_BOX, 3,
        ).fill({ color: 0x0b1017, alpha: 0.58 })
          .stroke({ width: 1, color: 0x5b4b31, alpha: 0.76 });
      }
    }
    const totalRows = this._gridTotalRows();
    if (totalRows <= GRID_ROWS) return;
    const trackX = this._interior.x + this._interior.w - 5;
    const trackY = this._interior.y + 2;
    const trackH = this._interior.h - 4;
    const thumbH = Math.max(18, Math.round(trackH * GRID_ROWS / totalRows));
    const maxScroll = totalRows - GRID_ROWS;
    const thumbY = trackY + Math.round((trackH - thumbH) * (this._gridScrollRow / maxScroll));
    g.roundRect(trackX, trackY, 4, trackH, 2).fill({ color: 0x05070a, alpha: 0.8 });
    g.roundRect(trackX, thumbY, 4, thumbH, 2).fill({ color: 0xc59b47, alpha: 0.95 });
  }

  onWheel(deltaY) {
    if (!this._gridMode) return;
    const direction = deltaY > 0 ? 1 : -1;
    const totalRows = this._gridTotalRows();
    const next = Math.max(0, Math.min(totalRows - GRID_ROWS, this._gridScrollRow + direction));
    if (next === this._gridScrollRow) return;
    tooltips.hide();
    this._gridScrollRow = next;
    this._reflowGrid();
  }

  /** Sum tiledata.weight × amount of every item parented to this
   *  container. CUO renders the same total. We don't have a per-bag
   *  capacity cap on the wire so just show the running weight. */
  _refreshWeight() {
    if (!this._weightLbl) return;
    let total = 0;
    for (const e of this._byItem.values()) {
      const it = e.item;
      if (!it) continue;
      const w = assets.tiledata?.statics?.[it.itemId | 0]?.weight | 0;
      total += w * (it.amount || 1);
    }
    this._weightLbl.setText(`weight: ${total}`);
    this._positionWeightLabel();
  }

  _positionWeightLabel() {
    if (!this._weightLbl) return;
    const w = this._weightLbl.width || String(this._weightLbl._cachedText ?? '').length * 6;
    const x = Math.max(4, ((this.width - w) / 2) | 0);
    this._weightLbl.setPosition(x, Math.max(0, this.height - 14));
  }

  /** Background drop — held item lands at the EXACT pixel under the
   *  cursor inside the bag interior (CUO-style free placement). Server
   *  merges if the held item is stackable + same itemId/hue as
   *  something already in the container; otherwise it stores the pixel
   *  coords verbatim so the next open re-renders at the same spot. */
  onClick(btn, lx, ly) {
    if (btn !== 0 || !dragDrop.isHolding()) return;
    const { gx, gy } = this._gridForPixel(lx, ly);
    this._dropAtPixel(gx, gy);
  }

  /** Drag-and-drop drop landing on the gump body (between/around item
   *  entries). Without this hook, UIManager walks up the parent chain
   *  looking for `onDrop`, finds none, then emits `drag:dropped-on-world`
   *  → the item goes to the player's feet. Marcin reported items
   *  "disappearing" when re-arranged inside the backpack — they were
   *  actually being dropped on the ground at his position. Pixel-true
   *  drop matches CUO behaviour. */
  onDrop(btn, lx, ly) {
    if (btn !== 0 || !dragDrop.isHolding()) return;
    const { gx, gy } = this._gridForPixel(lx, ly);
    this._dropAtPixel(gx, gy);
  }

  // ---- Trade mode (0x6F) -------------------------------------------------

  _onTradeEvent(ev) {
    if (!ev) return;
    if (ev.action === 0x00 && ev.containerSerial === this.containerSerial) {
      this._tradeMode = true;
      this._partnerName = ev.partnerName ?? '';
      this._renderTradeButtons();
      this.setTitle(`Trade with ${this._partnerName || 'partner'}`);
    } else if (ev.action === 0x02 && ev.containerSerial === this.containerSerial) {
      this._ourAccept   = !!ev.ourAccept;
      this._theirAccept = !!ev.otherAccept;
      this._refreshTradeAcceptVisuals();
    } else if (ev.action === 0x01 && ev.containerSerial === this.containerSerial) {
      this.close();
    }
  }

  _renderTradeButtons() {
    if (this._acceptBtn) return;
    this._acceptBtn = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 80, height: 22,
      label: 'Accept', action: ButtonAction.Activate,
    });
    this._cancelBtn = new Button({
      normalGumpId: 0x0483, pressedGumpId: 0x0484,
      width: 80, height: 22,
      label: 'Cancel', action: ButtonAction.Activate,
    });
    this._acceptLabel = new Label('You: ✗  Them: ✗', { fontSize: 11, hue: 0xfff0c0 });
    const yBase = HEADER_H + PAD * 2 + CONTENT_H + 4;
    this._acceptBtn.setPosition(PAD, yBase);
    this._cancelBtn.setPosition(PAD + 90, yBase);
    this._acceptLabel.setPosition(PAD, yBase + 26);
    this.add(this._acceptLabel);
    this.add(this._acceptBtn);
    this.add(this._cancelBtn);
    this._acceptBtn.onClick = () => {
      this._ourAccept = !this._ourAccept;
      net.send(buildSecureTrade({
        action: 0x02, serial: this.containerSerial,
        accept: this._ourAccept,
      }));
      this._refreshTradeAcceptVisuals();
    };
    this._cancelBtn.onClick = () => {
      net.send(buildSecureTrade({
        action: 0x01, serial: this.containerSerial,
        accept: false,
      }));
      this.close();
    };
    this.setSize(PAD * 2 + CONTENT_W, yBase + 50);
  }

  _refreshTradeAcceptVisuals() {
    if (!this._acceptLabel) return;
    const y = this._ourAccept   ? '✓' : '✗';
    const t = this._theirAccept ? '✓' : '✗';
    this._acceptLabel.setText(`You: ${y}  Them: ${t}`);
  }
}
