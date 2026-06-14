import { formatHotkeyCombo, normalizeHotkeyKey, parseHotkeyCombo } from '../src/shared/hotkey-combo.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const combo = parseHotkeyCombo('Ctrl+Shift+Alt+X');
assert(combo?.key === 'x', 'combo parser should keep the key');
assert(combo.ctrl && combo.shift && combo.alt, 'combo parser should keep modifiers');
assert(formatHotkeyCombo(combo) === 'Ctrl+Shift+Alt+X', 'combo formatter should round-trip modifiers');

const space = parseHotkeyCombo('Control + Space');
assert(space?.key === ' ', 'combo parser should understand Space');
assert(formatHotkeyCombo(space) === 'Ctrl+Space', 'combo formatter should print Space');

const fKey = parseHotkeyCombo('F12');
assert(fKey?.key === 'f12', 'combo parser should normalize function keys');
assert(formatHotkeyCombo(fKey) === 'F12', 'combo formatter should print function keys');

assert(parseHotkeyCombo('Ctrl+Shift') === null, 'combo parser should reject modifier-only strings');
assert(parseHotkeyCombo('Ctrl+A+B') === null, 'combo parser should reject two-key strings');
assert(normalizeHotkeyKey('Escape') === 'escape', 'key normalizer should lowercase named keys');

console.log('[smoke:hotkeys] ok');
