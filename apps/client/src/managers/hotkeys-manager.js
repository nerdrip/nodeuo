// HotkeysManager — keyboard hotkey → action dispatcher. Mirrors a
// distilled CUO `Game/Managers/HotkeysManager.cs` + `MacroManager`
// action dispatch. Macro authoring (creating new sequences, editing
// timing) lives in `MacroManager`; here we maintain the *bound*
// (key, mods) → MacroAction registry plus the dispatch table that
// turns each enum value into outgoing packets / bus events.
//
// CUO `MacroType` enum is ~270 entries. We ship the most-used ~80 here;
// missing entries log a warning and fall through. Authoring those that
// matter to a given player is a content task, not a code one.
//
// Hotkey bindings persist via the per-character profile under
// `hotkeys.bindings = [{ key, ctrl, shift, alt, action, args }]`.

import { bus } from '../core/event-bus.js';
import { profile } from './profile-manager.js';
import { net } from '../net/net-client.js';
import { world } from '../world/world.js';
import {
  buildUseReq, buildAttackReq, buildTextCommand,
  buildWarMode, buildLogoutRequest,
  buildClearAttack, buildInvokeVirtue, buildUseSkill,
  buildOpenSpellBook,
} from '../net/outgoing.js';
import { targetManager } from './target-manager.js';
import { auraManager } from './aura-manager.js';
import { spellByName } from '../ui/gumps/spell-data.js';
import { skillIdFromName } from '../shared/skill-ids.js';
import { formatHotkeyCombo, normalizeHotkeyKey, parseHotkeyCombo } from '../shared/hotkey-combo.js';

export const MacroAction = Object.freeze({
  None: 0,
  // Speech
  Say: 1, Emote: 2, Whisper: 3, Yell: 4,
  // Walk
  WalkN: 10, WalkE: 11, WalkS: 12, WalkW: 13,
  WalkNE: 14, WalkSE: 15, WalkSW: 16, WalkNW: 17,
  // Combat
  AttackLast: 30, AttackClosest: 31, ClearAttack: 32, WarMode: 33,
  // Targets
  LastTarget: 40, TargetSelf: 41, CancelTarget: 42, AllNames: 43,
  TargetClosest: 44, TargetNext: 45, TargetCorpse: 46,
  // Skills
  UseSkillHide: 50, UseSkillStealth: 51, UseSkillMeditate: 52,
  UseSkillTracking: 53, UseSkillAnatomy: 54, UseSkillAnimalLore: 55,
  UseSkillEvalInt: 56, UseSkillForensicEval: 57, UseSkillItemId: 58,
  UseSkillTasteId: 59, UseSkillArmsLore: 60, UseSkillBegging: 61,
  UseSkillPeacemaking: 62, UseSkillProvocation: 63, UseSkillDiscordance: 64,
  UseSkillStealing: 65, UseSkillDetectHidden: 66, UseSkillSnooping: 67,
  UseSkillSpiritSpeak: 68, UseSkillCartography: 69, UseSkillFishing: 70,
  UseSkillRemoveTrap: 71, UseSkillImbuing: 72, UseSkillMysticism: 73,
  // Spell cast (named)
  CastHeal: 100, CastGreaterHeal: 101, CastCure: 102, CastFireball: 103,
  CastLightning: 104, CastEnergyBolt: 105, CastExplosion: 106,
  CastFlameStrike: 107, CastTeleport: 108, CastInvisibility: 109,
  CastRecall: 110, CastMark: 111, CastGate: 112, CastDispel: 113,
  CastReveal: 114, CastBless: 115, CastCurse: 116, CastMagicArrow: 117,
  CastHarm: 118, CastMagicReflection: 119, CastReactiveArmor: 120,
  CastWallOfStone: 121, CastEnergyField: 122,
  // Gumps
  OpenPaperdoll: 200, OpenStatus: 201, OpenJournal: 202, OpenBackpack: 203,
  OpenSkills: 204, OpenChat: 205, OpenMap: 206, OpenParty: 207,
  OpenOptions: 208, OpenSpellbook: 209, OpenLogout: 210,
  // Items / equipment
  Bandage: 220, BandageSelf: 221, BandageTarget: 222,
  EquipLastWeapon: 230, ArmDisarm: 231,
  // Virtues
  InvokeHonor: 240, InvokeSacrifice: 241, InvokeValor: 242, InvokeCompassion: 243,
  // Misc
  Resync: 250, Reconnect: 251, ToggleAura: 252, AllAttack: 253,
  Logout: 254,
  // ----- Long tail (CUO `MacroType` pages 4..) -----
  // Necromancy
  CastAnimateDead: 300, CastBloodOath: 301, CastCorpseSkin: 302,
  CastCurseWeapon: 303, CastEvilOmen: 304, CastHorrificBeast: 305,
  CastLichForm: 306, CastMindRot: 307, CastPainSpike: 308,
  CastPoisonStrike: 309, CastStrangle: 310, CastSummonFamiliar: 311,
  CastVampiricEmbrace: 312, CastVengefulSpirit: 313, CastWither: 314,
  CastWraithForm: 315, CastExorcism: 316,
  // Chivalry
  CastCleanseByFire: 330, CastCloseWounds: 331, CastConsecrateWeapon: 332,
  CastDispelEvil: 333, CastDivineFury: 334, CastEnemyOfOne: 335,
  CastHolyLight: 336, CastNobleSacrifice: 337, CastRemoveCurse: 338,
  CastSacredJourney: 339,
  // Bushido / Ninjitsu / Spellweaving / Mysticism — coarse-grained
  CastBushidoConfidence: 350, CastBushidoEvasion: 351,
  CastBushidoCounterAttack: 352, CastBushidoLightningStrike: 353,
  CastBushidoMomentumStrike: 354, CastBushidoHonorableExecution: 355,
  CastNinjitsuFocusAttack: 360, CastNinjitsuDeathStrike: 361,
  CastNinjitsuAnimalForm: 362, CastNinjitsuKiAttack: 363,
  CastNinjitsuSurpriseAttack: 364, CastNinjitsuBackstab: 365,
  CastNinjitsuShadowjump: 366, CastNinjitsuMirrorImage: 367,
  CastSpellweavingArcaneCircle: 370, CastSpellweavingGiftOfRenewal: 371,
  CastSpellweavingImmolatingWeapon: 372, CastSpellweavingAttunement: 373,
  CastSpellweavingThunderstorm: 374, CastSpellweavingNaturesFury: 375,
  CastMysticismNetherBolt: 380, CastMysticismHealingStone: 381,
  CastMysticismPurgeMagic: 382, CastMysticismEnchant: 383,
  CastMysticismSleep: 384, CastMysticismEagleStrike: 385,
  CastMysticismAnimatedWeapon: 386,
  // Magery — extras (not in 100..123)
  CastClumsy: 400, CastCreateFood: 401, CastFeeblemind: 402,
  CastNightSight: 403, CastWeaken: 404,
  CastAgility: 405, CastCunning: 406, CastMagicTrap: 407,
  CastMagicUntrap: 408, CastProtection: 409, CastStrength: 410,
  CastMagicLock: 411, CastUnlock: 412, CastPoison: 413,
  CastArchCure: 414, CastArchProtection: 415, CastFireField: 416,
  CastManaDrain: 417, CastBladeSpirits: 418, CastDispelField: 419,
  CastIncognito: 420, CastMindBlast: 421, CastParalyze: 422,
  CastPoisonField: 423, CastSummonCreature: 424,
  CastMassCurse: 425, CastParalyzeField: 426,
  CastChainLightning: 427, CastGateTravel: 428,
  CastManaVampire: 429, CastMassDispel: 430,
  CastMeteorSwarm: 431, CastPolymorph: 432,
  CastEarthquake: 433, CastEnergyVortex: 434,
  CastResurrection: 435, CastSummonAir: 436,
  CastSummonDaemon: 437, CastSummonEarth: 438,
  CastSummonFire: 439, CastSummonWater: 440,
  // Skills (extras — CUO ships every UseSkill_*)
  UseSkillAlchemy: 500, UseSkillAnimalTaming: 501,
  UseSkillVeterinary: 502, UseSkillMusicianship: 503,
  UseSkillMagery: 504, UseSkillCamping: 505, UseSkillCarpentry: 506,
  UseSkillCooking: 507, UseSkillTinkering: 508, UseSkillBlacksmithy: 509,
  UseSkillBowcraft: 510, UseSkillEnticement: 511,
  UseSkillHerding: 513, UseSkillTailoring: 514, UseSkillInscription: 515,
  UseSkillLockpicking: 516, UseSkillMining: 517, UseSkillLumberjack: 518,
  UseSkillPoisoning: 519, UseSkillNecromancy: 520, UseSkillBushido: 521,
  UseSkillNinjitsu: 522, UseSkillFocus: 523, UseSkillSpellweaving: 524,
  UseSkillThrowing: 525,
  // Hotbar / inventory utility
  UsePotionAgility: 600, UsePotionCure: 601, UsePotionExplosion: 602,
  UsePotionHeal: 603, UsePotionRefresh: 604, UsePotionStrength: 605,
  UsePotionMana: 606, UseObjectByType: 610, UseFromBackpack: 611,
  GrabItem: 612, SetGrabBag: 613, UseLastTarget: 614,
  // Selection / movement helpers
  SelectNext: 700, SelectPrevious: 701, SelectNearest: 702,
  ScrollUp: 703, ScrollDown: 704, AutoFollow: 705,
  StopMovement: 706, OpenContainer: 707,
  // Window navigation
  CloseAllGumps: 800, CloseTopGump: 801, MinimizeGump: 802,
  ToggleGargoyleFly: 810, EnableSallosEasyGrab: 811,
  // Speech shortcuts
  Quit: 900, ConfirmQuit: 901, EditMacro: 902,
});

const SPELL_BY_ACTION = {
  // Magery (named server-side as plain English book entries; ServUO
  // accepts the cast verb either as the rune phrase OR as the canonical
  // spell name. We use the spell-data.js canonical names so the same
  // strings work with the SpellbookGump click path).
  [MacroAction.CastClumsy]:         'Clumsy',
  [MacroAction.CastCreateFood]:     'Create Food',
  [MacroAction.CastFeeblemind]:     'Feeblemind',
  [MacroAction.CastHeal]:           'Heal',
  [MacroAction.CastMagicArrow]:     'Magic Arrow',
  [MacroAction.CastNightSight]:     'Night Sight',
  [MacroAction.CastReactiveArmor]:  'Reactive Armor',
  [MacroAction.CastWeaken]:         'Weaken',
  [MacroAction.CastAgility]:        'Agility',
  [MacroAction.CastCunning]:        'Cunning',
  [MacroAction.CastCure]:           'Cure',
  [MacroAction.CastHarm]:           'Harm',
  [MacroAction.CastMagicTrap]:      'Magic Trap',
  [MacroAction.CastMagicUntrap]:    'Magic Untrap',
  [MacroAction.CastProtection]:     'Protection',
  [MacroAction.CastStrength]:       'Strength',
  [MacroAction.CastBless]:          'Bless',
  [MacroAction.CastFireball]:       'Fireball',
  [MacroAction.CastMagicLock]:      'Magic Lock',
  [MacroAction.CastPoison]:         'Poison',
  [MacroAction.CastTeleport]:       'Teleport',
  [MacroAction.CastUnlock]:         'Unlock',
  [MacroAction.CastWallOfStone]:    'Wall of Stone',
  [MacroAction.CastArchCure]:       'Arch Cure',
  [MacroAction.CastArchProtection]: 'Arch Protection',
  [MacroAction.CastCurse]:          'Curse',
  [MacroAction.CastFireField]:      'Fire Field',
  [MacroAction.CastGreaterHeal]:    'Greater Heal',
  [MacroAction.CastLightning]:      'Lightning',
  [MacroAction.CastManaDrain]:      'Mana Drain',
  [MacroAction.CastRecall]:         'Recall',
  [MacroAction.CastBladeSpirits]:   'Blade Spirits',
  [MacroAction.CastDispelField]:    'Dispel Field',
  [MacroAction.CastIncognito]:      'Incognito',
  [MacroAction.CastMagicReflection]:'Magic Reflection',
  [MacroAction.CastMindBlast]:      'Mind Blast',
  [MacroAction.CastParalyze]:       'Paralyze',
  [MacroAction.CastPoisonField]:    'Poison Field',
  [MacroAction.CastSummonCreature]: 'Summon Creature',
  [MacroAction.CastDispel]:         'Dispel',
  [MacroAction.CastEnergyBolt]:     'Energy Bolt',
  [MacroAction.CastExplosion]:      'Explosion',
  [MacroAction.CastInvisibility]:   'Invisibility',
  [MacroAction.CastMark]:           'Mark',
  [MacroAction.CastMassCurse]:      'Mass Curse',
  [MacroAction.CastParalyzeField]:  'Paralyze Field',
  [MacroAction.CastReveal]:         'Reveal',
  [MacroAction.CastChainLightning]: 'Chain Lightning',
  [MacroAction.CastEnergyField]:    'Energy Field',
  [MacroAction.CastFlameStrike]:    'Flame Strike',
  [MacroAction.CastGateTravel]:     'Gate Travel',
  [MacroAction.CastGate]:           'Gate Travel',
  [MacroAction.CastManaVampire]:    'Mana Vampire',
  [MacroAction.CastMassDispel]:     'Mass Dispel',
  [MacroAction.CastMeteorSwarm]:    'Meteor Swarm',
  [MacroAction.CastPolymorph]:      'Polymorph',
  [MacroAction.CastEarthquake]:     'Earthquake',
  [MacroAction.CastEnergyVortex]:   'Energy Vortex',
  [MacroAction.CastResurrection]:   'Resurrection',
  [MacroAction.CastSummonAir]:      'Air Elemental',
  [MacroAction.CastSummonDaemon]:   'Summon Daemon',
  [MacroAction.CastSummonEarth]:    'Earth Elemental',
  [MacroAction.CastSummonFire]:     'Fire Elemental',
  [MacroAction.CastSummonWater]:    'Water Elemental',
  // Necromancy
  [MacroAction.CastAnimateDead]:    'Animate Dead',
  [MacroAction.CastBloodOath]:      'Blood Oath',
  [MacroAction.CastCorpseSkin]:     'Corpse Skin',
  [MacroAction.CastCurseWeapon]:    'Curse Weapon',
  [MacroAction.CastEvilOmen]:       'Evil Omen',
  [MacroAction.CastHorrificBeast]:  'Horrific Beast',
  [MacroAction.CastLichForm]:       'Lich Form',
  [MacroAction.CastMindRot]:        'Mind Rot',
  [MacroAction.CastPainSpike]:      'Pain Spike',
  [MacroAction.CastPoisonStrike]:   'Poison Strike',
  [MacroAction.CastStrangle]:       'Strangle',
  [MacroAction.CastSummonFamiliar]: 'Summon Familiar',
  [MacroAction.CastVampiricEmbrace]:'Vampiric Embrace',
  [MacroAction.CastVengefulSpirit]: 'Vengeful Spirit',
  [MacroAction.CastWither]:         'Wither',
  [MacroAction.CastWraithForm]:     'Wraith Form',
  [MacroAction.CastExorcism]:       'Exorcism',
  // Chivalry
  [MacroAction.CastCleanseByFire]:    'Cleanse by Fire',
  [MacroAction.CastCloseWounds]:      'Close Wounds',
  [MacroAction.CastConsecrateWeapon]: 'Consecrate Weapon',
  [MacroAction.CastDispelEvil]:       'Dispel Evil',
  [MacroAction.CastDivineFury]:       'Divine Fury',
  [MacroAction.CastEnemyOfOne]:       'Enemy of One',
  [MacroAction.CastHolyLight]:        'Holy Light',
  [MacroAction.CastNobleSacrifice]:   'Noble Sacrifice',
  [MacroAction.CastRemoveCurse]:      'Remove Curse',
  [MacroAction.CastSacredJourney]:    'Sacred Journey',
  // Bushido
  [MacroAction.CastBushidoConfidence]:        'Confidence',
  [MacroAction.CastBushidoEvasion]:           'Evasion',
  [MacroAction.CastBushidoCounterAttack]:     'Counter Attack',
  [MacroAction.CastBushidoLightningStrike]:   'Lightning Strike',
  [MacroAction.CastBushidoMomentumStrike]:    'Momentum Strike',
  [MacroAction.CastBushidoHonorableExecution]:'Honorable Execution',
  // Ninjitsu
  [MacroAction.CastNinjitsuFocusAttack]:    'Focus Attack',
  [MacroAction.CastNinjitsuDeathStrike]:    'Death Strike',
  [MacroAction.CastNinjitsuAnimalForm]:     'Animal Form',
  [MacroAction.CastNinjitsuKiAttack]:       'Ki Attack',
  [MacroAction.CastNinjitsuSurpriseAttack]: 'Surprise Attack',
  [MacroAction.CastNinjitsuBackstab]:       'Backstab',
  [MacroAction.CastNinjitsuShadowjump]:     'Shadowjump',
  [MacroAction.CastNinjitsuMirrorImage]:    'Mirror Image',
  // Spellweaving
  [MacroAction.CastSpellweavingArcaneCircle]:     'Arcane Circle',
  [MacroAction.CastSpellweavingGiftOfRenewal]:    'Gift of Renewal',
  [MacroAction.CastSpellweavingImmolatingWeapon]: 'Immolating Weapon',
  [MacroAction.CastSpellweavingAttunement]:       'Attunement',
  [MacroAction.CastSpellweavingThunderstorm]:     'Thunderstorm',
  [MacroAction.CastSpellweavingNaturesFury]:      "Nature's Fury",
  // Mysticism
  [MacroAction.CastMysticismNetherBolt]:    'Nether Bolt',
  [MacroAction.CastMysticismHealingStone]:  'Healing Stone',
  [MacroAction.CastMysticismPurgeMagic]:    'Purge Magic',
  [MacroAction.CastMysticismEnchant]:       'Enchant',
  [MacroAction.CastMysticismSleep]:         'Sleep',
  [MacroAction.CastMysticismEagleStrike]:   'Eagle Strike',
  [MacroAction.CastMysticismAnimatedWeapon]:'Animated Weapon',
};

const SKILL_NAME_BY_ACTION = {
  [MacroAction.UseSkillHide]:        'Hiding',
  [MacroAction.UseSkillStealth]:     'Stealth',
  [MacroAction.UseSkillMeditate]:    'Meditation',
  [MacroAction.UseSkillTracking]:    'Tracking',
  [MacroAction.UseSkillAnatomy]:     'Anatomy',
  [MacroAction.UseSkillAnimalLore]:  'Animal Lore',
  [MacroAction.UseSkillEvalInt]:     'Evaluating Intelligence',
  [MacroAction.UseSkillForensicEval]:'Forensic Evaluation',
  [MacroAction.UseSkillItemId]:      'Item Identification',
  [MacroAction.UseSkillTasteId]:     'Taste Identification',
  [MacroAction.UseSkillArmsLore]:    'Arms Lore',
  [MacroAction.UseSkillBegging]:     'Begging',
  [MacroAction.UseSkillPeacemaking]: 'Peacemaking',
  [MacroAction.UseSkillProvocation]: 'Provocation',
  [MacroAction.UseSkillDiscordance]: 'Discordance',
  [MacroAction.UseSkillStealing]:    'Stealing',
  [MacroAction.UseSkillDetectHidden]:'Detecting Hidden',
  [MacroAction.UseSkillSnooping]:    'Snooping',
  [MacroAction.UseSkillSpiritSpeak]: 'Spirit Speak',
  [MacroAction.UseSkillCartography]: 'Cartography',
  [MacroAction.UseSkillFishing]:     'Fishing',
  [MacroAction.UseSkillRemoveTrap]:  'Remove Trap',
  [MacroAction.UseSkillImbuing]:     'Imbuing',
  [MacroAction.UseSkillMysticism]:   'Mysticism',
  // Long tail (CUO `MacroType.UseSkill_*`).
  [MacroAction.UseSkillAlchemy]:     'Alchemy',
  [MacroAction.UseSkillAnimalTaming]:'Animal Taming',
  [MacroAction.UseSkillVeterinary]:  'Veterinary',
  [MacroAction.UseSkillMusicianship]:'Musicianship',
  [MacroAction.UseSkillMagery]:      'Magery',
  [MacroAction.UseSkillCamping]:     'Camping',
  [MacroAction.UseSkillCarpentry]:   'Carpentry',
  [MacroAction.UseSkillCooking]:     'Cooking',
  [MacroAction.UseSkillTinkering]:   'Tinkering',
  [MacroAction.UseSkillBlacksmithy]: 'Blacksmithy',
  [MacroAction.UseSkillBowcraft]:    'Bowcraft',
  [MacroAction.UseSkillEnticement]:  'Enticement',
  [MacroAction.UseSkillHerding]:     'Herding',
  [MacroAction.UseSkillTailoring]:   'Tailoring',
  [MacroAction.UseSkillInscription]: 'Inscription',
  [MacroAction.UseSkillLockpicking]: 'Lockpicking',
  [MacroAction.UseSkillMining]:      'Mining',
  [MacroAction.UseSkillLumberjack]:  'Lumberjacking',
  [MacroAction.UseSkillPoisoning]:   'Poisoning',
  [MacroAction.UseSkillNecromancy]:  'Necromancy',
  [MacroAction.UseSkillBushido]:     'Bushido',
  [MacroAction.UseSkillNinjitsu]:    'Ninjitsu',
  [MacroAction.UseSkillFocus]:       'Focus',
  [MacroAction.UseSkillSpellweaving]:'Spellweaving',
  [MacroAction.UseSkillThrowing]:    'Throwing',
};

const GUMP_NAME_BY_ACTION = {
  [MacroAction.OpenPaperdoll]: 'paperdoll',
  [MacroAction.OpenStatus]:    'status',
  [MacroAction.OpenJournal]:   'journal',
  [MacroAction.OpenBackpack]:  'backpack',
  [MacroAction.OpenSkills]:    'skills',
  [MacroAction.OpenChat]:      'chat',
  [MacroAction.OpenMap]:       'minimap',
  [MacroAction.OpenParty]:     'party',
  [MacroAction.OpenOptions]:   'options',
  [MacroAction.OpenSpellbook]: 'spellbook',
  [MacroAction.OpenLogout]:    'logout',
};

const VIRTUE_BY_ACTION = {
  [MacroAction.InvokeHonor]:      4,
  [MacroAction.InvokeSacrifice]:  3,
  [MacroAction.InvokeValor]:      6,
  [MacroAction.InvokeCompassion]: 5,
};

const DIR_BY_ACTION = {
  [MacroAction.WalkN]: 0, [MacroAction.WalkNE]: 1, [MacroAction.WalkE]: 2,
  [MacroAction.WalkSE]: 3, [MacroAction.WalkS]: 4, [MacroAction.WalkSW]: 5,
  [MacroAction.WalkW]: 6, [MacroAction.WalkNW]: 7,
};

class HotkeysManager {
  constructor() {
    /** @type {Map<string, {action:number, args?:any, chord?:boolean}>} */
    this._bindings = new Map();
    this._lastTargetSerial = 0;
    this._installed = false;
    /** Pending chord lead fingerprint — set when the user presses the
     *  first key of a chord, cleared on resolution or expiry. */
    this._chordArmed = null;
    this._chordArmedUntil = 0;
  }
  install() {
    if (this._installed) return;
    this._installed = true;
    const saved = profile.get?.('hotkeys.bindings') ?? [];
    for (const b of saved) {
      if (b.chord && b.lead && b.next) {
        const leadFp = this._key(b.lead.key, b.lead.ctrl, b.lead.shift, b.lead.alt);
        const nextFp = this._key(b.next.key, b.next.ctrl, b.next.shift, b.next.alt);
        this._bindings.set(this._chordKey(leadFp, nextFp),
          { action: b.action | 0, args: b.args, chord: true });
        continue;
      }
      const parsed = parseHotkeyCombo(b.combo ?? b.hotkey ?? b);
      if (!parsed) continue;
      this._bindings.set(this._key(parsed.key, parsed.ctrl, parsed.shift, parsed.alt),
        { action: b.action | 0, args: b.args });
    }
    window.addEventListener('keydown', (e) => this._onKey(e), true);
    bus.on('combat:target', (info) => { this._lastTargetSerial = info.serial >>> 0; });
  }

  bind(key, mods, action, args) {
    const k = this._key(key, mods?.ctrl, mods?.shift, mods?.alt);
    if (action === MacroAction.None) this._bindings.delete(k);
    else this._bindings.set(k, { action: action | 0, args });
    this._persist();
  }
  bindCombo(combo, action, args) {
    const parsed = parseHotkeyCombo(combo);
    if (!parsed) return false;
    this.bind(parsed.key, parsed, action, args);
    return true;
  }
  unbind(key, mods) {
    this._bindings.delete(this._key(key, mods?.ctrl, mods?.shift, mods?.alt));
    this._persist();
  }
  unbindCombo(combo) {
    const parsed = parseHotkeyCombo(combo);
    if (!parsed) return false;
    this.unbind(parsed.key, parsed);
    return true;
  }
  list() {
    return [...this._bindings.entries()].map(([k, v]) => ({ key: k, ...v }));
  }

  /** Direct dispatch for callers that want to fire an action without a key. */
  dispatch(action, args) { this._dispatch(action | 0, args); }

  _key(key, ctrl, shift, alt) {
    const mods = (ctrl ? 'C' : '') + (shift ? 'S' : '') + (alt ? 'A' : '');
    return `${mods}|${normalizeHotkeyKey(key)}`;
  }

  /** Compose a chord binding fingerprint. Format: "<leadFp>>><nextFp>"
   *  (triple-> separator so a real key named ">" can still be bound). */
  _chordKey(leadFp, nextFp) { return `${leadFp}>>>${nextFp}`; }

  /** Bind a chord (lead → next). E.g. bindChord({ key:'k', ctrl:true },
   *  { key:'a' }, MacroAction.OpenSpellbook). The first keypress arms a
   *  1.5s window in which a matching second keypress fires the action;
   *  any other key cancels the chord. CUO `HotKeyCombination` supports
   *  the same shape via SDL Keymod bitfields. */
  bindChord(lead, next, action, args = null) {
    const leadFp = this._key(lead.key, lead.ctrl, lead.shift, lead.alt);
    const nextFp = this._key(next.key, next.ctrl, next.shift, next.alt);
    this._bindings.set(this._chordKey(leadFp, nextFp), { action, args, chord: true });
    this._persist();
  }

  _onKey(e) {
    // Don't intercept keys when typing into a DOM input (chat, console).
    const t = e.target;
    if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const fp = this._key(e.key, e.ctrlKey, e.shiftKey, e.altKey);
    // 1) If a chord is armed, the next key must complete it. Either way,
    //    the chord state is consumed.
    if (this._chordArmed && performance.now() < this._chordArmedUntil) {
      const chordFp = this._chordKey(this._chordArmed, fp);
      const cb = this._bindings.get(chordFp);
      this._chordArmed = null;
      this._chordArmedUntil = 0;
      if (cb) {
        e.preventDefault();
        this._dispatch(cb.action, cb.args);
      }
      return;
    }
    // 2) Direct single-key binding.
    const binding = this._bindings.get(fp);
    if (binding && !binding.chord) {
      e.preventDefault();
      this._dispatch(binding.action, binding.args);
      return;
    }
    // 3) If any chord starts with this fp, arm a 1.5s window and wait.
    let hasChord = false;
    const prefix = `${fp}>>>`;
    for (const k of this._bindings.keys()) {
      if (k.startsWith(prefix)) { hasChord = true; break; }
    }
    if (hasChord) {
      e.preventDefault();
      this._chordArmed = fp;
      this._chordArmedUntil = performance.now() + 1500;
      bus.emit('hotkey:chord-armed', { lead: fp });
    }
  }

  _persist() {
    const out = [];
    for (const [k, v] of this._bindings) {
      if (v.chord) {
        // Chord key: "<modA>|<keyA>>>><modB>|<keyB>". Persist as a
        // structured pair so we can rebuild it on load.
        const [leadFp, nextFp] = k.split('>>>');
        const [lmods, lkey] = leadFp.split('|');
        const [nmods, nkey] = nextFp.split('|');
        out.push({
          chord: true,
          lead: { key: lkey, ctrl: lmods.includes('C'), shift: lmods.includes('S'), alt: lmods.includes('A') },
          next: { key: nkey, ctrl: nmods.includes('C'), shift: nmods.includes('S'), alt: nmods.includes('A') },
          action: v.action, args: v.args,
        });
        continue;
      }
      const [mods, key] = k.split('|');
      const combo = {
        key,
        ctrl:  mods.includes('C'),
        shift: mods.includes('S'),
        alt:   mods.includes('A'),
      };
      out.push({
        ...combo,
        combo: formatHotkeyCombo(combo),
        action: v.action,
        args: v.args,
      });
    }
    try { profile.set?.('hotkeys.bindings', out); } catch { /* noop */ }
  }

  _dispatch(action, args) {
    // Spells — server's TextCommand 0x56 expects a *numeric* spell id
    // (ServUO `parseInt(cmd)`). Translate the canonical name from
    // SPELL_BY_ACTION via spellByName before sending.
    if (SPELL_BY_ACTION[action]) {
      const def = spellByName(SPELL_BY_ACTION[action]);
      if (def) {
        try { net.send(buildTextCommand(0x56, String(def.id))); } catch { /* socket */ }
      }
      return;
    }
    // Skills
    if (SKILL_NAME_BY_ACTION[action]) {
      const id = skillIdFromName(SKILL_NAME_BY_ACTION[action]);
      try {
        if (id) net.send(buildUseSkill(id));
        else net.send(buildTextCommand(0x24, SKILL_NAME_BY_ACTION[action]));
      } catch { /* socket */ }
      return;
    }
    // Gumps
    if (GUMP_NAME_BY_ACTION[action]) {
      const kind = GUMP_NAME_BY_ACTION[action];
      if (kind === 'spellbook') {
        try { net.send(buildOpenSpellBook(0)); } catch { /* socket */ }
      } else {
        bus.emit('macro:gump', { kind });
      }
      return;
    }
    // Virtue
    if (VIRTUE_BY_ACTION[action]) {
      try { net.send(buildInvokeVirtue(VIRTUE_BY_ACTION[action])); } catch { /* socket */ }
      return;
    }
    // Walk
    if (DIR_BY_ACTION[action] != null) {
      bus.emit('macro:walk', { dir: DIR_BY_ACTION[action] });
      return;
    }
    // Combat / target
    switch (action) {
      case MacroAction.AttackLast:
        if (this._lastTargetSerial) {
          try { net.send(buildAttackReq(this._lastTargetSerial)); } catch { /* socket */ }
        }
        return;
      case MacroAction.AttackClosest: {
        const m = this._closestEnemy();
        if (m) {
          try { net.send(buildAttackReq(m.serial)); } catch { /* socket */ }
        }
        return;
      }
      case MacroAction.ClearAttack:
        try { net.send(buildClearAttack()); } catch { /* socket */ }
        return;
      case MacroAction.WarMode: {
        const next = !world.player?.warMode;
        try { net.send(buildWarMode(next)); } catch { /* socket */ }
        return;
      }
      case MacroAction.LastTarget:
        if (targetManager.active && this._lastTargetSerial) {
          targetManager.pickEntity({ serial: this._lastTargetSerial });
        }
        return;
      case MacroAction.TargetSelf:
        if (targetManager.active && world.player) {
          targetManager.pickEntity({ serial: world.player.serial });
        }
        return;
      case MacroAction.CancelTarget:
        if (targetManager.active) targetManager.cancel();
        return;
      case MacroAction.TargetClosest: {
        const m = this._closestEnemy();
        if (m && targetManager.active) targetManager.pickEntity({ serial: m.serial });
        else if (m) bus.emit('macro:target-closest', { serial: m.serial });
        return;
      }
      case MacroAction.AllNames:
        bus.emit('macro:all-names', {});
        return;
      case MacroAction.TargetCorpse: {
        const c = this._closestCorpse();
        if (c && targetManager.active) targetManager.pickEntity({ serial: c.serial });
        return;
      }
      case MacroAction.Bandage:
      case MacroAction.BandageSelf: {
        // Use a bandage from the player's backpack on self — server
        // resolves the bandage item by graphic when we send 0x06 on the
        // bandage stack. For simplicity, emit a target prompt that the
        // user fulfils, OR if the prompt is already up, target self.
        if (targetManager.active && world.player) {
          targetManager.pickEntity({ serial: world.player.serial });
          return;
        }
        bus.emit('macro:bandage-self', {});
        return;
      }
      case MacroAction.BandageTarget:
        bus.emit('macro:bandage-target', {});
        return;
      case MacroAction.EquipLastWeapon:
        bus.emit('macro:equip-last-weapon', {});
        return;
      case MacroAction.ArmDisarm:
        bus.emit('macro:arm-disarm', {});
        return;
      case MacroAction.Resync:
        bus.emit('net:resync-request');
        return;
      case MacroAction.Reconnect:
        bus.emit('net:reconnect-request', {});
        return;
      case MacroAction.ToggleAura:
        auraManager.cycleMode();
        return;
      case MacroAction.AllAttack:
        bus.emit('macro:all-attack', {});
        return;
      case MacroAction.Logout:
        try { net.send(buildLogoutRequest()); } catch { /* socket */ }
        return;
      case MacroAction.Say:
      case MacroAction.Emote:
      case MacroAction.Whisper:
      case MacroAction.Yell:
        bus.emit('macro:speak', { kind: action, text: args });
        return;
      // Potions: drink-from-pack hooks the drag-drop system; we just
      // emit a typed event the drag manager reacts to (`use first item
      // matching graphic group X in backpack`).
      case MacroAction.UsePotionHeal:
      case MacroAction.UsePotionCure:
      case MacroAction.UsePotionRefresh:
      case MacroAction.UsePotionAgility:
      case MacroAction.UsePotionStrength:
      case MacroAction.UsePotionMana:
      case MacroAction.UsePotionExplosion: {
        const POT = {
          [MacroAction.UsePotionHeal]:      ['Heal',      0x0F0C],
          [MacroAction.UsePotionCure]:      ['Cure',      0x0F07],
          [MacroAction.UsePotionRefresh]:   ['Refresh',   0x0F0B],
          [MacroAction.UsePotionAgility]:   ['Agility',   0x0F08],
          [MacroAction.UsePotionStrength]:  ['Strength',  0x0F09],
          [MacroAction.UsePotionMana]:      ['Mana',      0x0F0A],
          [MacroAction.UsePotionExplosion]: ['Explosion', 0x0F0D],
        };
        const [kind, graphic] = POT[action];
        bus.emit('macro:use-potion', { kind, graphic });
        return;
      }
      case MacroAction.UseObjectByType:
        bus.emit('macro:use-object-by-type', { graphic: args | 0 });
        return;
      case MacroAction.UseFromBackpack:
        bus.emit('macro:use-from-backpack', { graphic: args | 0 });
        return;
      case MacroAction.GrabItem:
        bus.emit('macro:grab-item', {});
        return;
      case MacroAction.SetGrabBag:
        bus.emit('macro:set-grab-bag', {});
        return;
      case MacroAction.UseLastTarget:
        if (this._lastTargetSerial) {
          try { net.send(buildUseReq(this._lastTargetSerial)); } catch { /* socket */ }
        }
        return;
      case MacroAction.SelectNext:
      case MacroAction.SelectPrevious:
      case MacroAction.SelectNearest:
        bus.emit('macro:select', { mode: action });
        return;
      case MacroAction.AutoFollow:
        if (this._lastTargetSerial) bus.emit('macro:auto-follow', { serial: this._lastTargetSerial });
        return;
      case MacroAction.StopMovement:
        bus.emit('macro:stop-movement', {});
        return;
      case MacroAction.OpenContainer:
        if (this._lastTargetSerial) {
          try { net.send(buildUseReq(this._lastTargetSerial)); } catch { /* socket */ }
        }
        return;
      case MacroAction.CloseAllGumps:
        bus.emit('macro:close-all-gumps', {});
        return;
      case MacroAction.CloseTopGump:
        bus.emit('macro:close-top-gump', {});
        return;
      case MacroAction.MinimizeGump:
        bus.emit('macro:minimize-gump', {});
        return;
      case MacroAction.ToggleGargoyleFly:
        bus.emit('macro:toggle-fly', {});
        return;
      case MacroAction.EnableSallosEasyGrab:
        bus.emit('macro:toggle-sallos', {});
        return;
      case MacroAction.Quit:
      case MacroAction.ConfirmQuit:
        try { net.send(buildLogoutRequest()); } catch { /* socket */ }
        return;
      case MacroAction.EditMacro:
        bus.emit('macro:edit', {});
        return;
      case MacroAction.ScrollUp:
      case MacroAction.ScrollDown:
        bus.emit('macro:scroll', { dy: action === MacroAction.ScrollUp ? -1 : 1 });
        return;
    }
    if (import.meta?.env?.DEV) console.debug('[hotkeys] unmapped action', action);
  }

  _closestEnemy() {
    const p = world.player;
    if (!p) return null;
    let best = null, bestD = Infinity;
    const map = p.map ?? world.mapId ?? 1;
    const visit = (m) => {
      if (m === p) return undefined;
      if ((m.map ?? map) !== map) return undefined;
      // Skip Innocent (1) and Ally (2). Everything else is fair game.
      if (m.notoriety === 1 || m.notoriety === 2) return undefined;
      if (m.isDead) return undefined;
      const d = Math.abs(m.x - p.x) + Math.abs(m.y - p.y);
      if (d < bestD) { bestD = d; best = m; }
    };
    if (world.forEachMobileNear) {
      world.forEachMobileNear(p.x, p.y, map, 24, true, visit);
    } else {
      const nearby = world.mobilesNear
        ? world.mobilesNear(p.x, p.y, map, 24, true)
        : world.mobiles.values();
      for (const m of nearby) visit(m);
    }
    return best;
  }
  _closestCorpse() {
    const p = world.player;
    if (!p) return null;
    let best = null, bestD = Infinity;
    const map = p.map ?? world.mapId ?? 1;
    const visit = (it) => {
      if (!it.isCorpse) return undefined;
      if ((it.map ?? map) !== map) return undefined;
      const d = Math.abs(it.x - p.x) + Math.abs(it.y - p.y);
      if (d < bestD) { bestD = d; best = it; }
    };
    if (world.forEachItemNear) {
      world.forEachItemNear(p.x, p.y, map, 24, visit);
    } else {
      const nearby = world.itemsNear
        ? world.itemsNear(p.x, p.y, map, 24)
        : world.items.values();
      for (const it of nearby) visit(it);
    }
    return best;
  }
}

export const hotkeys = new HotkeysManager();
