// TooltipManager — caches per-serial tooltip line lists from 0xD6
// MegaCliloc, throws them up as a floating DOM panel near the cursor
// while the user hovers an entity. Mirrors ClassicUO's
// Game/Managers/ObjectPropertiesListManager.cs.
//
// Wave 9: per-line coloring. Different cliloc classes get distinct
// hues so artifacts pop in gold and resist values are colored per
// element (UO-canonical colors: phys grey, fire red, cold blue,
// poison green, energy yellow). The first line is always the item
// name (white). Artifact-tag line `[X]` is gold.

import { bus } from '../core/event-bus.js';
import { net } from '../net/net-client.js';
import { buildBatchQueryProperties } from '../net/outgoing.js';
import { assets } from '../assets/asset-manager.js';
import { profile } from './profile-manager.js';
import { dragDrop } from './drag-drop.js';
import { world } from '../world/world.js';
import { fallbackHueColor } from '../shared/hue-palette.js';
import { staticEntry } from '../shared/tiledata.js';

const DEFAULT_TOOLTIP_DELAY_MS = 400;
const DEFAULT_TOOLTIP_TEXT_COLOR = '#F0F0E0';
const TOOLTIP_REQUEST_COOLDOWN_MS = 1000;
const TOOLTIP_REQUEST_COOLDOWN_GC_MS = 30_000;
const TOOLTIP_HUE_CSS = new Map([
  [0xFFFF, '#FFFFFF'],
  [0x0481, '#FFF0C0'],
  [0x0099, '#FFD060'],
  [0x0058, '#80FFFF'],
]);

// HTML escape for safe innerHTML usage.
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// Resist colors mirror CUO ItemPropertiesGump.
const RESIST_COLORS = ['#C0C0C0', '#FF6060', '#80B0FF', '#80E080', '#FFD060'];

function clampNumber(value, fallback, min, max, integer = false) {
  const n = Number(value);
  const base = Number.isFinite(n) ? n : fallback;
  const clamped = Math.max(min, Math.min(max, base));
  return integer ? Math.round(clamped) : clamped;
}

export function tooltipHueToCss(hue) {
  const n = Number(hue);
  if (!Number.isFinite(n)) return DEFAULT_TOOLTIP_TEXT_COLOR;
  const id = n & 0xFFFF;
  const known = TOOLTIP_HUE_CSS.get(id);
  if (known) return known;
  const rgb = fallbackHueColor(id) & 0xFFFFFF;
  return `#${rgb.toString(16).padStart(6, '0').toUpperCase()}`;
}

export function tooltipProfileSettings(profileLike = profile) {
  const get = (path) => profileLike?.get?.(path);
  const textHue = get('tooltips.textHue') ?? 0xFFFF;
  return {
    enabled: get('tooltips.enabled') !== false,
    items: get('tooltips.items') !== false,
    mobs: get('tooltips.mobs') !== false,
    corpses: get('tooltips.corpses') !== false,
    echoToChat: get('tooltips.echoToChat') === true,
    holdAltToShow: get('tooltips.holdAltToShow') === true,
    colorResists: get('tooltips.colorResists') !== false,
    colorArtifact: get('tooltips.colorArtifact') !== false,
    compareEquipped: get('tooltips.compareEquipped') !== false,
    delayMs: clampNumber(get('tooltips.delayMs'), DEFAULT_TOOLTIP_DELAY_MS, 0, 2000, true),
    width: clampNumber(get('tooltips.width'), 280, 120, 520, true),
    fontSize: clampNumber(get('tooltips.fontSize'), 12, 8, 24, true),
    backgroundOpacity: clampNumber(get('tooltips.backgroundOpacity'), 0.78, 0, 1, false),
    textHue,
    textColor: tooltipHueToCss(textHue),
  };
}

export function tooltipCategoryForSerial(worldLike, serial, entity = null) {
  if (entity) {
    const itemId = entity.itemId ?? entity.graphic;
    if (entity.isCorpse || itemId === 0x2006) return 'corpses';
    if (itemId != null || entity.parent != null || entity.amount != null || entity.layer != null) return 'items';
    if (entity.body != null || entity.equipment != null || entity.notoriety != null) return 'mobs';
  }

  const s = serial >>> 0;
  if (worldLike?.mobiles?.get?.(s)) return 'mobs';
  const item = worldLike?.items?.get?.(s);
  if (item) return (item.isCorpse || item.itemId === 0x2006) ? 'corpses' : 'items';
  return 'items';
}

export function tooltipSettingsAllowCategory(settings, category) {
  if (settings?.enabled === false) return false;
  if (category === 'mobs') return settings?.mobs !== false;
  if (category === 'corpses') return settings?.corpses !== false;
  return settings?.items !== false;
}

/**
 * Decide a CSS color string for one tooltip line. The decision uses
 * the cliloc id (well-known artifact / resist tags) plus a fallback
 * heuristic on the rendered text.
 *
 * Returns null to leave the line in the panel's default style.
 */
export function tooltipLineColor(line, rendered, isFirst, settings = tooltipProfileSettings()) {
  const id = line?.cliloc;
  // First line = item name. Artifacts override below.
  if (isFirst) return settings?.textColor ?? DEFAULT_TOOLTIP_TEXT_COLOR;
  // Artifact name marker — wrapped in [..] in the OPL provider.
  if (settings?.colorArtifact !== false
      && id === 1042971 && rendered.startsWith('[') && rendered.endsWith(']')) return '#FFD700';
  // Wave 12: "(Unidentified)" teaser line — gold-ish purple to draw the
  // player's eye toward running ItemID on the drop.
  if (id === 1042971 && rendered === '(Unidentified)') return '#C080FF';
  // Wave 21: imbue weight gauge — neutral teal so it reads as info
  // (not a stat, not a warning).
  if (id === 1042971 && rendered.startsWith('Imbue Weight: ')) return '#80C0C0';
  // Wave 29: GM lock badge — strong red to signal "do not modify".
  if (id === 1042971 && rendered === '(Locked)') return '#FF6060';
  if (settings?.colorArtifact !== false && id === 1063341) return '#FFD700';     // "Artifact" cliloc tag
  // Resists composite line "Resists a/b/c/d/e" — gradient handled in renderer
  // (return sentinel so the renderer knows to multi-color the numbers).
  if (settings?.colorResists !== false && id === 1042971 && rendered.startsWith('Resists ')) return 'multi-resist';
  // AOS attributes — cyan/teal block.
  if (id >= 1075600 && id <= 1075999) return '#80FFFF';
  // Weapon-specific attribute clilocs (1111900+) — orange-yellow.
  if (id >= 1111900 && id <= 1112099) return '#FFC080';
  // Skill bonuses come through 1042971 with "+5.0 SkillName" text.
  if (id === 1042971 && /^\+[\d.]+\s+\w/.test(rendered)) return '#88FFAA';
  return null;
}

/**
 * Render the resist composite "Resists 12/8/5/0/3" with one span per
 * element using RESIST_COLORS. Falls through to plain rendering when
 * the format doesn't match.
 */
export function renderTooltipResistLine(text, settings = tooltipProfileSettings()) {
  if (settings?.colorResists === false) return esc(text);
  const m = text.match(/^Resists\s+(.+)$/);
  if (!m) return esc(text);
  const parts = m[1].split('/');
  if (parts.length !== 5) return esc(text);
  const colored = parts.map((v, i) => `<span style="color:${RESIST_COLORS[i]}">${esc(v)}</span>`).join('/');
  return `Resists ${colored}`;
}

function tooltipPlainText(text) {
  return String(text ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract comparable numeric OPL attributes without depending on cliloc ids. */
export function tooltipNumericStats(lines, resolve = (line) => assets.cl(line.cliloc, line.args)) {
  const result = new Map();
  for (const line of lines ?? []) {
    const text = tooltipPlainText(resolve(line));
    const resist = text.match(/^Resists\s+([+-]?\d+)\/([+-]?\d+)\/([+-]?\d+)\/([+-]?\d+)\/([+-]?\d+)$/i);
    if (resist) {
      ['physical resist', 'fire resist', 'cold resist', 'poison resist', 'energy resist']
        .forEach((key, index) => result.set(key, Number(resist[index + 1])));
      continue;
    }
    const match = text.match(/^(.+?)\s+([+-]?\d+(?:\.\d+)?)%?$/);
    if (!match) continue;
    const key = match[1].replace(/[:\s]+$/g, '').trim().toLowerCase();
    if (key && key !== 'weight' && key !== 'durability') result.set(key, Number(match[2]));
  }
  return result;
}

class TooltipManager {
  constructor() {
    /** @type {Map<number, {cliloc:number,args:string}[]>} */
    this._cache = new Map();
    /** @type {HTMLElement | null} */
    this._panel = null;
    /** @type {Set<number>} pending property requests (deduped) */
    this._pending = new Set();
    /** Flush window for batched 0xD6 requests. */
    this._flushTimer = null;
    this._altDown = false;
    this._renderedKey = '';
    this._renderedSerial = 0;
    this._appliedStyleKey = '';
    this._requestCooldown = new Map();
    this._lastRequestCooldownGcAt = 0;

    /** @type {Map<number, number>} per-serial revision hash from 0xDC. */
    this._revisions = new Map();

    bus.on('tooltip:lines', ({ serial, revision, lines }) => {
      const s = serial >>> 0;
      this._cache.set(s, lines);
      if (this._renderedSerial === s) this._renderedKey = '';
      if (revision != null) this._revisions.set(s, revision >>> 0);
    });

    // 0xDC OPLInfo — server's "the properties of <serial> are now revision X".
    // CUO's ObjectPropertiesListManager compares the incoming hash against its
    // cached one and discards the cached lines on mismatch (next hover then
    // refetches via 0xD6). Without this consumer our cache went stale forever
    // — fixed/upgraded items would keep showing pre-mod tooltips.
    // Cliloc late-arrival invalidate. If the user hovered an item
    // BEFORE `cliloc.json` finished loading, `assets.cl()` returned the
    // literal `#NNNN` placeholder and we cached that. Once the file
    // lands and emits `cliloc:ready`, drop every cached line so the
    // next hover re-resolves through the now-populated table.
    bus.on('cliloc:ready', () => {
      this._cache.clear();
      this._renderedKey = '';
      // Keep `_revisions` — the server-side hashes are unrelated.
    });
    // Audit rev.4 P2 — auto-batch on entity approach. CUO's
    // ObjectPropertiesListManager pre-fetches OPL (0xD6) when an
    // entity enters the client view range so the first hover is
    // instant. Without this, every cold-cache hover lagged a server
    // round-trip. We piggyback on `mobile:incoming` (already emitted
    // from handlers.js:279) and `item:placed` (handlers.js:374,389,420).
    bus.on('mobile:incoming', (m) => {
      if (m?.serial) this.request(m.serial, m);
    });
    bus.on('item:placed', (it) => {
      if (it?.serial) this.request(it.serial, it);
    });
    bus.on('tooltip:revision', ({ serial, revision }) => {
      const s = serial >>> 0;
      // Audit #38 P2 #4 — CUO `ObjectPropertiesListManager.IsRevisionEquals`
      // strips the high bit `0x40000000` (server-side "vendor-stocked"
      // flag, not part of the hash). Was: raw u32 compare — every 0xDC
      // on a vendor item flipped the cache check, fetching 0xD6 again
      // per hover. Network spam + flickering tooltips for shopkeepers.
      const rev = (revision >>> 0) & ~0x40000000;
      const have = this._revisions.get(s);
      if (have !== rev) {
        this._cache.delete(s);
        this._revisions.delete(s);
        if (this._renderedSerial === s) this._renderedKey = '';
        // Audit #34 P1 #2 — CUO `PacketHandlers.cs:5349` immediately
        // calls `AddMegaClilocRequest(serial)` after a revision drop.
        // We were leaving the cache empty until the user re-hovered,
        // which never happens for already-displayed UI surfaces (info
        // bar, worn-weapon proc display). The first-time-revision path
        // (have === undefined) is left alone so we don't bounce a
        // request against an unseen entity.
        if (have !== undefined) this.request(s, null, { force: true });
      }
    });

    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Alt' || e.altKey) this._altDown = true;
      }, true);
      window.addEventListener('keyup', (e) => {
        this._altDown = !!e.altKey && e.key !== 'Alt';
      }, true);
      window.addEventListener('blur', () => { this._altDown = false; });
    }
  }

  _canUseSerial(serial, entity = null, settings = tooltipProfileSettings()) {
    const category = tooltipCategoryForSerial(world, serial, entity);
    return tooltipSettingsAllowCategory(settings, category);
  }

  _canDisplayTooltip(settings) {
    return settings.enabled !== false
      && (!settings.holdAltToShow || this._altDown);
  }

  _ensurePanel(settings) {
    if (!this._panel) {
      const el = document.createElement('div');
      el.className = 'uo-panel';
      el.style.position = 'fixed';
      el.style.padding = '6px 10px';
      el.style.pointerEvents = 'none';
      el.style.zIndex = '9999';
      el.style.whiteSpace = 'pre-wrap';
      el.style.boxSizing = 'border-box';
      document.body.appendChild(el);
      this._panel = el;
    }
    this._applyPanelStyle(settings);
    return this._panel;
  }

  _applyPanelStyle(settings) {
    if (!this._panel) return;
    const key = this._settingsKey(settings);
    if (key === this._appliedStyleKey) return;
    this._appliedStyleKey = key;
    this._panel.style.font = `500 ${settings.fontSize}px/1.4 "Segoe UI Variable Text", "Segoe UI", Inter, system-ui, sans-serif`;
    this._panel.style.maxWidth = `${settings.width}px`;
    this._panel.style.background = `rgba(12, 16, 24, ${settings.backgroundOpacity})`;
    this._panel.style.color = settings.textColor;
  }

  _maybeEchoToChat(serial, lines, settings) {
    if (!settings.echoToChat) return;
    let joinedForKey = '';
    let joinedForChat = '';
    let count = 0;
    for (const line of lines) {
      const part = tooltipPlainText(assets.cl(line.cliloc, line.args));
      if (!part) continue;
      if (count > 0) {
        joinedForKey += '\n';
        joinedForChat += ' | ';
      }
      joinedForKey += part;
      joinedForChat += part;
      count++;
    }
    if (count === 0) return;
    const key = `${serial >>> 0}:${this._revisions.get(serial >>> 0) ?? ''}:${joinedForKey}`;
    if (this._lastEchoKey === key) return;
    this._lastEchoKey = key;
    const text = joinedForChat.length > 600 ? `${joinedForChat.slice(0, 597)}...` : joinedForChat;
    bus.emit('message:journal', {
      text: `[OPL] ${text}`,
      textType: 1,
      hue: settings.textHue,
    });
  }

  _settingsKey(settings) {
    return [
      settings.width,
      settings.fontSize,
      settings.backgroundOpacity,
      settings.textHue,
      settings.colorResists ? 1 : 0,
      settings.colorArtifact ? 1 : 0,
      settings.compareEquipped ? 1 : 0,
    ].join(':');
  }

  _linesKey(serial, lines, settings) {
    let key = `${serial >>> 0}:${this._revisions.get(serial >>> 0) ?? ''}:${this._settingsKey(settings)}`;
    for (const l of lines) key += `|${l.cliloc}:${l.args ?? ''}:${l.hue ?? ''}`;
    return key;
  }

  _equippedComparisonSerial(serial, settings) {
    if (!settings.compareEquipped) return 0;
    const item = world.items?.get?.(serial >>> 0);
    if (!item || item.parent === world.player?.serial) return 0;
    let layer = item.layer | 0;
    if (!layer) layer = staticEntry(assets.tiledata, item.itemId ?? item.graphic)?.layer | 0;
    if (layer <= 0 || layer === 21 || layer === 25 || layer >= 26) return 0;
    let equipped = world.player?.equipment?.get?.(layer);
    if (!equipped && (layer === 1 || layer === 2)) {
      equipped = world.player?.equipment?.get?.(layer === 1 ? 2 : 1);
    }
    const other = equipped?.serial >>> 0;
    return other && other !== (serial >>> 0) ? other : 0;
  }

  /** Ask the server for properties on `serial`. Calls are batched into
   *  a single 0xD6 BatchQueryProperties packet every 50 ms. */
  request(serial, entity = null, opts = {}) {
    const s = serial >>> 0;
    if (!this._canUseSerial(s, entity)) return;
    if (this._cache.has(s)) return;
    if (this._pending.has(s)) return;
    const now = performance.now();
    if (!opts.force) {
      const last = this._requestCooldown.get(s) || 0;
      if (last && now - last < TOOLTIP_REQUEST_COOLDOWN_MS) return;
    }
    this._pending.add(s);
    this._scheduleFlush();
  }

  _gcRequestCooldown(now = performance.now()) {
    if (now - this._lastRequestCooldownGcAt < TOOLTIP_REQUEST_COOLDOWN_GC_MS) return;
    this._lastRequestCooldownGcAt = now;
    const cutoff = now - TOOLTIP_REQUEST_COOLDOWN_MS * 4;
    for (const [serial, at] of this._requestCooldown) {
      if (at < cutoff && !this._pending.has(serial)) this._requestCooldown.delete(serial);
    }
  }

  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => this._flushPending(), 50);
  }

  _flushPending() {
    this._flushTimer = null;
    if (this._pending.size === 0) return;
    const settings = tooltipProfileSettings();
    const serials = [];
    const now = performance.now();
    this._gcRequestCooldown(now);
    for (const pendingSerial of this._pending) {
      if (!this._canUseSerial(pendingSerial, null, settings)) {
        this._pending.delete(pendingSerial);
        continue;
      }
      serials.push(pendingSerial);
      this._requestCooldown.set(pendingSerial, now);
      this._pending.delete(pendingSerial);
      if (serials.length >= 64) break;
    }
    if (this._pending.size > 0) this._scheduleFlush();
    if (serials.length === 0) return;
    net.send(buildBatchQueryProperties(serials));
  }

  /** Render-or-update the tooltip panel at (sx, sy) for the given serial.
   *  Hover-delay gate: the panel only paints once the cursor has dwelled
   *  on the same serial for `profile.get('tooltips.delayMs') ?? 400` ms.
   *  Mirrors CUO `TooltipManager.cs` + `ProfileManager.CurrentProfile.
   *  TooltipDelayBeforeDisplay`. The options-gump slider that configures
   *  this value was previously a dead control — show() ran on every
   *  mousemove. */
  show(serial, sx, sy) {
    // Audit #33 P3.2 — CUO `Control.OnMouseOver` short-circuits tooltip
    // while `GameCursor.ItemHold.Enabled`. Suppressing here so the held
    // item visual under the cursor isn't occluded by a stale tooltip
    // for the entity behind it.
    const s = serial >>> 0;
    const settings = tooltipProfileSettings();
    if (dragDrop?.isHolding?.()
        || !this._canDisplayTooltip(settings)
        || !this._canUseSerial(s, null, settings)) { this.hide(); return; }
    const now = performance.now();
    const delay = settings.delayMs;
    if (this._pendingHover?.serial !== s) {
      this._pendingHover = { serial: s, sx, sy, at: now };
    } else {
      // Refresh coords every move so the panel anchors near where the
      // cursor ended up dwelling, not where it first crossed in.
      this._pendingHover.sx = sx;
      this._pendingHover.sy = sy;
    }
    if (now - this._pendingHover.at < delay) {
      // Still pre-delay — request the data so it's ready when the
      // timer elapses, but DON'T paint yet.
      this.request(serial);
      return;
    }
    const lines = this._cache.get(s);
    if (!lines || lines.length === 0) {
      this.request(serial);
      return;
    }
    const comparisonSerial = this._equippedComparisonSerial(s, settings);
    const comparisonLines = comparisonSerial ? this._cache.get(comparisonSerial) : null;
    if (comparisonSerial && !comparisonLines) this.request(comparisonSerial);
    const panel = this._ensurePanel(settings);
    this._panel.style.left = `${sx + 16}px`;
    this._panel.style.top  = `${sy + 16}px`;
    const renderKey = this._linesKey(s, lines, settings)
      + (comparisonLines ? `::cmp:${this._linesKey(comparisonSerial, comparisonLines, settings)}` : '');
    if (renderKey === this._renderedKey) {
      panel.style.display = '';
      this._maybeEchoToChat(s, lines, settings);
      return;
    }
    // Wave 9: render per-line colored spans. Each line is wrapped in
    // its own div so per-line colors don't bleed across lines.
    // CUO `ItemPropertiesGump.cs` honours `<basefont color=#RRGGBB>`
    // and `<br>` tags inside cliloc text — quest givers / artifact
    // descriptions colour key words. We parse those before HTML-escape
    // so per-line server hues survive; literal `<` `>` in normal text
    // still gets escaped.
    let html = '';
    for (let idx = 0; idx < lines.length; idx++) {
      const l = lines[idx];
      const text = assets.cl(l.cliloc, l.args) ?? '';
      if (!text) continue;
      const color = tooltipLineColor(l, text, idx === 0, settings);
      if (color === 'multi-resist') {
        html += `<div>${renderTooltipResistLine(text, settings)}</div>`;
        continue;
      }
      const inner = parseSpeechHtml(text);
      html += color ? `<div style="color:${color}">${inner}</div>` : `<div>${inner}</div>`;
    }
    if (comparisonLines?.length) {
      const candidateStats = tooltipNumericStats(lines);
      const equippedStats = tooltipNumericStats(comparisonLines);
      html += '<div style="margin:6px 0 3px;border-top:1px solid #80652f;padding-top:4px;color:#d8bb72">Compared with equipped</div>';
      const equippedName = tooltipPlainText(assets.cl(comparisonLines[0]?.cliloc, comparisonLines[0]?.args)) || 'Equipped item';
      html += `<div style="color:#b8b1a0">${esc(equippedName)}</div>`;
      let shown = 0;
      for (const [key, value] of candidateStats) {
        if (!equippedStats.has(key)) continue;
        const delta = value - equippedStats.get(key);
        if (!delta) continue;
        const color = delta > 0 ? '#77e38d' : '#ff7777';
        html += `<div style="color:${color}">${esc(key)}: ${delta > 0 ? '+' : ''}${delta}</div>`;
        if (++shown >= 8) break;
      }
      if (!shown) html += '<div style="color:#8f8a7c">No directly comparable numeric changes</div>';
    }
    panel.innerHTML = html;
    this._renderedKey = renderKey;
    this._renderedSerial = s;
    panel.style.display = '';
    this._maybeEchoToChat(s, lines, settings);
  }

  /** Show a literal string at (sx, sy) — used by BuffGump and InfoBar
   *  for cliloc-resolved labels we don't want to push through the
   *  serial cache. */
  showText(sx, sy, text) {
    if (!text) return;
    const settings = tooltipProfileSettings();
    if (!this._canDisplayTooltip(settings)) { this.hide(); return; }
    const panel = this._ensurePanel(settings);
    panel.style.left = `${sx + 16}px`;
    panel.style.top  = `${sy + 16}px`;
    this._renderedKey = '';
    this._renderedSerial = 0;
    panel.textContent = String(text);
    panel.style.display = '';
  }

  hide() {
    this._pendingHover = null;
    this._renderedKey = '';
    this._renderedSerial = 0;
    if (this._panel) this._panel.style.display = 'none';
  }
}

export const tooltips = new TooltipManager();

/** Convert a CUO-style cliloc snippet to safe HTML:
 *  - `<basefont color="#RRGGBB">...</basefont>` → `<span style="color:#RRGGBB">...</span>`
 *  - `<br>` (and `<br/>`) → literal newline (whiteSpace: pre-wrap renders it)
 *  - everything else escaped.
 *  Mirrors `ClassicUO/Game/Managers/MessageManager.cs HandleMessage`
 *  inline-tag handling at MVP scope. */
function parseSpeechHtml(text) {
  const out = [];
  // Audit #38 P3 #8 — CUO `RenderedText.cs:508` honours `<i>`/`<b>`/`<u>`
  // (FontStyle bits). Common in seer announcements, BOD reward text,
  // GM whispers. Was: only `<basefont color>` + `<br>`. Other tags
  // were HTML-escaped to literal `&lt;I&gt;…&lt;/I&gt;`.
  const re = /<basefont\s+color\s*=\s*"?(#?[0-9a-fA-F]{6}|[a-zA-Z]+)"?\s*>([\s\S]*?)<\/basefont>|<br\s*\/?>|<i>([\s\S]*?)<\/i>|<b>([\s\S]*?)<\/b>|<u>([\s\S]*?)<\/u>/gi;
  let lastIdx = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) out.push(esc(text.slice(lastIdx, m.index)));
    const tag = m[0].toLowerCase();
    if (tag.startsWith('<br')) {
      out.push('<br>');
    } else if (tag.startsWith('<basefont')) {
      let col = m[1] ?? '';
      if (col && !col.startsWith('#') && /^[0-9a-fA-F]{6}$/.test(col)) col = '#' + col;
      out.push(`<span style="color:${col}">${esc(m[2] ?? '')}</span>`);
    } else if (tag.startsWith('<i>')) {
      out.push(`<em>${esc(m[3] ?? '')}</em>`);
    } else if (tag.startsWith('<b>')) {
      out.push(`<strong>${esc(m[4] ?? '')}</strong>`);
    } else if (tag.startsWith('<u>')) {
      out.push(`<u>${esc(m[5] ?? '')}</u>`);
    }
    lastIdx = re.lastIndex;
  }
  if (lastIdx < text.length) out.push(esc(text.slice(lastIdx)));
  return out.join('');
}
