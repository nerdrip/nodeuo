// Diagnostic tracer — high-volume logging gated by a runtime toggle.
// Disabled by default; enable with `[trace on` or `UO_TRACE=1` for a
// focused debugging session. Movement/visibility traces are intentionally
// category-gated because they can emit on every step and stall the Node
// event loop through stdout backpressure on longer play sessions.
//
// Usage:
//   import { trace } from '../trace.js';
//   trace('move', `seq=${seq} dir=${dir} pos=(${x},${y})`);
//
// The category prefix makes it easy to grep / filter:
//   UO_TRACE=1 UO_TRACE_CATEGORIES=move,vis pnpm dev
//   grep '\[trace door\]' server.log

const _noisyCategories = new Set(['move', 'vis']);
const _noisyCategoryRatePerSec = new Map([
  ['move', 40],
  ['vis', 20],
]);
/** @type {Map<string, { at: number, count: number }>} */
const _rateState = new Map();
const _enabledCategories = new Set(
  String(process.env.UO_TRACE_CATEGORIES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

let _enabled = (process.env.UO_TRACE ?? '0') === '1';

export function setTraceEnabled(v) { _enabled = !!v; }
export function isTraceEnabled() { return _enabled; }
export function setTraceCategoryEnabled(category, v) {
  const key = String(category ?? '').trim().toLowerCase();
  if (!key) return;
  if (v) _enabledCategories.add(key);
  else _enabledCategories.delete(key);
}
export function isTraceCategoryEnabled(category) {
  const key = String(category ?? '').trim().toLowerCase();
  return !_noisyCategories.has(key) || _enabledCategories.has(key);
}

/** Emit a single trace line. Format: `[trace <category>] <message>`.
 *  Cheap when disabled — single boolean read, message arg never built
 *  if the caller passes a function.
 *
 *  @param {string} category
 *  @param {string | (() => string)} msg
 */
export function trace(category, msg) {
  if (!_enabled) return;
  const key = String(category ?? '').toLowerCase();
  if (!isTraceCategoryEnabled(key)) return;
  const rate = _noisyCategoryRatePerSec.get(key) ?? 0;
  if (rate > 0) {
    const now = Date.now();
    const slot = _rateState.get(key);
    if (!slot || (now - slot.at) >= 1000) {
      _rateState.set(key, { at: now, count: 1 });
    } else if (slot.count >= rate) {
      return;
    } else {
      slot.count += 1;
    }
  }
  try {
    const text = typeof msg === 'function' ? msg() : msg;
    console.log(`[trace ${key}] ${text}`);
  } catch { /* never throw from a log call */ }
}
