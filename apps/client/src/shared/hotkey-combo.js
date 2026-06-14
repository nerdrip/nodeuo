const MOD_ALIASES = new Map([
  ['ctrl', 'ctrl'],
  ['control', 'ctrl'],
  ['ctl', 'ctrl'],
  ['shift', 'shift'],
  ['alt', 'alt'],
  ['option', 'alt'],
]);

const KEY_ALIASES = new Map([
  [' ', ' '],
  ['space', ' '],
  ['spacebar', ' '],
  ['esc', 'escape'],
  ['escape', 'escape'],
  ['return', 'enter'],
  ['del', 'delete'],
  ['plus', '+'],
]);

export function normalizeHotkeyKey(key) {
  const value = String(key ?? '');
  if (value === ' ') return ' ';
  const raw = value.trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (KEY_ALIASES.has(lower)) return KEY_ALIASES.get(lower);
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(raw)) return lower;
  if (/^arrow(up|down|left|right)$/i.test(raw)) return lower;
  if (raw.length === 1) return raw.toLowerCase();
  return lower;
}

export function parseHotkeyCombo(combo) {
  if (combo && typeof combo === 'object') {
    const key = normalizeHotkeyKey(combo.key);
    return key ? {
      key,
      ctrl: !!combo.ctrl,
      shift: !!combo.shift,
      alt: !!combo.alt,
    } : null;
  }
  const parts = String(combo ?? '')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const out = { key: '', ctrl: false, shift: false, alt: false };
  for (const part of parts) {
    const mod = MOD_ALIASES.get(part.toLowerCase());
    if (mod) {
      out[mod] = true;
      continue;
    }
    if (out.key) return null;
    out.key = normalizeHotkeyKey(part);
  }
  return out.key ? out : null;
}

export function formatHotkeyCombo(binding) {
  const parsed = parseHotkeyCombo(binding);
  if (!parsed) return '';
  const parts = [];
  if (parsed.ctrl) parts.push('Ctrl');
  if (parsed.shift) parts.push('Shift');
  if (parsed.alt) parts.push('Alt');
  parts.push(formatHotkeyKey(parsed.key));
  return parts.join('+');
}

function formatHotkeyKey(key) {
  const k = normalizeHotkeyKey(key);
  if (!k) return '';
  if (k === ' ') return 'Space';
  if (/^f\d+$/i.test(k)) return k.toUpperCase();
  if (k.startsWith('arrow')) {
    return `Arrow${k.slice(5, 6).toUpperCase()}${k.slice(6)}`;
  }
  if (k.length === 1) return k.toUpperCase();
  return k.slice(0, 1).toUpperCase() + k.slice(1);
}
