// MacroManager — key-binding → action runner. Mirrors ClassicUO's
// Game/Managers/MacroManager.cs at MVP scope.
//
// A macro is a list of `{ kind, arg }` actions, attached to a hotkey
// (key + modifiers). On key down we execute each action serially.
//
// Action kinds (subset of CUO's MacroType enum):
//   say              arg = string         → 0xAD UnicodeSpeech
//   open-paperdoll                        → toggle paperdoll gump locally
//   open-journal                          → toggle journal gump
//   open-skills                           → toggle skills gump
//   open-status                           → toggle status gump
//   target-self                           → if target prompt active, pick self
//   target-last                           → if target prompt active, pick last
//   close-all-gumps                       → ESC equivalent
//   bandage-self                          → 0x06 UseReq on a bandage in pack (not yet)
//
// Persistence: localStorage `uo.macros`.

import { net } from '../net/net-client.js';
import { bus } from '../core/event-bus.js';
import {
  buildUnicodeSpeech, buildTextCommand, buildAttackReq, buildClearAttack,
  buildUseReq, buildWarMode, buildLogoutRequest, buildUseSkill,
  buildOpenSpellBook,
} from '../net/outgoing.js';
import { targetManager } from './target-manager.js';
import { world } from '../world/world.js';
import { pinSelfWarLatch } from '../net/handlers.js';
import { skillIdFromName } from '../shared/skill-ids.js';
import { spellbookTypeFromKind } from '../shared/spellbook-types.js';
import { formatHotkeyCombo, normalizeHotkeyKey, parseHotkeyCombo } from '../shared/hotkey-combo.js';

const KEY = 'uo.macros';

function normalizeMacroHotkey(macro) {
  const combo = parseHotkeyCombo(macro?.combo ?? macro?.hotkey ?? macro);
  if (!combo) {
    return {
      ...macro,
      key: normalizeHotkeyKey(macro?.key),
      ctrl: !!macro?.ctrl,
      shift: !!macro?.shift,
      alt: !!macro?.alt,
    };
  }
  return {
    ...macro,
    ...combo,
    combo: formatHotkeyCombo(combo),
  };
}

function sendOpenSpellbook(kind = 'spellbook') {
  const type = spellbookTypeFromKind(kind);
  if (type == null) return false;
  net.send(buildOpenSpellBook(type));
  return true;
}

function openGumpOrSpellbook(kind) {
  if (!sendOpenSpellbook(kind)) bus.emit('macro:gump', { kind });
}

function sendUseSkill(value) {
  const id = skillIdFromName(value);
  if (!id) return null;
  net.send(buildUseSkill(id));
  return id;
}

const CUO_OPEN_SUBTYPES = Object.freeze({
  10: 'paperdoll',
  11: 'status',
  12: 'journal',
  13: 'skills',
  14: 'mage-spellbook',
  16: 'backpack',
  17: 'worldmap',
  20: 'partymanifest',
  22: 'necro-spellbook',
  23: 'paladin-spellbook',
  24: 'combatbook',
  25: 'bushido-spellbook',
  26: 'ninja-spellbook',
  27: 'guild',
  28: 'spellweaving-spellbook',
  30: 'mysticism-spellbook',
  31: 'racial-abilities',
  32: 'mastery-spellbook',
});

const CUO_SKILL_SUBTYPES = [
  'Anatomy', 'Animal Lore', 'Animal Taming', 'Arms Lore', 'Begging',
  'Cartography', 'Detecting Hidden', 'Discordance', 'Evaluating Intelligence',
  'Forensic Evaluation', 'Hiding', 'Imbuing', 'Inscription',
  'Item Identification', 'Meditation', 'Peacemaking', 'Poisoning',
  'Provocation', 'Remove Trap', 'Spirit Speak', 'Stealing', 'Stealth',
  'Taste Identification', 'Tracking',
];

const CUO_SPELL_SUBTYPES = [
  'Clumsy', 'Create Food', 'Feeblemind', 'Heal', 'Magic Arrow',
  'Night Sight', 'Reactive Armor', 'Weaken', 'Agility', 'Cunning', 'Cure',
  'Harm', 'Magic Trap', 'Magic Untrap', 'Protection', 'Strength', 'Bless',
  'Fireball', 'Magic Lock', 'Poison', 'Telekinesis', 'Teleport', 'Unlock',
  'Wall Of Stone', 'Arch Cure', 'Arch Protection', 'Curse', 'Fire Field',
  'Greater Heal', 'Lightning', 'Mana Drain', 'Recall', 'Blade Spirits',
  'Dispel Field', 'Incognito', 'Magic Reflection', 'Mind Blast', 'Paralyze',
  'Poison Field', 'Summon Creature', 'Dispel', 'Energy Bolt', 'Explosion',
  'Invisibility', 'Mark', 'Mass Curse', 'Paralyze Field', 'Reveal',
  'Chain Lightning', 'Energy Field', 'Flame Strike', 'Gate Travel',
  'Mana Vampire', 'Mass Dispel', 'Meteor Swarm', 'Polymorph', 'Earthquake',
  'Energy Vortex', 'Resurrection', 'Air Elemental', 'Summon Daemon',
  'Earth Elemental', 'Fire Elemental', 'Water Elemental', 'Animate Dead',
  'Blood Oath', 'Corpse Skin', 'Curse Weapon', 'Evil Omen', 'Horrific Beast',
  'Lich Form', 'Mind Rot', 'Pain Spike', 'Poison Strike', 'Strangle',
  'Summon Familiar', 'Vampiric Embrace', 'Vengeful Spirit', 'Wither',
  'Wraith Form', 'Exorcism', 'Cleanse By Fire', 'Close Wounds',
  'Consecrate Weapon', 'Dispel Evil', 'Divine Fury', 'Enemy Of One',
  'Holy Light', 'Noble Sacrifice', 'Remove Curse', 'Sacred Journey',
  'Honorable Execution', 'Confidence', 'Evasion', 'Counter Attack',
  'Lightning Strike', 'Momentum Strike', 'Focus Attack', 'Death Strike',
  'Animal Form', 'Ki Attack', 'Surprise Attack', 'Backstab', 'Shadowjump',
  'Mirror Image', 'Arcane Circle', 'Gift Of Renewal', 'Immolating Weapon',
  'Attunement', 'Thunderstorm', 'Natures Fury', 'Summon Fey', 'Summon Fiend',
  'Reaper Form', 'Wildfire', 'Essence Of Wind', 'Dryad Allure',
  'Ethereal Voyage', 'Word Of Death', 'Gift Of Life', 'Arcane Empowerment',
  'Nether Bolt', 'Healing Stone', 'Purge Magic', 'Enchant', 'Sleep',
  'Eagle Strike', 'Animated Weapon', 'Stone Form', 'Spell Trigger',
  'Mass Sleep', 'Cleansing Winds', 'Bombard', 'Spell Plague', 'Hail Storm',
  'Nether Cyclone', 'Rising Colossus', 'Inspire', 'Invigorate', 'Resilience',
  'Perseverance', 'Tribulation', 'Despair',
];

const SDL_SPECIAL_KEYS = Object.freeze({
  8: 'backspace',
  9: 'tab',
  13: 'enter',
  27: 'escape',
  32: ' ',
  1073741903: 'arrowright',
  1073741904: 'arrowleft',
  1073741905: 'arrowdown',
  1073741906: 'arrowup',
  1073741901: 'delete',
});

function xmlDecode(value) {
  return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, ent) => {
    const e = ent.toLowerCase();
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16) || 0);
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10) || 0);
    return m;
  });
}

function parseXmlAttrs(raw) {
  const attrs = {};
  String(raw ?? '').replace(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_, key, dq, sq) => {
    attrs[key.toLowerCase()] = xmlDecode(dq ?? sq ?? '');
    return '';
  });
  return attrs;
}

function attr(el, name) {
  return el.getAttribute?.(name) ?? el[name.toLowerCase()] ?? '';
}

function boolAttr(value) {
  return /^(1|true|yes)$/i.test(String(value ?? '').trim());
}

function cuoKeyToHotkey(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const n = parseInt(raw, 10);
  if (!Number.isNaN(n)) {
    if (n >= 1073741882 && n <= 1073741893) return `f${n - 1073741881}`;
    if (n >= 48 && n <= 57) return String.fromCharCode(n);
    if (n >= 65 && n <= 90) return String.fromCharCode(n + 32);
    if (n >= 97 && n <= 122) return String.fromCharCode(n);
    if (SDL_SPECIAL_KEYS[n]) return SDL_SPECIAL_KEYS[n];
    return '';
  }
  return normalizeHotkeyKey(raw);
}

function cuoSkillName(sub) {
  return CUO_SKILL_SUBTYPES[(sub | 0) - 33] ?? '';
}

function cuoSpellName(sub) {
  return CUO_SPELL_SUBTYPES[(sub | 0) - 61] ?? '';
}

function normalizeOpenKind(kind) {
  if (kind === 'combatbook') return 'mastery-spellbook';
  return kind;
}

function cuoActionToActions(action) {
  const code = parseInt(attr(action, 'code'), 10);
  const sub = parseInt(attr(action, 'subcode'), 10);
  const text = attr(action, 'text');
  const one = (kind, arg) => arg ? [{ kind, arg }] : [{ kind }];
  switch (code) {
    case 1: return text ? one('say', text) : [];
    case 2: return text ? one('emote', text) : [];
    case 3: return text ? one('whisper', text) : [];
    case 4: return text ? one('yell', text) : [];
    case 5: {
      const dirs = ['', 'nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
      return dirs[sub] ? one(`walk-${dirs[sub]}`) : one('walk', String(Math.max(0, sub - 1)));
    }
    case 6: return one('toggle-war');
    case 8: {
      const kind = normalizeOpenKind(CUO_OPEN_SUBTYPES[sub] ?? '');
      return kind === 'backpack' ? one('open-backpack') : (kind ? one(`open-${kind}`) : []);
    }
    case 12: return one('open-door');
    case 13: {
      const skill = cuoSkillName(sub);
      return skill ? one('use-skill', skill) : [];
    }
    case 14: return one('last-skill');
    case 15: {
      const spell = cuoSpellName(sub);
      return spell ? one('cast', spell) : [];
    }
    case 16: return one('cast-last');
    case 17: return one('last-object');
    case 18: return one('bow');
    case 19: return one('salute');
    case 20: return one('quit');
    case 21: return one('all-names');
    case 22: return one('target-last');
    case 23: return one('target-self');
    case 24: return one('arm-disarm');
    case 25: return one('wait-for-target', '5000');
    case 26: return one('target-next');
    case 27: return one('attack-last');
    case 28: return one('delay', text || '250');
    case 31: return one('toggle-always-run');
    case 34: return one('primary-ability');
    case 35: return one('secondary-ability');
    case 36: return one('equip-last');
    case 43: return one('enable-range-color');
    case 44: return one('disable-range-color');
    case 45: return one('toggle-range-color');
    case 47: return one('invoke-virtue', text || String(sub || ''));
    case 48: return one('target-next');
    case 49: return one('target-prev');
    case 50: return one('target-next');
    case 51: return one('attack-selected');
    case 52: return one('use-selected-target');
    case 53: return one('current-target');
    case 54: return one('target-system-toggle');
    case 55: return one('open-buff-bar');
    case 56: return one('bandage-self');
    case 57: return one('bandage-last');
    case 58: return one('toggle-fly');
    case 59: return sub === 224 ? one('zoom-in') : sub === 225 ? one('zoom-out') : one('zoom-reset');
    case 64: return one('grab-everything');
    case 66: return one('toggle-name-overhead');
    case 67: return one('use-item-in-hand');
    case 68: return one('use-potion', text || '');
    case 69: return one('close-all-healthbars');
    case 70: return parseRazorMacroText(text);
    case 71: return one('toggle-roofs');
    case 72: return one('toggle-trees-stumps');
    case 73: return one('toggle-vegetation');
    case 74: return one('toggle-cave-tiles');
    case 75: return one('close-inactive-healthbars');
    case 76: return one('close-corpses');
    case 77: return text ? one('use-object', text) : one('last-object');
    case 78: return one('toggle-look-at');
    default: return [];
  }
}

function parseRazorMacroText(text) {
  const out = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    const m = line.match(/^([a-z][\w-]*)(?:\s+(.+))?$/i);
    if (!m) continue;
    const cmd = m[1].toLowerCase();
    const arg = String(m[2] ?? '').replace(/^['"]|['"]$/g, '');
    const push = (kind, value) => out.push(value ? { kind, arg: value } : { kind });
    if (['say', 'emote', 'whisper', 'yell'].includes(cmd)) push(cmd, arg);
    else if (cmd === 'cast' || cmd === 'castspell') push('cast', arg);
    else if (cmd === 'useskill') push('use-skill', arg);
    else if (cmd === 'waitfortarget' || cmd === 'waittarget') push('wait-for-target', arg || '5000');
    else if (cmd === 'pause' || cmd === 'wait' || cmd === 'delay') push('delay', arg || '250');
    else if (cmd === 'targetself') push('target-self');
    else if (cmd === 'targetlast' || cmd === 'lasttarget') push('target-last');
    else if (cmd === 'attacklast') push('attack-last');
    else if (cmd === 'dclick' || cmd === 'useobject') push('use-object', arg);
    else push(cmd, arg);
  }
  return out;
}

function readCuoXmlDom(text) {
  if (typeof globalThis.DOMParser === 'undefined') return null;
  const doc = new globalThis.DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;
  const macros = [];
  for (const macroEl of doc.getElementsByTagName('macro')) {
    const actionsEl = macroEl.getElementsByTagName('actions')[0];
    const actions = actionsEl ? Array.from(actionsEl.getElementsByTagName('action')) : [];
    macros.push({ macro: macroEl, actions });
  }
  return macros;
}

function readCuoXmlLite(text) {
  const macros = [];
  const macroRe = /<macro\b([^>]*)>([\s\S]*?)<\/macro>/gi;
  let macroMatch;
  while ((macroMatch = macroRe.exec(text))) {
    const macro = parseXmlAttrs(macroMatch[1]);
    const actions = [];
    const actionRe = /<action\b([^>]*?)(?:\/>|>[\s\S]*?<\/action>)/gi;
    let actionMatch;
    while ((actionMatch = actionRe.exec(macroMatch[2]))) {
      actions.push(parseXmlAttrs(actionMatch[1]));
    }
    macros.push({ macro, actions });
  }
  return macros;
}

function importCuoXmlMacros(blob) {
  const text = String(blob ?? '').trim();
  if (!/^<\?xml|^<macros\b|<macro\b/i.test(text)) return null;
  const records = readCuoXmlDom(text) ?? readCuoXmlLite(text);
  if (!records?.length) return null;
  return records.map(({ macro, actions }, index) => {
    const imported = {
      name: attr(macro, 'name') || `Imported ${index + 1}`,
      key: cuoKeyToHotkey(attr(macro, 'key')),
      alt: boolAttr(attr(macro, 'alt')),
      ctrl: boolAttr(attr(macro, 'ctrl')),
      shift: boolAttr(attr(macro, 'shift')),
      actions: actions.flatMap((a) => cuoActionToActions(a)),
      source: 'classicuo-xml',
    };
    return normalizeMacroHotkey(imported);
  }).filter((m) => typeof m.key === 'string' && Array.isArray(m.actions) && m.actions.length);
}

/** @typedef {{ kind:string, arg?:string }} MacroAction */
/** @typedef {{ key:string, ctrl?:boolean, shift?:boolean, alt?:boolean, actions:MacroAction[] }} Macro */

class MacroManager {
  constructor() {
    /** @type {Macro[]} */
    this.macros = [];
    /** registered runners by `kind` */
    this._runners = new Map();
    /** Last successfully-cast spell name (for `last-spell` action). */
    this._lastSpell = null;
    /** Last skill used (for `last-skill` action). */
    this._lastSkill = null;
    /** Most recent attack focus (set by 0xAA combat:target → bus). */
    this._lastAttack = 0;
    /** Local war-mode mirror (synced from 0x72). */
    this._warMode = false;
    /** Always-run flag (purely client-side; doubles 0x02 run bit). */
    this.alwaysRun = false;
    /** Current beneficial-targeting flag for next target prompt. CUO
     *  uses this to decide whether to bypass criminal warnings on
     *  Bless/Heal targets. */
    this.beneficialNext = false;
    this._registerDefaultRunners();
    this._load();
    document.addEventListener('keydown', this._onKey, true);
    // Track last-attack serial via the 0xAA combat:target event we now
    // surface in net/handlers.js. Without this `attack-last` would
    // never have a target to fall back on.
    bus.on('combat:target', ({ serial }) => { if (serial) this._lastAttack = serial >>> 0; });
    bus.on('player:warmode', ({ warMode }) => { this._warMode = !!warMode; });
    // PaperdollGump's PeaceWarToggle button (CUO PaperdollGump.cs:199)
    // dispatches `macro:warmode`. Route through the same flip+send path
    // as the F-key macro so the two stay in lock-step.
    //
    // BUGFIX: derive the next state from `world.player.warMode` (server
    // truth) rather than the local `_warMode` mirror. The mirror starts
    // at `false` and is only synced by 0x72 echoes — but the server
    // never sends an unsolicited 0x72 at login (war-state arrives via
    // the mobileIncoming flags byte). So if the player loaded ALREADY
    // in war mode, clicking the paperdoll PEACE button toggled the
    // mirror false → true and SENT war-mode-on, leaving the player
    // permanently locked in war stance. Read the live mob state so
    // every click sends the inverse of what's actually true.
    bus.on('macro:warmode', () => {
      // Read live state from `world.player.warMode` (the FLAG_WARMODE
      // derivation done by Mobile.flags setter) — the local `_warMode`
      // mirror starts at false and is only synced on the FIRST 0x72
      // echo, so it lies until then.
      const live = !!world.player?.warMode;
      const next = !live;
      this._warMode = next;
      // PIN THE LATCH FIRST — this guards against any 0x77/0x78/0x20
      // self-echo arriving in the next 5s with a stale flags byte. The
      // server occasionally re-broadcasts mobileMoving on the same tick
      // as the war toggle and the broadcast can carry the OLD war bit
      // because it was queued before our buildWarMode landed; without
      // a pinned latch the Object.assign in those handlers would undo
      // our optimistic flip.
      pinSelfWarLatch(next);
      // OPTIMISTIC LOCAL APPLY — flip the bit on `world.player.flags`
      // immediately so the mobile renderer picks up the new pose this
      // frame without waiting for the server's 0x72 round-trip.
      if (world.player) {
        const bit = 0x40;
        const cur = (world.player.flags | 0);
        const want = next ? (cur | bit) : (cur & ~bit);
        if (want !== cur) world.player.flags = want;
        // Belt+braces: directly poke the derived booleans too so that
        // even if some code path bypasses the setter (e.g., a bare
        // `m.warMode = …` somewhere) the renderer sees the right state
        // on the very next tick.
        world.player.warMode = next;
        // Also emit the bus event locally — the paperdoll sprite swap
        // listens on `player:warmode` and would otherwise wait for the
        // server echo to redraw. The 0x72 handler emits the same event
        // when its echo lands; receivers are idempotent.
        bus.emit('player:warmode', { warMode: next });
      }
      net.send(buildWarMode(next));
    });
  }

  /** Add a runner for a custom action kind. */
  registerRunner(kind, fn) { this._runners.set(kind, fn); }

  /** Register a reactive macro trigger.  `event` is a bus event name
   *  (`'combat:state'`, `'mobile:hp'`, `'message:journal'`, ...) and
   *  `match(payload)` returns true when the payload should trigger.
   *  Returns a dispose function. CUO has only a hand-rolled equivalent
   *  via `OnCombatStateChanged` callback table; ours is a generic hook
   *  so users can attach arbitrary "on X, run macro Y" rules from the
   *  console / future trigger gump. */
  registerTrigger(event, match, macroName) {
    const off = bus.on(event, (payload) => {
      try {
        if (typeof match === 'function' && !match(payload)) return;
        const m = this.macros.find((mm) => mm.name === macroName);
        if (m) this.runAsync(m.actions ?? []);
      } catch (err) { console.warn('[macro] trigger threw', err); }
    });
    (this._triggers ??= []).push(off);
    return off;
  }

  /** Wipe all registered triggers (used by tests / hot-reload). */
  clearTriggers() {
    if (!this._triggers) return;
    for (const off of this._triggers) try { off(); } catch { /* noop */ }
    this._triggers.length = 0;
  }

  /** Audit rev.4 P1 #2 — re-attach reactive triggers from persisted
   *  macros. Each macro can carry a `trigger: { event, when }` field
   *  where `event` is a bus event name and `when` is a serializable
   *  predicate (compiled by `_compileTriggerPredicate`). Without this
   *  call, the `registerTrigger` API was only callable from the dev
   *  console — never restored across reloads.
   *
   *  Standard events surfaced in our event-bus:
   *    `combat:state`     payload {inCombat:boolean}
   *    `mobile:hp`        payload {serial, hp, hpMax, …}
   *    `message:journal`  payload {text, textType, hue, …}
   *    `target:select`    payload {serial}
   *    `player:warmode`   payload {warMode}
   *    `region:enter`     payload {kind}
   */
  attachTriggers() {
    this.clearTriggers();
    for (const m of this.macros) {
      if (!m?.trigger?.event) continue;
      const match = this._compileTriggerPredicate(m.trigger.when);
      // `m.name` is preferred; fall back to a synthetic name keyed on
      // the macro's hotkey so legacy entries without a `name` still
      // resolve.
      const name = m.name || `__hotkey:${m.key || ''}`;
      try {
        // Inline the registerTrigger body so we can pass the macro's
        // actions directly instead of round-tripping through `name`
        // lookup (legacy macros may not have a `name` to resolve).
        const off = bus.on(m.trigger.event, (payload) => {
          try {
            if (match && !match(payload)) return;
            this.runAsync(m.actions ?? []);
          } catch (err) { console.warn('[macro] trigger threw', err); }
        });
        (this._triggers ??= []).push(off);
      } catch (e) { console.warn('[macro] attachTriggers failed for', name, e); }
    }
  }

  /** Compile a serializable predicate `{ field, op, value }` (or array
   *  of such for AND-chain) to a runtime predicate fn(payload)->bool.
   *  `field` is a dot-path into the payload (`'inCombat'`, `'hp'`).
   *  `op` ∈ {eq, ne, lt, gt, lte, gte, contains, startsWith, endsWith}.
   *  Returns null on no `when` (matches every event). */
  _compileTriggerPredicate(when) {
    if (!when) return null;
    const rules = Array.isArray(when) ? when : [when];
    return (payload) => {
      if (!payload) return false;
      for (const r of rules) {
        if (!r || typeof r !== 'object') continue;
        const field = String(r.field ?? '');
        const parts = field.split('.');
        let v = payload;
        for (const p of parts) { v = v?.[p]; if (v === undefined) break; }
        const op = String(r.op ?? 'eq');
        const target = r.value;
        let ok = false;
        switch (op) {
          case 'eq':
          case '==':         ok = v === target || String(v) === String(target); break;
          case 'ne':
          case '!=':         ok = v !== target && String(v) !== String(target); break;
          case 'lt':
          case '<':          ok = Number(v)  <  Number(target); break;
          case 'gt':
          case '>':          ok = Number(v)  >  Number(target); break;
          case 'lte':
          case '<=':         ok = Number(v)  <= Number(target); break;
          case 'gte':
          case '>=':         ok = Number(v)  >= Number(target); break;
          case 'contains':   ok = String(v ?? '').includes(String(target ?? '')); break;
          case 'startsWith': ok = String(v ?? '').startsWith(String(target ?? '')); break;
          case 'endsWith':   ok = String(v ?? '').endsWith(String(target ?? '')); break;
          case 'truthy':     ok = !!v; break;
          case 'falsy':      ok = !v; break;
          default:           ok = false;
        }
        if (!ok) return false;     // AND-chain — every rule must pass.
      }
      return true;
    };
  }

  triggerSummaries() {
    return this.macros
      .map((m, index) => {
        const trigger = m?.trigger;
        if (!trigger?.event) return null;
        const rules = Array.isArray(trigger.when) ? trigger.when : (trigger.when ? [trigger.when] : []);
        const predicate = rules
          .filter((r) => r && typeof r === 'object')
          .map((r) => `${r.field ?? ''} ${r.op ?? 'eq'} ${r.value ?? ''}`)
          .filter(Boolean)
          .join(' && ');
        return {
          index,
          label: m.name || formatHotkeyCombo(m) || `Macro ${index + 1}`,
          event: String(trigger.event),
          predicate,
          action: m.actions?.[0]?.kind ?? '',
        };
      })
      .filter(Boolean);
  }

  /** Add a new macro (and persist). */
  add(macro) {
    this.macros.push(macro);
    this._save();
    this.attachTriggers();
  }

  remove(index) {
    this.macros.splice(index, 1);
    this._save();
    this.attachTriggers();
  }

  /** Match a key event to a macro. */
  _matches(m, e) {
    const evKey = normalizeHotkeyKey(e.key);
    const macroKey = normalizeHotkeyKey(m.key);
    if (!macroKey || macroKey !== evKey) return false;
    if (!!m.ctrl  !== !!e.ctrlKey)  return false;
    if (!!m.shift !== !!e.shiftKey) return false;
    if (!!m.alt   !== !!e.altKey)   return false;
    return true;
  }

  _onKey = (e) => {
    // Audit #41 client P2 #26 — was: only blocked `HTMLInputElement`.
    // Pixi TextInput, HTMLTextArea, and contenteditable divs all
    // bypassed the gate → typing Tab in a chat input fired the
    // war-mode macro mid-message. Mirror CUO's UIManager focus check.
    const el = document.activeElement;
    if (el instanceof HTMLInputElement) return;
    if (el instanceof HTMLTextAreaElement) return;
    if (el?.isContentEditable) return;
    if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA') return;
    for (const m of this.macros) {
      if (!this._matches(m, e)) continue;
      e.preventDefault();
      // Audit #46 P1#16 — hotkey-fired macros used sync `run()` which
      // ignored `stepDelayMs` per-step pacing. Route through `runAsync`
      // so per-step delays + wait-for-target / wait-for-cast-complete
      // gates also fire on key triggers.
      const stepDelayMs = (m.stepDelayMs | 0) || 0;
      this.runAsync(m.actions, { stepDelayMs }).catch((err) => {
        console.error('[macro] hotkey-run threw', err);
      });
      return;
    }
  };

  /** Execute a list of actions in order. */
  run(actions) {
    for (const a of actions) {
      const fn = this._runners.get(a.kind);
      if (fn) {
        try { fn(a.arg); }
        catch (err) { console.error(`[macro] ${a.kind} threw`, err); }
      }
    }
  }

  _registerDefaultRunners() {
    // ---- Speech (4 modes; CUO hue/font conventions) ---------------------
    this.registerRunner('say',     (t) => t && net.send(buildUnicodeSpeech(t)));
    this.registerRunner('emote',   (t) => t && net.send(buildUnicodeSpeech(t, { type: 0x02, hue: 0x21 })));
    this.registerRunner('whisper', (t) => t && net.send(buildUnicodeSpeech(t, { type: 0x08, hue: 0x33 })));
    this.registerRunner('yell',    (t) => t && net.send(buildUnicodeSpeech(t, { type: 0x04, hue: 0x55 })));
    // ---- Combat ---------------------------------------------------------
    this.registerRunner('attack-last',     () => {
      if (this._lastAttack) net.send(buildAttackReq(this._lastAttack));
    });
    this.registerRunner('attack-selected', () => {
      // Audit #40 client P1 #3 — `lastSerial` was never written by
      // TargetManager (defined fields: `lastTarget` + `lastAttack`).
      // The `??` always fell through to `_lastAttack` → "attack
      // selected" did the same thing as "attack last".
      const s = targetManager.lastTarget?.serial ?? this._lastAttack;
      if (s) net.send(buildAttackReq(s));
    });
    this.registerRunner('clear-target',    () => net.send(buildClearAttack()));
    this.registerRunner('toggle-war',      () => {
      const live = !!world.player?.warMode;
      const next = !live;
      this._warMode = next;
      pinSelfWarLatch(next);
      if (world.player) {
        const bit = 0x40;
        const cur = (world.player.flags | 0);
        world.player.flags = next ? (cur | bit) : (cur & ~bit);
        world.player.warMode = next;
        bus.emit('player:warmode', { warMode: next });
      }
      net.send(buildWarMode(next));
    });
    this.registerRunner('primary-ability',   () => net.send(buildTextCommand(0x70, 'PrimaryAbility')));
    this.registerRunner('secondary-ability', () => net.send(buildTextCommand(0x70, 'SecondaryAbility')));
    this.registerRunner('arm-disarm',        () => bus.emit('macro:arm-disarm'));
    this.registerRunner('equip-last',        () => bus.emit('macro:equip-last'));
    // ---- Spells ---------------------------------------------------------
    // ServUO accepts `cast <SpellName>` via 0x12 TextCommand type 0x56.
    // CUO sends the spell ID directly (0x12 type 0x56 + ascii spell-id);
    // both decode the same way in PacketHandlers.
    this.registerRunner('cast', (spellName) => {
      if (!spellName) return;
      net.send(buildTextCommand(0x56, String(spellName)));
      this._lastSpell = String(spellName);
      bus.emit('macro:cast-fired', { spellName: String(spellName) });
    });
    this.registerRunner('cast-last', () => {
      if (this._lastSpell) net.send(buildTextCommand(0x56, this._lastSpell));
    });
    this.registerRunner('open-spellbook', () => sendOpenSpellbook('spellbook'));
    // ---- Skills ---------------------------------------------------------
    // Skill name (e.g. "Hiding", "Stealth") -> CUO `0x12/0x24 "<id> 0"`.
    this.registerRunner('use-skill', (name) => {
      if (!name) return;
      const id = sendUseSkill(name);
      if (id) this._lastSkill = id;
      else {
        net.send(buildTextCommand(0x24, String(name)));
        this._lastSkill = String(name);
      }
    });
    this.registerRunner('last-skill', () => {
      if (!this._lastSkill) return;
      if (!sendUseSkill(this._lastSkill)) net.send(buildTextCommand(0x24, this._lastSkill));
    });
    this.registerRunner('meditation', () => { this._lastSkill = sendUseSkill('Meditation'); });
    this.registerRunner('hiding',     () => { this._lastSkill = sendUseSkill('Hiding'); });
    this.registerRunner('stealth',    () => { this._lastSkill = sendUseSkill('Stealth'); });
    this.registerRunner('peacemaking',() => { this._lastSkill = sendUseSkill('Peacemaking'); });
    // ---- Targeting ------------------------------------------------------
    this.registerRunner('target-self',    () => world.player && targetManager.pickSelf(world.player.serial));
    this.registerRunner('target-last',    () => targetManager.pickLast());
    this.registerRunner('target-next', () => {
      targetManager.setFriendFilter?.(null);
      targetManager.cycleRing?.('next');
      bus.emit('macro:target-next');
    });
    this.registerRunner('beneficial-target',
      () => { this.beneficialNext = !this.beneficialNext; });
    // ---- Items ----------------------------------------------------------
    // BandageSelf — find a bandage in our backpack and use it on self.
    // Server side: handleUseReq → bandages dispatch onUse hook.
    this.registerRunner('bandage-self', () => {
      const bandage = this._findInPack(0x0E21);
      if (!bandage) return;
      net.send(buildUseReq(bandage.serial));
      // Audit #40 client P3 #11 — wait for the actual target prompt
      // instead of guessing 250ms. CUO callback flow auto-fulfils
      // the next target cursor with self-pick. Poll up to 2s; if the
      // server's 0x6C arrives faster the self-pick fires immediately,
      // if it never arrives the poll just times out (no stale callback).
      const start = performance.now();
      const tick = () => {
        if (targetManager.active && world.player) {
          targetManager.pickSelf(world.player.serial);
          return;
        }
        if (performance.now() - start < 2000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    this.registerRunner('use-potion', (idHex) => {
      const id = parseInt(String(idHex), 16) | 0;
      if (!id) return;
      const p = this._findInPack(id);
      if (p) net.send(buildUseReq(p.serial));
    });
    this.registerRunner('use-object', (serialHex) => {
      const s = parseInt(String(serialHex), 16) >>> 0;
      if (s) net.send(buildUseReq(s));
    });
    this.registerRunner('use-item', (serialHex) => {
      const s = parseInt(String(serialHex), 16) >>> 0;
      if (s) net.send(buildUseReq(s));
    });
    this.registerRunner('last-object', () => {
      const s = targetManager.lastObjectSerial?.() >>> 0;
      if (s) net.send(buildUseReq(s));
    });
    // ---- Gumps ----------------------------------------------------------
    for (const kind of ['paperdoll','journal','skills','status','options',
                        'minimap','party','worldmap','spellbook','help']) {
      this.registerRunner(`open-${kind}`, () => openGumpOrSpellbook(kind));
    }
    this.registerRunner('open-backpack', () => bus.emit('macro:open-backpack'));
    this.registerRunner('open-healthbar', (serialHex) => {
      const s = serialHex ? (parseInt(String(serialHex), 16) >>> 0)
                          : (world.player?.serial ?? 0);
      bus.emit('macro:open-healthbar', { serial: s });
    });
    this.registerRunner('close-all-gumps', () => bus.emit('macro:close-all-gumps'));
    // ---- Movement -------------------------------------------------------
    // Synthetic walk macro: caller picks a UO direction byte (0..7).
    this.registerRunner('walk', (dirStr) => {
      const dir = (parseInt(String(dirStr), 10) | 0) & 0x07;
      bus.emit('macro:walk', { direction: dir, run: this.alwaysRun });
    });
    this.registerRunner('toggle-always-run',
      () => { this.alwaysRun = !this.alwaysRun; });
    // ---- Game state -----------------------------------------------------
    this.registerRunner('quit',      () => net.send(buildLogoutRequest()));
    this.registerRunner('salute',    () => net.send(buildUnicodeSpeech('*salutes*', { type: 0x02 })));
    this.registerRunner('bow',       () => net.send(buildUnicodeSpeech('*bows*',     { type: 0x02 })));
    this.registerRunner('delay',     (ms) => {
      // No-op for synchronous run; handled in runAsync below.
      void ms;
    });

    // ===================================================================
    //  Extended action set — mirrors the second half of CUO `MacroType`
    //  enum (MacroManager.cs). Each entry covers one action a Razor /
    //  UOSteam profile typically uses but our 32-entry MVP didn't have.
    // ===================================================================

    // ---- Targeting helpers (cycle / clear / queue) -----------------
    this.registerRunner('target-next-friend', () => {
      targetManager.setFriendFilter?.((m) => {
        // Innocent / ally noto bits — CUO TargetType.Beneficial.
        const n = m.notoriety ?? 1;
        return n === 1 || n === 2;
      });
      targetManager.cycleRing?.('next');
      bus.emit('macro:target-next', { kind: 'friend' });
    });
    this.registerRunner('target-next-enemy', () => {
      targetManager.setFriendFilter?.((m) => {
        // Criminal / enemy / murderer noto bits — CUO TargetType.Harmful.
        const n = m.notoriety ?? 0;
        return n === 4 || n === 5 || n === 6;
      });
      targetManager.cycleRing?.('next');
      bus.emit('macro:target-next', { kind: 'enemy' });
    });
    this.registerRunner('target-prev', () => {
      targetManager.cycleRing?.('prev');
      bus.emit('macro:target-prev');
    });
    this.registerRunner('target-mount',         () => bus.emit('macro:target-mount'));
    this.registerRunner('target-pet',           () => bus.emit('macro:target-pet'));
    this.registerRunner('target-cancel',        () => targetManager.cancel?.());
    this.registerRunner('target-queue',         () => bus.emit('macro:target-queue'));
    this.registerRunner('cycle-hostile',        () => bus.emit('macro:cycle', { kind: 'hostile' }));
    this.registerRunner('cycle-beneficial',     () => bus.emit('macro:cycle', { kind: 'beneficial' }));
    this.registerRunner('cycle-object',         () => bus.emit('macro:cycle', { kind: 'object' }));

    // ---- Names / overheads ----------------------------------------
    this.registerRunner('all-names',           () => bus.emit('macro:all-names'));
    this.registerRunner('toggle-name-overhead',() => bus.emit('macro:toggle-name-overhead'));
    this.registerRunner('toggle-show-stats',   () => bus.emit('macro:toggle-show-stats'));

    // ---- Mounting / pet -------------------------------------------
    // NodeUO exposes mount toggling as a normal speech command while classic
    // emulator compatibility remains untouched.  The old placeholder sent an
    // Animal Lore skill request, so the macro could mount neither way and,
    // most visibly, could never dismount an already mounted player.
    this.registerRunner('mount-dismount',      () => net.send(buildUnicodeSpeech('[mount')));
    this.registerRunner('toggle-fly', () => {
      // CUO `MacroType.ToggleGargoyleFly` — flip the local prediction
      // (server still confirms via 0xBF subop 0x32), then emit the
      // outgoing toggle request. Renderer reads mob.isFlying for the
      // SA group remap; without the optimistic flip there's a ~120ms
      // anim hitch waiting for the round-trip.
      if (world.player) {
        world.player.isFlying = !world.player.isFlying;
        bus.emit('mobile:update', world.player);
      }
      bus.emit('macro:toggle-fly');
    });
    this.registerRunner('rename-pet',          () => bus.emit('macro:rename-pet'));
    this.registerRunner('release-pet',         () => bus.emit('macro:release-pet'));
    this.registerRunner('all-stay',            () => net.send(buildUnicodeSpeech('all stay')));
    this.registerRunner('all-follow',          () => net.send(buildUnicodeSpeech('all follow')));
    this.registerRunner('all-guard',           () => net.send(buildUnicodeSpeech('all guard')));
    this.registerRunner('all-kill',            () => net.send(buildUnicodeSpeech('all kill')));
    this.registerRunner('all-come',            () => net.send(buildUnicodeSpeech('all come')));
    this.registerRunner('all-stop',            () => net.send(buildUnicodeSpeech('all stop')));

    // ---- Containers / loot ----------------------------------------
    this.registerRunner('loot-corpse',         () => bus.emit('macro:loot-corpse'));
    this.registerRunner('grab-everything',     () => bus.emit('macro:grab-everything'));
    this.registerRunner('open-loot-bag',       () => bus.emit('macro:open-loot-bag'));
    this.registerRunner('bind-loot-bag',       () => bus.emit('macro:bind-loot-bag'));

    // ---- Spell / skill memory --------------------------------------
    this.registerRunner('cast-last-on-self',   () => {
      if (this._lastSpell && world.player) {
        net.send(buildTextCommand(0x56, this._lastSpell));
        targetManager.pickSelf(world.player.serial);
      }
    });
    this.registerRunner('cast-last-on-last',   () => {
      if (this._lastSpell) {
        net.send(buildTextCommand(0x56, this._lastSpell));
        targetManager.pickLast?.();
      }
    });
    this.registerRunner('use-last-skill-on-last', () => {
      if (this._lastSkill) {
        if (!sendUseSkill(this._lastSkill)) net.send(buildTextCommand(0x24, this._lastSkill));
        targetManager.pickLast?.();
      }
    });

    // ---- UI gump shortcuts -----------------------------------------
    for (const kind of [
      'options', 'profile', 'racial-abilities', 'mage-spellbook',
      'necro-spellbook', 'paladin-spellbook', 'bushido-spellbook',
      'ninja-spellbook', 'spellweaving-spellbook', 'mysticism-spellbook',
      'mastery-spellbook', 'help', 'macros', 'partymanifest',
      'guild', 'minimap', 'worldmap', 'top-bar', 'buff-bar',
      'info-bar', 'inventory', 'corpse-grid',
    ]) {
      this.registerRunner(`open-${kind}`, () => openGumpOrSpellbook(kind));
    }

    // ---- Inventory + equipment swap --------------------------------
    this.registerRunner('toggle-hands',        () => bus.emit('macro:toggle-hands'));
    this.registerRunner('drink-cure',          () => {
      const it = this._findInPack(0x0F07); // cure potion
      if (it) net.send(buildUseReq(it.serial));
    });
    this.registerRunner('drink-heal',          () => {
      const it = this._findInPack(0x0F0C); // greater heal potion
      if (it) net.send(buildUseReq(it.serial));
    });
    this.registerRunner('drink-refresh',       () => {
      const it = this._findInPack(0x0F0B); // refresh potion
      if (it) net.send(buildUseReq(it.serial));
    });
    this.registerRunner('drink-explosion',     () => {
      const it = this._findInPack(0x0F0D); // explosion potion
      if (it) net.send(buildUseReq(it.serial));
    });

    // ---- Speech variants ------------------------------------------
    this.registerRunner('say-party',  (t) => t && net.send(buildUnicodeSpeech(`/${t}`)));
    this.registerRunner('say-guild',  (t) => t && net.send(buildUnicodeSpeech(`\\${t}`)));
    this.registerRunner('say-alliance',(t)=> t && net.send(buildUnicodeSpeech(`|${t}`)));
    this.registerRunner('say-emote-yell',(t) => t && net.send(buildUnicodeSpeech(t, { type: 0x06, hue: 0x55 })));

    // ---- Movement keys (for keyboard re-binding) -------------------
    for (const dir of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
      this.registerRunner(`walk-${dir}`, () => bus.emit('macro:walk', { dir }));
      this.registerRunner(`run-${dir}`,  () => bus.emit('macro:walk', { dir, run: true }));
    }

    // ===================================================================
    //  Tier-3 macro extension — covers the remaining major MacroType
    //  enum entries (CUO MacroManager.cs). Most of these dispatch to
    //  bus events that other managers/gumps listen for; the few that
    //  hit the wire build a known packet inline.
    // ===================================================================

    // ---- Skill specific direct invocations ------------------------
    for (const skill of [
      'AnimalTaming', 'AnimalLore', 'AnatomyMercy', 'ArmsLore',
      'Begging', 'Camping', 'Cartography', 'DetectHidden',
      'EvalInt', 'Forensic', 'Herding', 'Inscribe',
      'ItemID', 'Lockpicking', 'Magery', 'MagicResist',
      'Musicianship', 'Necromancy', 'Parry', 'Poisoning',
      'Provocation', 'RemoveTrap', 'Snooping', 'SpiritSpeak',
      'Tactics', 'TasteID', 'Tracking', 'Veterinary',
      'Discordance', 'Peacemaking', 'Bushido', 'Chivalry',
      'Ninjitsu', 'SpellWeaving', 'Mysticism', 'Imbuing',
      'Throwing', 'Focus',
    ]) {
      const lc = skill.replace(/([A-Z])/g, '-$1').slice(1).toLowerCase();
      const id = skillIdFromName(skill);
      this.registerRunner(`skill-${lc}`, () => {
        if (id) {
          net.send(buildUseSkill(id));
          this._lastSkill = id;
        } else {
          net.send(buildTextCommand(0x24, skill));
          this._lastSkill = skill;
        }
      });
    }

    // ---- Cast specific spell by school + name ----------------------
    for (const spellSchool of ['magery', 'necromancy', 'chivalry', 'bushido', 'ninjitsu', 'spellweaving', 'mysticism', 'mastery']) {
      this.registerRunner(`cast-${spellSchool}`, (spellName) => {
        if (!spellName) return;
        net.send(buildTextCommand(0x56, spellName));
        this._lastSpell = spellName;
      });
    }

    // ---- Special-move quick toggles --------------------------------
    for (const move of ['ArmorIgnore', 'BleedAttack', 'ConcussionBlow',
        'CrushingBlow', 'Disarm', 'DismountAttack', 'DoubleStrike',
        'InfectiousStrike', 'MortalStrike', 'MovingShot', 'ParalyzingBlow',
        'ShadowStrike', 'WhirlwindAttack', 'RidingSwipe', 'FrenziedWhirlwind',
        'Block', 'DefenseMastery', 'NerveStrike', 'TalonStrike',
        'Feint', 'DualWield', 'DoubleShot', 'ArmorPierce',
        'PsychicAttack', 'ForceArrow', 'LightningArrow', 'ForceOfNature',
        'StaggerStrike', 'ToughnessStrike']) {
      const lc = move.replace(/([A-Z])/g, '-$1').slice(1).toLowerCase();
      this.registerRunner(`move-${lc}`, () => net.send(buildTextCommand(0x70, move)));
    }

    // ---- Open journal / chat sub-modes -----------------------------
    this.registerRunner('open-journal-tab',  (tab) => bus.emit('macro:journal-tab', { tab }));
    this.registerRunner('chat-mode',         () => bus.emit('macro:chat-mode'));
    this.registerRunner('emote-mode',        () => bus.emit('macro:emote-mode'));
    this.registerRunner('whisper-mode',      () => bus.emit('macro:whisper-mode'));
    this.registerRunner('yell-mode',         () => bus.emit('macro:yell-mode'));
    this.registerRunner('party-mode',        () => bus.emit('macro:party-mode'));
    this.registerRunner('guild-mode',        () => bus.emit('macro:guild-mode'));
    this.registerRunner('alliance-mode',     () => bus.emit('macro:alliance-mode'));

    // ---- Useful target macros --------------------------------------
    this.registerRunner('target-self-bandage', () => {
      const it = this._findInPack(0x0E21);
      if (it && world.player) {
        net.send(buildUseReq(it.serial));
        targetManager.pickSelf(world.player.serial);
      }
    });
    this.registerRunner('target-cancel-prompt', () => targetManager.cancel?.());

    // ---- Bandage on last target ------------------------------------
    this.registerRunner('bandage-last', () => {
      const it = this._findInPack(0x0E21);
      if (it) {
        net.send(buildUseReq(it.serial));
        targetManager.pickLast?.();
      }
    });

    // ---- Quick-select gump types -----------------------------------
    for (const kind of [
      'virtues', 'masteries', 'magery-spellbook', 'necromancy-spellbook',
      'chivalry-spellbook', 'bushido-spellbook', 'ninjitsu-spellbook',
      'spellweaving-spellbook', 'mysticism-spellbook', 'bard-mastery-spellbook',
      'pet-bar', 'crafting-window', 'animal-lore', 'animal-stats',
    ]) {
      this.registerRunner(`open-${kind}`, () => openGumpOrSpellbook(kind));
    }

    // ---- Quick-equip aliases --------------------------------------
    this.registerRunner('equip-helm',         () => bus.emit('macro:equip-by-layer', { layer: 6 }));
    this.registerRunner('equip-shield',       () => bus.emit('macro:equip-by-layer', { layer: 11 }));
    this.registerRunner('equip-cloak',        () => bus.emit('macro:equip-by-layer', { layer: 20 }));
    this.registerRunner('equip-ring',         () => bus.emit('macro:equip-by-layer', { layer: 14 }));
    this.registerRunner('equip-bracelet',     () => bus.emit('macro:equip-by-layer', { layer: 14 }));
    this.registerRunner('equip-talisman',     () => bus.emit('macro:equip-by-layer', { layer: 22 }));

    // ---- Looting helpers ------------------------------------------
    this.registerRunner('loot-gold',          () => bus.emit('macro:loot-gold'));
    this.registerRunner('loot-rare',          () => bus.emit('macro:loot-rare'));
    this.registerRunner('skip-corpse',        () => bus.emit('macro:skip-corpse'));

    // ---- Toggles ---------------------------------------------------
    this.registerRunner('toggle-attack-cooldown', () => bus.emit('macro:toggle-attack-cooldown'));
    this.registerRunner('toggle-overhead-stats',  () => bus.emit('macro:toggle-overhead-stats'));
    this.registerRunner('toggle-overhead-text',   () => bus.emit('macro:toggle-overhead-text'));
    this.registerRunner('toggle-name-tags',       () => bus.emit('macro:toggle-name-tags'));

    // ===================================================================
    //  Tier-4 macro extension — final ~15 actions covering CUO MacroType
    //  enum entries we hadn't reached yet (mostly UI shortcuts +
    //  Razor-style helpers).
    // ===================================================================
    this.registerRunner('toggle-pause',           () => bus.emit('macro:toggle-pause'));
    this.registerRunner('toggle-grid-loot',       () => bus.emit('macro:toggle-grid-loot'));
    this.registerRunner('open-active-icons',      () => bus.emit('macro:gump', { kind: 'active-icons' }));
    this.registerRunner('open-network-stats',     () => bus.emit('macro:gump', { kind: 'network-stats' }));
    this.registerRunner('open-debug',             () => bus.emit('macro:gump', { kind: 'debug' }));
    this.registerRunner('open-tips',              () => bus.emit('macro:gump', { kind: 'tips' }));
    this.registerRunner('open-character-creation',() => bus.emit('macro:gump', { kind: 'character-creation' }));
    this.registerRunner('open-anchor-manager',    () => bus.emit('macro:gump', { kind: 'anchor' }));
    this.registerRunner('open-name-overhead-handler', () => bus.emit('macro:gump', { kind: 'name-overhead-handler' }));
    this.registerRunner('open-tooltip-options',   () => bus.emit('macro:gump', { kind: 'tooltip-options' }));
    this.registerRunner('toggle-grass',           () => bus.emit('macro:toggle-grass'));
    this.registerRunner('toggle-trees-stumps',    () => bus.emit('macro:toggle-trees-stumps'));
    this.registerRunner('toggle-vegetation',      () => bus.emit('macro:toggle-vegetation'));
    this.registerRunner('toggle-cave-tiles',      () => bus.emit('macro:toggle-cave-tiles'));
    this.registerRunner('enable-range-color',     () => bus.emit('macro:range-color', { enabled: true }));
    this.registerRunner('disable-range-color',    () => bus.emit('macro:range-color', { enabled: false }));
    this.registerRunner('toggle-range-color',     () => bus.emit('macro:range-color', { toggle: true }));
    this.registerRunner('zoom-in',                () => bus.emit('macro:zoom', { delta: +1 }));
    this.registerRunner('zoom-out',               () => bus.emit('macro:zoom', { delta: -1 }));
    this.registerRunner('zoom-reset',             () => bus.emit('macro:zoom', { reset: true }));

    // ---- Pet quick commands (CUO `Razor pets`) -------------------
    this.registerRunner('pet-rename',  (newName) => bus.emit('macro:pet-rename', { name: newName }));
    this.registerRunner('pet-release', () => net.send(buildUnicodeSpeech('all release')));
    this.registerRunner('pet-transfer',() => net.send(buildUnicodeSpeech('all transfer')));

    // ===================================================================
    //  Final macro tier — last quirks from CUO MacroType. Some are
    //  Razor-style helpers that route to specific text commands or
    //  bus events.
    // ===================================================================
    // SmartItem — toggle "use last item" flow per CUO.
    this.registerRunner('smart-item',           () => bus.emit('macro:smart-item'));
    this.registerRunner('smart-bandage',        () => bus.emit('macro:smart-bandage'));
    this.registerRunner('always-run-mover',     () => { this.alwaysRun = !this.alwaysRun; });
    this.registerRunner('open-chat-channel',    (name) => bus.emit('macro:chat-channel', { name }));
    this.registerRunner('leave-chat-channel',   () => bus.emit('macro:chat-channel', { name: null }));
    this.registerRunner('toggle-look-at',       () => bus.emit('macro:toggle-look-at'));
    this.registerRunner('toggle-trade-window',  () => bus.emit('macro:toggle-trade-window'));
    this.registerRunner('toggle-action-bar',    () => bus.emit('macro:toggle-action-bar'));
    this.registerRunner('print-screen',         () => bus.emit('macro:print-screen'));
    this.registerRunner('save-keys',            () => this._save());
    this.registerRunner('export-macros',        () => bus.emit('macro:export'));
    this.registerRunner('import-macros',        () => bus.emit('macro:import'));
    this.registerRunner('take-screenshot',      () => bus.emit('macro:print-screen'));

    // CUO `OpenAbilityTab` — opens the racial-ability tab on the spellbook.
    this.registerRunner('open-racial-tab',      () => bus.emit('macro:gump', { kind: 'racial-abilities' }));

    // Razor "smart-target" auto-cycle for chained spells.
    this.registerRunner('smart-target-friend',  () => bus.emit('macro:smart-target', { kind: 'friend' }));
    this.registerRunner('smart-target-enemy',   () => bus.emit('macro:smart-target', { kind: 'enemy' }));

    // ---- Audit #44 macro extensions (CUO MacroType gaps) ---------------
    // Pathfind to a tile. Arg = "x,y" or last RMB-clicked tile via bus.
    // Mirrors CUO `Macro.MacroType.PathFind` which calls the same A* on
    // (LastObject) or the parameter tuple.
    this.registerRunner('pathfind', (xyArg) => {
      if (xyArg && typeof xyArg === 'string' && xyArg.includes(',')) {
        const [xs, ys] = xyArg.split(',').map((s) => parseInt(s.trim(), 10) | 0);
        if (Number.isFinite(xs) && Number.isFinite(ys)) {
          bus.emit('pathfind:server-request', { x: xs, y: ys, z: 0 });
          return;
        }
      }
      bus.emit('macro:pathfind');   // fall back to last clicked tile
    });
    // Resync — CUO `Macro.MacroType.Resynchronize` sends the standard
    // "Resync" text command (server replies with a full state push).
    this.registerRunner('resync', () => net.send(buildTextCommand(0x12, 'Resync')));
    // OpenDoor — CUO `Macro.MacroType.OpenDoor` → `0x12 0x58 OpenDoor`.
    this.registerRunner('open-door', () => net.send(buildTextCommand(0x58, '')));
    // Standalone `help` alias (in addition to the open-help gump runner
    // registered above). Razor scripts often spell it just `help`.
    this.registerRunner('help', () => bus.emit('macro:gump', { kind: 'help' }));
    // Audit P3 #21 — alt-mode gumps (advanced skills with search/sort,
    // corpse with filter buttons, text-list container view).
    this.registerRunner('open-skills-advanced',
      () => bus.emit('macro:gump', { kind: 'skills-advanced' }));
    this.registerRunner('open-corpse-filter',
      () => bus.emit('macro:gump', { kind: 'corpse-filter' }));
    this.registerRunner('open-text-container',
      () => bus.emit('macro:gump', { kind: 'text-container' }));
  }

  /** Return the first item in our player's backpack matching `itemId`,
   *  or null. Used by `bandage-self`, `use-potion`, etc. */
  _findInPack(itemId) {
    if (!world.player) return null;
    const pack = world.player.equipment?.get?.(21);
    if (!pack) return null;
    const packSerial = pack.serial >>> 0;
    // Bug-hunt #6 client C#16: was linear walk over `world.items` per
    // macro invocation (bandage-self / potion / etc. fire 1-3 ×/s).
    // Reverse parent index already exists — use it.
    const wanted = itemId | 0;
    if (world.forEachDescendant) {
      let found = null;
      world.forEachDescendant(packSerial, (it) => {
        if (it.itemId !== wanted) return undefined;
        found = it;
        return false;
      });
      return found;
    }
    if (world.descendantsOf) {
      for (const it of world.descendantsOf(packSerial)) {
        if (it.itemId === wanted) return it;
      }
      return null;
    }
    if (world.childrenOf) {
      for (const it of world.childrenOf(packSerial)) {
        if (it.itemId === wanted) return it;
      }
      return null;
    }
    for (const it of world.items.values()) {
      if (it.parent === packSerial && it.itemId === wanted) return it;
    }
    return null;
  }

  /** Async-aware runner — supports control flow (delay/wait-for-target/
   *  if/else/endif/loop/endloop/break) plus the basic `kind/arg` actions.
   *  Mirrors Razor / UOSteam macro syntax at MVP scope.
   *
   *  Control kinds (parsed sequentially):
   *    delay <ms>                  pause chain
   *    wait-for-target <ms>        block until a target prompt activates
   *                                (or timeout)
   *    if <expr>                   skip to matching `else`/`endif` if expr
   *                                evaluates falsy
   *    else                        flip current `if` branch state
   *    endif                       end an `if` block
   *    loop <count>                repeat block N times (default 1)
   *    endloop                     end a `loop` block
   *    break                       exit the innermost loop
   *
   *  Expressions in `if`:
   *    hp<50  hp>0  hp<=70%       compares player HP (% if suffix '%')
   *    mp<20  stam<30
   *    poisoned  hidden  warmode
   *    target-active              true while waiting for target prompt
   *
   *  Vars in args (substituted at runtime via `_subst`):
   *    {last-target}              last target serial (hex)
   *    {last-object}              last UseReq serial (hex)
   *    {self}                     player serial (hex)
   */
  async runAsync(actions, opts = {}) {
    // Audit rev.4 P3 — per-macro step delay. CUO `MacroObject.Delay`
    // pauses between each action; we accept a `stepDelayMs` option
    // (callers pass `m.stepDelayMs` when invoking from a hotkey or
    // trigger). Sleep ONLY between non-flow actions (skip after
    // if/else/endif/loop/endloop to keep the visual flow tight).
    const stepDelay = opts.stepDelayMs | 0;
    // Pre-pass: build a flow plan that maps if/else/endif and loop/endloop.
    const flow = this._buildFlow(actions);
    let i = 0;
    let breakLoop = false;
    const stack = []; // loop frames: { startIdx, endIdx, remaining }
    const ifStack = []; // if frames: { skipUntilElse, skipAll }
    while (i < actions.length) {
      const a = actions[i];
      if (a.kind === 'if') {
        const ok = this._evalExpr(a.arg);
        ifStack.push({ active: ok, hadElse: false });
        if (!ok) {
          // skip until matching else/endif
          i = flow.ifNext[i] ?? actions.length;
          continue;
        }
        i++; continue;
      }
      if (a.kind === 'else') {
        const top = ifStack[ifStack.length - 1];
        if (!top) { i++; continue; }
        if (top.active) {
          // we entered the THEN branch — skip the else body
          i = flow.endif[i] ?? actions.length;
          continue;
        }
        top.hadElse = true; top.active = true;
        i++; continue;
      }
      if (a.kind === 'endif') {
        ifStack.pop();
        i++; continue;
      }
      if (a.kind === 'loop') {
        const count = Math.max(1, parseInt(a.arg ?? '1', 10) | 0);
        const endIdx = flow.loopEnd[i] ?? actions.length;
        stack.push({ startIdx: i, endIdx, remaining: count });
        i++; continue;
      }
      if (a.kind === 'endloop') {
        const top = stack[stack.length - 1];
        if (!top) { i++; continue; }
        top.remaining -= 1;
        if (breakLoop || top.remaining <= 0) {
          stack.pop();
          breakLoop = false;
          i = top.endIdx + 1;
          continue;
        }
        i = top.startIdx + 1;
        continue;
      }
      if (a.kind === 'break') { breakLoop = true; i = (stack[stack.length - 1]?.endIdx ?? actions.length); continue; }
      if (a.kind === 'delay') {
        const ms = Math.max(0, parseInt(a.arg ?? '250', 10) | 0);
        await new Promise((r) => setTimeout(r, ms));
        i++; continue;
      }
      if (a.kind === 'wait-for-target') {
        const ms = Math.max(0, parseInt(a.arg ?? '5000', 10) | 0);
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (targetManager.isActive?.()) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        i++; continue;
      }
      // wait-for-cast-complete <ms> — blocks until `spell:cast-complete`
      // fires on the event bus or the timeout elapses. Mirrors CUO's
      // `Macro.WaitForCast` which gates the next action on the FlagsType
      // `Casting` flag clearing on the player.
      if (a.kind === 'wait-for-cast-complete') {
        const ms = Math.max(0, parseInt(a.arg ?? '5000', 10) | 0);
        let done = false;
        const off = bus.on('spell:cast-complete', () => { done = true; });
        try {
          const deadline = Date.now() + ms;
          while (!done && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
          }
        } finally { off?.(); }
        i++; continue;
      }
      // wait-for-animation <ms> — blocks until the player mobile's
      // current action animation ends (the renderer clears `animAction`
      // when the loop completes) or the timeout fires. Useful before
      // chaining a second special-move on top of the first.
      if (a.kind === 'wait-for-animation') {
        const ms = Math.max(0, parseInt(a.arg ?? '2000', 10) | 0);
        const deadline = Date.now() + ms;
        const startAction = world.player?.animAction;
        while (Date.now() < deadline) {
          const cur = world.player?.animAction;
          if (cur == null || cur !== startAction) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        i++; continue;
      }
      const fn = this._runners.get(a.kind);
      if (fn) {
        try { fn(this._subst(a.arg)); }
        catch (err) { console.error(`[macro] ${a.kind} threw`, err); }
      }
      if (stepDelay > 0) await new Promise((r) => setTimeout(r, stepDelay));
      i++;
    }
  }

  /** Build a flow-control map from a sequential action list — for each
   *  `if` / `loop` index, store the matching closer so the runner can
   *  jump in O(1). Mismatched markers default to end-of-list. */
  _buildFlow(actions) {
    const out = { ifNext: {}, endif: {}, loopEnd: {} };
    const ifStack = [];   // [{ ifIdx, elseIdx? }]
    const loopStack = []; // [loopIdx]
    for (let i = 0; i < actions.length; i++) {
      const k = actions[i].kind;
      if (k === 'if')        ifStack.push({ ifIdx: i });
      else if (k === 'else') {
        const top = ifStack[ifStack.length - 1];
        if (top) {
          out.ifNext[top.ifIdx] = i + 1;     // if-false → skip past else
          top.elseIdx = i;
        }
      }
      else if (k === 'endif') {
        const top = ifStack.pop();
        if (top) {
          if (top.elseIdx == null) out.ifNext[top.ifIdx] = i + 1;
          else                     out.endif[top.elseIdx] = i;
        }
      }
      else if (k === 'loop')    loopStack.push(i);
      else if (k === 'endloop') {
        const start = loopStack.pop();
        if (start != null) out.loopEnd[start] = i;
      }
    }
    return out;
  }

  /** Substitute {var} placeholders in a macro arg. Returns the original
   *  arg unchanged when no braces present. */
  _subst(arg) {
    if (typeof arg !== 'string' || arg.indexOf('{') < 0) return arg;
    return arg.replace(/\{([a-z-]+)\}/gi, (_, name) => {
      switch (name.toLowerCase()) {
        case 'self':         return world.player ? world.player.serial.toString(16) : '0';
        case 'last-target':  return targetManager.lastTargetSerial?.()?.toString(16) ?? '0';
        case 'last-attack':  return (this._lastAttack >>> 0).toString(16);
        case 'last-object':  return targetManager.lastObjectSerial?.()?.toString(16) ?? '0';
        case 'last-spell':   return this._lastSpell ?? '';
        case 'last-skill':   return this._lastSkill ?? '';
        default:             return '';
      }
    });
  }

  /** Evaluate a boolean condition string for `if`. Lightweight grammar
   *  — keep it intentionally narrow so a typo can't run wild logic. */
  _evalExpr(raw) {
    const expr = String(raw ?? '').trim().toLowerCase();
    if (!expr) return false;
    const p = world.player;
    if (!p) return false;
    // Simple identifiers.
    if (expr === 'poisoned')      return !!p.poisoned;
    if (expr === 'hidden')        return !!p.hidden;
    if (expr === 'warmode')       return !!p.warMode;
    if (expr === 'target-active') return !!targetManager.isActive?.();
    // Stat comparisons: <stat><op><number>[%]
    // Client audit #7 #11 — longer alternatives FIRST so `stamina<50`
    // doesn't match `stam` and fail with leftover `ina<50`. JS regex
    // alternation is left-to-right and doesn't backtrack on stuck
    // alternative.
    const m = expr.match(/^(stamina|stam|hp|mp|st)\s*(<=|>=|<|>|==|!=)\s*(\d+)\s*(%?)$/);
    if (m) {
      const [, statName, op, numStr, pct] = m;
      const cur = statName === 'hp' ? (p.hp ?? 0)
                : statName === 'mp' ? (p.mp ?? p.mana ?? 0)
                                    : (p.st ?? p.stam ?? 0);
      const max = statName === 'hp' ? (p.hpMax ?? 1)
                : statName === 'mp' ? (p.mpMax ?? p.manaMax ?? 1)
                                    : (p.stMax ?? p.stamMax ?? 1);
      const lhs = pct === '%' ? (max > 0 ? (cur / max) * 100 : 0) : cur;
      const rhs = parseFloat(numStr);
      switch (op) {
        case '<':  return lhs <  rhs;
        case '<=': return lhs <= rhs;
        case '>':  return lhs >  rhs;
        case '>=': return lhs >= rhs;
        case '==': return lhs === rhs;
        case '!=': return lhs !== rhs;
      }
    }
    return false;
  }

  _load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) {
        // Seed with one or two sane defaults so a fresh user has something
        // to play with — they can edit / delete from the OptionsGump later.
        this.macros = [
          { key: 'F1', actions: [{ kind: 'open-paperdoll' }] },
          { key: 'F2', actions: [{ kind: 'open-journal' }] },
          { key: 'F3', actions: [{ kind: 'open-skills' }] },
          { key: 'F4', actions: [{ kind: 'open-status' }] },
        ];
        this._save();
        return;
      }
      this.macros = JSON.parse(raw).map((m) => normalizeMacroHotkey(m));
    } catch (e) { console.warn('[macros] load failed', e); }
    // Audit rev.4 P1 #2 — auto-attach reactive triggers persisted on
    // each macro. Without this every reload would forget the user's
    // "auto-heal when HP < 50%" rule.
    try { this.attachTriggers(); } catch { /* noop */ }
  }
  _save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.macros)); }
    catch (e) { console.warn('[macros] save failed', e); }
  }

  // -------------------------------------------------------------------
  //  Import / Export — JSON snapshots plus ClassicUO `macros.xml`
  //  compatibility for backup, cross-character sharing, or moving
  //  between browsers. Wired by the `macro:export` / `macro:import`
  //  bus events emitted from the export/import macro actions.
  // -------------------------------------------------------------------

  exportToString() {
    return JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      macros: this.macros,
    }, null, 2);
  }

  /** Replace local macros with the contents of a JSON blob or ClassicUO
   *  macros.xml. Returns the count of imported macros, or -1 if the
   *  input was malformed. */
  importFromString(blob) {
    try {
      const xmlMacros = importCuoXmlMacros(blob);
      if (xmlMacros) {
        this.macros = xmlMacros;
        this._save();
        this.attachTriggers();
        return xmlMacros.length;
      }
      const data = JSON.parse(blob);
      if (!Array.isArray(data?.macros)) return -1;
      // Sanity-filter: each entry needs a `key` string + `actions[]`.
      const sane = data.macros
        .map((m) => normalizeMacroHotkey(m))
        .filter((m) => m && typeof m.key === 'string' && Array.isArray(m.actions));
      this.macros = sane;
      this._save();
      this.attachTriggers();
      return sane.length;
    } catch (e) {
      console.warn('[macros] import failed:', e?.message ?? e);
      return -1;
    }
  }

  /** Trigger the browser save-as flow. Lazy because document/Blob are
   *  browser-only and we want this manager unit-testable on Node. */
  downloadToFile(filename = 'uo-macros.json') {
    if (typeof globalThis.document === 'undefined') return;
    const blob = new globalThis.Blob([this.exportToString()],
      { type: 'application/json' });
    const url = globalThis.URL.createObjectURL(blob);
    const a = globalThis.document.createElement('a');
    a.href = url; a.download = filename;
    globalThis.document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => globalThis.URL.revokeObjectURL(url), 1000);
  }

  /** Open a file picker for an external macro JSON / ClassicUO XML. */
  uploadFromFile() {
    if (typeof globalThis.document === 'undefined') return Promise.resolve(-1);
    return new Promise((resolve) => {
      const input = globalThis.document.createElement('input');
      input.type = 'file'; input.accept = '.json,.xml,application/json,text/xml,application/xml';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) { resolve(-1); return; }
        try {
          const text = await file.text();
          resolve(this.importFromString(text));
        } catch { resolve(-1); }
      };
      input.click();
    });
  }
}

export const macroManager = new MacroManager();
