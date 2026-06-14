// Notoriety → 24-bit RGB hue map. Mirrors ClassicUO `NotorietyFlag.cs`.
// Used by:
//   • client/src/managers/name-overhead-manager.js
//   • client/src/ui/gumps/health-bar-gump.js + paperdoll-gump.js
//   • client/src/ui/gumps/minimap-gump.js
//   • admin editor mob dots
//
// Pixi's `tint` field rejects 32-bit ARGB ints — every consumer here
// expects the 24-bit RGB shape and applies alpha separately. Don't add
// alpha bits to these values.

export const NOTORIETY_HUE = Object.freeze({
  1: 0x33CCFF,    // Innocent — cyan (CUO `NotorietyFlag.cs:25` InnocentHue)
  2: 0x55FF55,    // Ally — green
  3: 0xC0C0C0,    // Gray (attackable)
  4: 0xC0C0C0,    // Criminal — gray (same swatch as 3 in CUO)
  5: 0xFF8000,    // Enemy — orange
  6: 0xFF3030,    // Murderer — red
  7: 0xFFE060,    // Invulnerable — yellow
});

/** Friendly label for the notoriety byte, mirrors CUO popup text. */
export const NOTORIETY_LABEL = Object.freeze({
  1: 'Innocent',
  2: 'Ally',
  3: 'Attackable',
  4: 'Criminal',
  5: 'Enemy',
  6: 'Murderer',
  7: 'Invulnerable',
});

export function notorietyHue(noto) {
  return NOTORIETY_HUE[noto] ?? 0xFFFFFF;
}
