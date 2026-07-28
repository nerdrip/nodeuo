// Server gump layout parser. Mirrors ClassicUO's
// Game/Managers/UIManager.cs `parseLayout` and the cmd handlers in
// Game/UI/Gumps/Gump.cs.
//
// The layout is a single ASCII string sent inside 0xB0 / 0xDD packets.
// Commands are wrapped in `{ ... }` blocks; tokens inside are separated
// by spaces. Strings can be referenced by index from a parallel array of
// Unicode lines (`textLines`).
//
// Supported commands (the ones actually used by ServUO's stock gumps):
//   page <n>
//   resizepic <x> <y> <gumpId> <w> <h>
//   gumppic <x> <y> <gumpId> [hue=<h>]
//   gumppictiled <x> <y> <w> <h> <gumpId>
//   button <x> <y> <upId> <downId> <action> <pageNo> <buttonId>
//   buttontileart <x> <y> <upId> <downId> <action> <pageNo> <buttonId> <tileId> <hue> <oh> <ov>
//   checkbox <x> <y> <unId> <chId> <checked> <switchId>
//   radio    <x> <y> <unId> <chId> <checked> <switchId>
//   text         <x> <y> <hue> <textIndex>
//   croppedtext  <x> <y> <w> <h> <hue> <textIndex>
//   htmlgump     <x> <y> <w> <h> <textIndex> <hasBackground> <hasScrollbar>
//   xmfhtmlgump  <x> <y> <w> <h> <clilocId> <hasBackground> <hasScrollbar>
//   xmfhtmlgumpcolor <x> <y> <w> <h> <clilocId> <hasBackground> <hasScrollbar> <colorAsHue>
//   xmfhtmltok   <x> <y> <w> <h> <hasBackground> <hasScrollbar> <colorAsHue> <clilocId> <args>
//   tooltip      <id>
//   itemproperty <serial>
//   group        <n>
//   endgroup
//   noresize
//   noclose
//   nodispose
//   nomove
//   masterGump   <id>
//   textentry    <x> <y> <w> <h> <hue> <entryId> <textIndex>
//   textentrylimited <x> <y> <w> <h> <hue> <entryId> <textIndex> <maxChars>
//
// Anything unknown logs a one-line debug warning and is ignored.

import { Gump } from './gump.js';
import { Label } from './controls/label.js';
import { Button, ButtonAction } from './controls/button.js';
import { GumpPic } from './controls/gump-pic.js';
import { GumpPicTiled } from './controls/gump-pic-tiled.js';
import { ResizePic } from './controls/resize-pic.js';
import { ItemPic } from './controls/item-pic.js';
import { StaticPic } from './controls/static-pic.js';
import { MobilePic } from './controls/mobile-pic.js';
import { MultiPic } from './controls/multi-pic.js';
import { CroppedText } from './controls/cropped-text.js';
import { HtmlControl } from './controls/html-control.js';
import { CheckerTrans } from './controls/checker-trans.js';
import { ensureGumpControlInfo } from './controls/gump-control-info.js';
import { tooltips } from '../managers/tooltip-manager.js';
import { Checkbox } from './controls/checkbox.js';
import { TextInput } from './controls/text-input.js';
import { assets } from '../assets/asset-manager.js';

/** Tokenize a single command body (the part between '{' and '}'). */
function tokenize(body) {
  const out = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && body[i] === ' ') i++;
    if (i >= body.length) break;
    if (body[i] === '@') {
      // ClassicUO escape: '@@' = '{', '@(' = '}'-marker. Strip the prefix.
      let s = '';
      i++; // skip '@'
      while (i < body.length && body[i] !== ' ') s += body[i++];
      out.push(s);
      continue;
    }
    let s = '';
    while (i < body.length && body[i] !== ' ') s += body[i++];
    if (s.length) out.push(s);
  }
  return out;
}

function num(tokens, index) {
  return +tokens[index];
}

/** Walk the whole layout string and yield each `{ cmd args... }` block. */
function* commands(layout, maxCommands = 4096) {
  let i = 0;
  let count = 0;
  while (i < layout.length) {
    if (count++ >= maxCommands) break;
    while (i < layout.length && layout[i] !== '{') i++;
    if (i >= layout.length) break;
    const start = i + 1;
    let end = layout.indexOf('}', start);
    if (end < 0) break;
    yield layout.slice(start, end).trim();
    i = end + 1;
  }
}

/** Prime atlas requests before controls resolve their own textures. Pending
 * loads are deduplicated by AssetManager, so the opened gump gets priority
 * without downloading any page twice. */
export function prefetchGumpAssets(layout) {
  const ids = new Set();
  for (const body of commands(String(layout || '').slice(0, 1024 * 1024), 4096)) {
    const t = tokenize(body);
    const op = String(t[0] || '').toLowerCase();
    let candidates = [];
    if (['gumppic', 'gumppichued', 'gumppicphued', 'tilepicasgumppic', 'kr_gumppic'].includes(op)) candidates = [t[3]];
    else if (op === 'gumppictiled') candidates = [t[5]];
    else if (op === 'resizepic') candidates = [t[3]];
    else if (op === 'button' || op === 'buttontileart') candidates = [t[3], t[4]];
    else if (op === 'checkbox' || op === 'radio') candidates = [t[3], t[4]];
    for (const raw of candidates) {
      const id = Number(raw);
      if (Number.isInteger(id) && id >= 0 && id <= 0xffff) ids.add(id);
      if (ids.size >= 128) break;
    }
    if (ids.size >= 128) break;
  }
  for (const id of ids) void assets.gumpTexture(id).catch?.(() => {});
  return ids.size;
}

/**
 * Parse a server-gump layout into a populated Gump.
 *
 * @param {object} opts
 * @param {string} opts.layout
 * @param {string[]} opts.textLines   parallel UTF-16 lines, indexed by `<textIndex>`
 * @param {number} opts.serverSerial  echoes back in 0xB1
 * @param {number} opts.gumpSerial    server's chosen local gumpSerial
 * @param {number} opts.x
 * @param {number} opts.y
 * @returns {Gump}
 */
export function parseGumpLayout({ layout, textLines, serverSerial, gumpSerial, x, y }) {
  // Network gumps are data, not trusted code. Bound work and normalize the
  // parallel string table before constructing Pixi objects. The limits are
  // intentionally far above ordinary ServUO gumps but prevent a malformed
  // shard packet from allocating an unbounded UI tree or multi-megabyte Text.
  layout = String(layout ?? '').slice(0, 1024 * 1024);
  prefetchGumpAssets(layout);
  textLines = Array.isArray(textLines)
    ? textLines.slice(0, 4096).map((line) => String(line ?? '').slice(0, 16384))
    : [];
  const g = new Gump();
  g.serverSerial = serverSerial >>> 0;
  g.gumpSerial = gumpSerial >>> 0;
  g.setPosition(x, y);

  let currentPage = 0;
  let radioGroupCounter = 0;
  // Track radio-group ids so siblings can exclude each other.
  let radioGroup = `g${gumpSerial}-0`;

  for (const cmd of commands(layout)) {
    const t = tokenize(cmd);
    if (!t.length) continue;
    const op = t[0].toLowerCase();
    try {
      switch (op) {
        case 'page': currentPage = +t[1] | 0; break;
        case 'resizepic': {
          const x = num(t, 1), y = num(t, 2), id = num(t, 3), w = num(t, 4), h = num(t, 5);
          const c = new ResizePic(id, w, h);
          c.setPosition(x, y); c.page = currentPage;
          g.add(c); break;
        }
        // Audit #40 client P2 #8 — CUO `gump-layout.cs:6624` aliases
        // `tilepicasgumppic` to `gumppic`. Some older ServUO publishes
        // use this token; we were dropping the picture entirely.
        case 'gumppic':
        case 'tilepicasgumppic':
        case 'kr_gumppic':       // Korean client variant — alias to gumppic
        {
          const x = +t[1], y = +t[2], id = +t[3];
          let hue = 0;
          for (let k = 4; k < t.length; k++) {
            const m = /^hue=(\d+)$/i.exec(t[k]); if (m) hue = +m[1];
          }
          const c = new GumpPic(id, { hue });
          c.setPosition(x, y); c.page = currentPage;
          g.add(c); break;
        }
        // CUO `Network/PacketHandlers.cs:7083` canonical AOS form:
        //   `gumppichued x y id hue`. Bare positional hue (no `hue=`
        //   token). `gumppicphued` is the partial-hue variant. Both
        //   were silently dropped before — server-driven craft / BOD
        //   gumps that used the AOS layout rendered without art.
        case 'gumppichued':
        case 'gumppicphued': {
          const x = +t[1], y = +t[2], id = +t[3], hue = +t[4] || 0;
          const c = new GumpPic(id, { hue });
          c.setPosition(x, y); c.page = currentPage;
          g.add(c); break;
        }
        case 'gumppictiled': {
          const x = num(t, 1), y = num(t, 2), w = num(t, 3), h = num(t, 4), id = num(t, 5);
          const c = new GumpPicTiled(id, { width: w, height: h });
          c.setPosition(x, y); c.page = currentPage;
          g.add(c); break;
        }
        // CUO `PacketHandlers.cs:6927` — `tilepic x y itemId` renders a
        // STATIC art tile (gold pile, sigil, anvil thumbnail). Used by
        // bank checks, BOD reward gumps, blacksmith preview, gold-counter
        // dialogs. Was dropped → those gumps rendered empty boxes.
        case 'tilepic': {
          const x = +t[1], y = +t[2], id = +t[3];
          const c = new StaticPic(id);
          c.setPosition(x, y); c.page = currentPage;
          g.add(c); break;
        }
        case 'tilepichue': {
          const x = +t[1], y = +t[2], id = +t[3], hue = +t[4] || 0;
          const c = new StaticPic(id, { hue });
          c.setPosition(x, y); c.page = currentPage;
          g.add(c); break;
        }
        // NodeUO bounded static preview. Unlike standard `tilepic`, this
        // contains very tall/wide art inside the supplied box.
        case 'tilepicfit': {
          const x = +t[1], y = +t[2], id = +t[3], hue = +t[4] || 0;
          const width = +t[5] || 44, height = +t[6] || 44;
          const c = new ItemPic(id, { hue, maxWidth: width, maxHeight: height });
          c.setPosition(x, y); c.page = currentPage;
          c.acceptMouseInput = false;
          g.add(c); break;
        }
        // NodeUO extension used by visual admin catalogues:
        //   mobilepic x y body hue direction width height
        // Standard clients safely ignore this unknown layout verb.
        case 'mobilepic': {
          const x = +t[1], y = +t[2], body = +t[3], hue = +t[4] || 0;
          const direction = +t[5] || 0, width = +t[6] || 52, height = +t[7] || 52;
          const c = new MobilePic(body, { hue, direction, width, height });
          c.setPosition(x, y); c.page = currentPage;
          g.add(c); break;
        }
        // NodeUO extension used by the visual multi catalogue:
        //   multipic x y multiId width height
        // Classic clients ignore the unknown verb and keep the textual
        // picker fully usable; our web client shows the complete footprint.
        case 'multipic': {
          const x = +t[1], y = +t[2], multiId = +t[3];
          const width = +t[4] || 64, height = +t[5] || 48;
          const c = new MultiPic(multiId, { width, height });
          c.setPosition(x, y); c.page = currentPage;
          g.add(c); break;
        }
        // CUO `PacketHandlers.cs:7058 GumpPicInPic` — crops a sub-rect of
        // a gump texture: `picinpic x y gumpId sx sy w h`. Used by
        // quest progress windows, arena scoreboards, BOD pages. Drop
        // path rendered empty panes.
        case 'picinpic':
        case 'picinpichued':
        case 'picinpicphued': {
          // CUO `Game/UI/Controls/GumpPicInPic.cs` — `picinpic x y gumpId
          // sx sy w h [hue]`. (sx, sy, w, h) describe a sub-rect of the
          // source gump texture that gets cropped out and shown at (x, y)
          // at its natural size. Used by BOD pages, quest progress
          // windows, arena scoreboards. Previously the (sx, sy) crop was
          // ignored and the full sprite was stretched to (w × h); fixed
          // by passing the crop into GumpPic as a sub-texture frame.
          const x = +t[1], y = +t[2], id = +t[3];
          const sx = +t[4] || 0, sy = +t[5] || 0;
          const w = +t[6] || 32, h = +t[7] || 32;
          const hue = op === 'picinpic' ? 0 : (+t[8] || 0);
          const c = new GumpPic(id, {
            width: w, height: h, hue,
            srcX: sx, srcY: sy, srcW: w, srcH: h,
          });
          c.setPosition(x, y); c.page = currentPage;
          g.add(c); break;
        }
        case 'button': {
          const x = num(t, 1), y = num(t, 2), up = num(t, 3), down = num(t, 4);
          const action = num(t, 5), pageNo = num(t, 6), buttonId = num(t, 7);
          const c = new Button({
            normalGumpId: up, pressedGumpId: down,
            buttonId, pageNo,
            action: action === 0 ? ButtonAction.SwitchPage : ButtonAction.Activate,
            label: '',
          });
          c.setPosition(x, y); c.page = currentPage;
          g.add(c); break;
        }
        case 'buttontileart': {
          const x = num(t, 1), y = num(t, 2), up = num(t, 3), down = num(t, 4);
          const action = num(t, 5), pageNo = num(t, 6), buttonId = num(t, 7);
          const tileId = num(t, 8), hue = num(t, 9), oh = num(t, 10), ov = num(t, 11);
          const c = new Button({
            normalGumpId: up, pressedGumpId: down,
            buttonId, pageNo,
            action: action === 0 ? ButtonAction.SwitchPage : ButtonAction.Activate,
          });
          const art = new ItemPic(tileId, { hue });
          art.acceptMouseInput = false;
          art.setPosition(oh || 0, ov || 0);
          c.add(art);
          c.setPosition(x, y); c.page = currentPage;
          g.add(c); break;
        }
        case 'checkbox': {
          const x = num(t, 1), y = num(t, 2), un = num(t, 3), ch = num(t, 4);
          const checked = num(t, 5), switchId = num(t, 6);
          const c = new Checkbox({
            uncheckedGump: un, checkedGump: ch, switchId,
            checked: checked === 1, kind: 'checkbox', size: 18,
          });
          c.setPosition(x, y); c.page = currentPage;
          g.add(c); break;
        }
        case 'radio': {
          const x = num(t, 1), y = num(t, 2), un = num(t, 3), ch = num(t, 4);
          const checked = num(t, 5), switchId = num(t, 6);
          const c = new Checkbox({
            uncheckedGump: un, checkedGump: ch, switchId,
            checked: checked === 1, kind: 'radio',
            groupId: radioGroup, size: 18,
          });
          c.setPosition(x, y); c.page = currentPage;
          g.add(c); break;
        }
        case 'text': {
          const x = num(t, 1), y = num(t, 2), hue = num(t, 3), textIdx = num(t, 4);
          const c = new Label(textLines[textIdx] ?? '', { hue: paletteHueToRgb(hue) });
          c.setPosition(x, y); c.page = currentPage;
          g.add(c); break;
        }
        case 'croppedtext': {
          // CUO `Game/UI/Gumps/Gump.cs::CroppedText` — clips text to
          // (w, h). The standalone control owns both the ellipsis
          // approximation and a Pixi mask so text cannot bleed outside.
          const x = num(t, 1), y = num(t, 2), w = num(t, 3), h = num(t, 4);
          const hue = num(t, 5), textIdx = num(t, 6);
          const c = new CroppedText(textLines[textIdx] ?? '', {
            width: w,
            height: h,
            hue: paletteHueToRgb(hue),
          });
          c.setPosition(x, y); c.page = currentPage;
          g.add(c); break;
        }
        case 'htmlgump': {
          const x = num(t, 1), y = num(t, 2), w = num(t, 3), h = num(t, 4), textIdx = num(t, 5);
          const c = new HtmlControl({
            text: textLines[textIdx] ?? '', maxWidth: w, maxHeight: h,
            background: num(t, 6) === 1, scrollable: num(t, 7) === 1,
          });
          c.setPosition(x, y); c.page = currentPage;
          g.add(c); break;
        }
        case 'xmfhtmlgump': {
          // xmfhtmlgump x y w h cliloc bg scrollable
          const x = +t[1], y = +t[2], w = +t[3], h = +t[4];
          const text = assets.cl(+t[5]);
          const c = new HtmlControl({
            text, maxWidth: w, maxHeight: h, fontSize: 11,
            background: +t[6] === 1, scrollable: +t[7] === 1,
          });
          c.setPosition(x, y); c.page = currentPage;
          g.add(c); break;
        }
        case 'xmfhtmlgumpcolor': {
          // xmfhtmlgumpcolor x y w h cliloc bg scrollable colorAsHue
          const x = +t[1], y = +t[2], w = +t[3], h = +t[4];
          const text = assets.cl(+t[5]);
          let hue = +t[8] || 0;
          // Audit #42 client P2 #22 — CUO `PacketHandlers.cs:6809-6812`
          // sentinel: 0x7FFF means "default white" (0xFFFFFF). Was: passed
          // through `paletteHueToRgb` → random palette colour.
          const rgb = hue === 0x7FFF ? 0xFFFFFF : paletteHueToRgb(hue);
          const c = new HtmlControl({
            text, maxWidth: w, maxHeight: h, fontSize: 11, color: rgb,
            background: +t[6] === 1, scrollable: +t[7] === 1,
          });
          c.setPosition(x, y); c.page = currentPage;
          g.add(c); break;
        }
        case 'xmfhtmltok': {
          // xmfhtmltok x y w h bg scrollable colorAsHue cliloc @args@
          const x = +t[1], y = +t[2], w = +t[3], h = +t[4];
          const hue = +t[7] || 0;
          const cliloc = +t[8];
          // Audit #40 client P2 #9 — CUO `gump-layout.cs:6872` reads
          // `gparams[i].Trim('@').Replace('@', '\t')`. The on-wire
          // delimiter for multi-arg cliloc substitutions is literal
          // '@'; `Clilocs.Translate` expects tab-separated. Was:
          // `.replace(/\t/g, '\t')` (a no-op self-replace).
          const argsRaw = t.slice(9).join(' ');
          const args = argsRaw.replace(/^@|@$/g, '').replace(/@/g, '\t');
          const text = assets.cl(cliloc, args);
          const c = new HtmlControl({
            text, maxWidth: w, maxHeight: h, fontSize: 11,
            color: paletteHueToRgb(hue),
            background: +t[5] === 1, scrollable: +t[6] === 1,
          });
          c.setPosition(x, y); c.page = currentPage;
          g.add(c); break;
        }
        case 'textentry':
        case 'textentrylimited': {
          const x = num(t, 1), y = num(t, 2), w = num(t, 3), h = num(t, 4);
          const hue = num(t, 5), entryId = num(t, 6), textIdx = num(t, 7), maxLen = num(t, 8);
          const c = new TextInput({
            width: w, height: h,
            hue: paletteHueToRgb(hue),
            entryId,
            text: textLines[textIdx] ?? '',
            maxLength: op === 'textentrylimited' ? (maxLen | 0) : 256,
          });
          c.setPosition(x, y); c.page = currentPage;
          g.add(c); break;
        }
        case 'group': /* radio grouping is handled by `radio` directly */
          radioGroup = `g${gumpSerial}-${t[1] ?? '0'}`;
          break;
        case 'endgroup':
          radioGroup = `g${gumpSerial}-end-${++radioGroupCounter}`;
          break;
        case 'tooltip': {
          // CUO `PacketHandlers.cs:6969 Tooltip` — attaches a cliloc
          // string to the LAST added element so a hover popup shows
          // contextual text. ServUO craft gumps + skill-info gumps
          // depend on this for the "what does this slot do" hint.
          //   tooltip <clilocId> [arg1\targ2...]
          // Audit #46 P1#14 — CUO at `:7010-7016` *appends* additional
          // tooltip text with `\n` separator when the last element
          // already has one (multi-cliloc on a single control). Was
          // overwriting: multi-line tooltips lost all but last line.
          const clilocId = +t[1];
          if (Number.isFinite(clilocId)) {
            const argsRaw = t.slice(2).join(' ');
            const argsClean = argsRaw.replace(/^@|@$/g, '');
            const text = assets.cl?.(clilocId, argsClean) ?? '';
            const last = g.children[g.children.length - 1];
            if (last && text) {
              const info = ensureGumpControlInfo(last);
              last._tooltipText = info.appendTooltip(text);
              const fullText = last._tooltipText;
              last.onMouseEnter = (e) => {
                try {
                  tooltips.showText(e?.global?.x ?? 0, e?.global?.y ?? 0, fullText);
                } catch { /* ignore */ }
              };
              last.onMouseLeave = () => { try { tooltips.hide(); } catch { /* ignore */ } };
            }
          }
          break;
        }
        case 'itemproperty': {
          // Audit #46 P1#11 — CUO `PacketHandlers.cs:7034-7046`:
          //   itemproperty <serial>
          // Binds the last-added control to OPL of the named entity so
          // hover fetches the mega-cliloc and shows the rich tooltip.
          // Was a no-op → server-side OPL-attached layout elements
          // never displayed tooltips.
          const serial = (Number(t[1]) || 0) >>> 0;
          const last = g.children[g.children.length - 1];
          if (last && serial) {
            ensureGumpControlInfo(last).setItemPropertySerial(serial);
            last._opSerial = serial;
            // Defer-load OPL when the user actually hovers; the tooltip
            // manager caches by serial.
            last.onMouseEnter = (e) => {
              try {
                const opl = tooltips.request?.(serial);
                const text = (typeof opl === 'string')
                  ? opl
                  : (opl?.text ?? '');
                if (text) {
                  tooltips.showText(e?.global?.x ?? 0, e?.global?.y ?? 0, text);
                }
              } catch { /* ignore */ }
            };
            last.onMouseLeave = () => { try { tooltips.hide(); } catch { /* ignore */ } };
          }
          break;
        }
        case 'noresize':
        case 'nodispose':
        case 'noclose':
        case 'nomove':
          // CUO `PacketHandlers.cs:6934-6944`:
          //   noclose   → CanCloseWithRightClick = false (RMB blocked)
          //   nodispose → CanCloseWithEsc        = false (ESC blocked)
          if (op === 'nomove')    g.canMove = false;
          if (op === 'noclose')   g.canCloseWithRMB = false;
          if (op === 'nodispose') g.canCloseWithEsc = false;
          break;
        case 'mastergump': {
          // Audit #46 P1#12 — CUO `PacketHandlers.cs:7053-7056`:
          //   mastergump <serial>
          // Binds this gump as a child of the named master gump so when
          // the master closes the child cascade-closes too. Was a no-op
          // → nested vendor/craft sub-gumps lingered after master.
          const masterSerial = (Number(t[1]) || 0) >>> 0;
          if (masterSerial) {
            ensureGumpControlInfo(g).setMasterGumpSerial(masterSerial);
            g.masterGumpSerial = masterSerial;
          }
          break;
        }
        case 'checkertrans': {
          // CUO `PacketHandlers.cs:6606 ApplyTrans` halves alpha of
          // every child whose bbox overlaps the rect on the current page,
          // while `CheckerTrans` itself draws a translucent black cover.
          // Quest progress / dialogue gumps use it to dim already-completed
          // steps. We keep both behaviours: underlying controls are dimmed,
          // then a non-interactive overlay is rendered above them.
          const x = +t[1], y = +t[2], w = +t[3], h = +t[4];
          if (Number.isFinite(x)) {
            for (const c of g.children) {
              if (c.page !== 0 && c.page !== currentPage) continue;
              const cx = c.x | 0, cy = c.y | 0;
              const cw = (c.width | 0) || 1, ch = (c.height | 0) || 1;
              if (cx + cw < x || cx > x + w) continue;
              if (cy + ch < y || cy > y + h) continue;
              if (c.node) c.node.alpha = Math.min(c.node.alpha ?? 1, 0.5);
            }
            const overlay = new CheckerTrans({ width: w, height: h });
            overlay.setPosition(x, y); overlay.page = currentPage;
            g.add(overlay);
          }
          break;
        }
        // CUO no-ops these silently. Audit #46 P1#13 removed dead
        // duplicate `'noresize'`/`'mastergump'` arms here (handled
        // canonically above).
        case '\0':                 // null-terminator marker
        case 'togglelimitgumpscale':
          break;
        default:
          if (typeof console !== 'undefined') console.debug(`[gump] unknown cmd: ${op}`);
      }
    } catch (e) {
      console.warn(`[gump] cmd "${op}" failed`, e);
    }
  }

  // Native gump/button textures resolve asynchronously. Their constructors
  // initially report placeholder bounds (typically 32x32), so a one-shot
  // calculation here clipped later-loaded art and made controls outside the
  // stale root rectangle impossible to click. Recalculate whenever a direct
  // child adopts its natural atlas size.
  const recalculateBounds = () => {
    if (g.node?.destroyed) return;
    let maxX = 0, maxY = 0;
    for (const c of g.children) {
      if (c.x + c.width > maxX) maxX = c.x + c.width;
      if (c.y + c.height > maxY) maxY = c.y + c.height;
    }
    g.setSize(Math.max(1, maxX), Math.max(1, maxY));
  };
  for (const c of g.children) {
    const previousResize = c.onResize;
    c.onResize = (...args) => {
      previousResize?.apply?.(c, args);
      recalculateBounds();
    };
  }
  recalculateBounds();
  g.setActivePage(0);
  return g;
}

/** Resolve a UO 16-bit hue index to the bright end of its real hues.mul
 *  palette. Text controls use a solid colour (rather than the 32-step item
 *  shader), matching ClassicUO's convention of sampling the final palette
 *  colour. The previous hash-based placeholder turned standard hues such as
 *  1152/1153 into low-contrast pink, making server gumps unreadable. */
function paletteHueToRgb(hue) {
  if (hue <= 0) return 0xfff0c0;
  if ((hue | 0) === 0x7fff) return 0xffffff;
  const index = ((hue | 0) & 0x3fff) - 1;
  const entry = assets.huesMeta?.hues?.[index];
  const color16 = entry?.tableEnd || entry?.tableStart;
  if (Number.isFinite(color16) && color16 > 0) {
    const r5 = (color16 >>> 10) & 0x1f;
    const g5 = (color16 >>> 5) & 0x1f;
    const b5 = color16 & 0x1f;
    const r = (r5 << 3) | (r5 >>> 2);
    const g = (g5 << 3) | (g5 >>> 2);
    const b = (b5 << 3) | (b5 >>> 2);
    return (r << 16) | (g << 8) | b;
  }
  // Asset-light tests and third-party shards may omit hues.json. Preserve a
  // readable neutral rather than inventing a random colour.
  return 0xfff0c0;
}
