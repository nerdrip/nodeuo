// OptionsGump — multi-tab settings panel. Mirrors ClassicUO's
// Game/UI/Gumps/OptionsGump.cs. Tabs (12): Audio, Gameplay, Graphics,
// Input, Combat, Chat, Tooltips, Containers, Counters, World/Map, Voice,
// Experimental — at parity with CUO's section coverage.
//
// All values are stored under the `profile` manager (per-character JSON)
// so they round-trip across sessions. Live consumers (audio-manager,
// renderer, ui-manager, hotkeys-manager) listen to `profile:changed`.

import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Checkbox } from '../controls/checkbox.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { Control } from '../control.js';
import { profile } from '../../managers/profile-manager.js';

// Canonical UO horizontal slider gump ids — used by ClassicUO's
// Slider — custom-drawn (recessed gutter + filled portion + round
// knob). We used to mount the UO 0x0845/0x0846/0x0847 3-piece track
// here, but the middle "rope" segment doesn't tile cleanly when
// stretched to ~180 px (Marcin: "slidery maja kiepsa grafike") — the
// shimmering gold-chain look fought the rest of the panel chrome.
// The Graphics-drawn version reads as clean recessed metal with a
// warm cream fill that matches the gump's parchment label hue.
const SLIDER_W = 110;
const SLIDER_H = 16;
const SLIDER_TRACK_H = 6;
const SLIDER_KNOB_R = 7;

// Padding around the tab-content area. Earlier sliders and labels were
// flush against the WindowGump chrome on the left + top — adding a
// breath of margin matches the paperdoll / spellbook chrome and the
// user asked for "padding zeby ladniej wyglądalo".
const PAD_X = 22;
const CONTENT_START_Y = 42;
const CONTENT_PAD_BOTTOM = 10;
const OPTIONS_W = 900;
const SIDEBAR_W = 178;
const CONTENT_X = 190;

class Slider extends Control {
  constructor({ width = SLIDER_W, value = 0.5, onChange }) {
    super();
    this.width = width;
    this.height = SLIDER_H;
    this._value = Math.max(0, Math.min(1, value));
    this._onChange = onChange;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this.acceptMouseInput = true;
    this._draw();
  }
  get value() { return this._value; }
  setValue(v, { silent = false } = {}) {
    this._value = Math.max(0, Math.min(1, v));
    this._draw();
    if (!silent) this._onChange?.(this._value);
  }
  onMouseDown(_btn, lx) { this.setValue(lx / this.width); }
  _draw() {
    const w = this.width;
    const trackY = (SLIDER_H - SLIDER_TRACK_H) >> 1;
    const fillW = Math.round(this._value * w);
    const knobX = Math.round(this._value * (w - SLIDER_KNOB_R * 2)) + SLIDER_KNOB_R;
    this._gfx.clear();
    // Recessed gutter (full width).
    this._gfx.roundRect(0, trackY, w, SLIDER_TRACK_H, SLIDER_TRACK_H >> 1)
      .fill({ color: 0x0a0908, alpha: 0.85 })
      .stroke({ width: 1, color: 0x3a2a14, alpha: 0.8 });
    // Cream fill up to the current value.
    if (fillW > 2) {
      this._gfx.roundRect(0, trackY, fillW, SLIDER_TRACK_H, SLIDER_TRACK_H >> 1)
        .fill({ color: 0xc09060, alpha: 0.95 });
    }
    // Round knob with thin dark border.
    this._gfx.circle(knobX, SLIDER_H >> 1, SLIDER_KNOB_R)
      .fill({ color: 0xfff0c0 })
      .stroke({ width: 1.5, color: 0x3a2a14 });
  }
}

/** Vertical category button used by the settings sidebar. */
class TabButton extends Control {
  constructor({ label, index = 0, active = false, onClick }) {
    super();
    this.width = 158;
    this.height = 34;
    this._label = label;
    this._index = index;
    this._active = active;
    this._onClick = onClick;
    this.acceptMouseInput = true;
    this._bg = new Graphics();
    this.node.addChild(this._bg);
    this._num = new Label(String(index + 1).padStart(2, '0'), {
      fontSize: 10, hue: 0x8f7955, fontWeight: 700,
    });
    this._num.setPosition(10, 10);
    this._num.acceptMouseInput = false;
    this.add(this._num);
    this._lbl = new Label(label, { fontSize: 13, hue: 0xd8cfbd, fontWeight: 600 });
    this._lbl.acceptMouseInput = false;
    this._lbl.setPosition(38, 7);
    this.add(this._lbl);
    this._apply(false);
  }
  setActive(v) { this._active = !!v; this._apply(false); }
  onMouseDown() { this._onClick?.(); }
  onMouseEnter() { this._apply(true); }
  onMouseLeave() { this._apply(false); }
  _apply(hover) {
    if (!this._bg || this._bg.destroyed) return;
    const fill = this._active ? 0x353f50 : (hover ? 0x252d3a : 0x171c24);
    const edge = this._active ? 0xd8ae62 : (hover ? 0x75613f : 0x34312b);
    this._bg.clear()
      .roundRect(0, 0, this.width, this.height, 6)
      .fill({ color: fill, alpha: this._active ? 0.98 : 0.82 })
      .stroke({ width: 1, color: edge, alpha: 0.95 });
    if (this._active) this._bg.roundRect(0, 5, 3, this.height - 10, 2)
      .fill({ color: 0xf0bd63, alpha: 1 });
    this._lbl.setHue?.(this._active ? 0xffe2aa : (hover ? 0xf1eadc : 0xbab3a6));
    this._num.setHue?.(this._active ? 0xe7b85f : 0x776b58);
  }
}

export class OptionsGump extends WindowGump {
  constructor() {
    const scale = Math.max(0.75, Number(profile.get('ui.scale')) || 1);
    const logicalW = (globalThis.innerWidth || 1280) / scale;
    const logicalH = (globalThis.innerHeight || 800) / scale;
    const height = Math.max(510, Math.min(620, Math.floor(logicalH - 24)));
    super({
      title: 'Settings', width: OPTIONS_W, height,
      x: Math.max(12, Math.round((logicalW - OPTIONS_W) / 2)),
      y: Math.max(12, Math.round((logicalH - height) / 2)),
    });

    /** @type {{ id:string, label:string, build:(yStart:number)=>void }[]} */
    this._tabs = [
      { id: 'audio', label: 'Audio', description: 'Volume, music and positional sound.', columns: ['Volume & playback', 'Sound behaviour'], build: (y) => this._buildAudio(y) },
      { id: 'gameplay', label: 'Gameplay', description: 'Movement, feedback and world interaction.', columns: ['Movement & feedback', 'World interaction'], build: (y) => this._buildGameplay(y) },
      { id: 'graphics', label: 'Graphics', description: 'Rendering quality, lighting and interface scale.', columns: ['Display & effects', 'Lighting & advanced'], build: (y) => this._buildGraphics(y) },
      { id: 'input', label: 'Input', description: 'Mouse, keyboard and drag-selection behaviour.', columns: ['Mouse & keyboard', 'Drag & selection'], build: (y) => this._buildInput(y) },
      { id: 'combat', label: 'Combat', description: 'Targeting, health feedback and combat presentation.', columns: ['Combat feedback', 'Targeting & health bars'], build: (y) => this._buildCombat(y) },
      { id: 'chat', label: 'Chat & journal', description: 'Messages, overhead speech and journal display.', columns: ['Chat display', 'Journal & overhead'], build: (y) => this._buildChat(y) },
      { id: 'tooltips', label: 'Tooltips', description: 'Object information, comparison and login helpers.', columns: ['Tooltip presentation', 'Journal & login'], build: (y) => this._buildTooltips(y) },
      { id: 'cont', label: 'Containers', description: 'Backpack layout, item handling and limits.', columns: ['Container behaviour', 'Layout & limits'], build: (y) => this._buildContainers(y) },
      { id: 'counters', label: 'Counter bar', description: 'Tracked items, grid size and refresh behaviour.', columns: ['Counter display', 'Grid behaviour'], build: (y) => this._buildCounters(y) },
      { id: 'world', label: 'World map', description: 'Map markers, party information and overlays.', columns: ['Map behaviour', 'Markers & overlays'], build: (y) => this._buildWorld(y) },
      { id: 'voice', label: 'Accessibility', description: 'Text-to-speech and browser voice configuration.', columns: ['Text to speech', 'Voice engine'], build: (y) => this._buildVoice(y) },
      { id: 'exp', label: 'Advanced', description: 'Diagnostics and experimental client features.', columns: ['Diagnostics', 'Experimental behaviour'], build: (y) => this._buildExperimental(y) },
    ];
    this._tabButtons = [];
    this._tabContent = [];

    this._chrome = new Graphics();
    this.node.addChildAt(this._chrome, Math.min(1, this.node.children.length));
    this._drawChrome();

    const navTitle = new Label('CATEGORIES', { fontSize: 10, hue: 0x8f8677, fontWeight: 700 });
    navTitle.setPosition(18, 31); this.add(navTitle);
    this._sectionTitle = new Label('', { fontSize: 21, hue: 0xffe0a3, fontWeight: 650 });
    this._sectionTitle.setPosition(CONTENT_X + 12, 27); this.add(this._sectionTitle);
    this._sectionDescription = new Label('', { fontSize: 12, hue: 0xa9a69f, fontWeight: 450 });
    this._sectionDescription.setPosition(CONTENT_X + 12, 53); this.add(this._sectionDescription);

    let ty = 49;
    for (let index = 0; index < this._tabs.length; index++) {
      const tab = this._tabs[index];
      const btn = new TabButton({
        label: tab.label,
        index,
        active: tab.id === 'audio',
        onClick: () => this._showTab(tab.id),
      });
      btn.setPosition(11, ty);
      this.add(btn);
      this._tabButtons.push({ id: tab.id, ctrl: btn });
      ty += 38;
    }

    this._contentScroll = new ScrollArea({
      width: this.width - CONTENT_X - 12,
      height: this.height - 84,
    });
    this._contentScroll.setPosition(CONTENT_X, 72);
    this.add(this._contentScroll);

    const footer = new Label('Changes are saved automatically  ·  RMB closes', {
      fontSize: 10, hue: 0x736c60, fontWeight: 500,
    });
    footer.setPosition(CONTENT_X + 12, this.height - 20); this.add(footer);

    this._showTab('audio');
  }

  _showTab(id) {
    this._activeTabId = id;
    for (const tb of this._tabButtons) tb.ctrl.setActive(tb.id === id);
    const target = this._tabs.find((t) => t.id === id);
    this._sectionTitle?.setText?.(target?.label ?? 'Settings');
    this._sectionDescription?.setText?.(target?.description ?? '');
    this._contentScroll?.beginBulkUpdate?.();
    this._buildingTab = true;
    try {
      // Dispose old controls (releases their Pixi resources + drops
      // event subscriptions) through ScrollArea.remove so its hit-test
      // list does not keep dead controls after repeated tab swaps.
      for (const c of this._tabContent) {
        try { this._contentScroll?.remove?.(c); } catch { /* ignore */ }
        try { c.dispose?.(); } catch { /* ignore */ }
      }
      this._tabContent = [];
      if (this._contentDecor) {
        try { this._contentDecor.destroy(); } catch { /* already destroyed */ }
        this._contentDecor = null;
      }
      this._contentScroll?.scrollTo(0);
      target?.build(CONTENT_START_Y);
      this._addColumnHeading(target?.columns?.[0] ?? 'General', PAD_X);
      this._addColumnHeading(target?.columns?.[1] ?? 'Advanced', PAD_X + 330);
    } finally {
      this._buildingTab = false;
      this._contentScroll?.endBulkUpdate?.();
    }
    this._refreshContentHeight();
    this._drawContentPanels();
  }

  _drawChrome() {
    this._chrome.clear();
    this._chrome.roundRect(8, 24, SIDEBAR_W - 12, this.height - 34, 8)
      .fill({ color: 0x10151d, alpha: 0.78 })
      .stroke({ width: 1, color: 0x34312b, alpha: 0.9 });
    this._chrome.roundRect(CONTENT_X - 4, 24, this.width - CONTENT_X - 4, this.height - 34, 8)
      .fill({ color: 0x111821, alpha: 0.54 })
      .stroke({ width: 1, color: 0x40392e, alpha: 0.75 });
    this._chrome.moveTo(CONTENT_X - 4, 67).lineTo(this.width - 8, 67)
      .stroke({ width: 1, color: 0x5b4a32, alpha: 0.55 });
  }

  _addColumnHeading(text, x) {
    const heading = new Label(String(text).toUpperCase(), {
      fontSize: 10, hue: 0xd8ad63, fontWeight: 750,
    });
    heading.setPosition(x, 9);
    this._addControl(heading);
  }

  _drawContentPanels() {
    if (!this._contentScroll?.content) return;
    let bottom = CONTENT_START_Y + 60;
    for (const c of this._tabContent) bottom = Math.max(bottom, (c?.y || 0) + (c?.height || 0));
    const panelH = Math.max(this._contentScroll.height - 10, bottom + 10);
    if (this._contentDecor) {
      try { this._contentDecor.destroy(); } catch { /* noop */ }
    }
    const gfx = new Graphics();
    gfx.roundRect(8, 32, 322, panelH - 32, 7)
      .fill({ color: 0x0c1118, alpha: 0.52 })
      .stroke({ width: 1, color: 0x343b44, alpha: 0.65 });
    gfx.roundRect(338, 32, 344, panelH - 32, 7)
      .fill({ color: 0x0c1118, alpha: 0.52 })
      .stroke({ width: 1, color: 0x343b44, alpha: 0.65 });
    this._contentScroll.content.addChildAt(gfx, 0);
    this._contentDecor = gfx;
  }

  _addControl(c) {
    if (this._contentScroll) this._contentScroll.add(c);
    else this.add(c);
    this._tabContent.push(c);
    if (!this._buildingTab) {
      this._refreshContentHeight();
      this._drawContentPanels();
    }
  }

  _refreshContentHeight() {
    if (!this._contentScroll) return;
    let bottom = 0;
    for (const c of this._tabContent) {
      if (!c || c.node?.destroyed) continue;
      bottom = Math.max(bottom, c.y + c.height);
    }
    this._contentScroll.setContentHeight(bottom + CONTENT_PAD_BOTTOM);
  }

  _addSlider(label, path, y, x = PAD_X, opts = {}) {
    const min = Number.isFinite(opts.min) ? opts.min : 0;
    const max = Number.isFinite(opts.max) ? opts.max : 1;
    const step = Number.isFinite(opts.step) && opts.step > 0 ? opts.step : 0;
    const raw = Number(profile.get(path) ?? opts.default ?? min);
    const norm = max > min ? (raw - min) / (max - min) : raw;
    const formatValue = (value) => {
      if (typeof opts.format === 'function') return String(opts.format(value));
      if (opts.integer || step >= 1) return String(Math.round(value));
      if (min === 0 && max === 1) return `${Math.round(value * 100)}%`;
      return Number(value).toFixed(step > 0 && step < 0.1 ? 2 : 1);
    };
    const lbl = new Label(label, { fontSize: 13, hue: 0xe7dfd0, fontWeight: 550 });
    lbl.setPosition(x, y);
    this._addControl(lbl);
    const sliderWidth = opts.width ?? 92;
    const sl = new Slider({
      width: sliderWidth,
      value: norm,
      onChange: (v) => {
        let next = min + (max - min) * v;
        if (step > 0) next = Math.round(next / step) * step;
        if (opts.integer) next = Math.round(next);
        profile.set(path, next);
        valueLbl.setText(formatValue(next));
      },
    });
    sl.setPosition(x + 158, y);
    this._addControl(sl);
    const valueLbl = new Label(formatValue(raw), {
      fontSize: 11, hue: 0xd8ad63, fontWeight: 700,
    });
    // Reserve a fixed value lane inside the column. The previous x+298
    // placement left only a handful of pixels before the panel edge, so
    // `100%` and five-digit values escaped into the next column.
    valueLbl.setPosition(x + 258, y);
    this._addControl(valueLbl);
  }

  _addCheckbox(label, path, y, x = PAD_X) {
    const cb = new Checkbox({
      switchId: 0, kind: 'checkbox',
      checked: !!profile.get(path), size: 16,
    });
    cb.setPosition(x, y);
    const baseOnClick = cb.onClick.bind(cb);
    cb.onClick = (...a) => {
      baseOnClick(...a);
      profile.set(path, cb.checked);
    };
    this._addControl(cb);
    const lbl = new Label(label, { fontSize: 13, hue: 0xe7dfd0, fontWeight: 520 });
    lbl.setPosition(x + 22, y + 1);
    lbl.acceptMouseInput = true;
    lbl.onClick = () => cb.onClick?.();
    this._addControl(lbl);
  }

  /** Value-cycling picker — click increments through `options`. Used for
   *  small enums (HP display type, grid-loot mode, font index) where a
   *  full Combobox would be overkill. */
  _addPicker(label, path, options, y, x = PAD_X + 330) {
    const lbl = new Label(label, { fontSize: 13, hue: 0xe7dfd0, fontWeight: 550 });
    lbl.setPosition(x, y);
    this._addControl(lbl);
    const labels = [];
    const values = [];
    for (const o of options) {
      if (o && typeof o === 'object') {
        labels.push(o.label);
        values.push(o.value);
      } else {
        labels.push(String(o));
        values.push(o);
      }
    }
    const cur = profile.get(path);
    let idx = Math.max(0, values.findIndex((v) => v === cur));
    const valLbl = new Label(labels[idx], { fontSize: 12, hue: 0xe2b96f, fontWeight: 700 });
    valLbl.acceptMouseInput = true;
    valLbl.setPosition(x + 165, y);
    valLbl.onMouseDown = () => {
      idx = (idx + 1) % values.length;
      profile.set(path, values[idx]);
      valLbl.setText?.(labels[idx]);
    };
    this._addControl(valLbl);
  }

  _buildAudio(y) {
    this._addSlider('Master volume', 'audio.master', y);
    this._addSlider('SFX volume',    'audio.sfx',    y + 22);
    this._addSlider('Music volume',  'audio.music',  y + 44);
    // Audit #41 deferred (client P2 #18) — ambient layer (forest/water
    // loops, weather rain) was a profile default with no slider; users
    // couldn't tune it.
    this._addSlider('Ambient volume', 'audio.ambient', y + 66);
    this._addSlider('Footsteps',     'audio.footsteps', y + 88);
    this._addCheckbox('Combat music',         'audio.combatMusic',  y + 114);
    this._addCheckbox('Login music',          'audio.loginMusic',   y + 134);
    this._addCheckbox('Login music — repeat', 'audio.loginMusicLoop', y + 154);
    this._addCheckbox('Read NPC speech aloud (TTS)', 'tts.speech', y + 174);
    // Right column — CUO Profile.cs::ReproduceSoundsInBackground / EnableFootstepsSound.
    this._addCheckbox('Play sound when window blurred', 'audio.reproduceSoundsInBackground', y,      PAD_X + 330);
    this._addCheckbox('Footstep sounds enabled',        'audio.footstepSfx',                  y + 20, PAD_X + 330);
    this._addCheckbox('3D positional SFX',              'audio.enableSfx3d',                  y + 40, PAD_X + 330);
    this._addCheckbox('Music volume follows master',    'audio.musicVolumeFollowsMaster',     y + 60, PAD_X + 330);
    this._addSlider('UI effects volume',                 'audio.ui',                           y + 84, PAD_X + 330);
    this._addCheckbox('Mute when window loses focus',    'audio.muteOnBlur',                   y + 110, PAD_X + 330);
  }

  _buildGameplay(y) {
    this._addCheckbox('Always run',                'gameplay.alwaysRun',         y);
    this._addCheckbox('Show health bar above mobs','gameplay.showHealthOverhead', y + 20);
    this._addCheckbox('Show damage numbers',       'gameplay.showDamageNumbers',  y + 40);
    this._addCheckbox('Auto-loot adjacent corpses','gameplay.autoLoot',           y + 60);
    this._addCheckbox('Smooth movement',           'gameplay.smoothMovement',     y + 80);
    this._addCheckbox('Click-to-walk',             'gameplay.clickToWalk',        y + 100);
    this._addCheckbox('Confirm criminal action',   'gameplay.queryCriminalAction', y + 120);
    this._addCheckbox('Auto-stack picked items',   'gameplay.autoStack',          y + 140);
    this._addCheckbox('Show party overhead text',  'gameplay.partyOverhead',      y + 160);
    // Right column — CUO Profile.cs missing gameplay flags.
    this._addCheckbox('Hold Shift to split a stack',  'experimental.holdShiftToSplitStack', y,      PAD_X + 330);
    this._addCheckbox('Hold Tab to toggle war-mode',  'experimental.holdDownKeyTab',        y + 20, PAD_X + 330);
    this._addCheckbox('Sallos easy-grab (single click)','experimental.sallosEasyGrab',      y + 40, PAD_X + 330);
    this._addCheckbox('Show house interior content',  'gameplay.showHouseContent',          y + 60, PAD_X + 330);
    this._addCheckbox('Enable cave borders',          'ui.enableCaveBorder',                y + 80, PAD_X + 330);
    this._addCheckbox('Convert trees to stumps',      'ui.treeToStumps',                    y + 100, PAD_X + 330);
    this._addCheckbox('Smooth door swing',            'ui.smoothDoors',                     y + 120, PAD_X + 330);
    this._addCheckbox('Auto-open doors on bump',      'gameplay.autoOpenDoors',             y + 140, PAD_X + 330);
    this._addCheckbox('Hide vegetation',              'ui.hideVegetation',                  y + 160, PAD_X + 330);
  }

  _buildGraphics(y) {
    this._addSlider('Light level (lerp)', 'graphics.lightOverlay', y);
    this._addSlider('Default zoom',       'graphics.defaultZoom',  y + 22, PAD_X, { min: 0.5, max: 3, step: 0.05 });
    // Audit #40 client P1 #6 — tooltip-manager reads `tooltips.delayMs`
    // not `graphics.tooltipDelay`; unify so the Graphics-tab slider
    // is no longer dead.
    this._addSlider('Tooltip delay',      'tooltips.delayMs',      y + 44, PAD_X, { min: 0, max: 2000, step: 50, integer: true });
    this._addCheckbox('Show FPS',                  'ui.showFps',               y + 70);
    this._addCheckbox('Pixelated scaling',         'graphics.nearestSampling', y + 90);
    this._addCheckbox('Foliage transparency',      'graphics.foliageTrans',    y + 110);
    this._addCheckbox('Circle of transparency',    'graphics.circleTrans',     y + 130);
    this._addCheckbox('Hide statics under roof',   'graphics.hideUnderRoof',   y + 150);
    this._addCheckbox('Animated water',            'graphics.animatedWater',   y + 170);
    this._addCheckbox('Weather (rain/snow)',       'graphics.weatherFx',       y + 190);
    this._addSlider('Water intensity',             'graphics.waterIntensity', y + 216, PAD_X, { min: 0, max: 2, step: 0.1 });
    this._addSlider('Weather density',             'graphics.weatherDensity', y + 238, PAD_X, { min: 0, max: 2, step: 0.1 });
    this._addCheckbox('No-flicker effects',        'graphics.noFlicker',       y + 264);
    this._addSlider('Interface scale',             'ui.scale',                 y + 290, PAD_X, { min: 0.75, max: 2, step: 0.05 });
    this._addCheckbox('Compact side panels',       'ui.compactSidePanels',     y + 318);
    this._addCheckbox('Hide empty side panels',    'ui.autoHideEmptyPanels',   y + 338);
    this._addSlider('Gump snap threshold',         'ui.gumpSnapThreshold',     y + 362, PAD_X, { min: 0, max: 64, step: 1, integer: true });
    this._addCheckbox('Lock key gumps',            'ui.lockKeyGumps',          y + 390);
    // Right column — CUO Profile.cs::EnableShadows / EnableDeathScreen / etc.
    this._addCheckbox('Enable shadows',             'experimental.enableShadows',         y,       PAD_X + 330);
    this._addCheckbox('Statics cast shadows',       'experimental.shadowsStatics',        y + 20,  PAD_X + 330);
    this._addCheckbox('Black & white when dead',    'experimental.enableBlackWhiteEffect', y + 40,  PAD_X + 330);
    this._addCheckbox('Highlight game objects',     'experimental.highlightGameObjects',  y + 60,  PAD_X + 330);
    this._addCheckbox('Custom light override',      'light.custom',                       y + 80,  PAD_X + 330);
    this._addSlider('Light override level',         'light.level',                        y + 102, PAD_X + 330, { min: 0, max: 30, step: 1, integer: true });
    this._addPicker('Light override mode',          'light.type',
      [{ label: 'Absolute', value: 0 }, { label: 'Minimum', value: 1 }],
      y + 130, PAD_X + 330);
    this._addCheckbox('Day / night cycle',          'light.dayNightCycle',                y + 154, PAD_X + 330);
    this._addCheckbox('Dark dungeons',              'light.useDarkNights',                y + 174, PAD_X + 330);
    this._addCheckbox('Alternative light palette',  'graphics.useAlternativeLights',      y + 194, PAD_X + 330);
    this._addPicker('Circle of transparency',       'ui.circleOfTransparencyType',
      [{ label: 'Off', value: 0 }, { label: 'Hard', value: 1 }, { label: 'Soft', value: 2 }],
      y + 224, PAD_X + 330);
    this._addSlider('CoT radius',                   'ui.circleOfTransparencyRadius',      y + 246, PAD_X + 330, { min: 2, max: 20, step: 1, integer: true });
    this._addCheckbox('No color out-of-range',      'graphics.noColorObjectsOutOfRange',  y + 270, PAD_X + 330);
    this._addPicker('Field graphics',               'ui.fieldsType',
      [{ label: 'Classic', value: 'classic' }, { label: 'Static', value: 'static' }, { label: 'Animated', value: 'animated' }],
      y + 292, PAD_X + 330);
    this._addPicker('Effects quality',              'graphics.effectsQuality',
      [{ label: 'Automatic', value: 'auto' }, { label: 'Low GPU', value: 'low' }, { label: 'High', value: 'high' }],
      y + 320, PAD_X + 330);
  }

  _buildInput(y) {
    const help = new Label(
      'Hotkeys & macros: open Macros (Ctrl+M).',
      { fontSize: 10, hue: 0xa08868, stroke: false },
    );
    help.setPosition(12, y);
    this._addControl(help);
    this._addCheckbox('Use mouse-wheel zoom',  'input.mouseWheelZoom',  y + 22);
    this._addCheckbox('Right-click moves',     'input.rightClickMoves', y + 42);
    this._addCheckbox('Drag with left + alt',  'input.dragWithAlt',     y + 62);
    this._addCheckbox('Auto-walk to clicked tile', 'input.autoWalk',    y + 82);
    this._addSlider('Drag pixel threshold',    'input.dragThreshold',   y + 110, PAD_X, { min: 1, max: 20, step: 1, integer: true });
    // Audit #46 P2 — KeyRepeat + MouseSensitivity + Shift-context.
    this._addSlider('Key repeat delay (ms)',    'input.keyRepeatDelayMs',    y + 134, PAD_X, { min: 100, max: 1000, step: 25, integer: true });
    this._addSlider('Key repeat interval (ms)', 'input.keyRepeatIntervalMs', y + 156, PAD_X, { min: 20, max: 250, step: 5, integer: true });
    this._addSlider('Mouse sensitivity',        'input.mouseSensitivity',    y + 178, PAD_X, { min: 0.25, max: 3, step: 0.05 });
    this._addCheckbox('Hold Shift for context', 'input.holdShiftForContext', y,       PAD_X + 330);
    this._addCheckbox('Alt closes anchored',    'input.holdDownKeyAltToCloseAnchored', y + 20, PAD_X + 330);
    // Audit #46 P2 — DragSelect controls (binds to dragSelect.* block).
    this._addCheckbox('Enable drag-select',     'dragSelect.enabled',        y + 50, PAD_X + 330);
    this._addPicker('Drag-select modifier',     'dragSelect.modifierKey',
      [{ label: 'Ctrl', value: 'ctrl' }, { label: 'Shift', value: 'shift' }, { label: 'Alt', value: 'alt' }],
      y + 70, PAD_X + 330);
    this._addCheckbox('Humanoids only',         'dragSelect.humanoidsOnly',  y + 92, PAD_X + 330);
    this._addCheckbox('Hostile only',           'dragSelect.hostileOnly',    y + 112, PAD_X + 330);
    this._addCheckbox('Open as healthbar anchor', 'dragSelect.asAnchor',     y + 132, PAD_X + 330);
  }

  _buildCombat(y) {
    this._addCheckbox('Auto-target last attacker',  'combat.autoTarget',        y);
    this._addCheckbox('Queue spells (chain cast)',  'combat.queueSpells',      y + 20);
    this._addCheckbox('Auto re-target on miss',     'combat.autoRetarget',     y + 40);
    this._addCheckbox('Show spell hue on cursor',   'combat.spellHueCursor',   y + 60);
    this._addCheckbox('Confirm friendly fire',      'combat.friendlyFire',     y + 80);
    this._addCheckbox('Open corpse on dbl-click',   'corpse.autoOpen',         y + 100);
    this._addCheckbox('Highlight current target',   'combat.highlightTarget',  y + 120);
    this._addCheckbox('Show buff icons',            'combat.buffIcons',        y + 140);
    this._addSlider('Auto-target range (tiles)',    'combat.autoTargetRange',  y + 170, PAD_X, { min: 1, max: 18, step: 1, integer: true });
    this._addCheckbox('Show buff timers',           'combat.buffBarTime',      y + 196);
    this._addCheckbox('Show DPS meter',             'combat.showDps',          y + 216);
    this._addCheckbox('Old bandage self macro',     'combat.bandageSelfOld',   y + 236);
    // Right column — CUO Profile.cs::MobileHP* + AutoOpenCorpseRange + crim-action gating.
    this._addPicker('Mob HP display',               'ui.mobileHPType',
      [{ label: 'None', value: 'none' }, { label: '%', value: 'percent' },
       { label: 'Line', value: 'line' }, { label: 'Both', value: 'both' }],
      y, PAD_X + 330);
    this._addPicker('Show HP when',                 'ui.mobileHPShowWhen',
      [{ label: 'Always', value: 'always' }, { label: 'Damaged', value: 'damaged' }, { label: 'Low', value: 'low' }],
      y + 22, PAD_X + 330);
    this._addSlider('Auto-open corpse range',       'corpse.autoOpenRange',   y + 50, PAD_X + 330, { min: 1, max: 5, step: 1, integer: true });
    this._addCheckbox('Skip empty corpses',         'corpse.skipEmpty',       y + 76, PAD_X + 330);
    this._addCheckbox('Skip innocent loot',         'corpse.skipInnocent',    y + 96, PAD_X + 330);
    this._addCheckbox('Use grid-loot for corpses',  'corpse.gridLoot',        y + 116, PAD_X + 330);
    this._addCheckbox('Highlight poisoned mobs',    'ui.highlightPoisoned',   y + 136, PAD_X + 330);
    this._addCheckbox('Highlight paralyzed mobs',   'ui.highlightParalyzed',  y + 156, PAD_X + 330);
    this._addCheckbox('Highlight invulnerable mobs','ui.highlightInvulnerable', y + 176, PAD_X + 330);
    // Audit rev.9 P2 #3 — CUO `Profile.cs::PartyAuraColor` + `SpellFormat`.
    this._addPicker('Party aura color',             'combat.partyAuraColor',
      [{ label: 'Cyan', value: 0x0058 }, { label: 'Green', value: 0x0044 },
       { label: 'Magenta', value: 0x0057 }, { label: 'Gold', value: 0x0035 }],
      y + 196, PAD_X + 330);
    this._addPicker('Spell-cast text format',       'combat.spellFormat',
      [{ label: '"<name>"',     value: 'name' },
       { label: '"In Vas Ort"',  value: 'powerwords' },
       { label: '"<name> (<pw>)"', value: 'both' }],
      y + 218, PAD_X + 330);
    this._addCheckbox('Show invulnerable tag',      'combat.invulnerableTag',   y + 240, PAD_X + 330);
    this._addCheckbox('Confirm beneficial criminal','gameplay.queryBeneficialCriminalAction', y + 260, PAD_X + 330);
  }

  _buildChat(y) {
    this._addCheckbox('Use unicode speech',         'chat.unicode',            y);
    this._addCheckbox('Activate chat on Enter',     'chat.activateChatAfterEnter', y + 20);
    this._addCheckbox('Show whisper/yell buttons',  'chat.chatAdditionalButtons',  y + 40);
    this._addCheckbox('Mute global chat',           'chat.muteGlobal',         y + 60);
    this._addCheckbox('Auto-scroll journal',        'chat.autoScrollJournal',  y + 80);
    this._addCheckbox('Scale message display time', 'chat.scaleSpeechDelay',   y + 100);
    this._addSlider('Chat background opacity',      'chat.chatBackgroundOpacity', y + 130);
    this._addSlider('Speech display time (ms)',     'chat.speechDelayMs',      y + 152, PAD_X, { min: 1000, max: 12000, step: 250, integer: true });
    this._addPicker('Chat font',                    'chat.chatFont',
      [0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({ label: `Font ${n}`, value: n })),
      y + 178);
    // Right column — per-channel hue raw value (cycle palette quickset).
    const huePalette = [
      { label: 'Speech (default)', value: 0x03B2 },
      { label: 'Whisper grey',     value: 0x0033 },
      { label: 'Emote yellow',     value: 0x0040 },
      { label: 'Yell red',         value: 0x0026 },
      { label: 'Party green',      value: 0x0044 },
      { label: 'Alliance magenta', value: 0x0057 },
      { label: 'Guild gold',       value: 0x0044 },
    ];
    this._addPicker('Speech hue',    'chat.speechHue',   huePalette, y,       PAD_X + 330);
    this._addPicker('Whisper hue',   'chat.whisperHue',  huePalette, y + 22,  PAD_X + 330);
    this._addPicker('Emote hue',     'chat.emoteHue',    huePalette, y + 44,  PAD_X + 330);
    this._addPicker('Yell hue',      'chat.yellHue',     huePalette, y + 66,  PAD_X + 330);
    this._addPicker('Party hue',     'chat.partyHue',    huePalette, y + 88,  PAD_X + 330);
    this._addPicker('Alliance hue',  'chat.allianceHue', huePalette, y + 110, PAD_X + 330);
    this._addPicker('Guild hue',     'chat.guildHue',    huePalette, y + 132, PAD_X + 330);
    this._addPicker('System hue',    'chat.systemHue',   huePalette, y + 154, PAD_X + 330);
    // Audit rev.4 P2 — notoriety hues. CUO `Profile.cs` ships ~12
    // colour fields keyed to NotorietyFlag values; we expose them in
    // the chat tab so the user can tune the name-overhead + healthbar
    // tinting without diving into options JSON. Tied to the
    // `notoriety.*` defaults block.
    const notoPalette = [
      { label: 'Cream',       value: 0x0059 },
      { label: 'Green',       value: 0x003F },
      { label: 'Grey',        value: 0x03B2 },
      { label: 'Orange',      value: 0x0026 },
      { label: 'Red',         value: 0x0021 },
      { label: 'Yellow gold', value: 0x0035 },
      { label: 'Tan',         value: 0x0033 },
      { label: 'Lime',        value: 0x0044 },
      { label: 'Magenta',     value: 0x0057 },
      { label: 'Ice blue',    value: 0x0142 },
    ];
    this._addPicker('Innocent hue',    'notoriety.innocentHue',  notoPalette, y + 178, PAD_X + 330);
    this._addPicker('Friend hue',      'notoriety.friendHue',    notoPalette, y + 200, PAD_X + 330);
    this._addPicker('Gray hue',        'notoriety.grayHue',      notoPalette, y + 222, PAD_X + 330);
    this._addPicker('Enemy hue',       'notoriety.enemyHue',     notoPalette, y + 244, PAD_X + 330);
    this._addPicker('Murderer hue',    'notoriety.murdererHue',  notoPalette, y + 266, PAD_X + 330);
    this._addPicker('Invul hue',       'notoriety.invulHue',     notoPalette, y + 288, PAD_X + 330);
    this._addPicker('Poison hue',      'notoriety.poisonHue',    notoPalette, y + 310, PAD_X + 330);
    this._addPicker('Paralyzed hue',   'notoriety.paralyzedHue', notoPalette, y + 332, PAD_X + 330);
    // Audit rev.9 P2 #3 — beneficial / harmful action hues + canAttack tint.
    this._addPicker('Beneficial hue',  'notoriety.beneficialHue', notoPalette, y + 354, PAD_X + 330);
    this._addPicker('Harmful hue',     'notoriety.harmfulHue',   notoPalette, y + 376, PAD_X + 330);
    this._addPicker('Can-attack hue',  'notoriety.canAttackHue', notoPalette, y + 398, PAD_X + 330);
  }

  _buildTooltips(y) {
    this._addCheckbox('Enable tooltips',            'tooltips.enabled',          y);
    this._addCheckbox('Tooltips on items',          'tooltips.items',            y + 20);
    this._addCheckbox('Tooltips on mobs',           'tooltips.mobs',             y + 40);
    this._addCheckbox('Tooltips on corpses',        'tooltips.corpses',          y + 60);
    this._addCheckbox('Show OPL in chat',           'tooltips.echoToChat',       y + 80);
    this._addSlider('Tooltip delay (ms)',           'tooltips.delayMs',          y + 110, PAD_X, { min: 0, max: 2000, step: 50, integer: true });
    this._addSlider('Max width (px)',               'tooltips.width',            y + 132, PAD_X, { min: 120, max: 520, step: 10, integer: true });
    this._addSlider('Font size (px)',               'tooltips.fontSize',         y + 154, PAD_X, { min: 8, max: 24, step: 1, integer: true });
    this._addCheckbox('Color resists by element',   'tooltips.colorResists',     y + 184);
    this._addCheckbox('Highlight artifacts in gold','tooltips.colorArtifact',    y + 204);
    this._addCheckbox('Hold Alt to show tooltips',  'tooltips.holdAltToShow',    y + 224);
    this._addCheckbox('Compare with equipped item', 'tooltips.compareEquipped',  y + 244);
    // Right column — opacity + text hue (small palette).
    this._addSlider('Background opacity',           'tooltips.backgroundOpacity', y,  PAD_X + 330);
    this._addPicker('Text hue',                     'tooltips.textHue',
      [{ label: 'White',   value: 0xFFFF },
       { label: 'Cream',   value: 0x0481 },
       { label: 'Yellow',  value: 0x0099 },
       { label: 'Cyan',    value: 0x0058 }],
      y + 24, PAD_X + 330);
    // Audit #46 P2 — journal + login prefs (small misc block).
    this._addCheckbox('Journal: save to file',      'journalPrefs.saveToFile',  y + 56, PAD_X + 330);
    this._addCheckbox('Journal: dark mode',         'journalPrefs.darkMode',    y + 76, PAD_X + 330);
    this._addCheckbox('Journal: hide timestamps',   'journalPrefs.hideTimestamps', y + 96, PAD_X + 330);
    this._addCheckbox('AutoLogin enabled',          'login.autoLogin',           y + 126, PAD_X + 330);
    this._addCheckbox('Auto-reconnect on disconnect','login.autoReconnect',      y + 146, PAD_X + 330);
    this._addSlider('Reconnect interval (ms)',      'login.reconnectIntervalMs', y + 168, PAD_X + 330, { min: 1000, max: 30000, step: 500, integer: true });
    this._addSlider('Reconnect max tries',          'login.reconnectMaxTries',   y + 190, PAD_X + 330, { min: 1, max: 60, step: 1, integer: true });
  }

  _buildContainers(y) {
    // Audit #40 client P1 #6 — `container-gump.js` reads `ui.containerScale`
    // (the canonical CUO key). Was: slider wrote to `containers.scale`
    // → user dragged the slider and nothing happened.
    this._addSlider('Container scale',              'ui.containerScale',         y, PAD_X, { min: 0.5, max: 2, step: 0.05 });
    this._addCheckbox('Double-click to loot to pack', 'ui.doubleClickToLootInsideContainers', y + 25);
    this._addCheckbox('Auto-stack on drop',         'containers.autoStack',      y + 45);
    this._addPicker('Grid-loot mode',               'containers.gridLoot',
      [{ label: 'Off', value: 'none' }, { label: 'Grid', value: 'grid' }, { label: 'Both', value: 'both' }],
      y + 65);
    this._addCheckbox('Always pin backpack',        'containers.pinBackpack',    y + 87);
    this._addCheckbox('Show item counts',           'containers.showCounts',     y + 107);
    this._addCheckbox('Open last container at slot','containers.restorePos',     y + 127);
    this._addCheckbox('Confirm dropping gold',      'containers.confirmGoldDrop',y + 147);
    this._addCheckbox('Hide empty containers',      'containers.hideEmpty',      y + 167);
    this._addSlider('Drop snap radius (px)',        'containers.dropRadius',     y + 192, PAD_X, { min: 0, max: 64, step: 1, integer: true });
    // Right column — classic free-placement or a regular Tibia-style grid.
    this._addPicker('Container layout',             'containers.layoutMode',
      [{ label: 'Classic', value: 'classic' }, { label: 'Grid', value: 'grid' }],
      y, PAD_X + 330);
    this._addPicker('Backpack style',               'ui.backpackStyle',
      [{ label: 'Classic', value: 'classic' }, { label: 'Flat', value: 'flat' }, { label: 'Small', value: 'small' }],
      y + 22, PAD_X + 330);
    this._addCheckbox('Large container gumps',      'ui.useLargeContainerGumps', y + 44, PAD_X + 330);
    this._addCheckbox('Scale items inside',         'ui.scaleItemsInsideContainers', y + 64, PAD_X + 330);
    this._addCheckbox('Per-container open position','ui.overrideContainerLocation', y + 84, PAD_X + 330);
    this._addCheckbox('Drop preserves slot offset', 'ui.relativeDragAndDropItems', y + 104, PAD_X + 330);
    this._addSlider('Gold confirm threshold',       'containers.confirmGoldThreshold', y + 126, PAD_X + 330, { min: 0, max: 100000, step: 1000, integer: true });
    // Audit rev.9 P2 #3 — CUO `Profile.cs::HideZoomGump` /
    // `RestrictMaxContainerOpened`.
    this._addCheckbox('Hide container zoom button', 'ui.hideZoomGump',           y + 148, PAD_X + 330);
    this._addSlider('Max open containers',          'ui.restrictMaxContainerOpened', y + 170, PAD_X + 330, { min: 1, max: 30, step: 1, integer: true });
    this._addPicker('Open position mode',           'ui.overrideContainerLocationSetting',
      [{ label: 'Default', value: 'default' }, { label: 'Backpack', value: 'nearBackpack' },
       { label: 'Cascade', value: 'cascade' }, { label: 'Remember', value: 'remember' }],
      y + 194, PAD_X + 330);
    this._addPicker('Container hue',                'ui.hueContainerGumps',
      [{ label: 'None', value: 0 }, { label: 'Green', value: 0x0044 },
       { label: 'Gold', value: 0x0035 }, { label: 'Blue', value: 0x0142 },
       { label: 'Red', value: 0x0021 }],
      y + 216, PAD_X + 330);
  }

  _buildCounters(y) {
    this._addCheckbox('Show counter bar',           'counters.enabled',          y);
    this._addCheckbox('Auto-count from backpack',   'counters.autoCount',        y + 20);
    this._addCheckbox('Show item icon',             'counters.icon',             y + 40);
    this._addCheckbox('Show numeric count',         'counters.count',            y + 60);
    this._addSlider('Highlight threshold',          'counters.highlightAmount',  y + 90, PAD_X, { min: 0, max: 100, step: 1, integer: true });
    this._addSlider('Bar opacity',                  'counters.opacity',          y + 112);
    this._addSlider('Cell size (px)',               'counters.cellSize',         y + 134, PAD_X, { min: 20, max: 80, step: 1, integer: true });
    this._addSlider('Refresh interval (ms)',        'counters.refreshMs',        y + 156, PAD_X, { min: 100, max: 5000, step: 100, integer: true });
    // Audit rev.9 P2 #3 — counter rows / cols + sound-on-use.
    this._addSlider('Counter rows',                 'counters.rows',             y,        PAD_X + 330, { min: 1, max: 6, step: 1, integer: true });
    this._addSlider('Counter cols',                 'counters.cols',             y + 22,   PAD_X + 330, { min: 1, max: 12, step: 1, integer: true });
    this._addCheckbox('Beep when slot drained',     'counters.highlightOnUse',   y + 50,   PAD_X + 330);
    this._addCheckbox('Hide slot when empty',       'counters.hideEmpty',        y + 70,   PAD_X + 330);
    const help = new Label(
      'Drag items into the bar to track. Right-click a slot to clear.',
      { fontSize: 10, hue: 0xa08868, stroke: false },
    );
    help.setPosition(12, y + 188);
    this._addControl(help);
  }

  _buildWorld(y) {
    this._addCheckbox('Show worldmap on login',     'worldmap.showOnLogin',      y);
    this._addCheckbox('Show coordinates',           'worldmap.showCoordinates',  y + 20);
    this._addCheckbox('Show party blips',           'worldmap.showParty',        y + 40);
    this._addCheckbox('Show guild blips',           'worldmap.showGuild',        y + 60);
    this._addCheckbox('Fog of war',                 'worldmap.fogOfWar',         y + 80);
    this._addCheckbox('Show user markers',          'worldmap.userMarkers',      y + 100);
    this._addCheckbox('Auto-pan to player',         'worldmap.autoPan',          y + 120);
    this._addSlider('Default zoom',                 'worldmap.zoom',             y + 150, PAD_X, { min: 0.5, max: 4, step: 0.05 });
    this._addSlider('Marker size (px)',             'worldmap.markerSize',       y + 172, PAD_X, { min: 4, max: 24, step: 1, integer: true });
    // Right column — external markers URL hint + show-mobiles toggle.
    this._addCheckbox('Show mobiles on map',        'ui.worldMapShowMobiles',    y,       PAD_X + 330);
    this._addCheckbox('Positional target on map',   'ui.worldMapAllowPositionalTarget', y + 20, PAD_X + 330);
    // Audit rev.9 P2 #3 — CUO `Profile.cs::WorldMapShowGroupBar` +
    // `WorldMapShowGridIfZoomed` + `WorldMapShowPartyMembers`.
    this._addCheckbox('Show floating group bar',    'worldmap.showGroupBar',     y + 42,  PAD_X + 330);
    this._addCheckbox('Show grid when zoomed',      'worldmap.showGridIfZoomed', y + 62,  PAD_X + 330);
    this._addCheckbox('Show party member names',    'worldmap.showPartyNames',   y + 82,  PAD_X + 330);
    this._addCheckbox('Show sextant coords',        'ui.worldMapShowSextant',    y + 104, PAD_X + 330);
    this._addCheckbox('Show mouse coords',          'ui.worldMapShowMouseCoordinates', y + 124, PAD_X + 330);
    this._addCheckbox('Show multis / houses',       'ui.worldMapShowMultis',     y + 144, PAD_X + 330);
    this._addCheckbox('Show hidden markers',        'ui.worldMapShowHiddenMarkers', y + 164, PAD_X + 330);
    this._addCheckbox('Show zone overlays',         'ui.worldMapShowZones',      y + 184, PAD_X + 330);
    const help = new Label(
      'External markers URL — set via console:\nprofile.set("worldmap.extMarkersUrl", "https://…")',
      { fontSize: 10, hue: 0xa08868, stroke: false },
    );
    help.setPosition(PAD_X + 330, y + 212);
    this._addControl(help);
  }

  _buildVoice(y) {
    this._addCheckbox('Enable voice chat (TTS)',     'voice.ttsEnabled',  y);
    this._addCheckbox('Speak NPC dialogue',          'voice.ttsNpc',      y + 20);
    this._addCheckbox('Speak system messages',       'voice.ttsSystem',   y + 40);
    this._addCheckbox('Speak party chat',            'voice.ttsParty',    y + 60);
    this._addSlider('Speech rate (slow → fast)',     'voice.ttsRate',     y + 90, PAD_X, { min: 0.5, max: 2, step: 0.05 });
    this._addSlider('Speech pitch (low → high)',     'voice.ttsPitch',    y + 112, PAD_X, { min: 0.5, max: 2, step: 0.05 });
    this._addSlider('Volume',                        'voice.ttsVolume',   y + 134);
    // Voice picker — Combobox of `voiceChat.voiceNames()`. Lazy import
    // to avoid the OptionsGump pulling the voice manager on cold load.
    try {
      const tabId = this._activeTabId;
      Promise.resolve().then(async () => {
        const { Combobox } = await import('../controls/combobox.js');
        const { voiceChat } = await import('../../managers/voice-chat.js');
        if (this._activeTabId !== tabId) return;
        const names = voiceChat.voiceNames?.() ?? [];
        if (names.length === 0) return;
        const lblV = new Label('Voice:', { fontSize: 11, hue: 0xc0b890, stroke: false });
        lblV.setPosition(12, y + 165);
        this._addControl(lblV);
        const cb = new Combobox({
          values: names,
          value: profile.get('voice.ttsVoice') ?? names[0],
          width: 240, height: 22,
          onChange: (v) => profile.set('voice.ttsVoice', v),
        });
        cb.setPosition(60, y + 162);
        this._addControl(cb);
      });
    } catch { /* ignore — falls back to default voice */ }
    const help = new Label(
      'Voice uses your browser\'s built-in Web Speech engine. Voices vary per OS / browser.',
      { fontSize: 10, hue: 0xa08868, stroke: false },
    );
    help.setPosition(12, y + 195);
    this._addControl(help);
  }

  _buildExperimental(y) {
    this._addCheckbox('Network stats overlay',      'debug.networkStats',        y);
    this._addCheckbox('FPS overlay',                'debug.fps',                 y + 20);
    this._addCheckbox('Render-list debug',          'debug.renderLists',         y + 40);
    this._addCheckbox('Packet logger',              'debug.packetLog',           y + 60);
    this._addCheckbox('Hue picker on click',        'debug.huePickerClick',      y + 80);
    this._addCheckbox('Skip animdata animation',    'debug.skipAnimData',        y + 100);
    this._addCheckbox('Skip lighting overlay',      'debug.skipLighting',        y + 120);
    this._addCheckbox('Use lite atlas (low VRAM)',  'debug.liteAtlas',           y + 140);
    this._addCheckbox('CoT radius overlay',         'debug.cotOverlay',          y + 160);
    this._addCheckbox('Roof group overlay',         'debug.roofOverlay',         y + 180);
    this._addCheckbox('Gump bounds overlay',         'debug.gumpBounds',          y + 200);
    this._addCheckbox('Chunk state overlay',         'debug.chunkOverlay',        y + 220);
    this._addCheckbox('Chunk cost heatmap',          'debug.chunkHeatmap',        y + 240);
    this._addCheckbox('Selected tile z-depth',       'debug.zDepthOverlay',       y + 260);
    // Right column — CUO Profile.cs experimental flags.
    this._addCheckbox('Cast spells by single-click', 'gameplay.castSpellsByOneClick', y,      PAD_X + 330);
    this._addCheckbox('Fast spells hotbar assign',   'gameplay.fastSpellsAssign',     y + 20, PAD_X + 330);
    this._addCheckbox('Disable default hotkeys',     'experimental.disableDefaultHotkeys', y + 40, PAD_X + 330);
    this._addCheckbox('Disable arrow walk',          'experimental.disableArrowBtn', y + 60, PAD_X + 330);
    this._addCheckbox('Save 4:3 aspect ratio',       'experimental.saveAspectRatio', y + 80, PAD_X + 330);
    this._addCheckbox('Reduce FPS when inactive',    'ui.reduceFPSWhenInactive',     y + 100, PAD_X + 330);
    this._addCheckbox('Use standard skills gump',    'experimental.useStandardSkillsGump', y + 120, PAD_X + 330);
    this._addCheckbox('Worker pathfinding',          'experimental.workerPathfinding', y + 140, PAD_X + 330);
    this._addCheckbox('Force Unicode journal',       'experimental.forceUnicodeJournal',   y + 160, PAD_X + 330);
    this._addCheckbox('Ignore alliance messages',    'experimental.ignoreAllianceMessages', y + 180, PAD_X + 330);
    this._addCheckbox('Ignore guild messages',       'experimental.ignoreGuildMessages',    y + 200, PAD_X + 330);
    this._addCheckbox('Reduced UI motion',            'ui.reducedMotion',                  y + 220, PAD_X + 330);
    this._addCheckbox('High contrast focus',          'ui.highContrast',                   y + 240, PAD_X + 330);
    this._addCheckbox('Gamepad UI navigation',        'ui.gamepadNavigation',              y + 260, PAD_X + 330);
    this._addSlider('Minimum UI text (px)',            'ui.minTextPx',                      y + 282, PAD_X + 330, { min: 8, max: 18, step: 1, integer: true });
    const help = new Label(
      'Experimental — refresh page after toggling. Contact the shard for support.',
      { fontSize: 10, hue: 0x8888a0, stroke: false },
    );
    help.setPosition(12, y + 286);
    this._addControl(help);
  }

  get type() { return 'options'; }
}
