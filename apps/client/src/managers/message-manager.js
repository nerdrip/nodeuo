// MessageManager — central routing for all server text (ASCII / Unicode /
// Cliloc / Affix). Mirrors ClassicUO `Game/Managers/MessageManager.cs`.
//
// Why a manager: prior to this, `chat:ascii`/`unicode`/`cliloc` were
// fired in three places with three different shapes. Journal, overhead
// bubble, system tray, and party filter all subscribed individually,
// each re-implementing party/guild/ignore filters. The result was
// inconsistent — e.g. journal showed party messages even when the
// "OverheadPartyMessages" profile flag was off.
//
// What it does:
//   1. Listens to the three raw channels.
//   2. Normalises each event into a single `Message` shape.
//   3. Applies notoriety/party/ignore filters.
//   4. Re-emits as `message:journal` (always) and `message:overhead`
//      (when the message has a serial that maps to an entity in view).
//   5. Tracks the active server prompt (0x9A ASCII / 0xC2 Unicode) so
//      consumers can submit a single response without juggling state.
//
// MessageType enum (CUO Data/MessageType.cs):
const MT = Object.freeze({
  Regular: 0, System: 1, Emote: 2, Limit3Spell: 3, Label: 6,
  Focus: 7, Whisper: 8, Yell: 9, Spell: 10, Guild: 13, Alliance: 14,
  Command: 15, Encoded: 0xC0, Party: 16,
});

// TextType — Game/Data/TextType.cs (visual classification).
const TT = Object.freeze({
  Normal: 0, System: 1, Object: 2, Guild: 3, Alliance: 4, Party: 5,
  ClientCommand: 6, Damage: 7, Label: 8,
});

import { bus } from '../core/event-bus.js';
import { world } from '../world/world.js';
import { assets } from '../assets/asset-manager.js';
import { profile } from './profile-manager.js';

/** @typedef {{
 *   serial:number, name:string, text:string, hue:number, font:number,
 *   type:number, source:'ascii'|'unicode'|'cliloc'|'affix'|'system',
 *   affix?:string, args?:string, cliloc?:number, lang?:string,
 *   isUnicode:boolean, textType:number,
 * }} Message
 */

class MessageManager {
  constructor() {
    /** @type {Set<string>} */
    this._ignored = new Set();
    /** @type {{ serialOrigin:number, promptId:number, ascii:boolean } | null} */
    this._activePrompt = null;
    /** profile-controlled filters; default to "show everything" */
    this.opts = {
      showPartyOverhead: true,
      ignoreGuildMessages: false,
      ignoreAllianceMessages: false,
      systemHue: 0x03B2,
    };
    this._installed = false;
  }

  install() {
    if (this._installed) return;
    this._installed = true;
    this._syncProfile();
    bus.on('chat:ascii',   (m) => this._dispatch(this._normalizeAscii(m)));
    bus.on('chat:unicode', (m) => this._dispatch(this._normalizeUnicode(m)));
    bus.on('chat:cliloc',  (m) => this._dispatch(this._normalizeCliloc(m)));
    bus.on('prompt:ascii', (pkt) => {
      // pkt is the raw frame; layout: 1B op + 2B len + 4B serial + 4B promptId
      if (!pkt || pkt.length < 11) return;
      this._activePrompt = {
        serialOrigin: ((pkt[3] << 24) | (pkt[4] << 16) | (pkt[5] << 8) | pkt[6]) >>> 0,
        promptId:     ((pkt[7] << 24) | (pkt[8] << 16) | (pkt[9] << 8) | pkt[10]) >>> 0,
        ascii: true,
      };
      bus.emit('prompt:active', this._activePrompt);
    });
    bus.on('prompt:unicode', (info) => {
      this._activePrompt = {
        serialOrigin: info.senderSerial >>> 0,
        promptId:     info.promptId    >>> 0,
        ascii: false,
      };
      bus.emit('prompt:active', this._activePrompt);
    });
    bus.on('profile:changed', ({ path }) => {
      if (path?.startsWith?.('experimental.') || path?.startsWith?.('gameplay.') || path?.startsWith?.('chat.')) {
        this._syncProfile();
      }
    });
  }

  _syncProfile() {
    this.opts.showPartyOverhead = profile.get('gameplay.partyOverhead') ?? true;
    this.opts.ignoreGuildMessages = !!profile.get('experimental.ignoreGuildMessages');
    this.opts.ignoreAllianceMessages = !!profile.get('experimental.ignoreAllianceMessages');
    this.opts.systemHue = profile.get('chat.systemHue') ?? 0x03B2;
  }

  /** Convert a raw 0x1C ASCII message to our normalised shape. */
  _normalizeAscii(m) {
    return {
      serial: m.serial >>> 0, name: (m.name || '').trim(),
      text: m.text || '', hue: m.hue, font: m.font, type: m.type,
      source: 'ascii', isUnicode: false,
      textType: this._classify(m),
    };
  }

  /** 0xAE Unicode. */
  _normalizeUnicode(m) {
    return {
      serial: m.serial >>> 0, name: (m.name || '').trim(),
      text: m.text || '', hue: m.hue, font: m.font, type: m.type,
      lang: m.language, source: 'unicode', isUnicode: true,
      textType: this._classify(m),
    };
  }

  /** 0xC1 / 0xCC Cliloc — resolved through the cliloc table with `args`
   *  (tab-separated) substituted into the template. */
  _normalizeCliloc(m) {
    const text = assets.cl(m.cliloc, m.args || '');
    return {
      serial: m.serial >>> 0, name: (m.name || '').trim(),
      text: m.affix ? `${text}${m.affix}` : text,
      hue: m.hue, font: m.font, type: m.type,
      cliloc: m.cliloc, args: m.args || '',
      affix: m.affix,
      source: m.affix ? 'affix' : 'cliloc', isUnicode: true,
      textType: this._classify(m),
    };
  }

  _classify(m) {
    if (m.type === MT.System || m.serial === 0xFFFFFFFF >>> 0) return TT.System;
    if (m.type === MT.Guild)    return TT.Guild;
    if (m.type === MT.Alliance) return TT.Alliance;
    if (m.type === MT.Party)    return TT.Party;
    if (m.type === MT.Label)    return TT.Label;
    if (m.serial !== 0 && world.items.has(m.serial >>> 0)) return TT.Object;
    return TT.Normal;
  }

  /** @param {Message} msg */
  _dispatch(msg) {
    if (!msg) return;
    if (this._ignored.has(msg.name.toLowerCase())) return;
    if (msg.textType === TT.Guild    && this.opts.ignoreGuildMessages) return;
    if (msg.textType === TT.Alliance && this.opts.ignoreAllianceMessages) return;

    // CUO `MessageManager.HandleMessage` ghost-speech filter: dead,
    // non-resurrected senders' regular chat is scrambled into the
    // canonical "OoOoO" consonant-replaced form. Party + Guild +
    // System bypass (party-channel ghosts can be understood by other
    // dead party members, and System messages aren't speech).
    const sender = world.mobiles.get(msg.serial);
    const senderDead = sender && (sender.isDead || sender.ghost);
    const speechType = msg.textType !== TT.System
                    && msg.textType !== TT.Party
                    && msg.textType !== TT.Guild
                    && msg.textType !== TT.Alliance;
    if (senderDead && speechType && typeof msg.text === 'string') {
      msg.text = ghostSpeech(msg.text);
    }

    // Audit rev.9 P3 #2 — speeches.json keyword tag. Flag player-speech
    // (Normal/Whisper/Yell originating from the local mob) whose text
    // contains a known NPC keyword so the journal can render those rows
    // in cyan ("vendors will react to this"). The JournalGump consults
    // `msg.matchesVendorKeyword` when colouring the row.
    try {
      if (msg.serial === world.player?.serial &&
          (msg.textType === TT.Normal || msg.textType === TT.Whisper || msg.textType === TT.Yell)) {
        // Lazy-import the keyword checker so we don't drag chat-manager
        // into the message hot path when speeches.json is empty.
        const cm = (typeof globalThis !== 'undefined') && globalThis.__chatManager;
        if (cm?.isVendorKeyword?.(msg.text)) msg.matchesVendorKeyword = true;
      }
    } catch { /* ignore */ }
    bus.emit('message:journal', msg);
    // Audit #46 P2 — typed subscribers. CUO ships a per-channel hook
    // matrix; we expose `message:journal:<type>` so InfoBar / BuffGump /
    // dedicated panels can filter without iterating the full stream.
    try {
      const typeName = ({
        [TT.Normal]: 'normal', [TT.System]: 'system', [TT.Emote]: 'emote',
        [TT.Whisper]: 'whisper', [TT.Yell]: 'yell', [TT.Spell]: 'spell',
        [TT.Party]: 'party', [TT.Guild]: 'guild', [TT.Alliance]: 'alliance',
        [TT.Command]: 'command', [TT.Encoded]: 'encoded',
      })[msg.textType] ?? 'unknown';
      bus.emit(`message:journal:${typeName}`, msg);
    } catch { /* ignore */ }

    // Overhead bubble: only when there's a known entity to anchor on,
    // and the type is one that visually belongs over a head.
    const overheadOk =
      msg.serial !== 0 &&
      msg.serial !== (0xFFFFFFFF >>> 0) &&
      msg.textType !== TT.System &&
      (msg.textType !== TT.Party || this.opts.showPartyOverhead) &&
      (world.mobiles.has(msg.serial) || world.items.has(msg.serial));
    if (overheadOk) bus.emit('message:overhead', msg);
  }

  /** Audit #46 P2 — convenience subscribe-by-type API. Returns an
   *  unsubscribe function (matches `bus.on` convention). */
  subscribe(typeName, fn) {
    return bus.on(`message:journal:${typeName}`, fn);
  }

  // --- Ignore list -------------------------------------------------------

  ignore(name) { if (name) this._ignored.add(String(name).toLowerCase()); }
  unignore(name) { if (name) this._ignored.delete(String(name).toLowerCase()); }
  isIgnored(name) { return this._ignored.has(String(name || '').toLowerCase()); }

  // --- Prompt ------------------------------------------------------------

  hasActivePrompt() { return !!this._activePrompt; }
  /** Caller (chat input) submits the prompt response. We yield the prompt
   *  state and emit `prompt:answered` with it; the actual outgoing builder
   *  is wired separately so the manager stays decoder-agnostic. */
  takePrompt() {
    const p = this._activePrompt;
    this._activePrompt = null;
    if (p) bus.emit('prompt:cleared', p);
    return p;
  }
  cancelPrompt() {
    if (!this._activePrompt) return;
    bus.emit('prompt:cancelled', this._activePrompt);
    this._activePrompt = null;
  }
}

export const messageManager = new MessageManager();

/** CUO `MessageManager.GHOST_SPEECH_TABLE`. Every consonant in a ghost
 *  utterance maps to one of a small set of "Oo" tokens so the listener
 *  can still hear cadence + rough length but not the actual words.
 *  Vowels keep their alpha-case (so non-ghosts seeing "OoOO" still get
 *  the right number of syllables). */
function ghostSpeech(text) {
  let out = '';
  for (const ch of text) {
    const c = ch.toLowerCase();
    if (c >= 'a' && c <= 'z') {
      if ('aeiou'.includes(c)) out += ch;
      else out += (ch === ch.toUpperCase()) ? 'O' : 'o';
    } else {
      out += ch;
    }
  }
  return out;
}
export const MessageType = MT;
export const TextType = TT;
