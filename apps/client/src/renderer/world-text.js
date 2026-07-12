// World text — short-lived overhead labels (chat bubbles, damage popups,
// system overheads). Mirrors ClassicUO's
// Game/Managers/WorldTextManager.cs at MVP scope.
//
// Bus events consumed:
//   chat:ascii / chat:unicode  → speech bubble above the speaker mobile
//   chat:cliloc                → cliloc-resolved bubble
//   damage:apply               → red `-N` popup above the victim
//   heal:apply                 → green `+N` popup
//
// Each entry has a TTL (~3 s for speech, ~1.5 s for damage); the manager
// fades them out and removes when expired.

import { Text, TextStyle } from 'pixi.js';
import { worldToScreenX, worldToScreenY } from './iso.js';
import { world } from '../world/world.js';
import { bus } from '../core/event-bus.js';
import { assets } from '../assets/asset-manager.js';
import { profile } from '../managers/profile-manager.js';
import { UI_FONT_FAMILY, UI_TEXT_RESOLUTION } from '../ui/text-quality.js';

const SPEECH_TTL_MS = 3500;
const POPUP_TTL_MS  = 1500;
const TEXT_NODE_POOL_CAP = 96;

const _textStyleCache = new Map();
const _textNodePool = [];
function worldTextStyle(fill, fontSize) {
  const key = `${fill | 0}:${fontSize | 0}`;
  let style = _textStyleCache.get(key);
  if (style) return style;
  style = new TextStyle({
    fill: fill | 0,
    fontSize: fontSize | 0,
    fontFamily: UI_FONT_FAMILY,
    fontWeight: 600,
    stroke: { color: 0x000000, width: 2, join: 'round' },
  });
  _textStyleCache.set(key, style);
  return style;
}

function acquireWorldTextNode(text, style) {
  const node = _textNodePool.pop() ?? new Text({
    text: '', style, resolution: UI_TEXT_RESOLUTION, roundPixels: true,
  });
  node.text = text;
  node.style = style;
  node.visible = true;
  node.alpha = 1;
  node.anchor.set(0.5, 1);
  return node;
}

function releaseWorldTextNode(node) {
  if (!node || node.destroyed) return;
  node.parent?.removeChild(node);
  node.visible = false;
  node.text = '';
  node.alpha = 1;
  if (_textNodePool.length >= TEXT_NODE_POOL_CAP) {
    node.destroy();
    return;
  }
  _textNodePool.push(node);
}

class TextEntry {
  constructor(serial, text, opts) {
    this.serial = serial >>> 0;
    this.text = text;
    this.kind = opts.kind ?? 'speech';
    this.hue = opts.hue ?? 0xfff0c0;
    this.fontSize = opts.fontSize ?? 12;
    this.bornAt = performance.now();
    this.ttl = opts.ttl ?? SPEECH_TTL_MS;
    /** screen-space Y offset (popups float upward) */
    this.driftY = 0;
    /** @type {Text | null} */
    this.node = null;
    this._lastX = NaN;
    this._lastY = NaN;
    this._lastAlpha = NaN;
  }
  age(now = performance.now()) { return now - this.bornAt; }
}

export class WorldTextRenderer {
  /** @param {import('pixi.js').Container} parent */
  constructor(parent) {
    this.parent = parent;
    /** @type {TextEntry[]} */
    this.entries = [];
    this._unsubs = [
      bus.on('chat:ascii',   (m) => this._addSpeechFiltered(m)),
      bus.on('chat:unicode', (m) => this._addSpeechFiltered(m)),
      bus.on('chat:cliloc',  (m) => this._addSpeech({
        ...m,
        text: assets.cl(m.cliloc, m.args),
      })),
      // Audit #34 P2 #5 — CUO `EntityTextContainer.cs:85` paints own-
      // damage hue 0x0034 (deep red) and others 0x0021 (orange) so the
      // player can distinguish at a glance who got hit. Was flat red
      // for both — every popup in a melee read as same-target.
      bus.on('damage:apply', ({ serial, amount, damageType }) => {
        const self = (serial >>> 0) === (world.player?.serial >>> 0);
        // Audit rev.9 P3 #6 — CUO `Mobile.cs::OnDamageReceived` tints
        // the floating popup by damage element. Each `damageType` is a
        // map `{phys, fire, cold, poison, energy}` totalling 100 (server
        // sends the breakdown alongside total). Pick the dominant
        // element and use its colour; if no breakdown is shipped, fall
        // back to the legacy self/other red/orange.
        let hue = self ? 0xc40e0e : 0xff7c2a;
        if (damageType && typeof damageType === 'object') {
          let bestEl = null, bestVal = 0;
          for (const el in damageType) {
            const v = damageType[el] | 0;
            if (v > bestVal) { bestVal = v; bestEl = el; }
          }
          const PALETTE = {
            phys:   self ? 0xc40e0e : 0xff7c2a,
            fire:   0xff4400,
            cold:   0x4080ff,
            poison: 0x40ff40,
            energy: 0xc080ff,
          };
          if (bestEl && PALETTE[bestEl]) hue = PALETTE[bestEl];
        }
        this._addPopup(serial, `-${amount}`, hue);
      }),
      bus.on('heal:apply',   ({ serial, amount }) => this._addPopup(serial, `+${amount}`, 0x60d060)),
    ];
  }

  /** ServUO replies to 0x09 LookReq with a 0x1C/0xAE message that looks
   *  exactly like normal speech (header `name='You see'`, body `text=<mob_name>`).
   *  net/handlers.js already swallows this into mob.name; without the
   *  same filter here the LookReq reply also pops a speech bubble in the
   *  middle of every mobile when it first comes into view. */
  _addSpeechFiltered(m) {
    if (m?.name === 'You see') return;
    this._addSpeech(m);
  }

  destroy() {
    for (const u of this._unsubs) u();
    this._unsubs.length = 0;
    for (const e of this.entries) releaseWorldTextNode(e.node);
    this.entries.length = 0;
  }

  _addSpeech({ serial, text, hue, type }) {
    if (!text) return;
    // Audit #36 P1 #3 — speech-type hue. CUO `MessageManager.cs:88-145`
    // tints by `MessageType`: Whisper(8) dimmer, Yell(9) bold red,
    // Party(16) blue, Guild(13) green, Alliance(14) cyan, Emote(2)
    // italic. Was: flat cream for everything — every utterance in a
    // tavern read identically. We don't have italic/bold in the
    // bitmap font, so we differentiate via hue + alpha.
    let resolvedHue = hue;
    let fontSize = 13;
    if (!resolvedHue) {
      switch (type | 0) {
        case 2:  resolvedHue = 0x0026; break;          // Emote — light orange
        case 8:  resolvedHue = 0xa0a0a0; break;        // Whisper — dim grey
        case 9:  resolvedHue = 0xff4040; fontSize = 15; break; // Yell — bold red
        case 13: resolvedHue = 0x60d060; break;        // Guild — green
        case 14: resolvedHue = 0x60d0d0; break;        // Alliance — cyan
        case 16: resolvedHue = 0x6080ff; break;        // Party — blue
        default: resolvedHue = 0xfff0c0;
      }
    }
    const entry = new TextEntry(serial, text, {
      kind: 'speech', hue: resolvedHue, fontSize, ttl: SPEECH_TTL_MS,
    });
    this._mount(entry);
    // Optional TTS read-out — toggled in Options ('Read NPC speech
    // aloud (TTS)'). Stored at profile path 'tts.speech'. Browser's
    // SpeechSynthesis API is sync-fire-and-forget; cap queue to ~3
    // so a chatty crowd doesn't flood the synth backlog.
    try {
      if (!profile.get?.('tts.speech')) return;
      const synth = window.speechSynthesis;
      if (!synth) return;
      if (synth.pending && synth.pending > 3) return;
      const u = new SpeechSynthesisUtterance(String(text).slice(0, 200));
      u.rate = 1.05; u.pitch = 1; u.volume = 0.8;
      synth.speak(u);
    } catch { /* TTS unavailable in this browser/profile */ }
  }
  _addPopup(serial, text, hue) {
    const entry = new TextEntry(serial, text, {
      kind: 'popup', hue, fontSize: 14, ttl: POPUP_TTL_MS,
    });
    // Audit #34 P2 #4 — CUO `OverheadDamage.Draw` stacks concurrent
    // popups by counting existing entries for the same serial and
    // cascading each `offY +=` so rapid hits (AOE volley, multi-archer
    // focus fire) read as separate numbers instead of one. Track the
    // stack index at mount time; tick uses it as a multiplier.
    entry.stackIndex = 0;
    const now = performance.now();
    for (const e of this.entries) {
      if (e.kind === 'popup' && e.serial === (serial >>> 0)
          && e.age(now) < POPUP_TTL_MS) {
        entry.stackIndex += 1;
      }
    }
    this._mount(entry);
  }

  _mount(entry) {
    entry.node = acquireWorldTextNode(entry.text, worldTextStyle(entry.hue, entry.fontSize));
    this.parent.addChild(entry.node);
    this.entries.push(entry);
    // Audit #36 P2 #9 — CUO `EntityTextContainer.cs:65-98` caps to 10
    // messages PER ENTITY. Our global 64 cap meant a chatty NPC could
    // monopolise the queue and evict another mob's first overhead
    // before its TTL. Add a per-serial drop pass before the global
    // failsafe cap.
    const PER_SERIAL_CAP = 10;
    let same = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].serial !== entry.serial) continue;
      same += 1;
      if (same > PER_SERIAL_CAP) {
        const dropped = this.entries[i];
        this.entries.splice(i, 1);
        releaseWorldTextNode(dropped?.node);
      }
    }
    // Global failsafe (raised to 256 since per-serial cap now does
    // the heavy lifting for active mobs).
    const overflow = this.entries.length - 256;
    for (let i = 0; i < overflow; i++) {
      const dropped = this.entries[i];
      releaseWorldTextNode(dropped?.node);
    }
    if (overflow > 0) this.entries.splice(0, overflow);
  }

  hasActive() {
    return this.entries.length > 0;
  }

  /** Per-frame: position + fade entries based on age. */
  tick(_dt, now = performance.now()) {
    if (this.entries.length === 0) return;
    let write = 0;
    for (let read = 0; read < this.entries.length; read++) {
      const e = this.entries[read];
      const age = e.age(now);
      if (age >= e.ttl) {
        releaseWorldTextNode(e.node);
        continue;
      }
      const mob = world.mobiles.get(e.serial);
      if (!mob || !e.node) {
        this.entries[write++] = e;
        continue;
      }
      const projX = worldToScreenX(mob.x, mob.y);
      const projY = worldToScreenY(mob.x, mob.y, mob.z);
      // Popups drift upward; speech sits a few px above the body's
      // current head pixel. Earlier the offset was a flat -28 which
      // landed in the middle of a 60-px human sprite — speech and the
      // overhead name label both ended up across the chest.
      if (e.kind === 'popup') {
        // Audit #34 P2 #4 — stack offset so concurrent popups don't
        // pixel-overlap. Each older popup pushes new ones 14 px higher.
        e.driftY = -age / 30 - 14 * (e.stackIndex | 0);
      } else {
        const meta = mob._spriteHeadOffset; // set by mobile-renderer per tick
        e.driftY = (typeof meta === 'number' ? meta : -78) - 18;
      }
      const nextX = projX | 0;
      const nextY = (projY + e.driftY) | 0;
      if (e._lastX !== nextX || e._lastY !== nextY) {
        e.node.position.set(nextX, nextY);
        e._lastX = nextX;
        e._lastY = nextY;
      }
      const fadeIn  = Math.min(1, age / 100);
      const fadeOut = Math.max(0, 1 - (age - (e.ttl - 400)) / 400);
      const alpha = Math.min(fadeIn, fadeOut);
      if (e._lastAlpha !== alpha) {
        e.node.alpha = alpha;
        e._lastAlpha = alpha;
      }
      if (e.node.zIndex !== 1_000_000_000) e.node.zIndex = 1_000_000_000;
      this.entries[write++] = e;
    }
    this.entries.length = write;
  }
}
