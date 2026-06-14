// LoginScene — port of ClassicUO `Game/Scenes/LoginScene.cs` flow.
//
// State machine (mirrors CUO `LoginSteps`):
//
//   Main             user types account/password, picks Connect
//   Connecting       socket open in flight (loading)
//   VerifyingAccount 0xEF + 0x80 sent, waiting for 0xA8 server list
//   ServerSelection  pick a shard from the list (we usually have 1)
//   LoginInToServer  0xA0/0x91/0xA9 round-trip (loading)
//   CharacterSelection  5 character slots; Play / Delete / New
//   CharacterCreation   4 sub-pages: Appearance → Profession → Trade → City
//   CharacterCreationDone   final 0xF8 sent, waiting for 0x1B
//   EnteringBritania        post-login warm-up (loading)
//   PopUpMessage     blocking error / disclaimer dialog
//
// Every step renders its own gump (DOM panel — Pixi parity is a Phase-7
// follow-up); the LoginBackdrop Pixi animation runs underneath. Step
// transitions go through `_setStep(s)` so the disposer always tears
// down the previous panel before the next one mounts.

import { Scene } from '../core/scene.js';
import { net } from '../net/net-client.js';
import { bus } from '../core/event-bus.js';
import { LoginBackdrop } from './login-backdrop.js';
import {
  buildLoginSeed, buildAccountLogin, buildPlayServer, buildGameLogin,
  buildPlayCharacter, buildClientVersion, buildSystemInfo,
  buildCreateCharacter, buildDeleteCharacter, buildPing,
} from '../net/outgoing.js';
import { GameScene } from './game-scene.js';
import { profile } from '../managers/profile-manager.js';
import { assets } from '../assets/asset-manager.js';
import { SKILL_NAMES_BY_ID } from '../shared/skill-ids.js';

const LS_PREFIX = 'uo.login.';
const ADVANCED_PROFESSION_ID = 0;
const CREATE_SKILL_COUNT = 4;
const CREATE_STAT_TOTAL = 90;
const CREATE_SKILL_TOTALS = new Set([100, 120]);

/** CUO `LoginSteps` enum. */
export const LoginSteps = Object.freeze({
  Main:                  'Main',
  Connecting:            'Connecting',
  VerifyingAccount:      'VerifyingAccount',
  ServerSelection:       'ServerSelection',
  LoginInToServer:       'LoginInToServer',
  CharacterSelection:    'CharacterSelection',
  EnteringBritania:      'EnteringBritania',
  CharacterCreation:     'CharacterCreation',
  CharacterCreationDone: 'CharacterCreationDone',
  PopUpMessage:          'PopUpMessage',
});

/** ServUO Professions.cs presets — [str, dex, int, ...skills(id, val)]. */
// Audit rev.4 P2 — profession presets. Curated defaults below are the
// canonical 8 classes; custom shards can ship `assets/professions.json`
// extracted from Prof.txt to override and expand this list. The merge
// happens via `_loadCustomProfessions()` after asset init.
let PROFESSIONS = [
  { id: 1, name: 'Warrior',     desc: 'Anatomy + Healing + Swords + Tactics',
    str: 45, dex: 35, int: 10,
    skills: [{ id: 2, val: 30 }, { id: 18, val: 30 }, { id: 41, val: 30 }, { id: 28, val: 30 }] },
  { id: 2, name: 'Mage',        desc: 'Eval + Wrestling + Magery + Meditation',
    str: 25, dex: 20, int: 45,
    skills: [{ id: 17, val: 30 }, { id: 44, val: 30 }, { id: 26, val: 30 }, { id: 47, val: 30 }] },
  { id: 3, name: 'Blacksmith',  desc: 'Mining + Arms Lore + Smithing + Tinkering',
    str: 60, dex: 15, int: 15,
    skills: [{ id: 46, val: 30 }, { id: 5, val: 30 }, { id: 8, val: 30 }, { id: 38, val: 30 }] },
  { id: 4, name: 'Necromancer', desc: 'Necromancy + Spirit Speak + Swords + Meditation',
    str: 25, dex: 20, int: 45,
    skills: [{ id: 50, val: 30 }, { id: 33, val: 30 }, { id: 41, val: 30 }, { id: 47, val: 30 }] },
  { id: 5, name: 'Paladin',     desc: 'Chivalry + Swords + Focus + Tactics',
    str: 45, dex: 20, int: 25,
    skills: [{ id: 52, val: 30 }, { id: 41, val: 30 }, { id: 51, val: 30 }, { id: 28, val: 30 }] },
  { id: 6, name: 'Samurai',     desc: 'Bushido + Swords + Anatomy + Healing',
    str: 40, dex: 30, int: 20,
    skills: [{ id: 53, val: 30 }, { id: 41, val: 30 }, { id: 2, val: 30 }, { id: 18, val: 30 }] },
  { id: 7, name: 'Ninja',       desc: 'Ninjitsu + Hiding + Fencing + Stealth',
    str: 40, dex: 30, int: 20,
    skills: [{ id: 54, val: 30 }, { id: 22, val: 30 }, { id: 43, val: 30 }, { id: 48, val: 30 }] },
  { id: 0, name: 'Advanced',    desc: 'Pick your own stats and skills',
    str: 60, dex: 15, int: 15,
    skills: [{ id: 41, val: 30 }, { id: 28, val: 30 }, { id: 18, val: 30 }, { id: 26, val: 30 }] },
];

/** Audit rev.4 P2 — merge `assets.professions` (from Prof.txt extractor)
 *  with the curated defaults above. Custom shards can ship extra classes
 *  via the extractor without touching this file. Called lazily from the
 *  Profession-selection page render so the import is cheap. */
function _loadCustomProfessions(assets) {
  const pro = assets?.professions?.byId;
  if (!pro || typeof pro !== 'object') return;
  const customs = [];
  let nextId = Math.max(...PROFESSIONS.map((p) => p.id)) + 1;
  for (const key of Object.keys(pro)) {
    const p = pro[key];
    // Skip categories (they group children, not directly choosable).
    if (p.isCategory) continue;
    // Skip if a curated default already covers this name (case-insensitive).
    if (PROFESSIONS.some((cp) => cp.name.toLowerCase() === key.toLowerCase())) continue;
    let str = 60, dex = 15, int = 15;
    for (const [sid, val] of p.stats ?? []) {
      if (sid === 0) str = val;
      if (sid === 1) dex = val;
      if (sid === 2) int = val;
    }
    const skills = normalizeCreationSkills((p.skills ?? [])
      .slice(0, CREATE_SKILL_COUNT)
      .map(([sid, val]) => ({ id: sid, val })));
    customs.push({
      id: nextId++,
      name: key,
      desc: p.gumpName || `Custom shard profession`,
      str, dex, int, skills,
    });
  }
  if (customs.length) PROFESSIONS = [...PROFESSIONS.slice(0, -1), ...customs, PROFESSIONS[PROFESSIONS.length - 1]];
}

const SKILL_OPTIONS = Object.entries(SKILL_NAMES_BY_ID)
  .map(([id, name]) => [Number.parseInt(id, 10), name])
  .sort((a, b) => a[0] - b[0]);

const DEFAULT_CREATION_SKILLS = Object.freeze([
  { id: 41, val: 30 },
  { id: 28, val: 30 },
  { id: 18, val: 30 },
  { id: 26, val: 30 },
]);

function normalizeCreationSkills(skills = []) {
  const out = [];
  const seen = new Set();
  const push = (skill) => {
    const id = skill?.id | 0;
    if (id < 1 || id > 58 || seen.has(id) || out.length >= CREATE_SKILL_COUNT) return;
    seen.add(id);
    out.push({ id, val: clamp(skill?.val ?? skill?.value ?? 0, 0, 50) });
  };
  for (const skill of skills) push(skill);
  for (const skill of DEFAULT_CREATION_SKILLS) push(skill);
  return out.slice(0, CREATE_SKILL_COUNT);
}

function creationSkillOptionsForRace(race) {
  const isGargoyle = (race | 0) === 2;
  return SKILL_OPTIONS.filter(([id]) => {
    if (id === 48 || id === 49 || id === 55) return false; // Stealth / Remove Trap / Spellweaving
    if (isGargoyle && id === 32) return false;             // Archery
    if (!isGargoyle && id === 58) return false;            // Throwing
    return true;
  });
}

function validateCreationName(name) {
  const value = String(name ?? '');
  if (value !== value.trim()) return 'Name cannot start or end with whitespace.';
  if (value.length < 2 || value.length > 16) return 'Name must be 2-16 characters.';
  let separators = 0;
  let prevSeparator = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const isLetter = /[A-Za-z]/.test(ch);
    const isSeparator = ch === ' ' || ch === '-' || ch === '.' || ch === "'";
    if (!isLetter && !isSeparator) return 'Name can use letters plus one space, dash, period or quote.';
    if (isSeparator) {
      if (i === 0 || i === value.length - 1 || prevSeparator) return 'Name separator must be between letters.';
      separators++;
      if (separators > 1) return 'Name can use only one separator.';
    }
    prevSeparator = isSeparator;
  }
  return '';
}

const HUMAN_SKIN_HUES = [
  { hue: 0x83EA, label: 'Pale' },
  { hue: 0x83EB, label: 'Light' },
  { hue: 0x83F0, label: 'Tan' },
  { hue: 0x83F2, label: 'Olive' },
  { hue: 0x83F5, label: 'Brown' },
  { hue: 0x83F7, label: 'Bronze' },
  { hue: 0x83FA, label: 'Dark' },
  { hue: 0x83FD, label: 'Ebony' },
];

const ELF_SKIN_VALUES = [
  0x4DE, 0x76C, 0x835, 0x430, 0x24D, 0x24E, 0x24F, 0x0BF,
  0x4A7, 0x361, 0x375, 0x367, 0x3E8, 0x3DE, 0x353, 0x903,
  0x76D, 0x384, 0x579, 0x3E9, 0x374, 0x389, 0x385, 0x376,
  0x53F, 0x381, 0x382, 0x383, 0x76B, 0x3E5, 0x51D, 0x3E6,
];

const SKIN_HUES_BY_RACE = [
  HUMAN_SKIN_HUES,
  ELF_SKIN_VALUES.map((h, i) => ({ hue: h | 0x8000, label: `Elf ${i + 1}` })),
  Array.from({ length: 25 }, (_, i) => ({ hue: (1755 + i) | 0x8000, label: `Stone ${i + 1}` })),
];

const CLOTHING_HUES = [
  { hue: 1102, label: 'Black' },
  { hue: 1108, label: 'Dark Brown' },
  { hue: 1144, label: 'Brown' },
  { hue: 1147, label: 'Auburn' },
  { hue: 1148, label: 'Blond' },
  { hue: 1153, label: 'Light Blond' },
  { hue: 1158, label: 'Red' },
  { hue: 1163, label: 'Crimson' },
  { hue: 1175, label: 'Grey' },
  { hue: 1185, label: 'Silver' },
  { hue: 1190, label: 'White' },
];

const HUMAN_HAIR_HUES = CLOTHING_HUES.filter((h) => h.hue >= 1102 && h.hue <= 1149);
const ELF_HAIR_HUE_VALUES = [
  0x034, 0x035, 0x036, 0x037, 0x038, 0x039, 0x058, 0x08E,
  0x08F, 0x090, 0x091, 0x092, 0x101, 0x159, 0x15A, 0x15B,
  0x15C, 0x15D, 0x15E, 0x128, 0x12F, 0x1BD, 0x1E4, 0x1F3,
  0x207, 0x211, 0x239, 0x251, 0x26C, 0x2C3, 0x2C9, 0x31D,
  0x31E, 0x31F, 0x320, 0x321, 0x322, 0x323, 0x324, 0x325,
  0x326, 0x369, 0x386, 0x387, 0x388, 0x389, 0x38A, 0x59D,
  0x6B8, 0x725, 0x853,
];
const GARGOYLE_HAIR_HUE_VALUES = [
  0x709, 0x70B, 0x70D, 0x70F, 0x711, 0x763,
  0x765, 0x768, 0x76B, 0x6F3, 0x6F1, 0x6EF,
  0x6E4, 0x6E2, 0x6E0,
];

const HAIR_HUES_BY_RACE = [
  HUMAN_HAIR_HUES,
  ELF_HAIR_HUE_VALUES.map((h) => ({ hue: h, label: `Hue ${h.toString(16).toUpperCase().padStart(3, '0')}` })),
  GARGOYLE_HAIR_HUE_VALUES.map((h) => ({ hue: h, label: `Horn ${h.toString(16).toUpperCase().padStart(3, '0')}` })),
];

const HUMAN_HAIR_STYLES = [
  { id: 0x0000, label: 'Bald' },
  { id: 0x203B, label: 'Short' },
  { id: 0x203C, label: 'Long' },
  { id: 0x203D, label: 'Pony tail' },
  { id: 0x2044, label: 'Mohawk' },
  { id: 0x2045, label: 'Pageboy' },
  { id: 0x2047, label: 'Afro' },
  { id: 0x2048, label: 'Receding' },
  { id: 0x2049, label: 'Pigtails' },
  { id: 0x204A, label: 'Krisna' },
  { id: 0x2046, label: 'Buns' },
];
const ELF_HAIR_STYLES = [
  { id: 0x0000, label: 'Bald' },
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
];
const GARGOYLE_HAIR_STYLES_M = [
  { id: 0x0000, label: 'None' },
  { id: 0x4258, label: 'Plain' },
  { id: 0x4259, label: 'Sweptback' },
  { id: 0x425A, label: 'Long' },
  { id: 0x425B, label: 'Medium' },
  { id: 0x425C, label: 'Bun' },
  { id: 0x425D, label: 'Topknot' },
  { id: 0x425E, label: 'Crowned' },
  { id: 0x425F, label: 'Ridge' },
];
const GARGOYLE_HAIR_STYLES_F = [
  { id: 0x0000, label: 'None' },
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
const HUMAN_BEARD_STYLES = [
  { id: 0x0000, label: 'None' },
  { id: 0x203E, label: 'Mustache' },
  { id: 0x203F, label: 'Short beard' },
  { id: 0x2040, label: 'Goatee' },
  { id: 0x2041, label: 'Long beard' },
  { id: 0x204B, label: 'Mustache and beard' },
  { id: 0x204C, label: 'Full beard' },
  { id: 0x204D, label: 'Vandyke' },
];
const GARGOYLE_BEARD_STYLES = [
  { id: 0x0000, label: 'None' },
  { id: 0x42AD, label: 'Jaw horns' },
  { id: 0x42AE, label: 'Hooked jaw' },
  { id: 0x42AF, label: 'Long jaw' },
  { id: 0x42B0, label: 'Crest jaw' },
];

function creationRaceIndex(race) {
  return Math.max(0, Math.min(2, race | 0));
}

function creationSkinHues(race) {
  return SKIN_HUES_BY_RACE[creationRaceIndex(race)] ?? SKIN_HUES_BY_RACE[0];
}

function creationHairHues(race) {
  return HAIR_HUES_BY_RACE[creationRaceIndex(race)] ?? HAIR_HUES_BY_RACE[0];
}

function creationHairStyles(race, sex) {
  const r = creationRaceIndex(race);
  const female = (sex | 0) === 1;
  if (r === 1) {
    return ELF_HAIR_STYLES.filter((s) => {
      if (female) return s.id !== 0x2FBF && s.id !== 0x2FCD;
      return s.id !== 0x2FCC && s.id !== 0x2FD0;
    });
  }
  if (r === 2) return female ? GARGOYLE_HAIR_STYLES_F : GARGOYLE_HAIR_STYLES_M;
  return HUMAN_HAIR_STYLES.filter((s) => {
    if (female) return s.id !== 0x2048;
    return s.id !== 0x2046;
  });
}

function creationBeardStyles(race, sex) {
  if ((sex | 0) === 1) return [{ id: 0, label: 'None' }];
  const r = creationRaceIndex(race);
  if (r === 1) return [{ id: 0, label: 'None' }];
  if (r === 2) return GARGOYLE_BEARD_STYLES;
  return HUMAN_BEARD_STYLES;
}

function normalizeCreationAppearance(c) {
  if (!c) return c;
  c.race = creationRaceIndex(c.race);
  c.sex = c.sex === 1 ? 1 : 0;
  const skin = creationSkinHues(c.race);
  if (!skin.some((h) => h.hue === c.skinHue)) c.skinHue = skin[Math.min(2, skin.length - 1)]?.hue ?? 0x83EA;
  const hairStyles = creationHairStyles(c.race, c.sex);
  if (!hairStyles.some((s) => s.id === c.hairId)) c.hairId = hairStyles[1]?.id ?? hairStyles[0]?.id ?? 0;
  const hairHues = creationHairHues(c.race);
  if (!hairHues.some((h) => h.hue === c.hairHue)) c.hairHue = hairHues[1]?.hue ?? hairHues[0]?.hue ?? 0;
  const beardStyles = creationBeardStyles(c.race, c.sex);
  if (!beardStyles.some((s) => s.id === c.beardId)) c.beardId = 0;
  if (beardStyles.length <= 1) c.beardId = 0;
  c.beardHue = c.hairHue;
  return c;
}

// Max slots displayed in the character picker. ServUO supports 5, 6, or
// 7 depending on the account's `CharacterSlot` flags (see flags 0x80
// SixthCharacterSlot / 0x40 SeventhCharacterSlot in 0xA9 char list).
// 7 covers every modern ServUO config — extra empty slots just render as
// "— Empty Slot —" placeholders which is harmless. The earlier cap of 5
// hid characters at slot index ≥ 5, and clicking a "below the fold"
// character was impossible — _doPlay would always send slot 0..4 and
// ServUO rejected with "Invalid Character Selection" because account[0]
// was actually empty.
const MAX_CHAR_SLOTS = 7;

export class LoginScene extends Scene {
  constructor(gc) {
    super(gc);
    this._panel = null;
    this._unsubs = [];
    // _step starts as null — the first `_setStep(Main)` from load() must
    // run the renderer. Pre-seeding it to Main here would trip the
    // `if (this._step === step) return` guard and the form would never
    // mount (visible: only the LoginBackdrop sun glow, no DOM panel).
    this._step = null;
    this._popupOnDismiss = null;
    /** Account form state — survives across step transitions. */
    this._account = '';
    this._password = '';
    this._host = '127.0.0.1';
    this._port = 2593;
    /** 'ws' (direct to our shard) or 'bridge' (ws→tcp proxy to ServUO).
     *  Kept on the scene so `_onRelay` knows whether to do the canonical
     *  UO disconnect-and-reconnect dance — required for ServUO + the
     *  bridge, harmful for our same-socket WS path. */
    this._mode = 'ws';
    this._bridgeUrl = '';
    /** Server-list reply payload. */
    this._servers = [];
    this._serverIndex = 0;
    this._serverPingSeq = 0;
    this._serverPingSent = new Map();
    this._serverPingMs = null;
    this._serverPingTimer = null;
    /** 0x8C relay reply (kept so the resend at LoginInToServer reuses authKey). */
    this._relay = null;
    /** 0xA9 reply: 5 character slots + city list. */
    this._characters = [];
    this._cities = [];
    /** CharCreation working buffer — built page-by-page. */
    this._creation = null;
    this._creationPage = 0;
  }

  // --------------------------------------------------------------------------
  // Scene lifecycle

  async load() {
    this._backdrop = new LoginBackdrop(this.gc.ui);
    this._mountBg();

    this._sub('login:rejected',     (info) => this._onRejected(info));
    this._sub('login:server-list',  (info) => this._onServerList(info));
    this._sub('login:relay',        (info) => this._onRelay(info));
    this._sub('login:char-list',    (info) => this._onCharList(info));
    this._sub('world:login-confirm',()     => this._onLoginConfirm());
    this._sub('net:close',          ()     => this._onSocketClosed());
    this._sub('net:ping',           (info) => this._onServerPing(info));

    this._setStep(LoginSteps.Main);
    this.gc.setStatus('idle');
    // Login intro music — UO uses track 0 (oldult01 / "Stones") as the
    // ambient title-screen loop. Profile gate (`audio.loginMusic`)
    // lets the user disable it from Options. Browsers will not start
    // playback until the first user gesture (click on the panel),
    // which audio-manager handles via its 'pointerdown' kicker.
    try {
      // Defer one tick so the AudioContext init can fire from the
      // backdrop's hover handlers before we ask for music.
      setTimeout(() => bus.emit('atmosphere:music', { musicId: 0 }), 100);
    } catch { /* audio is best-effort */ }
  }

  unload() {
    this._stopServerPingProbe();
    for (const u of this._unsubs) u();
    this._unsubs.length = 0;
    this._panel?.remove(); this._panel = null;
    this._bg?.remove();    this._bg = null;
    this._backdrop?.destroy(); this._backdrop = null;
  }

  resize() { /* DOM panels centered via CSS */ }

  // --------------------------------------------------------------------------
  // State machine driver

  /** Swap to a new step — tears down the current panel and mounts the next. */
  _setStep(step, payload = null) {
    if (this._step === step) return;
    if (this._step === LoginSteps.ServerSelection && step !== LoginSteps.ServerSelection) {
      this._stopServerPingProbe();
    }
    this._step = step;
    this._panel?.remove(); this._panel = null;
    switch (step) {
      case LoginSteps.Main:                  this._renderMain(); break;
      case LoginSteps.Connecting:            this._renderLoading('Connecting to server'); break;
      case LoginSteps.VerifyingAccount:      this._renderLoading('Verifying account'); break;
      case LoginSteps.ServerSelection:       this._renderServerSelection(); break;
      case LoginSteps.LoginInToServer:       this._renderLoading('Logging in to server'); break;
      case LoginSteps.CharacterSelection:    this._renderCharacterSelection(); break;
      case LoginSteps.CharacterCreation:     this._renderCharacterCreation(); break;
      case LoginSteps.CharacterCreationDone: this._renderLoading('Creating character'); break;
      case LoginSteps.EnteringBritania:      this._renderLoading('Entering Britannia'); break;
      case LoginSteps.PopUpMessage:          this._renderPopup(payload); break;
      default: break;
    }
    this.gc.setStatus(step.toLowerCase());
  }

  // --------------------------------------------------------------------------
  // Background — gradient + dragon silhouette behind every step

  _mountBg() {
    this._bg = document.createElement('div');
    this._bg.id = 'uo-login-bg';
    this._bg.style.cssText = `
      position:fixed; inset:0; z-index:0; pointer-events:none;
      background:
        radial-gradient(ellipse at 50% 35%, rgba(255,224,128,0.18), transparent 60%),
        radial-gradient(ellipse at 50% 100%, rgba(120,68,30,0.45), transparent 70%),
        linear-gradient(180deg, #0a0d12 0%, #1a1206 60%, #06080a 100%);
    `;
    const dragonSvg = encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid meet">
        <defs><radialGradient id="g" cx="50%" cy="50%" r="60%">
          <stop offset="0%" stop-color="#f0c878" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="#f0c878" stop-opacity="0"/>
        </radialGradient></defs>
        <circle cx="300" cy="200" r="180" fill="url(#g)"/>
        <path d="M120 240 q40 -90 110 -120 q60 -25 110 0 q40 18 60 60 q15 35 5 70 q-10 35 -50 55 q-30 15 -70 10 q-40 -5 -75 -25 q-30 -18 -50 -25 q-30 -10 -45 -25 q-12 -12 5 -10 q15 1 30 5 z" fill="#f0c878" opacity="0.10"/>
      </svg>
    `).replace(/\s+/g, ' ');
    const dragonLayer = document.createElement('div');
    dragonLayer.style.cssText = `
      position:absolute; inset:0; pointer-events:none;
      background: url("data:image/svg+xml;utf8,${dragonSvg}") center/720px no-repeat;
      opacity:0.6; mix-blend-mode:screen;
    `;
    this._bg.appendChild(dragonLayer);
    this.gc.domMount(this._bg);
  }

  /** Mount a fresh panel element (replaces any previous panel). */
  _mountPanel(html, opts = {}) {
    const wrap = document.createElement('div');
    wrap.innerHTML = html.trim();
    this._panel = wrap.firstElementChild;
    this._panel.classList.add('uo-panel');
    Object.assign(this._panel.style, {
      position: 'fixed',
      top: '50%', left: '50%',
      transform: 'translate(-50%, -50%)',
      minWidth: opts.minWidth ?? '380px',
      zIndex: 10,
      boxShadow: '0 8px 40px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,224,128,0.15)',
    });
    if (opts.maxWidth) this._panel.style.maxWidth = opts.maxWidth;
    this.gc.domMount(this._panel);
    return this._panel;
  }

  // --------------------------------------------------------------------------
  // Step: Main — account login form

  _renderMain() {
    const remembered = {
      host: localStorage.getItem(LS_PREFIX + 'host')    ?? this._host,
      port: localStorage.getItem(LS_PREFIX + 'port')    ?? String(this._port),
      account: localStorage.getItem(LS_PREFIX + 'account') ?? this._account,
      mode: localStorage.getItem(LS_PREFIX + 'mode')    ?? 'ws',
      bridgeUrl: localStorage.getItem(LS_PREFIX + 'bridgeUrl') ?? 'ws://127.0.0.1:2595/bridge',
    };
    const modeBridge = remembered.mode === 'bridge';
    this._mountPanel(`
      <div>
        <h1 style="text-align:center;letter-spacing:6px;font-size:14px;margin-bottom:14px">ULTIMA ONLINE</h1>
        <label>Transport</label>
        <select id="m-mode" style="width:100%;margin-bottom:8px">
          <option value="ws"     ${modeBridge ? '' : 'selected'}>WebSocket (UO-Node server)</option>
          <option value="bridge" ${modeBridge ? 'selected' : ''}>TCP via bridge (ServUO / RunUO / OSI)</option>
        </select>
        <div id="m-bridge-row" style="display:${modeBridge ? '' : 'none'};margin-bottom:6px">
          <label>Bridge WS URL</label>
          <input id="m-bridge" type="text" value="${esc(remembered.bridgeUrl)}" />
        </div>
        <label>Shard host : port</label>
        <div class="row">
          <input id="m-host" type="text" value="${esc(remembered.host)}" />
          <input id="m-port" type="text" value="${esc(remembered.port)}" style="max-width:80px" />
        </div>
        <label>Account Name</label>
        <input id="m-account" type="text" value="${esc(remembered.account)}" maxlength="30" />
        <label>Password</label>
        <input id="m-password" type="password" value="" maxlength="30" />
        <div class="row" style="margin-top:10px">
          <button id="m-quit">Quit</button>
          <button id="m-login" class="primary" style="flex:2">Log In</button>
        </div>
        <div id="m-msg" class="uo-status-line"></div>
        <div style="font-size:10px;color:#605040;margin-top:14px;text-align:center;letter-spacing:1px">
          ULTIMA ONLINE — Web Edition
        </div>
      </div>
    `);
    // Transport selector toggles the bridge URL row.
    const modeSel = this._panel.querySelector('#m-mode');
    const bridgeRow = this._panel.querySelector('#m-bridge-row');
    modeSel?.addEventListener('change', () => {
      bridgeRow.style.display = modeSel.value === 'bridge' ? '' : 'none';
    });
    const accIn = this._panel.querySelector('#m-account');
    const pwIn = this._panel.querySelector('#m-password');
    pwIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._doConnect(); });
    accIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') pwIn.focus(); });
    this._panel.querySelector('#m-login').addEventListener('click', () => this._doConnect());
    this._panel.querySelector('#m-quit').addEventListener('click', () => {
      try { window.close(); } catch { /* navigation gated */ }
    });
    accIn.value ? pwIn.focus() : accIn.focus();
  }

  _setMainMsg(text) {
    const el = this._panel?.querySelector('#m-msg');
    if (el) el.textContent = text ?? '';
  }

  async _doConnect() {
    if (!this._panel) return;
    const host = this._panel.querySelector('#m-host').value.trim();
    const port = Number(this._panel.querySelector('#m-port').value.trim());
    const account = this._panel.querySelector('#m-account').value.trim();
    const password = this._panel.querySelector('#m-password').value;
    const mode = this._panel.querySelector('#m-mode')?.value ?? 'ws';
    const bridgeUrl = this._panel.querySelector('#m-bridge')?.value?.trim()
                   ?? 'ws://127.0.0.1:2595/bridge';
    if (!host || !port || !account) {
      this._setMainMsg('please fill server, port and account');
      return;
    }
    localStorage.setItem(LS_PREFIX + 'host', host);
    localStorage.setItem(LS_PREFIX + 'port', String(port));
    localStorage.setItem(LS_PREFIX + 'account', account);
    localStorage.setItem(LS_PREFIX + 'mode', mode);
    localStorage.setItem(LS_PREFIX + 'bridgeUrl', bridgeUrl);
    this._host = host; this._port = port;
    this._account = account; this._password = password;
    this._mode = mode;
    this._bridgeUrl = bridgeUrl;

    this._setStep(LoginSteps.Connecting);
    // Bridge mode: ws connection to the local bridge with `?target=host:port`
    // — the bridge opens a raw TCP socket to the real shard. WS mode talks
    // directly to our @uo/server on /game.
    const url = mode === 'bridge'
      ? `${bridgeUrl}${bridgeUrl.includes('?') ? '&' : '?'}target=${encodeURIComponent(host + ':' + port)}`
      : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${host}:${port}/game`;
    try {
      await net.connect(url);
    } catch (e) {
      this._showPopup(`Connection failed: ${e.message}`, () => this._setStep(LoginSteps.Main));
      return;
    }
    this._setStep(LoginSteps.VerifyingAccount);
    net.send(buildLoginSeed(0x7F000001));
    net.send(buildAccountLogin(account, password));
  }

  // --------------------------------------------------------------------------
  // Step: ServerSelection — pick a shard

  _onServerList(info) {
    this._servers = info?.servers?.length ? info.servers
      : [{ index: 0, name: 'Local Shard', percent: 0, timezone: 0, ip: 0 }];
    this._setStep(LoginSteps.ServerSelection);
  }

  _renderServerSelection() {
    const pingText = () => this._serverPingMs == null ? '...' : `${this._serverPingMs} ms`;
    const rows = this._servers.map((s, i) => `
      <div class="uo-server-row" data-idx="${i}" tabindex="0">
        <span class="uo-server-name">${esc(s.name)}</span>
        <span class="uo-server-load">${s.percent ?? 0}%</span>
        <span class="uo-server-ping">${pingText()}</span>
      </div>
    `).join('');
    this._mountPanel(`
      <div style="min-width:360px">
        <h1 style="text-align:center;letter-spacing:6px;font-size:14px;margin-bottom:14px">SELECT SERVER</h1>
        <div class="uo-server-list">${rows}</div>
        <div class="row" style="margin-top:10px">
          <button id="ss-back">Back</button>
          <button id="ss-next" class="primary" style="flex:2">Connect</button>
        </div>
      </div>
    `);
    const rowsEl = [...this._panel.querySelectorAll('.uo-server-row')];
    const select = (i) => {
      this._serverIndex = i;     // Client audit #6 #2 — was hardcoded 0
      rowsEl.forEach((r, j) => r.classList.toggle('selected', j === i));
    };
    rowsEl.forEach((r, i) => {
      r.addEventListener('click', () => select(i));
      r.addEventListener('dblclick', () => { select(i); this._doSelectServer(); });
    });
    select(0);
    this._panel.querySelector('#ss-back').addEventListener('click', () => this._goBackToMain());
    this._panel.querySelector('#ss-next').addEventListener('click', () => this._doSelectServer());

    // Inject server-list styling once.
    this._injectStyles();
    this._startServerPingProbe();

    // Client audit #6 #2: removed auto-select timeout. Single-server
    // shards just need the user to click Connect (or double-click row);
    // the previous unconditional 30 ms timer ignored the choice and
    // always logged into server 0 for multi-server lists.
    if (this._servers.length === 1) {
      this._serverIndex = 0;
      setTimeout(() => this._doSelectServer(), 30);
    }
  }

  _doSelectServer() {
    if (this._step !== LoginSteps.ServerSelection) return;
    this._setStep(LoginSteps.LoginInToServer);
    net.send(buildPlayServer(this._serverIndex));
  }

  _startServerPingProbe() {
    this._stopServerPingProbe();
    const send = () => {
      if (this._step !== LoginSteps.ServerSelection) return;
      if (!net.ws || net.ws.readyState !== WebSocket.OPEN) return;
      const seq = (this._serverPingSeq = (this._serverPingSeq + 1) & 0xff);
      this._serverPingSent.set(seq, performance.now());
      while (this._serverPingSent.size > 8) {
        const first = this._serverPingSent.keys().next().value;
        this._serverPingSent.delete(first);
      }
      try { net.send(buildPing(seq)); } catch { /* socket may close mid-probe */ }
    };
    send();
    this._serverPingTimer = setInterval(send, 10_000);
  }

  _stopServerPingProbe() {
    if (this._serverPingTimer) {
      clearInterval(this._serverPingTimer);
      this._serverPingTimer = null;
    }
    this._serverPingSent.clear();
  }

  _onServerPing({ seq } = {}) {
    const sentAt = this._serverPingSent.get(seq & 0xff);
    if (!sentAt) return;
    this._serverPingSent.delete(seq & 0xff);
    this._serverPingMs = Math.max(0, Math.round(performance.now() - sentAt));
    if (this._step !== LoginSteps.ServerSelection || !this._panel) return;
    for (const el of this._panel.querySelectorAll('.uo-server-ping')) {
      el.textContent = `${this._serverPingMs} ms`;
    }
  }

  _onRelay(info) {
    this._relay = info;
    // ServUO (and OSI/RunUO) requires the client to DISCONNECT after
    // 0x8C Relay and reconnect to the game-server address embedded in
    // the relay payload. The new connection must begin with a 4-byte
    // bare authKey, then 0x91 GameLogin. Without the reconnect ServUO
    // re-runs Encryption.DetermineClientType on the next received
    // packet on the original socket, sees the wrong seed pattern and
    // logs "Encrypted Client Unsupported". Marcin's symptom exactly.
    //
    // Our same-port WS shard (our @uo/server) accepts the in-place
    // continuation just fine — keep the legacy behaviour there since
    // bouncing the WS would otherwise add a needless 200 ms reconnect
    // round-trip. Detection: `this._mode === 'bridge'`.
    if (this._mode === 'bridge') {
      this._relayReconnect(info);
      return;
    }
    net.send(buildClientVersion('7.0.95.0'));
    net.send(buildSystemInfo());
    net.send(buildGameLogin(info.authKey, this._account, this._password));
  }

  async _relayReconnect(info) {
    // Decode IP — ServUO writes the relay's listen IP as u32 BE in the
    // 0x8C payload. We point the bridge at THAT IP:port so it opens a
    // fresh TCP socket to the game server (which is the same ServUO
    // process on classic single-port setups, but a different host in
    // a multi-server shard). authKey rides as the FIRST 4 bytes of the
    // new socket (bridge's auto-prepend bows out when buf[4]==0x91).
    const ipStr = `${(info.ip >>> 24) & 0xff}.${(info.ip >>> 16) & 0xff}.${(info.ip >>> 8) & 0xff}.${info.ip & 0xff}`;
    const url = `${this._bridgeUrl}${this._bridgeUrl.includes('?') ? '&' : '?'}target=${encodeURIComponent(ipStr + ':' + info.port)}`;
    try {
      net.close();
      await net.connect(url);
    } catch (e) {
      this._showPopup(`Relay reconnect failed: ${e.message}`, () => this._setStep(LoginSteps.Main));
      return;
    }
    // Send authKey as a 4-byte bare seed FUSED with 0x91 GameLogin in
    // a SINGLE WS message. ServUO's Encryption check expects:
    //   bytes 0..3 = u32 BE seed (= authKey)
    //   byte  4    = 0x91 / 0x80 / 0xEF (a known login opcode)
    // If we send them as two separate ws.send() calls the bridge sees
    // each WS frame as a chunk. The bridge's bare-seed auto-prepend
    // would then mis-fire on the FIRST 4-byte chunk (it's only 4
    // bytes, the "buf.length >= 5 && buf[4] === 0x91" detection can't
    // run yet) and prepend ANOTHER seed — ServUO sees gibberish at
    // byte 4 of the new TCP stream and rejects with "Encrypted Client
    // Unsupported". One concat -> single frame -> bridge sees
    // buf[4]===0x91 and bows out of prepending.
    const game = buildGameLogin(info.authKey, this._account, this._password);
    const fused = new Uint8Array(4 + game.length);
    fused[0] = (info.authKey >>> 24) & 0xff;
    fused[1] = (info.authKey >>> 16) & 0xff;
    fused[2] = (info.authKey >>>  8) & 0xff;
    fused[3] =  info.authKey         & 0xff;
    fused.set(game, 4);
    net.send(fused);
    // Do NOT send ClientVersion (0xBD) / SystemInfo (0xA4) here. ServUO
    // marks 0xBD as `ingame=true` in PacketHandlers — at the character-
    // list phase state.Mobile is null and ServUO rejects with "Packet
    // (0xBD) Requires State Mobile" + disconnect (Marcin's symptom on
    // the bridge path). ClassicUO actually sends ClientVersion only in
    // RESPONSE to a server-side 0xBD request, never proactively here.
    // We deferred the version push to the in-game phase — see the
    // 0xBD-from-server handler that echoes our version back.
  }

  // --------------------------------------------------------------------------
  // Step: CharacterSelection — 5 slots + Play / Delete / New

  _onCharList(info) {
    this._characters = info.characters ?? [];
    this._cities = info.cities ?? [];
    // Audit #46 P2 — slot count derived from 0xA9 flags by incoming.js.
    // Falls back to MAX_CHAR_SLOTS (7) when the server didn't specify.
    this._slotCount = Math.min(MAX_CHAR_SLOTS, Math.max(1, info.slotCount | 0 || MAX_CHAR_SLOTS));
    while (this._characters.length < this._slotCount) {
      this._characters.push({ name: '', slot: this._characters.length });
    }
    this._setStep(LoginSteps.CharacterSelection);
  }

  _renderCharacterSelection() {
    const slotCount = this._slotCount | 0 || MAX_CHAR_SLOTS;
    const slots = this._characters.slice(0, slotCount).map((c, i) => {
      const empty = !c?.name || !c.name.trim();
      return `
        <div class="uo-char-slot ${empty ? 'empty' : ''}" data-slot="${i}" tabindex="0">
          <div class="uo-slot-num">${i + 1}</div>
          <div class="uo-slot-name">${empty ? '— Empty Slot —' : esc(c.name)}</div>
        </div>
      `;
    }).join('');
    this._mountPanel(`
      <div style="min-width:420px">
        <h1 style="text-align:center;letter-spacing:6px;font-size:14px;margin-bottom:14px">SELECT CHARACTER</h1>
        <div class="uo-char-list">${slots}</div>
        <div class="row" style="margin-top:14px;gap:6px">
          <button id="cs-back">Back</button>
          <button id="cs-delete">Delete</button>
          <button id="cs-new">New</button>
          <button id="cs-play" class="primary" style="flex:2" disabled>Play</button>
        </div>
        <div id="cs-msg" class="uo-status-line"></div>
      </div>
    `);
    this._injectStyles();
    let chosen = -1;
    const slotsEl = [...this._panel.querySelectorAll('.uo-char-slot')];
    const playBtn = this._panel.querySelector('#cs-play');
    const delBtn  = this._panel.querySelector('#cs-delete');
    const refresh = () => {
      slotsEl.forEach((r, j) => r.classList.toggle('selected', j === chosen));
      const c = this._characters[chosen];
      const isEmpty = !c?.name || !c.name.trim();
      playBtn.disabled = chosen < 0 || isEmpty;
      delBtn.disabled  = chosen < 0 || isEmpty;
    };
    slotsEl.forEach((r, i) => {
      r.addEventListener('click', () => { chosen = i; refresh(); });
      r.addEventListener('dblclick', () => {
        chosen = i; refresh();
        const c = this._characters[chosen];
        if (c?.name?.trim()) this._doPlay();
        else this._beginCreation();
      });
    });
    refresh();
    this._panel.querySelector('#cs-back').addEventListener('click', () => this._goBackToMain());
    this._panel.querySelector('#cs-new').addEventListener('click', () => this._beginCreation());
    this._panel.querySelector('#cs-delete').addEventListener('click', () => {
      if (chosen < 0) return;
      const c = this._characters[chosen];
      if (!c?.name?.trim()) return;
      this._showPopup(`Delete "${c.name}"?\nThis cannot be undone.`,
        () => this._setStep(LoginSteps.CharacterSelection),
        () => {
          // Client audit #6 #1 — actually send 0x83 DeleteCharacter so
          // the server clears the slot. Was bus-only → character
          // reappeared on next char-list refresh.
          try { net.send(buildDeleteCharacter(chosen, this._password ?? '')); }
          catch (e) { console.warn('[login] delete send failed', e); }
          bus.emit('login:delete-character', { slot: chosen, name: c.name });
          this._characters[chosen] = { name: '', slot: chosen };
          this._setStep(LoginSteps.Main);   // remount → re-renders char list
          this._setStep(LoginSteps.CharacterSelection);
        });
    });
    playBtn.addEventListener('click', () => { if (chosen >= 0) { this._chosenSlot = chosen; this._doPlay(); } });
  }

  _doPlay() {
    const slot = this._chosenSlot ?? 0;
    const c = this._characters[slot];
    // Diagnostic — surfaces the (slot, name) we're about to send so a
    // server-side "Invalid Character Selection" error is traceable
    // back to the wire payload without packet captures. Names dump
    // includes every slot ServUO advertised in 0xA9 so we can tell
    // whether the clicked index lines up.
    if (net?.tracePackets || import.meta?.env?.DEV) {
      const allNames = (this._characters ?? [])
        .map((cc, i) => `${i}:${cc?.name?.trim() || '—'}`).join(' ');
      console.log(`[login] PlayCharacter slot=${slot} name='${c?.name ?? ''}' | char list: ${allNames}`);
    }
    this._setStep(LoginSteps.EnteringBritania);
    net.send(buildPlayCharacter(c?.name ?? '', slot));
  }

  // --------------------------------------------------------------------------
  // Step: CharacterCreation — 4 sub-pages

  _beginCreation() {
    this._creation = {
      name: '',
      sex: 0, race: 0,
      profession: 1, skipTrade: true,
      str: 45, dex: 35, int: 10,
      skills: normalizeCreationSkills(PROFESSIONS[0].skills),
      skinHue: creationSkinHues(0)[2].hue,
      hairId: creationHairStyles(0, 0)[1].id,
      hairHue: creationHairHues(0)[1].hue,
      beardId: 0,
      beardHue: creationHairHues(0)[1].hue,
      shirtHue: 0,
      pantsHue: 0,
      city: this._cities?.[0]?.index ?? 0,
      slot: this._characters.findIndex((c) => !c?.name?.trim()),
    };
    if (this._creation.slot < 0) this._creation.slot = 0;
    this._creationPage = 0;
    this._setStep(LoginSteps.CharacterCreation);
  }

  _renderCharacterCreation() {
    // Audit #46 P2 — CUO canonical char-create order is:
    //   0 = Appearance → 1 = Profession → 2 = Trade → 3 = City
    // (per `CharCreationGump.cs:27,160,174`). Was Profession-first
    // which forced the user to pick a class before knowing how the
    // avatar looks. Profession step also pre-fills Trade stats so it
    // still has to come BEFORE Trade — only Appearance and Profession
    // swap.
    switch (this._creationPage) {
      case 0: this._renderCcAppearance(); break;
      case 1: this._renderCcProfession(); break;
      case 2: this._renderCcTrade(); break;
      case 3: this._renderCcCity(); break;
    }
  }

  _renderCcProfession() {
    // Audit rev.4 P2 — merge custom shard professions from
    // `assets.professions` if present (Prof.txt extractor output).
    try {
      if (assets?.professions) _loadCustomProfessions(assets);
    } catch { /* noop */ }
    const profRows = PROFESSIONS.map((p) => `
      <div class="uo-prof-row" data-id="${p.id}" tabindex="0">
        <div class="uo-prof-name">${esc(p.name)}</div>
        <div class="uo-prof-desc">${esc(p.desc)}</div>
      </div>
    `).join('');
    this._mountPanel(`
      <div style="min-width:480px">
        <h1 style="text-align:center;letter-spacing:6px;font-size:14px;margin-bottom:6px">CHOOSE A PROFESSION</h1>
        <div style="font-size:11px;color:#a48830;text-align:center;margin-bottom:10px">
          Step 2 of 4 — pick a starting template
        </div>
        <div class="uo-prof-list">${profRows}</div>
        <div class="row" style="margin-top:14px">
          <button id="cc-back">Back</button>
          <button id="cc-next" class="primary" style="flex:2">Next</button>
        </div>
      </div>
    `);
    this._injectStyles();
    let chosen = this._creation.profession;
    const rows = [...this._panel.querySelectorAll('.uo-prof-row')];
    const refresh = () => rows.forEach((r) => r.classList.toggle('selected', +r.dataset.id === chosen));
    rows.forEach((r) => {
      r.addEventListener('click', () => { chosen = +r.dataset.id; refresh(); });
      r.addEventListener('dblclick', () => {
        chosen = +r.dataset.id;
        this._commitProfession(chosen);
        this._creationPage = this._creation.skipTrade ? 3 : 2;
        this._setStep(LoginSteps.Main); this._setStep(LoginSteps.CharacterCreation);
      });
    });
    refresh();
    // Audit #46 P2 — CUO order has Profession at page 1 (after Appearance).
    // Back returns to Appearance (page 0). Next advances to Trade (page 2).
    this._panel.querySelector('#cc-back').addEventListener('click', () => {
      this._creationPage = 0;
      this._setStep(LoginSteps.Main); this._setStep(LoginSteps.CharacterCreation);
    });
    this._panel.querySelector('#cc-next').addEventListener('click', () => {
      this._commitProfession(chosen);
      this._creationPage = this._creation.skipTrade ? 3 : 2;
      this._setStep(LoginSteps.Main); this._setStep(LoginSteps.CharacterCreation);
    });
  }

  _commitProfession(id) {
    const p = PROFESSIONS.find((x) => x.id === id) ?? PROFESSIONS[0];
    this._creation.profession = id;
    this._creation.str = p.str;
    this._creation.dex = p.dex;
    this._creation.int = p.int;
    this._creation.skills = normalizeCreationSkills(p.skills);
    this._creation.skipTrade = id !== ADVANCED_PROFESSION_ID;
  }

  /** Audit #46 P2 — live paperdoll preview during Appearance step.
   *  Renders body / hair / beard sprites from the extracted gump atlas
   *  PNGs (page + xy frame). Updates whenever a select changes. No
   *  Pixi dependency — vanilla DOM divs with `background-image` +
   *  `background-position` for sprite-sheet positioning.
   *
   *  Hue tinting via CSS filter (multiply-blend approximation). The
   *  full UO hue palette LUT is not used here — instead we map each
   *  preset hue to its perceptual RGB and apply via CSS variables.
   *  The preview is "accurate enough" for the user to compare styles;
   *  the in-world sprite uses the real palette downstream. */
  _renderCcPreview(target) {
    if (!target) return;
    const c = this._creation;
    const isFemale = c.sex === 1;
    const bodyGumpId = isFemale ? 0x000D : 0x000C;
    // Look up hair / beard paperdoll gump ids via tiledata animId +
    // 50000/60000 (matches PaperdollGump.resolveEquipGumpId).
    const hairGump = this._hairPaperdollId(c.hairId, isFemale);
    const beardGump = (!isFemale && c.beardId) ? this._hairPaperdollId(c.beardId, false) : 0;
    // Default shirt / pants gumps (CUO `Game/Data/Layer.cs` shirt=21
    // pants=22 — paperdoll uses 0x1518 shirt male / 0x1517 female,
    // 0x1539 pants). The preview shows these always-on so the user
    // sees colour changes.
    const shirtGump = this._itemPaperdollId(isFemale ? 0x1518 : 0x1517, isFemale);
    const pantsGump = this._itemPaperdollId(0x1539, isFemale);
    // Look up tile frame for each.
    const atlas = assets?.gumpAtlas ?? ((typeof globalThis !== 'undefined') && globalThis.__assets?.gumpAtlas);
    const tiles = atlas?.tiles;
    const lookup = (gid) => (tiles?.[gid] ?? null);
    const BASE = ((typeof window !== 'undefined') && window.__assetsBase) || '/assets';
    const layer = (gump, hueRgb) => {
      const meta = lookup(gump);
      if (!meta) return '';
      const mx = meta.u ?? meta.x ?? 0;
      const my = meta.v ?? meta.y ?? 0;
      const url = `${BASE}/gump-atlas-${String(meta.page).padStart(3, '0')}.png`;
      const filter = hueRgb
        ? `drop-shadow(0 0 0 #${hueRgb.toString(16).padStart(6, '0')})`
        : '';
      return `<div style="position:absolute;left:50%;top:0;width:${meta.w}px;height:${meta.h}px;margin-left:${-(meta.w / 2) | 0}px;background:url('${url}') -${mx}px -${my}px no-repeat;filter:${filter};image-rendering:pixelated"></div>`;
    };
    const skinRgb  = this._paletteHueRgb(c.skinHue);
    const hairRgb  = this._paletteHueRgb(c.hairHue);
    const shirtRgb = this._paletteHueRgb(c.shirtHue);
    const pantsRgb = this._paletteHueRgb(c.pantsHue);
    target.innerHTML = `
      <div style="position:relative;width:140px;height:170px;margin:6px auto 0;background:#1a1410;border:1px solid #6a4a18">
        ${layer(bodyGumpId, skinRgb)}
        ${shirtGump ? layer(shirtGump, shirtRgb) : ''}
        ${pantsGump ? layer(pantsGump, pantsRgb) : ''}
        ${hairGump ? layer(hairGump, hairRgb) : ''}
        ${beardGump ? layer(beardGump, hairRgb) : ''}
      </div>
      <div style="text-align:center;font-size:10px;color:#a48830;margin-top:4px">Live preview</div>
    `;
  }

  /** Approximate UO hue index → CSS-friendly RGB for the live preview
   *  filter. We don't have the full hue.mul LUT in the login scene's
   *  loader scope, so we synthesize a perceptual colour from common
   *  preset hues by a small lookup table + fall back to a hash-based
   *  hue rotation. */
  _paletteHueRgb(hueIndex) {
    if (!hueIndex) return null;
    const TABLE = {
      // Skin (selected presets near 0x83EA..0x83FD)
      0x83EA: 0xF4E0BD, 0x83EB: 0xE0C49A, 0x83F0: 0xC6A57D, 0x83F2: 0xA68760,
      0x83F5: 0x8B6A48, 0x83F7: 0x6F5238, 0x83FA: 0x4E3825, 0x83FD: 0x2E1F12,
      // Hair palette (rough mapping)
      1102: 0x111111, 1108: 0x2B1A0F, 1144: 0x5A3A1A, 1147: 0x8B3A1A,
      1148: 0xD8B070, 1153: 0xF2E2A0, 1158: 0xC02020, 1163: 0x801010,
      1175: 0x808080, 1185: 0xC0C0C0, 1190: 0xF0F0F0,
    };
    if (TABLE[hueIndex] != null) return TABLE[hueIndex];
    const rawHue = hueIndex & 0x3fff;
    const mix = (a, b, t) => {
      const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
      const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
      const r = Math.round(ar + (br - ar) * t);
      const g = Math.round(ag + (bg - ag) * t);
      const bl = Math.round(ab + (bb - ab) * t);
      return (r << 16) | (g << 8) | bl;
    };
    if (rawHue >= 1002 && rawHue <= 1058) return mix(0xF4E0BD, 0x2E1F12, (rawHue - 1002) / 56);
    const elfTone = ELF_SKIN_VALUES.indexOf(rawHue);
    if (elfTone >= 0) return mix(0xE5D0A8, 0x9BB88E, (elfTone % 16) / 15);
    if (rawHue >= 1755 && rawHue <= 1779) return mix(0xC3B6A0, 0x74685F, (rawHue - 1755) / 24);
    // Fallback — perceptual derivation from the hue index modulo.
    const h = (hueIndex * 137) & 0xFFFFFF;
    return h;
  }

  _hairPaperdollId(itemId, isFemale) {
    return this._itemPaperdollId(itemId, isFemale);
  }

  _itemPaperdollId(itemId, isFemale) {
    if (!itemId) return 0;
    const ASSETS = assets ?? ((typeof globalThis !== 'undefined') && globalThis.__assets);
    const animId = ASSETS?.tiledata?.statics?.[itemId]?.animId | 0;
    const tiles = ASSETS?.gumpAtlas?.tiles;
    if (animId <= 0) return tiles?.[itemId] ? itemId : 0;
    const base = isFemale ? 60000 : 50000;
    const preferred = animId + base;
    const fallback = animId + 50000;
    if (tiles?.[preferred]) return preferred;
    if (tiles?.[fallback]) return fallback;
    return tiles?.[itemId] ? itemId : preferred;
  }

  _renderCcAppearance() {
    const c = normalizeCreationAppearance(this._creation);
    const skinOpts = creationSkinHues(c.race).map((h) => `<option value="${h.hue}" ${h.hue === c.skinHue ? 'selected' : ''}>${esc(h.label)}</option>`).join('');
    const hairOpts = creationHairHues(c.race).map((h) => `<option value="${h.hue}" ${h.hue === c.hairHue ? 'selected' : ''}>${esc(h.label)}</option>`).join('');
    const clothingOpts = CLOTHING_HUES.map((h) => `<option value="${h.hue}" ${h.hue === c.shirtHue ? 'selected' : ''}>${esc(h.label)}</option>`).join('');
    const pantsOpts = CLOTHING_HUES.map((h) => `<option value="${h.hue}" ${h.hue === c.pantsHue ? 'selected' : ''}>${esc(h.label)}</option>`).join('');
    const styleList = creationHairStyles(c.race, c.sex);
    const styleOpts = styleList.map((s) => `<option value="${s.id}" ${s.id === c.hairId ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
    const beardList = creationBeardStyles(c.race, c.sex);
    const beardOpts = beardList.map((s) => `<option value="${s.id}" ${s.id === c.beardId ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
    const showBeard = beardList.length > 1;
    const showPants = c.race !== 2;
    const hairStyleLabel = c.race === 2 ? 'Horn Style' : 'Hair Style';
    const hairColorLabel = c.race === 2 ? 'Horn Color' : 'Hair Color';
    const beardLabel = c.race === 2 ? 'Facial Horns' : 'Beard Style';
    this._mountPanel(`
      <div style="min-width:460px">
        <h1 style="text-align:center;letter-spacing:6px;font-size:14px;margin-bottom:6px">APPEARANCE</h1>
        <div style="font-size:11px;color:#a48830;text-align:center;margin-bottom:10px">
          Step 1 of 4 — name and looks
        </div>
        <label>Name</label>
        <input id="cc-name" type="text" maxlength="16" value="${esc(c.name)}" />
        <div class="row" style="gap:14px;margin-top:6px">
          <label style="margin:0"><input type="radio" name="cc-sex" value="0" ${c.sex===0?'checked':''}> Male</label>
          <label style="margin:0"><input type="radio" name="cc-sex" value="1" ${c.sex===1?'checked':''}> Female</label>
          <label style="margin-left:auto">Race
            <select id="cc-race" style="margin-left:6px">
              <option value="0" ${c.race===0?'selected':''}>Human</option>
              <option value="1" ${c.race===1?'selected':''}>Elf</option>
              <option value="2" ${c.race===2?'selected':''}>Gargoyle</option>
            </select>
          </label>
        </div>
        <label>Skin Tone</label>
        <select id="cc-skin">${skinOpts}</select>
        <label>${hairStyleLabel}</label>
        <select id="cc-hair-id">${styleOpts}</select>
        <label>${hairColorLabel}</label>
        <select id="cc-hair-hue">${hairOpts}</select>
        <div id="cc-beard-block" ${showBeard?'':'style="display:none"'}>
          <label>${beardLabel}</label>
          <select id="cc-beard-id">${beardOpts}</select>
        </div>
        <label>Shirt Color</label>
        <select id="cc-shirt-hue">${clothingOpts}</select>
        <div id="cc-pants-block" ${showPants?'':'style="display:none"'}>
          <label>Pants Color</label>
          <select id="cc-pants-hue">${pantsOpts}</select>
        </div>
        <!-- Audit #46 P2 — live paperdoll preview. Refreshed by the
             onchange handlers below; rendered via _renderCcPreview which
             stamps gump-atlas PNGs as absolutely-positioned divs. -->
        <div id="cc-preview" style="margin-top:10px"></div>
        <div class="row" style="margin-top:14px">
          <button id="cc-back">Back</button>
          <button id="cc-next" class="primary" style="flex:2">Next</button>
        </div>
        <div id="cc-msg" class="uo-status-line"></div>
      </div>
    `);
    this._injectStyles();
    // Live-preview refresh: read every dropdown into _creation then
    // re-render. Wire to change events on every select.
    const previewEl = this._panel.querySelector('#cc-preview');
    const readAppearanceForm = () => {
      const cc = this._creation;
      cc.name = this._panel.querySelector('#cc-name')?.value ?? cc.name;
      const checkedSex = this._panel.querySelector('input[name="cc-sex"]:checked');
      if (checkedSex) cc.sex = +checkedSex.value;
      cc.race = +this._panel.querySelector('#cc-race')?.value || 0;
      cc.skinHue = +this._panel.querySelector('#cc-skin')?.value || cc.skinHue;
      const hairIdValue = this._panel.querySelector('#cc-hair-id')?.value;
      if (hairIdValue != null) cc.hairId = +hairIdValue;
      cc.hairHue = +this._panel.querySelector('#cc-hair-hue')?.value || cc.hairHue;
      cc.shirtHue = +this._panel.querySelector('#cc-shirt-hue')?.value || 0;
      cc.pantsHue = +this._panel.querySelector('#cc-pants-hue')?.value || 0;
      cc.beardId = +this._panel.querySelector('#cc-beard-id')?.value || 0;
      normalizeCreationAppearance(cc);
    };
    const refreshPreview = () => {
      try {
        readAppearanceForm();
        this._renderCcPreview(previewEl);
      } catch (err) {
        console.warn('[login] character preview failed', err);
        if (previewEl) {
          previewEl.innerHTML = `
            <div style="position:relative;width:140px;height:170px;margin:6px auto 0;background:#1a1410;border:1px solid #6a4a18"></div>
            <div style="text-align:center;font-size:10px;color:#a48830;margin-top:4px">Live preview</div>
          `;
        }
      }
    };
    ['cc-skin', 'cc-hair-id', 'cc-hair-hue', 'cc-beard-id', 'cc-shirt-hue', 'cc-pants-hue']
      .forEach((id) => this._panel.querySelector('#' + id)?.addEventListener('change', refreshPreview));
    this._panel.querySelector('#cc-race')?.addEventListener('change', (ev) => {
      readAppearanceForm();
      this._creation.race = +(ev.currentTarget?.value ?? 0);
      normalizeCreationAppearance(this._creation);
      this._setStep(LoginSteps.Main); this._setStep(LoginSteps.CharacterCreation);
    });
    const sexRadios = this._panel.querySelectorAll('input[name="cc-sex"]');
    sexRadios.forEach((r) => r.addEventListener('change', () => {
      readAppearanceForm();
      this._creation.sex = +r.value;
      normalizeCreationAppearance(this._creation);
      this._setStep(LoginSteps.Main); this._setStep(LoginSteps.CharacterCreation);
    }));
    // Audit #46 P2 — CUO order: Appearance is page 0, so back returns
    // to CharacterSelection (not to a prior creation page). Next
    // advances to Profession (page 1).
    this._panel.querySelector('#cc-back').addEventListener('click', () => {
      this._setStep(LoginSteps.CharacterSelection);
    });
    this._panel.querySelector('#cc-next').addEventListener('click', () => {
      const c2 = this._creation;
      const rawName = this._panel.querySelector('#cc-name').value;
      const nameError = validateCreationName(rawName);
      if (nameError) {
        this._panel.querySelector('#cc-msg').textContent = nameError;
        return;
      }
      c2.name = rawName.trim();
      c2.race = +this._panel.querySelector('#cc-race').value;
      c2.skinHue = +this._panel.querySelector('#cc-skin').value;
      c2.hairId = +this._panel.querySelector('#cc-hair-id').value;
      c2.hairHue = +this._panel.querySelector('#cc-hair-hue').value;
      // Audit #46 P2 — shirt + pants hues (CUO `CreateCharAppearanceGump`).
      c2.shirtHue = +this._panel.querySelector('#cc-shirt-hue')?.value || 0;
      c2.pantsHue = +this._panel.querySelector('#cc-pants-hue')?.value || 0;
      c2.beardId = +this._panel.querySelector('#cc-beard-id')?.value || 0;
      c2.beardHue = c2.hairHue;
      normalizeCreationAppearance(c2);
      this._creationPage = 1;       // → Profession
      this._setStep(LoginSteps.Main); this._setStep(LoginSteps.CharacterCreation);
    });
    refreshPreview();
  }

  _renderCcTrade() {
    const c = this._creation;
    const skillOptions = creationSkillOptionsForRace(c.race);
    const skillRow = (i) => {
      const s = c.skills[i] ?? { id: skillOptions[0][0], val: 0 };
      const selectedId = skillOptions.some(([id]) => id === s.id) ? s.id : skillOptions[0][0];
      const opts = skillOptions.map(([id, name]) => `<option value="${id}" ${id===selectedId?'selected':''}>${esc(name)}</option>`).join('');
      return `
        <div class="row" style="gap:6px;margin:2px 0;align-items:center">
          <select class="cc-skill-id" data-i="${i}" style="flex:1">${opts}</select>
          <input class="cc-skill-val" data-i="${i}" type="number" min="0" max="50" value="${s.val|0}" style="max-width:60px"/>
        </div>
      `;
    };
    this._mountPanel(`
      <div style="min-width:460px">
        <h1 style="text-align:center;letter-spacing:6px;font-size:14px;margin-bottom:6px">STATS &amp; SKILLS</h1>
        <div style="font-size:11px;color:#a48830;text-align:center;margin-bottom:10px">
          Step 3 of 4 — stats total ${CREATE_STAT_TOTAL} · skills total 100 or 120
        </div>
        <label>Stats</label>
        <div class="row" style="gap:6px;align-items:center">
          <span style="min-width:30px">STR</span><input id="cc-str" type="number" min="10" max="60" value="${c.str|0}" style="max-width:60px"/>
          <span style="min-width:30px">DEX</span><input id="cc-dex" type="number" min="10" max="60" value="${c.dex|0}" style="max-width:60px"/>
          <span style="min-width:30px">INT</span><input id="cc-int" type="number" min="10" max="60" value="${c.int|0}" style="max-width:60px"/>
        </div>
        <label>Skills (${CREATE_SKILL_COUNT} picks, each 0..50)</label>
        ${Array.from({ length: CREATE_SKILL_COUNT }, (_, i) => skillRow(i)).join('')}
        <div id="cc-totals" style="font-size:11px;color:#a48830;margin:6px 0"></div>
        <div class="row" style="margin-top:8px">
          <button id="cc-back">Back</button>
          <button id="cc-next" class="primary" style="flex:2">Next</button>
        </div>
        <div id="cc-msg" class="uo-status-line"></div>
      </div>
    `);
    const totals = this._panel.querySelector('#cc-totals');
    const refresh = () => {
      const s = +this._panel.querySelector('#cc-str').value | 0;
      const d = +this._panel.querySelector('#cc-dex').value | 0;
      const it = +this._panel.querySelector('#cc-int').value | 0;
      let sk = 0;
      this._panel.querySelectorAll('.cc-skill-val').forEach((el) => sk += (+el.value | 0));
      totals.textContent = `Stats ${s + d + it} / ${CREATE_STAT_TOTAL}   ·   Skills ${sk} / 100 or 120`;
    };
    normalizeCreationAppearance(this._creation);
    this._panel.querySelectorAll('input[type="number"], .cc-skill-id').forEach((el) => el.addEventListener('input', refresh));
    this._panel.querySelectorAll('.cc-skill-id').forEach((el) => el.addEventListener('change', refresh));
    refresh();
    this._panel.querySelector('#cc-back').addEventListener('click', () => {
      this._creationPage = 1;
      this._setStep(LoginSteps.Main); this._setStep(LoginSteps.CharacterCreation);
    });
    this._panel.querySelector('#cc-next').addEventListener('click', () => {
      const c2 = this._creation;
      c2.str = clamp(+this._panel.querySelector('#cc-str').value, 10, 60);
      c2.dex = clamp(+this._panel.querySelector('#cc-dex').value, 10, 60);
      c2.int = clamp(+this._panel.querySelector('#cc-int').value, 10, 60);
      if (c2.str + c2.dex + c2.int !== CREATE_STAT_TOTAL) {
        this._panel.querySelector('#cc-msg').textContent = `Stats must total ${CREATE_STAT_TOTAL} (got ${c2.str + c2.dex + c2.int}).`;
        return;
      }
      const skills = [];
      const picked = new Set();
      let sum = 0;
      let duplicate = false;
      this._panel.querySelectorAll('.cc-skill-id').forEach((sel, i) => {
        const id = +sel.value;
        const val = clamp(+this._panel.querySelector(`.cc-skill-val[data-i="${i}"]`).value, 0, 50);
        if (picked.has(id)) duplicate = true;
        picked.add(id);
        sum += val;
        if (val > 0) skills.push({ id, val });
      });
      if (duplicate) {
        this._panel.querySelector('#cc-msg').textContent = 'Skill picks must be unique.';
        return;
      }
      if (!CREATE_SKILL_TOTALS.has(sum)) {
        this._panel.querySelector('#cc-msg').textContent = `Skill total must be 100 or 120 (got ${sum}).`;
        return;
      }
      c2.skills = skills;
      this._creationPage = 3;
      this._setStep(LoginSteps.Main); this._setStep(LoginSteps.CharacterCreation);
    });
  }

  _renderCcCity() {
    const c = this._creation;
    const cities = (this._cities && this._cities.length) ? this._cities :
      [{ index: 0, name: 'Britain', area: 'a faded map' }];
    // Audit #46 P2 — per-city lore blurb. CUO ships a paragraph per
    // city via the server's `0xA9::cities` payload (`description` /
    // `descTrue`). When the shard provides one we render it under the
    // area string; otherwise fall back to a generic line.
    const CITY_LORE = {
      Britain: 'The mercantile heart of Britannia, ruled by Lord British himself.',
      Trinsic: 'A walled city of paladins on Britannia\'s southern coast.',
      Yew: 'A wooded community famed for the Empath Abbey.',
      Moonglow: 'Centre of magery study on the island of Verity.',
      Skara: 'Skara Brae — village of rangers between river and bay.',
      Minoc: 'A mining town nestled in the northern mountains.',
      Vesper: 'Trading port at the mouth of the Tokuno Strait.',
      Magincia: 'Once-proud island city, rebuilt after the Daemon raid.',
      Jhelom: 'Warriors\' isle south of Cape of Heroes.',
      'New Haven': 'Modern starter town with training NPCs for every skill.',
      // Audit rev.9 P3 #3 — extra canonical cities the 0xA9 list may
      // include depending on the shard's expansion set.
      Cove:           'A small fishing village on the east coast of Britannia.',
      'Nujel\'m':     'Island gem of poets and royalty — the Justice shrine.',
      'Serpent\'s Hold': 'Stone fortress of the Britannian army on Verity Isle.',
      Wind:           'High-mountain mage colony, hidden behind Lord Wind\'s veil.',
      Buccaneer:      'A pirate refuge — Buccaneer\'s Den, off Trinsic\'s coast.',
      Delucia:        'Lost Lands trading outpost ringed by hostile fauna.',
      Papua:          'Ish Naka-Tan jungle port at the south of the Lost Lands.',
      Zento:          'Tokuno samurai academy on the Isle of Makoto.',
      'Royal City':   'The TerMur capital — gargoyle dynasty seat at the Stygian Abyss gate.',
      Heartwood:      'Elven village deep within the Twin Oaks woodland.',
    };
    const rows = cities.map((city, i) => {
      const blurb = city.description ?? city.descTrue ?? CITY_LORE[city.name] ?? '';
      return `
      <div class="uo-city-row" data-i="${i}" tabindex="0">
        <div class="uo-city-name">${esc(city.name)}</div>
        <div class="uo-city-area">${esc(city.area ?? '')}</div>
        <div class="uo-city-lore">${esc(blurb)}</div>
      </div>`;
    }).join('');
    this._mountPanel(`
      <div style="min-width:480px">
        <h1 style="text-align:center;letter-spacing:6px;font-size:14px;margin-bottom:6px">STARTING CITY</h1>
        <div style="font-size:11px;color:#a48830;text-align:center;margin-bottom:10px">
          Step 4 of 4 — where do you wake up?
        </div>
        <div class="uo-city-list">${rows}</div>
        <div class="row" style="margin-top:14px">
          <button id="cc-back">Back</button>
          <button id="cc-finish" class="primary" style="flex:2">Create Character</button>
        </div>
      </div>
    `);
    this._injectStyles();
    let chosen = Math.max(0, cities.findIndex((cc) => cc.index === c.city));
    const rowsEl = [...this._panel.querySelectorAll('.uo-city-row')];
    const refresh = () => rowsEl.forEach((r, j) => r.classList.toggle('selected', j === chosen));
    rowsEl.forEach((r, i) => {
      r.addEventListener('click', () => { chosen = i; refresh(); });
      r.addEventListener('dblclick', () => { chosen = i; this._submitCreation(cities[chosen].index); });
    });
    refresh();
    this._panel.querySelector('#cc-back').addEventListener('click', () => {
      this._creationPage = c.skipTrade ? 1 : 2;
      this._setStep(LoginSteps.Main); this._setStep(LoginSteps.CharacterCreation);
    });
    this._panel.querySelector('#cc-finish').addEventListener('click', () => this._submitCreation(cities[chosen].index));
  }

  _submitCreation(cityIndex) {
    const c = this._creation;
    c.city = cityIndex;
    this._setStep(LoginSteps.CharacterCreationDone);
    net.send(buildCreateCharacter({
      name: c.name, sex: c.sex, race: c.race, profession: c.profession,
      str: c.str, dex: c.dex, int: c.int,
      skills: c.skills.map((s) => ({ id: s.id, value: s.val })),
      skinHue: c.skinHue, hairId: c.hairId, hairHue: c.hairHue,
      beardId: c.beardId, beardHue: c.beardHue,
      shirtHue: c.shirtHue | 0, pantsHue: c.pantsHue | 0,
      city: c.city, slot: c.slot,
    }));
  }

  // --------------------------------------------------------------------------
  // Step: Loading screens

  _renderLoading(label) {
    this._mountPanel(`
      <div style="text-align:center;min-width:340px;padding:24px 12px">
        <div class="uo-spinner"></div>
        <div style="margin-top:14px;letter-spacing:4px;font-size:12px;color:#f0c878">${esc(label.toUpperCase())}</div>
        <div style="margin-top:8px;font-size:10px;color:#605040">Please wait…</div>
      </div>
    `, { minWidth: '340px' });
    this._injectStyles();
  }

  // --------------------------------------------------------------------------
  // Step: Popup (errors, confirmations, disclaimer)

  _showPopup(message, onCancel = null, onOk = null) {
    this._popupOnDismiss = { onCancel, onOk };
    this._setStep(LoginSteps.PopUpMessage, message);
  }

  _renderPopup(message) {
    const hasOk = !!this._popupOnDismiss?.onOk;
    const hasCancel = !!this._popupOnDismiss?.onCancel;
    this._mountPanel(`
      <div style="min-width:340px;text-align:center">
        <h1 style="letter-spacing:4px;font-size:14px;margin-bottom:14px">NOTICE</h1>
        <div style="white-space:pre-line;font-size:12px;color:#e8d090;margin-bottom:14px">${esc(message ?? '')}</div>
        <div class="row" style="justify-content:center">
          ${hasCancel ? '<button id="p-cancel">Cancel</button>' : ''}
          <button id="p-ok" class="primary" style="flex:${hasCancel ? '1' : '2'}">${hasCancel && hasOk ? 'OK' : 'Continue'}</button>
        </div>
      </div>
    `);
    if (hasCancel) {
      this._panel.querySelector('#p-cancel').addEventListener('click', () => {
        const cb = this._popupOnDismiss?.onCancel;
        this._popupOnDismiss = null;
        cb?.();
      });
    }
    this._panel.querySelector('#p-ok').addEventListener('click', () => {
      const cb = this._popupOnDismiss?.onOk ?? this._popupOnDismiss?.onCancel;
      this._popupOnDismiss = null;
      cb?.();
    });
  }

  // --------------------------------------------------------------------------
  // Bus event handlers

  _onRejected(info) {
    const reason = ({
      0: 'Invalid account or credentials.',
      1: 'Someone is using this account.',
      2: 'Your account has been blocked.',
      3: 'Bad password.',
      4: 'Idle for too long.',
      5: 'Bad communication.',
    })[info.reason | 0] ?? `Login rejected (code ${info.reason}).`;
    this._showPopup(reason, () => this._setStep(LoginSteps.Main));
  }

  _onSocketClosed() {
    if (this._step === LoginSteps.Main) return;
    if (this._step === LoginSteps.PopUpMessage) return;
    // Audit #46 P2 — auto-reconnect (CUO `LoginScene.cs:139-163`).
    // When `login.autoReconnect` profile flag is on, retry up to
    // `reconnectMaxTries` × `reconnectIntervalMs` ms before giving
    // up; surface countdown in a popup so the user sees progress.
    const enabled = profile?.get?.('login.autoReconnect') !== false;
    if (!enabled) {
      this._showPopup('Connection lost.', () => this._setStep(LoginSteps.Main));
      return;
    }
    const intervalMs = (profile?.get?.('login.reconnectIntervalMs') | 0) || 5000;
    const maxTries   = (profile?.get?.('login.reconnectMaxTries')   | 0) || 12;
    this._reconnectTryCounter = (this._reconnectTryCounter | 0) + 1;
    if (this._reconnectTryCounter > maxTries) {
      this._reconnectTryCounter = 0;
      this._showPopup('Connection lost (max retries reached).', () => this._setStep(LoginSteps.Main));
      return;
    }
    this._showPopup(
      `Reconnecting (try ${this._reconnectTryCounter}/${maxTries})…`,
      () => {/* no-op — auto-dismissed by timer */},
    );
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      // Re-issue the original login attempt. _doConnect reads from the
      // DOM panel which has already been ripped down by _setStep, so we
      // rebuild and immediately resubmit the login form with cached
      // credentials.
      try {
        this._setStep(LoginSteps.Main);
        // Once the Main panel is mounted, prefill + auto-submit.
        setTimeout(() => {
          try {
            if (this._account) this._panel?.querySelector('#m-account')?.setAttribute('value', this._account);
            if (this._host)    this._panel?.querySelector('#m-host')?.setAttribute('value', this._host);
            this._doConnect?.();
          } catch { /* ignore */ }
        }, 50);
      } catch { /* ignore */ }
    }, intervalMs);
  }

  /** Audit #46 P2 — AutoLogin (CUO `LoginScene.cs:79-97`). When the
   *  profile flag is on AND we have a saved username + password, skip
   *  the Main panel and submit immediately on scene mount. Called once
   *  from _load() after the initial _setStep(Main). */
  _tryAutoLogin() {
    if (!profile?.get?.('login.autoLogin')) return false;
    const acc = localStorage.getItem(LS_PREFIX + 'account');
    if (!acc) return false;
    // Wait one tick so the Main panel is fully mounted, then submit.
    setTimeout(() => { try { this._doConnect?.(); } catch { /* ignore */ } }, 80);
    return true;
  }

  async _onLoginConfirm() {
    await this.gc.setScene(new GameScene(this.gc));
  }

  _goBackToMain() {
    net.close();
    this._setStep(LoginSteps.Main);
    // Audit #46 P2 — try AutoLogin AFTER the Main panel mounts.
    try { this._tryAutoLogin?.(); } catch { /* ignore */ }
  }

  // --------------------------------------------------------------------------
  // Bootstrap helpers

  _sub(topic, fn) { this._unsubs.push(bus.on(topic, fn)); }

  /** Inject step-specific styling once per scene mount. */
  _injectStyles() {
    if (document.getElementById('uo-login-styles')) return;
    const style = document.createElement('style');
    style.id = 'uo-login-styles';
    style.textContent = `
      .uo-status-line { font-size:11px;color:#a48830;margin-top:8px;min-height:14px;text-align:center }
      .uo-server-list, .uo-char-list, .uo-prof-list, .uo-city-list {
        max-height: 360px; overflow-y: auto;
        background: rgba(0,0,0,0.25); border: 1px solid rgba(255,224,128,0.18);
        border-radius: 4px; padding: 4px;
      }
      .uo-server-row, .uo-char-slot, .uo-prof-row, .uo-city-row {
        padding: 8px 12px; cursor: pointer; user-select: none;
        border-bottom: 1px solid rgba(255,224,128,0.08);
        display: flex; align-items: center; gap: 12px;
        transition: background .08s ease;
      }
      .uo-server-row:hover, .uo-char-slot:hover, .uo-prof-row:hover, .uo-city-row:hover {
        background: rgba(255,224,128,0.10);
      }
      .uo-server-row.selected, .uo-char-slot.selected, .uo-prof-row.selected, .uo-city-row.selected {
        background: rgba(255,224,128,0.22);
        outline: 1px solid rgba(255,224,128,0.4);
      }
      .uo-server-name, .uo-prof-name, .uo-city-name { flex: 1; font-weight: 600; color: #f0e0a8 }
      .uo-server-load { color: #b89060; font-size: 11px }
      .uo-server-ping { min-width: 54px; text-align: right; color: #80c8a0; font-size: 11px }
      .uo-prof-desc, .uo-city-area { font-size: 11px; color: #a89070; margin-left: auto; max-width: 60% }
      .uo-prof-row { flex-direction: column; align-items: flex-start; gap: 2px }
      .uo-prof-row .uo-prof-desc { margin-left: 0 }
      .uo-char-slot { gap: 16px }
      .uo-char-slot.empty .uo-slot-name { color: #6a5840; font-style: italic }
      .uo-slot-num { width: 24px; text-align: center; color: #c0a060; font-size: 16px; font-weight: bold }
      .uo-spinner {
        width: 48px; height: 48px; margin: 0 auto;
        border: 3px solid rgba(240,200,120,0.20);
        border-top-color: #f0c878;
        border-radius: 50%;
        animation: uo-spin 1s linear infinite;
      }
      @keyframes uo-spin { to { transform: rotate(360deg) } }
      button.primary { background: linear-gradient(180deg,#5a3818,#3a2410); color: #ffe8a8 }
      button.primary:hover { background: linear-gradient(180deg,#6e4820,#4a2e14) }
    `;
    document.head.appendChild(style);
  }
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n | 0));
}
