// SpellbookGump — OSI-canonical layout. Mirrors ClassicUO
// `Game/UI/Gumps/SpellbookGump.cs` but adapted to our control system.
//
// Layout (page-spread = two facing pages):
//   • Pages 1..pagesToFill: index pages — left & right each show ONE
//     circle's clickable spell-name list. Magery has 8 circles paired
//     into 4 index spreads.
//   • Pages pagesToFill+1..maxPage: detail spreads — each side shows
//     one spell with its big icon, name, "Reagents:" label and a
//     newline-separated reagent list. Mana is rendered under the icon.
//
// Quick-jump: 8 small numbered buttons (gump 0x08B1..0x08B8) at Y=175
// across the bottom of both pages; click one to jump to the matching
// circle's INDEX page. Page corners flip ±1.
//
// Per icon:
//   • Left click   → cast (0x12 TextCommand "<spellId>")
//   • Right click  → spawn UseSpellButtonGump under the cursor
//   • Left drag    → spawn UseSpellButtonGump under the cursor (drag the
//                    icon out to make a hotbar shortcut)
//
// All controls are built once at construction time; flipping pages
// uses Control's built-in `setActivePage` filter (page=N is visible
// only when current page == N). No destroy/recreate cycle.

import { Graphics } from 'pixi.js';
import { Gump } from '../gump.js';
import { Label } from '../controls/label.js';
import { Control } from '../control.js';
import { GumpPic } from '../controls/gump-pic.js';
import { bus } from '../../core/event-bus.js';
import { world } from '../../world/world.js';
import { net } from '../../net/net-client.js';
import { buildTextCommand } from '../../net/outgoing.js';
import { tooltips } from '../../managers/tooltip-manager.js';
import { profile } from '../../managers/profile-manager.js';
import {
  SPELLBOOK_GUMPS, spellsForSchool, spellById,
  spellIconId, expandReagents, circleName,
} from './spell-data.js';
import { UseSpellButtonGump } from './use-spell-button-gump.js';
import { uiManagerInstance } from '../ui-manager-singleton.js';

const BOOK_GRAPHIC_BY_SCHOOL = {
  0xFFB1: 0x08AC,
  0xFFB2: 0x2B00,
  0xFFB3: 0x2B01,
  0xFFB4: 0x2B07,
  0xFFB5: 0x2B06,
  0xFFB6: 0x2B2F,
  0xFFB7: 0x2B32,
};
const PAGE_CORNER_LEFT  = 0x08BB;
const PAGE_CORNER_RIGHT = 0x08BC;
const BOOK_W = 406;
const BOOK_H = 229;

// Layout coords pulled from CUO SpellbookGump.cs.
const ICON_X_LEFT  = 62;
const ICON_X_RIGHT = 225;
const ICON_Y       = 40;
const TEXT_X_LEFT  = 87;   // header above icon
const TEXT_X_RIGHT = 224;
const SPELL_NAME_X_LEFT  = 112;  // name to the right of the icon
const SPELL_NAME_X_RIGHT = 275;
const REAGENT_HEADER_Y = 92;
const REAGENT_LIST_Y   = 114;
const TOP_TEXT_Y = 6;
// 8 quick-jump buttons across the bottom of the two-page spread.
// Left page columns (1..4) sit on the left half of the book; right
// page columns (5..8) mirror them on the right. CUO native layout
// keeps both halves symmetric around the book's central spine. The
// previous numbers had columns 5..8 biased toward the right edge
// (last button at x=332 only 55 px from the 406-wide book's right
// edge while column 1 sat 58 px in from the left). Re-balancing so
// both halves match: 58 / 93 / 130 / 164  |  237 / 271 / 308 / 343.
const CIRCLE_BUTTON_Y = 175;
const CIRCLE_BUTTON_X = [58, 93, 130, 164, 218, 252, 289, 324];
const CIRCLE_BUTTON_GUMP = [0x08B1, 0x08B2, 0x08B3, 0x08B4, 0x08B5, 0x08B6, 0x08B7, 0x08B8];

class SpellIcon extends Control {
  /** @param {{id,name,circle,mana,reagents}} spell */
  constructor(spell, known) {
    super();
    this.spell = spell;
    this.known = known;
    this.width = 44;
    this.height = 44;
    this.acceptMouseInput = true;
    const iconId = spellIconId(spell);
    this._pic = new GumpPic(iconId || 0x08C0, { width: 44, height: 44 });
    this._pic.acceptMouseInput = false;
    this.add(this._pic);
    if (!known) this._pic.node.alpha = 0.45;
    // Hover ring drawn on top of the icon.
    this._frame = new Graphics();
    this.node.addChild(this._frame);
    this._drawFrame(false);
    // Last-spell highlight — pulses around the most-recently-cast spell
    // (read from macroManager._lastSpell, kept in sync by the cast runner).
    // Refreshes on `macro:cast-fired` bus events.
    this._lastSpellRing = new Graphics();
    this.node.addChild(this._lastSpellRing);
    this._lastSpellSub = bus.on('macro:cast-fired',
      ({ spellName }) => this._maybeFlashLast(spellName));
    // Reagent availability — gray out the icon when the player's pack
    // is missing one of the spell's reagents. Updates on every
    // container update so consumption / drop / pickup re-evaluates.
    this._reagentSub = bus.on('container:contents',  () => this._recheckReagents());
    this._reagentSub2= bus.on('container:item-update', () => this._recheckReagents());
    this._recheckReagents();
  }
  _drawFrame(hover) {
    if (!this._frame || this._frame.destroyed) return;
    this._frame.clear();
    if (hover) {
      this._frame.rect(-1, -1, 46, 46)
        .stroke({ width: 1, color: 0xc59533, alpha: 1 });
      this._frame.rect(0, 0, 44, 44)
        .fill({ color: 0xfff0a0, alpha: 0.18 });
    }
  }
  /** Flash an amber ring around the icon when the user casts THIS spell.
   *  Fade-out over ~800 ms; matches CUO's last-cast highlight cue. */
  _maybeFlashLast(spellName) {
    if (!this._lastSpellRing || this._lastSpellRing.destroyed) return;
    if (spellName !== this.spell?.name) return;
    if (profile.get('spellbook.lastSpellHighlight') === false) return;
    const ring = this._lastSpellRing;
    const start = performance.now();
    const tween = (now) => {
      if (!ring || ring.destroyed) return;
      const t = (now - start) / 800;
      ring.clear();
      if (t >= 1) return;
      ring.rect(-2, -2, 48, 48)
        .stroke({ width: 2, color: 0xffc060, alpha: 1 - t });
      requestAnimationFrame(tween);
    };
    requestAnimationFrame(tween);
  }
  /** Compare spell.reagents (textual recipe list) against the player's
   *  backpack — if any reagent is missing, drop the icon to ~55% alpha
   *  so the user sees at a glance which spells they can't cast. */
  _recheckReagents() {
    if (!this._pic || this._pic.node?.destroyed) return;
    if (!this.known) return;       // unknown spells stay at 0.45
    if (profile.get('spellbook.reagentCheck') === false) {
      this._pic.node.alpha = 1.0;
      return;
    }
    const recipe = this.spell?.reagents;
    if (!recipe) return;
    const have = (id) => {
      const bp = world.player?.equipment?.get?.(21)?.serial;
      if (!bp) return true;       // pre-login — don't gray everything
      const bpS = bp >>> 0;
      if (world.childrenOf) {
        for (const it of world.childrenOf(bpS)) {
          if ((it.itemId | 0) === (id | 0)) return true;
        }
      }
      return false;
    };
    // SPELL_REAGENT_IDS maps the canonical reagent name strings used in
    // spell-data.js to their itemId. Skip missing-data scenarios.
    const REAGENT_IDS = {
      'Black Pearl': 0x0F7A, 'Blood Moss': 0x0F7B, 'Garlic': 0x0F84,
      'Ginseng': 0x0F85, 'Mandrake Root': 0x0F86, 'Nightshade': 0x0F88,
      'Spider Silk': 0x0F8D, 'Sulfurous Ash': 0x0F8C,
      'Bat Wing': 0x0F78, 'Daemon Blood': 0x0F7D, 'Grave Dust': 0x0F8F,
      'Nox Crystal': 0x0F8E, 'Pig Iron': 0x0F8A,
    };
    let missing = false;
    for (const rname of recipe.split(/[,\n]+/)) {
      const id = REAGENT_IDS[rname.trim()];
      if (id != null && !have(id)) { missing = true; break; }
    }
    this._pic.node.alpha = missing ? 0.55 : 1.0;
  }
  setKnown(k) {
    if (this.known === k) return;
    this.known = k;
    if (this._pic && !this._pic.node?.destroyed) this._pic.node.alpha = k ? 1 : 0.45;
  }
  dispose() {
    this._lastSpellSub?.();
    this._reagentSub?.();
    this._reagentSub2?.();
    super.dispose?.();
  }
  onMouseEnter(e) {
    this._drawFrame(true);
    const tip = `${this.spell.name}\nMana ${this.spell.mana}` +
      `${this.known ? '' : '\n(not learned)'}`;
    tooltips.showText(e?.global?.x ?? 0, e?.global?.y ?? 0, tip);
  }
  onMouseLeave() { this._drawFrame(false); tooltips.hide(); }
  onClick(btn) {
    if (btn === 2) { this._spawnHotbar(); return; }
    try { net.send(buildTextCommand(0x56, String(this.spell.id))); }
    catch { /* socket transient */ }
  }
  onDragStart(btn) { this._spawnHotbar(btn ?? 0); }
  _spawnHotbar(_btn = 0) {
    const ui = uiManagerInstance.get();
    if (!ui) return;
    const gump = new UseSpellButtonGump(
      this.spell,
      (ui.lastMouseX || 200) - 22,
      (ui.lastMouseY || 200) - 22,
    );
    ui.addGump(gump);
    // CUO-style spawn-and-drag: a single drag from the spellbook should
    // PICK UP the new hotbar icon and follow the cursor until release —
    // not drop it under the spellbook page and require a second drag to
    // reposition. Inject the new gump into the manager's drag slot so
    // _onMouseMove starts moving it with the cursor right away.
    if (ui._pressed) {
      ui._pressed.moved = true;
      ui._dragging = {
        gump,
        ox: 22,    // half of icon — keeps the cursor centred on the button
        oy: 22,
      };
      ui.bringToFront?.(gump);
    }
    return gump;
  }
}

class SpellNameLink extends Control {
  /** Clickable spell name in the index pages. Jumps to the spell's
   *  detail page when left-clicked. */
  constructor(spell, targetPage, onJump) {
    super();
    this.spell = spell;
    this._targetPage = targetPage;
    this._onJump = onJump;
    this.width = 130;
    this.height = 14;
    this.acceptMouseInput = true;
    // Cream + stroke for max contrast on tan parchment.
    this._lbl = new Label(spell.name, { fontSize: 12, hue: 0xfff0c0, stroke: true });
    this._lbl.acceptMouseInput = false;
    this.add(this._lbl);
  }
  onMouseEnter() { this._lbl.setHue?.(0xffd060); }
  onMouseLeave() { this._lbl.setHue?.(0xfff0c0); }
  onClick(btn) { if (btn === 0) this._onJump(this._targetPage); }
}

class CircleJumpButton extends Control {
  constructor(circle, gumpId, onPick) {
    super();
    this.circle = circle;
    this.width = 28;
    this.height = 24;
    this.acceptMouseInput = true;
    this._onPick = onPick;
    const pic = new GumpPic(gumpId, { width: 28, height: 24 });
    pic.acceptMouseInput = false;
    this.add(pic);
  }
  onClick(btn) { if (btn === 0) this._onPick(this.circle); }
}

class PageCorner extends Control {
  constructor(direction, onClick) {
    super();
    this.direction = direction; // 'prev' | 'next'
    this.width = 27;
    this.height = 23;
    this.acceptMouseInput = true;
    this._onClick = onClick;
    const pic = new GumpPic(direction === 'prev' ? PAGE_CORNER_LEFT : PAGE_CORNER_RIGHT,
      { width: 27, height: 23 });
    pic.acceptMouseInput = false;
    this.add(pic);
  }
  onClick(btn) { if (btn === 0) this._onClick(this.direction); }
}

export class SpellbookGump extends Gump {
  constructor(containerSerial, gumpId, opts = 100, y = 100) {
    super();
    let x = 100;
    let optsObj = {};
    if (typeof opts === 'number') {
      x = opts;
    } else {
      x = opts.x ?? 100; y = opts.y ?? 100; optsObj = opts;
    }
    const meta = SPELLBOOK_GUMPS[gumpId & 0xffff] ?? SPELLBOOK_GUMPS[0xFFB1];
    this.containerSerial = containerSerial >>> 0;
    this.gumpId = gumpId & 0xffff;
    this._known = new Set();
    this._school = meta.school;
    this.canMove = true;
    this.canClose = true;
    this.setPosition(x, y);
    this.setSize(BOOK_W, BOOK_H);
    // Restore the user's last drag position. Without this the spellbook
    // re-opens at the hard-coded (100, 100) every session.
    this.restorePosition();

    // 1. Book backdrop (also drag handle).
    const bookId = BOOK_GRAPHIC_BY_SCHOOL[this.gumpId] ?? 0x08AC;
    const book = new GumpPic(bookId);
    book.setPosition(0, 0);
    book.acceptMouseInput = true;
    book.isDragHandle = true;
    this.add(book);

    // Close-X removed — RMB anywhere on the spellbook closes it via the
    // universal UIManager dispatch. Marcin: "wywal x bo zamykamy
    // kliknieciem". Without it the top-right corner is clean for the
    // page-flip curl.

    /** @type {SpellIcon[]} */ this._icons = [];
    /** @type {SpellNameLink[]} */ this._links = [];

    this._buildPages();

    // 3. Page corners — built AFTER pages so they sit on top of any
    // icon/text that may overlap their hit area.
    this._cornerLeft  = new PageCorner('prev', (d) => this._flipPage(d));
    this._cornerLeft.setPosition(50, 8);
    this.add(this._cornerLeft);
    // Right page corner — slid a touch further right than the strict
    // mirror so the visible curl sits FLUSH with the right-page edge
    // (CUO native art has the curl drawn off-centre toward the right
    // half of the sprite). 38 px from the book's right edge places
    // the artwork's curl tip in the corresponding corner.
    this._cornerRight = new PageCorner('next', (d) => this._flipPage(d));
    this._cornerRight.setPosition(BOOK_W - 38 - 36, 8);
    this.add(this._cornerRight);

    // 4. Magery quick-jump circle buttons across both pages, Y=175.
    if (this._school === 'Magery') {
      for (let c = 1; c <= 8; c++) {
        const b = new CircleJumpButton(c,
          CIRCLE_BUTTON_GUMP[c - 1], (pick) => this._gotoCircleIndex(pick));
        b.setPosition(CIRCLE_BUTTON_X[c - 1], CIRCLE_BUTTON_Y);
        this.add(b);
      }
    }

    // 5. Initial known-spell mask.
    if (Number.isFinite(optsObj.offset) && (optsObj.hi || optsObj.lo)) {
      this._setMask(optsObj.offset | 0, optsObj.hi >>> 0, optsObj.lo >>> 0);
    } else {
      // Permissive default — every spell appears known until the
      // server's 0xBF 0x1B push lands and overrides.
      for (const s of spellsForSchool(this.gumpId)) this._known.add(s.id);
      for (const ic of this._icons) ic.setKnown(true);
    }

    this._gotoPage(1);

    this._unsubs = [
      bus.on('spellbook:content', ({ serial, offset, hi, lo }) => {
        if ((serial >>> 0) !== this.containerSerial) return;
        this._setMask(offset | 0, hi >>> 0, lo >>> 0);
      }),
    ];
  }

  get type() { return 'spellbook'; }
  dispose() { for (const u of this._unsubs) u(); super.dispose(); }

  /** Assemble all pages once and stash their controls with the right
   *  `page` filter. Magery: 4 index spreads (8 circles paired) + 32
   *  detail spreads (one spell per side). Non-Magery schools collapse
   *  to a single index spread + ⌈n/2⌉ detail spreads. */
  _buildPages() {
    const spells = spellsForSchool(this.gumpId);
    const circles = [...new Set(spells.map((s) => s.circle))].sort((a, b) => a - b);
    const isMagery = this._school === 'Magery' && circles.length === 8;

    // pagesToFill = # of INDEX spreads. CUO pairs 2 circles per spread.
    const indexSpreads = isMagery ? 4 : 1;
    let detailPage = indexSpreads + 1;

    // Each spell gets a detail page assigned (left or right slot).
    /** @type {Map<number, {page:number, side:'L'|'R'}>} */
    const detailFor = new Map();
    let placed = 0;
    for (const sp of spells) {
      const side = (placed % 2 === 0) ? 'L' : 'R';
      if (placed > 0 && placed % 2 === 0) detailPage++;
      detailFor.set(sp.id, { page: detailPage, side });
      placed++;
    }
    this._maxPage = detailPage;
    this._indexSpreads = indexSpreads;

    // ---- Index pages ----
    for (let s = 1; s <= indexSpreads; s++) {
      const c1 = isMagery ? (s - 1) * 2 + 1 : circles[0];
      const c2 = isMagery ? (s - 1) * 2 + 2 : null;
      this._buildIndexSide(s, c1, ICON_X_LEFT, spells, detailFor);
      if (c2 != null) this._buildIndexSide(s, c2, ICON_X_RIGHT, spells, detailFor);
    }

    // ---- Detail pages ----
    for (const sp of spells) {
      const slot = detailFor.get(sp.id);
      const baseX = slot.side === 'L' ? ICON_X_LEFT : ICON_X_RIGHT;
      const headerX = slot.side === 'L' ? TEXT_X_LEFT : TEXT_X_RIGHT;
      const nameX = slot.side === 'L' ? SPELL_NAME_X_LEFT : SPELL_NAME_X_RIGHT;
      this._buildDetailSide(slot.page, sp, baseX, headerX, nameX);
    }
  }

  _buildIndexSide(page, circle, baseX, allSpells, detailFor) {
    // Cream-on-black "embossed" lettering — matches the paperdoll
    // title strip and reads cleanly on UO's tan parchment in both
    // daylight and night dim. The dark-ink-on-cream variant we used
    // before blended into the parchment tone at certain hue settings.
    const title = new Label(circleName(circle), { fontSize: 14, hue: 0xfff0c0, stroke: true });
    title.setPosition(baseX, 8);
    title.acceptMouseInput = false;
    title.page = page;
    this.add(title);
    // Spell name list — clickable, jumps to detail page.
    const circleSpells = allSpells.filter((s) => s.circle === circle);
    circleSpells.forEach((sp, i) => {
      const link = new SpellNameLink(
        sp,
        detailFor.get(sp.id).page,
        (p) => this._gotoPage(p),
      );
      link.setPosition(baseX, 32 + i * 14);
      link.page = page;
      this.add(link);
      this._links.push(link);
    });
  }

  _buildDetailSide(page, spell, iconX, headerX, nameX) {
    // Circle header — same cream embossed style as the index.
    const hdr = new Label(circleName(spell.circle),
      { fontSize: 11, hue: 0xffd080, stroke: true });
    hdr.setPosition(headerX, TOP_TEXT_Y + 4);
    hdr.acceptMouseInput = false;
    hdr.page = page;
    this.add(hdr);

    // Big icon — interactive (cast / drag).
    const known = this._known.has(spell.id);
    const ic = new SpellIcon(spell, known);
    ic.setPosition(iconX, ICON_Y);
    ic.page = page;
    this.add(ic);
    this._icons.push(ic);

    // Spell name — cream with thick stroke. Larger than the index list
    // so the user can read the active spell name from across the room.
    const name = new Label(spell.name,
      { fontSize: 13, hue: 0xfff0c0, stroke: true });
    name.setPosition(nameX, ICON_Y - 4);
    name.acceptMouseInput = false;
    name.page = page;
    this.add(name);

    // Mana cost just under the name — slightly dimmer to draw the eye
    // to the spell name first.
    const mana = new Label(`Mana ${spell.mana}`,
      { fontSize: 11, hue: 0xc0d0ff, stroke: true });
    mana.setPosition(nameX, ICON_Y + 14);
    mana.acceptMouseInput = false;
    mana.page = page;
    this.add(mana);

    // "Reagents:" header + multi-line reagent list.
    if (spell.reagents) {
      const reagHdr = new Label('Reagents:',
        { fontSize: 11, hue: 0xffd080, stroke: true });
      reagHdr.setPosition(iconX, REAGENT_HEADER_Y);
      reagHdr.acceptMouseInput = false;
      reagHdr.page = page;
      this.add(reagHdr);
      const reagList = expandReagents(spell);
      const lines = reagList.split('\n');
      lines.forEach((line, i) => {
        const lbl = new Label(line,
          { fontSize: 11, hue: 0xfff0c0, stroke: true });
        lbl.setPosition(iconX, REAGENT_LIST_Y + i * 12);
        lbl.acceptMouseInput = false;
        lbl.page = page;
        this.add(lbl);
      });
    }
  }

  _gotoPage(page) {
    const clamped = Math.max(1, Math.min(this._maxPage, page | 0));
    this._activePage = clamped;
    this.setActivePage(clamped);
    if (this._cornerLeft)  this._cornerLeft.visible  = clamped > 1;
    if (this._cornerRight) this._cornerRight.visible = clamped < this._maxPage;
    this._cornerLeft?._applyPageVisibility?.();
    this._cornerRight?._applyPageVisibility?.();
  }

  /** Quick-jump circle button → jump to that circle's INDEX page. */
  _gotoCircleIndex(circle) {
    // Each index spread holds 2 circles (1+2 → page 1, 3+4 → 2, ...).
    const page = Math.ceil(circle / 2);
    this._gotoPage(page);
  }

  _flipPage(dir) {
    if (dir === 'prev') this._gotoPage((this._activePage ?? 1) - 1);
    else this._gotoPage((this._activePage ?? 1) + 1);
  }

  _setMask(offset, hi, lo) {
    this._known.clear();
    for (let b = 0; b < 32; b++) if (lo & (1 << b)) this._known.add(offset + b);
    for (let b = 0; b < 32; b++) if (hi & (1 << b)) this._known.add(offset + 32 + b);
    for (const ic of this._icons) ic.setKnown(this._known.has(ic.spell.id));
  }

  _onContents({ containerSerial, items }) {
    if (containerSerial !== this.containerSerial) return;
    this._known.clear();
    for (const it of items) {
      const spellId = it.itemId & 0xff;
      if (spellById(spellId)) this._known.add(spellId);
    }
    for (const ic of this._icons) ic.setKnown(this._known.has(ic.spell.id));
  }
}
