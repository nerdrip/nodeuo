// ChatManager — port of ClassicUO `Game/Managers/ChatManager.cs`.
// Tracks subscribed channels (server-side tally) and the most recent
// channel each /slash command targeted. Chat input itself is the
// SystemChatControl in game-scene; this manager just keeps the channel
// state isolated.

import { bus } from '../core/event-bus.js';
import { net } from '../net/net-client.js';
import { buildUnicodeSpeech } from '../net/outgoing.js';
import { profile } from './profile-manager.js';
import { assets } from '../assets/asset-manager.js';

/** Resolve a display hue for a given UO TextType byte. Reads the
 *  per-channel hue from the user profile so the JournalGump renders
 *  speech / whisper / yell / party / etc. in the user's chosen palette
 *  even when the raw packet hue is the server default 0xFFFF. */
/** Audit #46 P3 — speeches.json keyword highlighter. Each entry is
 *  `{ keyword, kind, weight }`; we collapse the list into a Set of
 *  lowercase keyword tokens used by NPC vendors so the journal can
 *  highlight matched words in cyan when the player types one. */
let _speechKeywords = null;
function normalizeSpeechKeyword(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function _ensureSpeechSet() {
  if (_speechKeywords) return _speechKeywords;
  _speechKeywords = { words: new Set(), phrases: new Set() };
  const sp = assets?.speeches?.entries;
  if (!sp) return _speechKeywords;
  for (const e of sp) {
    const kw = normalizeSpeechKeyword(e?.keyword);
    if (kw.length < 3) continue;
    if (kw.includes(' ')) _speechKeywords.phrases.add(kw);
    else _speechKeywords.words.add(kw);
  }
  return _speechKeywords;
}

/** Returns true when the input text matches a known NPC keyword (used
 *  by JournalGump to highlight player speech that vendors will react
 *  to). */
export function isVendorKeyword(text) {
  const index = _ensureSpeechSet();
  if (!index.words.size && !index.phrases.size) return false;
  const normalized = normalizeSpeechKeyword(text);
  if (!normalized) return false;
  for (const word of normalized.split(/\s+/)) {
    if (word.length < 3) continue;
    if (index.words.has(word)) return true;
  }
  const padded = ` ${normalized} `;
  for (const phrase of index.phrases) {
    if (padded.includes(` ${phrase} `)) return true;
  }
  return false;
}

// Audit rev.9 P3 #2 — expose the checker via globalThis so the
// message-manager hot path can consult it without taking a hard
// dependency on chat-manager (avoids a circular import).
try {
  if (typeof globalThis !== 'undefined') {
    if (!globalThis.__chatManager) globalThis.__chatManager = {};
    globalThis.__chatManager.isVendorKeyword = isVendorKeyword;
  }
} catch { /* SSR / readonly globals */ }

export function hueForTextType(textType, fallback = 0xFFFF) {
  // TextType numeric values (alignment with CUO `MessageType` enum):
  //   0 Regular, 1 System, 2 Emote, 6 Label, 7 Focus,
  //   8 Whisper, 9 Yell, 10 Spell, 13 Guild, 14 Alliance,
  //   15 Party, 16 EncodedSpell, 17 GraphicCommand.
  const KEY = {
    0: 'speechHue',
    1: 'systemHue',
    2: 'emoteHue',
    8: 'whisperHue',
    9: 'yellHue',
    13: 'guildHue',
    14: 'allianceHue',
    15: 'partyHue',
  };
  const k = KEY[textType | 0];
  if (!k) return fallback;
  const hue = profile.get(`chat.${k}`);
  return (hue == null) ? fallback : (hue | 0);
}

class ChatManager {
  constructor() {
    /** @type {Set<string>} channels we've joined */
    this.joined = new Set(['general']);
    /** Active default channel for plain `/say` (when no slash). */
    this.activeChannel = 'general';
    /** Recent message history (per-channel ring of last 50). */
    this._history = new Map();
    bus.on?.('chat:incoming', (e) => this._record(e));
  }

  join(channel) {
    const c = String(channel || '').toLowerCase();
    if (!c) return;
    this.joined.add(c);
    this.activeChannel = c;
    this._send(`/join ${c}`);
    bus.emit?.('chat:channels-changed');
  }

  leave(channel) {
    const c = String(channel || '').toLowerCase();
    this.joined.delete(c);
    if (this.activeChannel === c) this.activeChannel = 'general';
    this._send(`/leave ${c}`);
    bus.emit?.('chat:channels-changed');
  }

  send(channel, body) {
    const c = String(channel || this.activeChannel).toLowerCase();
    const text = String(body || '').trim();
    if (!text) return;
    this._send(`/${c} ${text}`);
  }

  _send(line) {
    try { net.send(buildUnicodeSpeech(line, 0, 0, 0x03B2)); }
    catch { /* socket transient */ }
  }

  _record({ channel, from, body, ts }) {
    const c = String(channel || '').toLowerCase() || 'general';
    if (!this._history.has(c)) this._history.set(c, []);
    const arr = this._history.get(c);
    arr.push({ from, body, ts: ts ?? Date.now() });
    if (arr.length > 50) arr.splice(0, arr.length - 50);
  }

  history(channel) {
    return this._history.get(String(channel || '').toLowerCase()) ?? [];
  }

  channels() { return Array.from(this.joined); }
}

export const chatManager = new ChatManager();
