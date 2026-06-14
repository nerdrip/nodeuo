// RaceChangeGump — port of ClassicUO `Game/UI/Gumps/RaceChangeGump.cs`.
// Audit rev.9 P2 #1 — full appearance picker: live Pixi mannequin
// preview + hair / beard / skin-hue combobox triplet. Resolved reply
// goes out via the extended 0xBF 0x2B payload (race + sex + confirm +
// skinHue + hairId + hairHue + beardId + beardHue). Server reader is
// length-tolerant — old shards keep working with the 3-byte head.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { Combobox } from '../controls/combobox.js';
import { Checkbox } from '../controls/checkbox.js';
import { AnimatedCharacterFrame } from '../controls/animated-character-frame.js';
import { world } from '../../world/world.js';
import { net } from '../../net/net-client.js';
import { buildChangeRaceResponse } from '../../net/outgoing.js';
import { uiManager } from '../ui-manager.js';

const RACE_ID = { human: 1, elf: 2, gargoyle: 3 };
const RACES = [
  { id: 'human',    label: 'Human',    body: 0x190, femaleBody: 0x191 },
  { id: 'elf',      label: 'Elf',      body: 0x25D, femaleBody: 0x25E },
  { id: 'gargoyle', label: 'Gargoyle', body: 0x29A, femaleBody: 0x29B },
];

// Hair / beard catalogues per race. Item ids picked from the canonical
// ClassicUO `Data/HairAndBeards.cs` table; gargoyles use horns instead
// of beards (layer 16, item id range 0x4258..0x425F).
const HAIR = {
  human: [
    { id: 0,      label: 'Bald' },
    { id: 0x203B, label: 'Short' },
    { id: 0x203C, label: 'Long' },
    { id: 0x203D, label: 'Ponytail' },
    { id: 0x2044, label: 'Mohawk' },
    { id: 0x2045, label: 'Pageboy' },
    { id: 0x2046, label: 'Buns' },
    { id: 0x2047, label: 'Afro' },
    { id: 0x2048, label: 'Receding' },
    { id: 0x2049, label: 'Pigtails' },
    { id: 0x204A, label: 'Krisna' },
  ],
  elf: [
    { id: 0,      label: 'Bald' },
    { id: 0x2FBF, label: 'Mid-long' },
    { id: 0x2FC0, label: 'Long feather' },
    { id: 0x2FC1, label: 'Short' },
    { id: 0x2FC2, label: 'Mullet' },
    { id: 0x2FCC, label: 'Flower' },
    { id: 0x2FCD, label: 'Long' },
    { id: 0x2FCE, label: 'Knob' },
    { id: 0x2FCF, label: 'Braided' },
    { id: 0x2FD0, label: 'Bun' },
    { id: 0x2FD1, label: 'Spiked' },
  ],
  gargoyle: [
    { id: 0,      label: 'Bald' },
    { id: 0x4258, label: 'Plain' },
    { id: 0x4259, label: 'Sweptback' },
    { id: 0x425A, label: 'Long' },
    { id: 0x425B, label: 'Medium' },
    { id: 0x425C, label: 'Bun' },
    { id: 0x425D, label: 'Topknot' },
    { id: 0x425E, label: 'Crowned' },
  ],
};
const GARGOYLE_HAIR_FEMALE = [
  { id: 0,      label: 'None' },
  { id: 0x4261, label: 'Short horns' },
  { id: 0x4262, label: 'Long horns' },
  { id: 0x4273, label: 'Curved' },
  { id: 0x4274, label: 'Twisted' },
  { id: 0x4275, label: 'Tall' },
  { id: 0x42B0, label: 'Crown' },
  { id: 0x42B1, label: 'Swept crown' },
  { id: 0x42AA, label: 'Frill' },
  { id: 0x42AB, label: 'Tall frill' },
];
const BEARD = {
  human: [
    { id: 0,      label: 'None' },
    { id: 0x203E, label: 'Long' },
    { id: 0x203F, label: 'Short' },
    { id: 0x2040, label: 'Goatee' },
    { id: 0x2041, label: 'Mustache' },
    { id: 0x2042, label: 'Vandyke' },
    { id: 0x204B, label: 'Mustache & Beard' },
    { id: 0x204C, label: 'Bushy' },
    { id: 0x204D, label: 'Full' },
  ],
  elf: [
    { id: 0,      label: 'None' },
  ],
  // Gargoyle horns (layer 16 same as beard).
  gargoyle: [
    { id: 0,      label: 'None' },
    { id: 0x4260, label: 'Small jaw horns' },
    { id: 0x42AD, label: 'Jaw horns' },
    { id: 0x42AE, label: 'Hooked jaw' },
    { id: 0x42AF, label: 'Long jaw' },
    { id: 0x42B0, label: 'Crest jaw' },
  ],
};
const SKIN_HUE_HUMAN    = Array.from({ length: 8 }, (_, i) => 0x83EA + i);
const SKIN_HUE_ELF      = [
  0x4DE, 0x76C, 0x835, 0x430, 0x24D, 0x24E, 0x24F, 0x0BF,
  0x4A7, 0x361, 0x375, 0x367, 0x3E8, 0x3DE, 0x353, 0x903,
  0x76D, 0x384, 0x579, 0x3E9, 0x374, 0x389, 0x385, 0x376,
  0x53F, 0x381, 0x382, 0x383, 0x76B, 0x3E5, 0x51D, 0x3E6,
].map((h) => h | 0x8000);
const SKIN_HUE_GARGOYLE = Array.from({ length: 25 }, (_, i) => (1755 + i) | 0x8000);
const HAIR_HUES         = [0x44E, 0x453, 0x457, 0x45D, 0x462, 0x466, 0x46B, 0x470, 0x475, 0x47A];
const GARGOYLE_HORN_HUES = [
  0x709, 0x70B, 0x70D, 0x70F, 0x711, 0x763,
  0x765, 0x768, 0x76B, 0x6F3, 0x6F1, 0x6EF,
  0x6E4, 0x6E2, 0x6E0,
];

function hairListFor(race, sex) {
  const list = HAIR[race] ?? HAIR.human;
  if (race === 'human') {
    return list.filter((h) => sex === 'female' ? h.id !== 0x2048 : h.id !== 0x2046);
  }
  if (race === 'elf') {
    return list.filter((h) => sex === 'female'
      ? h.id !== 0x2FBF && h.id !== 0x2FCD
      : h.id !== 0x2FCC && h.id !== 0x2FD0);
  }
  if (race === 'gargoyle' && sex === 'female') {
    return [...GARGOYLE_HAIR_FEMALE, ...list.filter((h) => h.id !== 0)];
  }
  return list;
}

function beardListFor(race, sex) {
  if (race === 'gargoyle') return BEARD.gargoyle;
  if (sex === 'female' || race === 'elf') return BEARD.elf;
  return BEARD[race] ?? BEARD.human;
}

function hairHuesFor(race) {
  return race === 'gargoyle' ? GARGOYLE_HORN_HUES : HAIR_HUES;
}

export class RaceChangeGump extends WindowGump {
  /** @param {{ allowed?: string[], onResolve?: (raceId:number|null) => void }} opts */
  constructor(opts = {}) {
    super({ title: 'Change Race', width: 540, height: 360, x: 180, y: 140 });
    this._onResolve = opts.onResolve || null;
    const allowed = new Set((opts.allowed && opts.allowed.length) ? opts.allowed : RACES.map(r => r.id));

    // Internal picker state — defaults pulled from current mobile.
    this._sel = {
      race: world?.player?.race ? RACES[Math.max(0, world.player.race - 1)]?.id : 'human',
      sex: world?.player?.female ? 'female' : 'male',
      skinHue: world?.player?.hue || SKIN_HUE_HUMAN[0],
      hairId: 0,
      hairHue: HAIR_HUES[0],
      beardId: 0,
      beardHue: HAIR_HUES[0],
    };
    if (!allowed.has(this._sel.race)) this._sel.race = [...allowed][0] ?? 'human';

    // -- Race radio row ---------------------------------------------------
    const note = new Label('Choose your new race + appearance:', { fontSize: 12, hue: 0xfff0c0 });
    note.setPosition(12, 30); this.add(note);

    let x = 24;
    this._raceBtns = {};
    for (const r of RACES) {
      const btn = new Checkbox({
        text: r.label,
        checked: this._sel.race === r.id,
        size: 18,
      });
      btn.setPosition(x, 58);
      btn.onChange = (on) => {
        if (!on) { btn.setChecked(true); return; }
        if (!allowed.has(r.id)) { btn.setChecked(false); return; }
        this._sel.race = r.id;
        // Adjust skin/hair palette to race defaults.
        const skinPool = this._skinPool();
        this._sel.skinHue = skinPool[0];
        this._sel.hairId  = (HAIR[r.id]  ?? HAIR.human )[0].id;
        this._sel.beardId = (BEARD[r.id] ?? BEARD.human)[0].id;
        for (const id of Object.keys(this._raceBtns)) {
          this._raceBtns[id].setChecked(id === r.id);
        }
        this._rebuildCombos();
        this._refreshPreview();
      };
      btn.enabled = allowed.has(r.id);
      this.add(btn);
      this._raceBtns[r.id] = btn;
      x += 110;
    }

    // -- Sex dropdown -----------------------------------------------------
    const sexLbl = new Label('Sex:', { fontSize: 11, hue: 0xe8d0a0 });
    sexLbl.setPosition(24, 92); this.add(sexLbl);
    this._sexCombo = new Combobox({
      width: 100,
      items: [{ id: 'male', label: 'Male' }, { id: 'female', label: 'Female' }],
      value: this._sel.sex,
    });
    this._sexCombo.setPosition(70, 88);
    this._sexCombo.onChange = (v) => {
      this._sel.sex = v;
      this._rebuildCombos();
      this._refreshPreview();
    };
    this.add(this._sexCombo);

    // -- Hair / beard / hue combos placeholder; filled by _rebuildCombos.
    this._comboHair = null;
    this._comboBeard = null;
    this._comboSkin = null;
    this._comboHairHue = null;
    this._comboControls = [];
    this._rebuildCombos();

    // -- Choose / Cancel buttons -----------------------------------------
    const choose = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 90, height: 24, label: 'Apply', action: ButtonAction.Activate,
    });
    choose.setPosition(335, 320);
    choose.onClick = () => this._submit(true);
    this.add(choose);

    const cancel = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 80, height: 24, label: 'Cancel', action: ButtonAction.Activate,
    });
    cancel.setPosition(435, 320);
    cancel.onClick = () => this._submit(false);
    this.add(cancel);

    this._mountPreview();
    this._refreshPreview();
  }

  get type() { return 'race-change'; }

  _skinPool() {
    return ({ human: SKIN_HUE_HUMAN, elf: SKIN_HUE_ELF, gargoyle: SKIN_HUE_GARGOYLE })[this._sel.race] || SKIN_HUE_HUMAN;
  }

  _rebuildCombos() {
    for (const ctrl of this._comboControls ?? []) {
      try { ctrl.dispose?.(); } catch { /* ignore */ }
    }
    this._comboControls = [];
    this._comboHair = null;
    this._comboBeard = null;
    this._comboSkin = null;
    this._comboHairHue = null;

    const race = this._sel.race;
    const hairList  = hairListFor(race, this._sel.sex);
    const beardList = beardListFor(race, this._sel.sex);
    const hairHueList = hairHuesFor(race);
    const skinPool = this._skinPool();
    // Snap current selection if it's no longer valid.
    if (!hairList.find(h => h.id === this._sel.hairId))   this._sel.hairId  = hairList[0].id;
    if (!beardList.find(h => h.id === this._sel.beardId)) this._sel.beardId = beardList[0].id;
    if (!skinPool.includes(this._sel.skinHue)) this._sel.skinHue = skinPool[0];
    if (!hairHueList.includes(this._sel.hairHue)) {
      this._sel.hairHue = hairHueList[0];
      this._sel.beardHue = hairHueList[0];
    }

    let row = 124;
    const make = (label, items, value, onChange) => {
      const lbl = new Label(label, { fontSize: 11, hue: 0xe8d0a0 });
      lbl.setPosition(24, row + 4); this.add(lbl);
      const c = new Combobox({ width: 150, items, value });
      c.setPosition(110, row);
      c.onChange = (v) => { onChange(v); this._refreshPreview(); };
      this.add(c);
      this._comboControls.push(lbl, c);
      row += 28;
      return c;
    };
    this._comboHair = make(race === 'gargoyle' ? 'Horns:' : 'Hair:', hairList.map(h => ({ id: h.id, label: h.label })), this._sel.hairId,  (v) => { this._sel.hairId  = +v; });
    this._comboHairHue = make(race === 'gargoyle' ? 'Horn hue:' : 'Hair hue:', hairHueList.map((h, i) => ({ id: h, label: `Tone ${i + 1}` })), this._sel.hairHue, (v) => { this._sel.hairHue = +v; this._sel.beardHue = +v; });
    if (beardList.length > 1) {
      const beardLabel = race === 'gargoyle' ? 'Facial horns:' : 'Beard:';
      this._comboBeard = make(beardLabel, beardList.map(h => ({ id: h.id, label: h.label })), this._sel.beardId, (v) => { this._sel.beardId = +v; });
    }
    this._comboSkin = make('Skin:', skinPool.map((h, i) => ({ id: h, label: `Shade ${i + 1}` })), this._sel.skinHue, (v) => { this._sel.skinHue = +v; });
  }

  _mountPreview() {
    this._preview = new AnimatedCharacterFrame({
      width: 170,
      height: 230,
      body: this._previewBody(),
      hue: this._sel.skinHue,
      equipment: this._previewEquipment(),
      direction: 4,
      scale: 2.55,
    });
    this._preview.setPosition(335, 64);
    this.add(this._preview);
  }

  _refreshPreview() {
    this._preview?.setAppearance({
      body: this._previewBody(),
      hue: this._sel.skinHue,
      equipment: this._previewEquipment(),
      isFlying: this._sel.race === 'gargoyle',
    });
  }

  _previewBody() {
    const race = RACES.find((r) => r.id === this._sel.race) ?? RACES[0];
    return this._sel.sex === 'female' ? race.femaleBody : race.body;
  }

  _previewEquipment() {
    const eq = [];
    if (this._sel.hairId) {
      eq.push({ layer: 11, itemId: this._sel.hairId, hue: this._sel.hairHue });
    }
    if (this._sel.beardId && (this._sel.sex === 'male' || this._sel.race === 'gargoyle')) {
      eq.push({ layer: 16, itemId: this._sel.beardId, hue: this._sel.beardHue });
    }
    return eq;
  }

  _submit(confirm) {
    const raceId = RACE_ID[this._sel.race];
    const sex = this._sel.sex === 'female' ? 1 : 0;
    const payload = confirm ? {
      skinHue: this._sel.skinHue,
      hairId:  this._sel.hairId,
      hairHue: this._sel.hairHue,
      beardId: this._sel.beardId,
      beardHue: this._sel.beardHue,
    } : null;
    try { net.send(buildChangeRaceResponse(raceId, sex, confirm, payload)); } catch { /* ignore */ }
    this._onResolve?.(confirm ? raceId : null);
    this._teardownPreview();
    this.close?.();
  }

  _teardownPreview() {
    if (this._preview) {
      try { this._preview.dispose(); } catch { /* ignore */ }
      this._preview = null;
    }
  }

  dispose() {
    this._teardownPreview();
    super.dispose?.();
  }
}

/** Pop the gump as a modal in response to server prompt 0xBF 0x2A.
 *  Returns a Promise that resolves to the chosen race id (or null). */
export function showRaceChange(opts = {}) {
  return new Promise((resolve) => {
    const g = new RaceChangeGump({
      ...opts,
      onResolve: (rid) => { try { uiManager.clearModal?.(g); } catch { /* ignore */ } resolve(rid); },
    });
    uiManager.addGump?.(g);
    try { uiManager.setModal?.(g); } catch { /* ignore */ }
  });
}
