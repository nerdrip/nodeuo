// Speech mode catalogue. Mirrors CUO `MessageManager.cs:88-145` and
// the 0xAD UnicodeSpeech type byte values from ServUO `Server/Network/
// Packets.cs`. Each mode carries:
//
//   • prefix — single character the user types in the chat input to
//     route this one message through the mode without changing the
//     sticky dropdown selection (";hi" → whisper "hi")
//   • type   — wire byte for 0xAD (Party is the exception: it goes
//     through 0xBF subop 0x06 sub 0x03, signalled by type === -1)
//   • hue    — UO hue id for the rendered overhead text. Mirrors the
//     classic shard palette (whisper-grey, yell-orange, …).
//   • label  — dropdown caption + journal tag.
//
// SHARED MODULE: pure table + small helpers. Imported by the chat
// input wrapper (sticky selector), world-text overhead renderer, and
// the admin journal viewer.

export const SPEECH_TYPE_NORMAL    = 0x00;
export const SPEECH_TYPE_EMOTE     = 0x02;
export const SPEECH_TYPE_WHISPER   = 0x08;
export const SPEECH_TYPE_YELL      = 0x09;
export const SPEECH_TYPE_GUILD     = 0x0D;
export const SPEECH_TYPE_ALLIANCE  = 0x0E;
/** Party speech doesn't ride the 0xAD packet — it uses 0xBF/06/03.
 *  We mark it with type=-1 in the table so callers can branch. */
export const SPEECH_TYPE_PARTY     = -1;

/** Sticky-prefix-keyed catalogue. Order matches the chat dropdown. */
export const SPEECH_MODES = Object.freeze([
  { id: 'normal',   prefix: '',   hue: 0x03B2, label: 'Normal',   type: SPEECH_TYPE_NORMAL    },
  { id: 'whisper',  prefix: ';',  hue: 0x002D, label: 'Whisper',  type: SPEECH_TYPE_WHISPER   },
  { id: 'emote',    prefix: ':',  hue: 0x07B5, label: 'Emote',    type: SPEECH_TYPE_EMOTE     },
  { id: 'yell',     prefix: '!',  hue: 0x002B, label: 'Yell',     type: SPEECH_TYPE_YELL      },
  { id: 'guild',    prefix: '\\', hue: 0x0044, label: 'Guild',    type: SPEECH_TYPE_GUILD     },
  { id: 'alliance', prefix: '|',  hue: 0x005A, label: 'Alliance', type: SPEECH_TYPE_ALLIANCE  },
  { id: 'party',    prefix: '/',  hue: 0x0040, label: 'Party',    type: SPEECH_TYPE_PARTY     },
]);

/** Resolve a speech mode by its single-character prefix. Returns `null`
 *  when the leading char isn't a recognised prefix (caller defaults to
 *  the sticky mode). */
export function modeByPrefix(ch) {
  for (const m of SPEECH_MODES) {
    if (m.prefix && m.prefix === ch) return m;
  }
  return null;
}

/** Resolve a speech mode by its wire type byte. Used by the journal +
 *  world-text renderer to colour incoming messages from other players. */
export function modeByType(type) {
  for (const m of SPEECH_MODES) {
    if (m.type === type) return m;
  }
  return SPEECH_MODES[0];                  // Normal — safe fallback
}
