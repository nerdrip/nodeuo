// PaperdollGump — native UO paperdoll. Mirrors ClassicUO's
// Game/UI/Gumps/PaperDollGump.cs at MVP scope.
//
// Render stack (bottom -> top):
//   1. Background body image (gump 0x000C male / 0x000D female / etc.)
//   2. One paperdoll-equipment gump per equipped layer (gumpId from
//      Equipconv.def -> `eq.gump`, fallback to `itemId + 50000`)
//   3. Title (mob name)
//   4. Close button
//
// Drag-drop: clicking a slot lifts the equipped item (or drops the held
// item into that layer if the player is currently holding something).

import { Gump } from '../gump.js';
import { GumpPic } from '../controls/gump-pic.js';
import { PaperDollInteractable } from '../controls/paper-doll-interactable.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { bus } from '../../core/event-bus.js';
import { world } from '../../world/world.js';
import { dragDrop } from '../../managers/drag-drop.js';
import { targetManager } from '../../managers/target-manager.js';
import { assets } from '../../assets/asset-manager.js';
import { net } from '../../net/net-client.js';
import { buildProfileRequest } from '../../net/outgoing.js';
// Canonical paperdoll draw order lives in /shared/layers.js so the
// admin editor (mobile inspector → paperdoll preview) renders the same
// stacking order without re-authoring the list. PAPERDOLL_DRAW_ORDER
// covers 22 layers; Talisman (9) used to sit at the end of our local
// copy — preserved here by appending it explicitly.
import { PAPERDOLL_DRAW_ORDER, LAYER_TALISMAN, LAYER_BACKPACK } from '../../shared/layers.js';

// Local: append Talisman at the end so the existing "talisman draws on
// top of chest" behaviour is preserved exactly. The shared order omits
// it deliberately (CUO's PaperDollInteractable doesn't include it in
// the default loop — talisman is a post-AOS slot).
const PAPERDOLL_LAYERS = [...PAPERDOLL_DRAW_ORDER, LAYER_TALISMAN];

// CUO paperdoll is composed in two passes (PaperDollGump.cs:121 +
// PaperDollInteractable.cs:125-168):
//   1. Frame  → 0x07D0 player / 0x07D1 other  (262×324 parchment+border)
//   2. Body   → 0x000C male / 0x000D female   (semi-naked silhouette,
//                                               drawn at offset 8,19)
//   3. Equipment gumps on top of the body
//   4. Buttons (Options / Logout / Journal / Skills / etc.)
// The frame alone is just an empty parchment — without (2) you see the
// brass border with nothing inside.
function pickFrameGump(mob) {
  return (mob?.serial === world.player?.serial) ? 0x07D0 : 0x07D1;
}
function pickBodyGump(mob) {
  // Female human (0x191/0x193) → 0x000D, otherwise 0x000C.
  const g = mob?.body | 0;
  if (g === 0x191 || g === 0x193) return 0x000D;
  return 0x000C;
}
const BODY_OFFSET_X = 8;
const BODY_OFFSET_Y = 19;

// Spellbook art ids — duplicated from the server's SPELLBOOK_OFFSETS
// table (apps/server/src/net/handlers.js). The server tags
// `item.spellbook = true` on these but that flag does NOT ride the
// wire (no equipUpdate field for it), so the paperdoll has to
// recognise spellbooks by graphic alone. Without this set the
// "staff (2H) + spellbook (1H) coexist" case fell through to the
// generic 1H/2H mutex rule and the spellbook vanished from the gump.
const SPELLBOOK_ITEM_IDS = new Set([
  0x0EFA, // Magery
  0x2253, // Necromancy
  0x2252, // Chivalry / paladin (legacy id)
  0x238C, // Bushido
  0x23A0, // Ninjitsu
  0x2D50, // Spellweaving
  0x2D9D, // Mysticism
]);

// ClassicUO Mobile.IsCovered. Coverage is item-art-specific: a normal robe
// does not blindly delete shirt, pants, skirt and tunic from the paperdoll.
// The previous broad layer set made valid garments disappear and caused the
// paperdoll to disagree with the animated world mobile.
function isLayerCovered(mob, layer) {
  const get = (l) => mob?.equipment?.get?.(l);
  const robe = get(22);
  const robeId = robe?.itemId | 0;
  const pants = get(4);
  const pantsId = pants?.itemId | 0;
  if (layer === 3) {
    return !!get(24)
      || pantsId === 0x1411
      || pantsId === 0x0513 || pantsId === 0x0514
      || robeId === 0x0504;
  }
  if (layer === 4) {
    if (get(24) || robeId === 0x0504) return true;
    if (pantsId === 0x01EB || pantsId === 0x03E5 || pantsId === 0x03EB) {
      const skirtId = get(23)?.itemId | 0;
      if (skirtId && skirtId !== 0x01C7 && skirtId !== 0x01E4) return true;
      if (robeId && robeId !== 0x0229 && (robeId <= 0x04E7 || robeId > 0x04EB)) return true;
    }
  }
  if (layer === 17 && (get(17)?.itemId | 0) === 0x0238) {
    return !!robeId && robeId !== 0x9985 && robeId !== 0x9986 && robeId !== 0xA412;
  }
  if (layer === 13) {
    if (robeId && ![0x9985, 0x9986, 0xA412, 0xA2CA].includes(robeId)) return true;
    const tunicId = get(17)?.itemId | 0;
    const torsoId = get(13)?.itemId | 0;
    return !!tunicId && tunicId !== 0x1541 && tunicId !== 0x1542
      && (torsoId === 0x782A || torsoId === 0x782B);
  }
  if (layer === 19) {
    return !!robeId && ![0x9985, 0x9986, 0xA412].includes(robeId);
  }
  if ((layer === 6 || layer === 11) && robeId) {
    if (robeId > 0x3173) return robeId === 0x4B9D || robeId === 0x7816;
    if (robeId <= 0x2687) return robeId >= 0x204E;
    return robeId === 0x2FB9 || robeId === 0x3173;
  }
  return false;
}

/** Resolve the paperdoll equipment gump id for a given (body, itemId).
 *  Mirrors the inline lookup `_refresh` already does — extracted so the
 *  hover-preview overlay can use the exact same fallback chain. */
function resolveEquipGumpId(body, itemId) {
  const isFemale = (body === 0x191 || body === 0x193);
  const renderBody = assets.mobileRenderBody?.(body) ?? body;
  const gMap = assets.mobilesAtlas?.equipConv?.[renderBody]?.[itemId]
    ?? assets.mobilesAtlas?.equipConv?.[body]?.[itemId];
  let animId = gMap?.gump | 0;
  // Equipconv may store either the base wearable animation id or a complete
  // male/female paperdoll gump id. CUO normalises the latter back to the base
  // before probing the requested sex, rather than drawing it as-is.
  if (animId > 50000) animId -= animId >= 60000 ? 60000 : 50000;
  if (animId <= 0) animId = assets.tiledata?.statics?.[itemId]?.animId | 0;
  if (animId > 0) {
    const femaleId = animId + 60000;
    const maleId   = animId + 50000;
    const tiles = assets.gumpAtlas?.tiles;
    if (isFemale && tiles?.[femaleId]) return femaleId;
    if (tiles?.[maleId]) return maleId;
    return 0;
  }
  const legacyId = itemId + 50000;
  return assets.gumpAtlas?.tiles?.[legacyId] ? legacyId : 0;
}

export class PaperdollGump extends Gump {
  constructor(mobileSerial, opts = {}) {
    super();
    this.mobileSerial = mobileSerial >>> 0;
    this.canMove = true;
    this.canClose = true;
    this.setPosition(opts.x ?? 80, opts.y ?? 80);
    // Native gump 0x07D0 / 0x07D1 ships at 262×324. We don't stretch.
    this.setSize(262, 324);
    // Restore the user's last-known paperdoll position (per-mobile if
    // a mob serial was supplied, else global).
    this.restorePosition();
    /** @type {Map<number, GumpPic>} */
    this._slots = new Map();
    this._equipmentSerials = new Set();

    const mob = world.mobiles.get(this.mobileSerial);
    // Frame (parchment + brass border + empty centre).
    this._frame = new GumpPic(pickFrameGump(mob), { width: 262, height: 324 });
    this._frame.setPosition(0, 0);
    this._frame.acceptMouseInput = true;
    this._frame.isDragHandle = true;
    this.add(this._frame);
    // Body silhouette inside the frame.
    this._body = new GumpPic(pickBodyGump(mob), { hue: mob?.hue ?? 0 });
    this._body.setPosition(BODY_OFFSET_X, BODY_OFFSET_Y);
    this._body.acceptMouseInput = true;
    // Equip-on-drop helper. Used by both the body silhouette and the
    // frame so the user can drop the held item ANYWHERE on the
    // paperdoll — body, parchment border, behind a half-transparent
    // overlay — and still get a clean equip. The user reported that
    // "items can be taken off but not put back": the body silhouette
    // alone caught most clicks, but with pixel-check on the equipment
    // overlays a click that landed on a transparent pixel of, say,
    // pants would fall through to the FRAME (which had no handler) and
    // do nothing. Wiring the same handler on both surfaces makes drop
    // work no matter where on the paperdoll you click.
    const equipFromHeld = this._equipFromHeld = () => {
      if (!dragDrop.isHolding()) return;
      // Audit #38 P3 #9 — CUO `PaperDollGump` only routes equip-on-drop
      // when the paperdoll's serial matches `World.Player`. Other-mob
      // paperdolls (opened via "Open Paperdoll" context menu on a
      // player / NPC) shouldn't auto-equip; server rejects but the
      // local visual feedback (held cursor cleared) was misleading.
      if (this.mobileSerial !== world.player?.serial) {
        bus.emit('chat:system', { text: 'You cannot equip items on someone else.' });
        return;
      }
      const held = dragDrop.held;
      // Layer resolution priority:
      //   1. dragDrop.held.layer  — set by the lift caller when known
      //      (paperdoll re-equip remembers the originating slot).
      //   2. tiledata.statics[itemId].layer — canonical UO mapping
      //      from art id to wear-slot. This is the path for clothes
      //      lifted out of a backpack for the first time.
      //   3. world.items[serial].layer — last-resort (item still
      //      tracked locally even though it left a container).
      let layer = (held.layer | 0)
               || (assets.tiledata?.statics?.[held.itemId]?.layer | 0);
      if (!layer) {
        const wi = world.items.get(held.serial >>> 0);
        layer = (wi?.layer | 0);
      }
      if (layer > 0 && layer !== 21) {
        dragDrop.dropToEquip(this.mobileSerial, layer);
      } else {
        bus.emit('chat:system', { text: `Cannot determine equip slot for itemId 0x${(held.itemId | 0).toString(16)}.` });
      }
    };
    this._body.onClick = equipFromHeld;
    // Audit rev.4 P2 — skin-hue picker via dbl-click. CUO
    // `PaperDollInteractable` opens a hue dialog on body double-click;
    // we provide the same via a small DOM picker. Only the local
    // player's paperdoll responds (CUO behavior).
    this._body.onDoubleClick = () => {
      if (this.mobileSerial !== world.player?.serial) return;
      this._openSkinHuePicker();
    };
    // Drag-from-pack drop: when the user mouse-downs on an item in a
    // container, drags onto the body, and releases — UIManager fires
    // `onDrop` on the body. equipFromHeld is the same handler as
    // click-to-drop, so both gestures work.
    this._body.onDrop  = equipFromHeld;
    // Gump-level fallback — UIManager walks the parent chain looking
    // for `onDrop` when the directly-hit control has none. Equipment
    // slot GumpPics (the per-layer overlays added in `_refresh`) DON'T
    // set `onDrop`, so a drop landing exactly on a worn item (e.g.
    // existing robe sprite) would fall through to the gump → no onDrop
    // → world drop. User report 2026-05-19 "upuściłem item na paperdolla
    // i mi nie wrócił do plecaka". Mounting equipFromHeld at the gump
    // root means any drop inside the paperdoll bounds routes to equip,
    // and a failed equip bounces via the server's 0x27 PickUpRejected.
    this.onDrop = equipFromHeld;
    // Hover-preview hook — ghost overlay shows the user where the
    // currently-held item would land if they release here. See the
    // `_showPreview / _hidePreview` pair below.
    this._body.onMouseEnter = () => this._showPreview();
    this._body.onMouseLeave = () => this._hidePreview();
    this.add(this._body);
    // Frame absorbs equip drops too (see comment above). Note: the
    // frame is also `isDragHandle = true`, so a normal mouse-drag still
    // moves the gump — onClick only fires for short clicks (no drag),
    // which matches the "I want to drop here" intent.
    this._frame.onClick = equipFromHeld;
    this._frame.onDrop  = equipFromHeld;
    this._frame.onMouseEnter = () => this._showPreview();
    this._frame.onMouseLeave = () => this._hidePreview();

    // Name strip — CUO `PaperDollGump.cs` constants `X_NAME=39, Y_NAME=262`.
    // Sits at the BOTTOM of the parchment under the body silhouette,
    // not at the top. The earlier (40, 4) position painted the name
    // CUO PaperDollGump.cs reserves a parchment strip at the bottom of
    // the 262×324 frame for the character name. Position matches the
    // canonical y=308 strip; black ink on parchment so the text reads
    // against the cream background instead of the title-bar yellow we
    // were using before (which vanished into the parchment hue).
    // Cream label with a soft black stroke — readable against both
    // the cream parchment strip on player paperdolls (0x07D0) AND the
    // darker NPC frame (0x07D1). Earlier dark-ink-no-stroke version
    // vanished into the parchment for unhued characters and Marcin
    // saw "no name". Position centred on the bottom strip.
    this._title = new Label(mob?.name || '', {
      fontSize: 12, hue: 0xfff0c0, stroke: true,
    });
    // Name strip — the parchment scroll graphic ends about y=295 in
    // the 262×324 frame, so the text needs to sit inside the strip
    // itself, not on its bottom rim. y=280 lands the baseline in the
    // visible parchment area.
    this._title.setPosition(70, 280);
    this._title.acceptMouseInput = true;
    this._title.isDragHandle = true;
    this.add(this._title);

    // Close-X removed — RMB on the gump closes it (UIManager dispatch,
    // gump.canCloseWithRMB defaults to true). The 0x0837 sprite was
    // missing from the atlas on Marcin's install and showed as a
    // shimmer "blue diamond"; dropping the chrome makes the paperdoll
    // read cleaner and matches the rest of the gumps now.

    // Side button strip — CUO PaperDollGump.cs:121-249. Each gump id
    // triple is (normal, pressed, hover) but we only use the first two.
    // Local action: dispatch the right `macro:gump` event so the same
    // hotkey + button paths share one toggle implementation.
    const SIDE_X = 185;
    const sideY = (slot) => 44 + 27 * slot;
    this._sideButtons = [];
    if (this.mobileSerial === world.player?.serial) {
      const make = (slot, normal, pressed, action) => {
        const btn = new Button({ normalGumpId: normal, pressedGumpId: pressed,
                                 buttonId: 0, action: ButtonAction.Activate });
        btn.setPosition(SIDE_X, sideY(slot));
        btn.onClick = action;
        this.add(btn);
        this._sideButtons.push(btn);
      };
      make(0, 0x07EF, 0x07F0, () => bus.emit('macro:gump', { kind: 'help' }));
      make(1, 0x07D6, 0x07D7, () => bus.emit('macro:gump', { kind: 'options' }));
      make(2, 0x07D9, 0x07DA, () => bus.emit('macro:gump', { kind: 'logout' }));
      make(3, 0x07DC, 0x07DD, () => bus.emit('macro:gump', { kind: 'journal' }));
      make(4, 0x07DF, 0x07E0, () => bus.emit('macro:gump', { kind: 'skills' }));
      // Slot 5: Character Profile — CUO `PaperDollGump.cs:349-354`
      // double-click calls `GameActions.RequestProfile(LocalSerial)`
      // → 0xB8 read request. Server replies with 0xB8 carrying title +
      // body text; existing `profile:open` handler spawns ProfileGump.
      // Audit #32 P2 #5: was a chat-overlay emit which silently
      // dropped the canonical flow. Now actually sends the request.
      make(5, 0x07E2, 0x07E3, () => {
        try { net.send(buildProfileRequest(this.mobileSerial >>> 0)); }
        catch { /* socket transient */ }
      });
      make(7, 0x07EB, 0x07EC, () => bus.emit('macro:gump', { kind: 'status' }));
      // Slot 6: war/peace toggle (CUO PaperdollGump.cs:199 PeaceWarToggle).
      // Sprite swap reflects the current war-mode state: 0x07E5 idle ←→
      // 0x07E8 active. Uses the same path as the F key macro.
      // Mobile field is `warMode` (set from FLAG_WARMODE), not
      // `inWarMode` — initial port read the wrong field so the button
      // always rendered the peace sprite.
      const inWar = !!world.mobiles?.get?.(this.mobileSerial)?.warMode;
      // Audit #36 P2 #8 — CUO PaperDollGump.cs:21-22 defines Over
      // gump ids: peace 0x07E7, war 0x07EA. Wired here as a hint
      // for the Button class; if it doesn't read overGumpId yet, the
      // field is benign and harmless. Same hint applies to all side
      // buttons but the war/peace is the most-clicked one.
      const warBtn = new Button({
        normalGumpId: inWar ? 0x07E8 : 0x07E5,
        pressedGumpId: inWar ? 0x07E9 : 0x07E6,
        overGumpId: inWar ? 0x07EA : 0x07E7,
        buttonId: 0, action: ButtonAction.Activate,
      });
      warBtn.setPosition(SIDE_X, sideY(6));
      warBtn.onClick = () => bus.emit('macro:warmode');
      this.add(warBtn);
      this._sideButtons.push(warBtn);
      this._warButton = warBtn;
      // Virtue badge — CUO `PaperDollGump.cs:258` places gump 0x0071 at
      // (80, 4) at the TOP of the paperdoll.
      const virtueBadge = new GumpPic(0x0071);
      virtueBadge.setPosition(80, 4);
      virtueBadge.node.eventMode = 'static';
      virtueBadge.node.on('pointertap', () => bus.emit('macro:gump', { kind: 'virtues' }));
      this.add(virtueBadge);
      // The legacy 0x07D2 scroll pair is intentionally omitted. In this
      // asset set it is a fixed 19×51 strip that some compressed-atlas
      // backends reported with the page height, stretching a decorative
      // scroll over the whole paperdoll (the tall column in the screenshot).
      // Profile and party remain fully reachable from the labelled side
      // buttons/top bar, so removing duplicate decoration loses no action.
    }

    this._unsubs = [
      bus.on('mobile:incoming', (m) => { if (m.serial === this.mobileSerial) this._refresh(); }),
      bus.on('mobile:update',   (m) => { if (m.serial === this.mobileSerial) this._refresh(); }),
      // Refresh war/peace button sprite when the mode flips. Without
      // this listener the button stayed locked to whichever sprite was
      // active when the paperdoll was first opened.
      bus.on('player:warmode', ({ warMode }) => {
        if (this.mobileSerial !== world.player?.serial || !this._warButton) return;
        this._warButton.normalGumpId  = warMode ? 0x07E8 : 0x07E5;
        this._warButton.pressedGumpId = warMode ? 0x07E9 : 0x07E6;
        this._warButton.overGumpId    = warMode ? 0x07EA : 0x07E7;
        // `_draw()` calls `_maybeSwapTexture(id)` which awaits the new
        // gump tex and assigns it to the existing sprite — the button
        // image flips in-place as soon as the texture is cached. Don't
        // null `_sprite` here; previous code did and `_mountSprite()`
        // happily added a SECOND sprite on top of the orphaned old one,
        // so the button looked frozen until next paperdoll re-open.
        this._warButton._draw?.();
      }),
      bus.on('mobile:equip',    (i) => { if (i.mobile === this.mobileSerial) this._refresh(); }),
      // 0x1D RemoveEntity strips the serial from `mob.equipment` (see
      // world.removeEntity). Trigger a redraw so the paperdoll gump
      // for the lifted clothing piece disappears immediately instead
      // of lingering until the next 0x78 mobileIncoming.
      bus.on('entity:removed',  ({ serial }) => {
        const s = serial >>> 0;
        if (s === this.mobileSerial || this._equipmentSerials.has(s)) this._refresh();
      }),
      // Drop the hover-preview ghost as soon as the held item leaves
      // the cursor — drop confirmed (drag:dropped), equipped via swap
      // (drag:equipped), or server-rejected (drag:rejected). Otherwise
      // the preview would linger after the user committed the drop.
      bus.on('drag:dropped',  () => this._hidePreview()),
      bus.on('drag:equipped', () => this._hidePreview()),
      bus.on('drag:rejected', () => this._hidePreview()),
    ];
    this._refresh();
  }

  get type() { return 'paperdoll'; }

  dispose() {
    if (this._pendingHide) { clearTimeout(this._pendingHide); this._pendingHide = null; }
    if (this._preview) { try { this._preview.dispose(); } catch { /* ignore */ } this._preview = null; }
    for (const u of this._unsubs) u();
    super.dispose();
  }

  _refresh() {
    const mob = world.mobiles.get(this.mobileSerial);
    // Title: name + optional ", title" suffix (CUO LookReq parser feeds
    // both into mob.name as a single string already). Cap at 26 chars so
    // a long-titled NPC ("Jacob the Provisioner") doesn't overflow into
    // the side-button column at x=185.
    let titleText = mob?.name || `0x${this.mobileSerial.toString(16)}`;
    if (titleText.length > 26) titleText = titleText.slice(0, 26);
    this._title.setText(titleText);
    // Notoriety hue on the name strip — same table HealthBarGump uses.
    // CUO `PaperDollGump.cs` colours the title with the same noto hue
    // shown on overhead labels, so an enemy NPC's paperdoll reads orange
    // instead of innocent cream.
    const NOTO_HUE = {
      1: 0xfff0c0, 2: 0x00ff80, 3: 0xc0c0c0, 4: 0xc080ff,
      5: 0xff8030, 6: 0xff4040, 7: 0xfff060,
    };
    if (this._title.setHue) {
      this._title.setHue(NOTO_HUE[mob?.notoriety ?? 1] ?? 0xfff0c0);
    }
    // `gumpId` is asynchronous atlas state, not a passive field. Assigning it
    // directly changed the model without replacing the mounted texture, so a
    // refresh racing an earlier open could leave the old frame/body behind.
    // GumpPic owns the generation guard and releases the previous pooled
    // sprite safely through setGumpId().
    this._frame.setGumpId(pickFrameGump(mob));
    this._body.setGumpId(pickBodyGump(mob));
    this._body.setHue(mob?.hue ?? 0);

    this._equipmentSerials.clear();

    if (!mob?.equipment) {
      for (const sp of this._slots.values()) sp.dispose();
      this._slots.clear();
      return;
    }
    for (const eq of mob.equipment.values()) {
      if (eq?.serial != null) this._equipmentSerials.add(eq.serial >>> 0);
    }
    // ClassicUO composes normal equipment first and appends Backpack in a
    // dedicated final pass. The bag therefore sits above cloak/robe at the
    // avatar's hip; drawing it first put it behind the cape and let the
    // cape's alpha mask steal backpack clicks.
    const layers = [...PAPERDOLL_LAYERS, LAYER_BACKPACK];
    // OneHanded vs TwoHanded — UO retail rule: a 2H weapon dominates
    // the right hand and the 1H slot stays empty. ServUO enforces
    // this on equip but legacy players from before our hand-mutex fix
    // can still have BOTH layers populated. Hide the OneHanded item
    // when the TwoHanded slot is filled UNLESS the OneHanded item is
    // a spellbook (mage gameplay: staff in 2H + spellbook in 1H is
    // legal and CUO renders both). Without this guard the gump stacks
    // a staff sprite on top of a spellbook in the same fist position,
    // which is what Marcin's screenshot showed.
    const twoHand = mob.equipment.get?.(2);
    const oneHand = mob.equipment.get?.(1);
    // The server-side `item.spellbook = true` flag never reaches the
    // client (no field in equipUpdate / mobileIncoming), so checking
    // `world.items.get(...).spellbook` was always false → every 1H
    // slot got hidden whenever a 2H weapon equipped, including for
    // mages whose intended setup is staff-in-2H + spellbook-in-1H.
    // Recognise spellbooks by graphic id instead — the SPELLBOOK_ITEM_IDS
    // set lives at the top of this file.
    const oneHandIsBook = !!oneHand && SPELLBOOK_ITEM_IDS.has(oneHand.itemId | 0);
    const hideOneHand = !!twoHand && !!oneHand && !oneHandIsBook;
    const desired = [];
    for (const layer of layers) {
      if (layer === 1 && hideOneHand) continue;
      if (isLayerCovered(mob, layer)) continue;
      const eq = mob.equipment.get?.(layer);
      if (!eq) continue;
      // Prefer Equipconv override → tiledata.animID + MALE/FEMALE
      // gump offset per CUO PaperDollInteractable.cs:317. Final
      // fallback is itemId+50000 (lets GumpPic show a placeholder
      // for missing entries — chest/arms art that's not in the
      // catalogue surfaces as a tinted rectangle, not invisibly).
      const gumpId = resolveEquipGumpId(mob.body, eq.itemId);
      if (!gumpId) continue;
      desired.push({ layer, eq, gumpId });
    }

    const desiredLayers = new Set(desired.map((d) => d.layer));
    for (const [layer, old] of this._slots) {
      if (desiredLayers.has(layer)) continue;
      old.dispose();
      this._slots.delete(layer);
    }

    const orderedControls = [];
    for (const { layer, eq, gumpId } of desired) {
      const isBackpackSlot = layer === LAYER_BACKPACK;
      let pic = this._slots.get(layer);
      const same = pic
        && pic.gumpId === gumpId
        && (pic.equipment?.serial >>> 0) === (eq.serial >>> 0)
        && (pic.equipment?.itemId | 0) === (eq.itemId | 0);
      if (!same) {
        pic?.dispose();
        pic = new PaperDollInteractable({
        gumpId,
        hue: eq.hue,
        layer,
        equipment: eq,
        isBackpackSlot,
        onTarget: (ctrl) => {
          if (!targetManager?.active || dragDrop.isHolding()) return false;
          targetManager.pickEntity({
            serial: ctrl.equipment.serial >>> 0,
            graphic: ctrl.equipment.itemId | 0,
          });
          return true;
        },
        onDropHeld: (ctrl) => {
          if (!dragDrop.isHolding()) return;
          if (ctrl.isBackpackSlot) dragDrop.dropToContainer(ctrl.equipment.serial, 0, 0, 0);
          else                     dragDrop.dropToEquip(this.mobileSerial, ctrl.layer);
        },
        onLift: (ctrl) => {
          if (dragDrop.isHolding()) return;
          const e = ctrl.equipment;
          dragDrop.tryLift({ serial: e.serial, itemId: e.itemId, hue: e.hue, amount: 1, layer: ctrl.layer });
        },
        onUse: (ctrl) => {
          bus.emit('item:use', { serial: ctrl.equipment.serial });
        },
        onPreviewEnter: () => this._showPreview(),
        onPreviewLeave: () => this._hidePreview(),
        });
        pic.setPosition(BODY_OFFSET_X, BODY_OFFSET_Y);
        this.add(pic);
        this._slots.set(layer, pic);
      } else {
        pic.equipment = eq;
        pic.setHue(eq.hue ?? 0);
      }
      // Equipment overlays are full-body sprites (typically 260×237)
      // mostly transparent — PaperDollInteractable enables pixel-check
      // so empty alpha does not steal body/frame clicks below.
      // Single click on equipment:
      //   * non-backpack → lift to cursor (or drop held item to swap-equip)
      //   * backpack     → if holding something, throw it INTO the pack;
      //                    otherwise NO-OP. CUO doesn't let the player
      //                    lift their own bag — it's soulbound and the
      //                    server would 0x27-bounce the LiftReq anyway.
      // Double click → use the item (opens bag / drinks potion / wears
      // clothes). Mirrors CUO PaperDollInteractable click logic.
      // Click/drag/drop/use/target/preview hooks are owned by
      // PaperDollInteractable so layer sprites behave consistently.
      orderedControls.push(pic);
    }

    // Keep the composition deterministic: frame → body → equipped layers in
    // CUO order → title/buttons. Previously every refresh appended freshly
    // created equipment after the side buttons, and async texture completion
    // made the visible order depend on packet timing.
    const equippedSet = new Set(this._slots.values());
    const normal = this.children.filter((c) => !equippedSet.has(c));
    const bodyIndex = Math.max(0, normal.indexOf(this._body));
    this.children = [
      ...normal.slice(0, bodyIndex + 1),
      ...orderedControls,
      ...normal.slice(bodyIndex + 1),
    ];
    for (let i = 0; i < this.children.length; i++) {
      const node = this.children[i].node;
      if (node?.parent === this.node && this.node.getChildIndex(node) !== i) {
        this.node.setChildIndex(node, i);
      }
    }
  }

  /** Mount the half-transparent ghost overlay showing where the
   *  currently-held item would land. Called from the body / frame
   *  `onMouseEnter`; cancelled by `_hidePreview`. The same gump-id
   *  resolution chain as `_refresh` is reused via `resolveEquipGumpId`
   *  so the ghost matches the final equipped sprite exactly.
   *
   *  No-op when:
   *    - nothing is on the cursor (`dragDrop.isHolding()` false)
   *    - the held item has no resolvable equipment layer (we'd be
   *      lying about the drop target)
   *    - the held item is a backpack (layer 21) — equipping a backpack
   *      isn't a thing in UO, the slot is soulbound to the body.
   */
  /** Audit rev.4 P2 — skin-hue picker for the local paperdoll. CUO
   *  opens its own hue selector; we use a compact DOM popup with the
   *  canonical UO skin range (0x83EA..0x8430). Persists via `client:set-hue`
   *  which the server may or may not honour — `0x8E ClientWeather` style
   *  client→server messaging is shard-specific. We optimistically apply
   *  locally so the user sees the change immediately. */
  _openSkinHuePicker() {
    const SKIN_RANGE_START = 0x83EA, SKIN_RANGE_END = 0x8430;
    const cur = world.player?.hue | 0;
    const div = document.createElement('div');
    div.style.cssText = `
      position:fixed; left:50%; top:50%; transform:translate(-50%,-50%);
      z-index:9999; background:#1f1a12; border:2px solid #6e5520;
      padding:16px; font:13px Consolas, monospace; color:#e8d0a0;
      box-shadow:0 0 22px rgba(0,0,0,0.7); width:300px;
    `;
    div.innerHTML = `
      <div style="text-align:center; letter-spacing:3px; margin-bottom:10px">SKIN HUE</div>
      <div id="cc-hue-grid" style="display:grid; grid-template-columns:repeat(8,1fr); gap:3px; margin-bottom:10px"></div>
      <div style="display:flex; gap:8px; justify-content:flex-end">
        <button id="cc-hue-cancel" style="padding:4px 12px">Cancel</button>
        <button id="cc-hue-apply" style="padding:4px 12px; background:#5a3a18; color:#fff">Apply</button>
      </div>
    `;
    document.body.appendChild(div);
    const grid = div.querySelector('#cc-hue-grid');
    let pick = cur || SKIN_RANGE_START;
    for (let h = SKIN_RANGE_START; h <= SKIN_RANGE_END; h++) {
      const c = document.createElement('div');
      c.style.cssText = `width:24px; height:24px; cursor:pointer; border:2px solid ${h === pick ? '#ffe080' : '#1a1108'};`;
      // CUO hue 0x83EA..0x8430 is roughly a skin-tone gradient — we don't
      // have the hues palette here in DOM, so we synthesise a rough RGB
      // from the index. (Real shader-tinted body still draws via Pixi.)
      const norm = (h - SKIN_RANGE_START) / (SKIN_RANGE_END - SKIN_RANGE_START);
      const r = Math.round(0x60 + (0xFF - 0x60) * norm);
      const g = Math.round(0x30 + (0xC0 - 0x30) * norm);
      const b = Math.round(0x20 + (0x90 - 0x20) * norm);
      c.style.background = `rgb(${r},${g},${b})`;
      c.onclick = () => {
        pick = h;
        for (const ch of grid.children) ch.style.borderColor = '#1a1108';
        c.style.borderColor = '#ffe080';
      };
      grid.appendChild(c);
    }
    div.querySelector('#cc-hue-cancel').onclick = () => div.remove();
    div.querySelector('#cc-hue-apply').onclick = () => {
      // Optimistic local apply. Server-side acceptance depends on shard
      // policy (ServUO has no canonical "set my skin hue" packet — most
      // shards script a `[skin <hue>` command). Emit a bus event the
      // server bridge can map to a chat command if desired.
      if (world.player) world.player.hue = pick;
      try { bus.emit('client:set-skin-hue', { hue: pick }); } catch {}
      this._body?.setHue?.(pick);
      div.remove();
    };
  }

  _showPreview() {
    if (this._pendingHide) { clearTimeout(this._pendingHide); this._pendingHide = null; }
    if (!dragDrop.isHolding()) return;
    const held = dragDrop.held;
    let layer = (held.layer | 0)
             || (assets.tiledata?.statics?.[held.itemId]?.layer | 0);
    if (!layer) {
      const wi = world.items.get(held.serial >>> 0);
      layer = (wi?.layer | 0);
    }
    if (!layer || layer === LAYER_BACKPACK) return;
    if (this._preview && this._previewItemId === held.itemId) return;
    if (this._preview) { this._preview.dispose(); this._preview = null; }
    const mob = world.mobiles.get(this.mobileSerial);
    const gumpId = resolveEquipGumpId(mob?.body | 0, held.itemId | 0);
    if (!gumpId) return;
    const pic = new GumpPic(gumpId, { hue: held.hue ?? 0 });
    pic.setPosition(BODY_OFFSET_X, BODY_OFFSET_Y);
    pic.acceptMouseInput = false;        // pass clicks through to the body
    // Pixi alpha — half-transparent ghost. CUO uses 0.4–0.5 for the
    // same affordance on `PaperDollInteractable._dragGhost`.
    if (pic.node) pic.node.alpha = 0.45;
    this.add(pic);
    this._preview = pic;
    this._previewItemId = held.itemId | 0;
  }

  /** Hide the ghost. Deferred by 30 ms so a body→frame hover transition
   *  (which fires leave on body BEFORE enter on frame) doesn't flicker
   *  the preview off and back on. */
  _hidePreview() {
    if (this._pendingHide) clearTimeout(this._pendingHide);
    this._pendingHide = setTimeout(() => {
      this._pendingHide = null;
      if (!this._preview) return;
      this._preview.dispose();
      this._preview = null;
      this._previewItemId = 0;
    }, 30);
  }
}
