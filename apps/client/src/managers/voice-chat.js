// Voice chat — local Text-to-Speech for incoming chat lines. Uses
// the Web Speech API (`window.speechSynthesis`) so we don't need any
// audio assets to ship a voice-over feature. Each NPC line / system
// announcement is queued; the user can mute via profile.
//
// Settings (per profile):
//   voice.enabled   — master toggle
//   voice.npc       — speak NPC lines
//   voice.system    — speak system messages
//   voice.party     — speak party chat
//   voice.rate      — 0.5..2.0
//   voice.pitch     — 0..2
//   voice.volume    — 0..1
//   voice.voiceName — name of the SpeechSynthesisVoice (optional)
//
// Message routing flows through the existing `chat:*` event bus.

import { bus } from '../core/event-bus.js';
import { profile } from './profile-manager.js';

class VoiceChatManager {
  constructor() {
    this._installed = false;
    this._lastSpoken = '';
    this._lastSpokenAt = 0;
    this._voices = [];
  }

  install() {
    if (this._installed) return;
    this._installed = true;
    if (typeof globalThis.speechSynthesis === 'undefined') {
      console.warn('[voice] Web Speech API unavailable — voice chat disabled');
      return;
    }
    this._loadVoices();
    // voiceschanged fires async on Chrome.
    try {
      globalThis.speechSynthesis.addEventListener?.('voiceschanged',
        () => this._loadVoices());
    } catch { /* ignore */ }

    bus.on('chat:system', (m) => this._maybeSpeak(m?.text ?? String(m), 'system'));
    bus.on('chat:npc',    (m) => this._maybeSpeak(m?.text ?? String(m), 'npc'));
    bus.on('chat:party',  (m) => this._maybeSpeak(m?.text ?? String(m), 'party'));
  }

  _loadVoices() {
    try { this._voices = globalThis.speechSynthesis.getVoices?.() ?? []; }
    catch { this._voices = []; }
  }

  _maybeSpeak(text, channel) {
    if (!text) return;
    if (!profile.get('voice.enabled')) return;
    if (channel === 'npc'    && !profile.get('voice.npc'))    return;
    if (channel === 'system' && !profile.get('voice.system')) return;
    if (channel === 'party'  && !profile.get('voice.party'))  return;
    // Dedup spam — same line within 300ms is squashed.
    const now = performance.now();
    if (text === this._lastSpoken && now - this._lastSpokenAt < 300) return;
    this._lastSpoken = text; this._lastSpokenAt = now;
    this._speak(text);
  }

  _speak(text) {
    try {
      const u = new globalThis.SpeechSynthesisUtterance(text.slice(0, 200));
      u.rate   = profile.get('voice.rate')   ?? 1;
      u.pitch  = profile.get('voice.pitch')  ?? 1;
      u.volume = profile.get('voice.volume') ?? 0.7;
      const wantedName = profile.get('voice.voiceName');
      if (wantedName) {
        const v = this._voices.find((x) => x.name === wantedName);
        if (v) u.voice = v;
      }
      globalThis.speechSynthesis.speak(u);
    } catch (e) {
      console.warn('[voice] speak failed:', e?.message ?? e);
    }
  }

  /** Stop everything queued (panic toggle). */
  stop() {
    try { globalThis.speechSynthesis?.cancel?.(); }
    catch { /* ignore */ }
  }

  /** List available voices (for the OptionsGump dropdown). */
  voiceNames() { return this._voices.map((v) => v.name); }
}

export const voiceChat = new VoiceChatManager();
