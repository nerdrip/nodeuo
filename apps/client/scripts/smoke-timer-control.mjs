import assert from 'node:assert/strict';

globalThis.CanvasRenderingContext2D = globalThis.CanvasRenderingContext2D ?? function CanvasRenderingContext2D() {};
globalThis.document = globalThis.document ?? {
  createElement: () => ({
    getContext: () => ({
      font: '',
      measureText: (text) => ({
        width: String(text ?? '').length * 6,
        actualBoundingBoxAscent: 9,
        actualBoundingBoxDescent: 3,
        fontBoundingBoxAscent: 9,
        fontBoundingBoxDescent: 3,
      }),
    }),
  }),
};

const { TimerControl, formatTimerDuration } = await import('../src/ui/controls/timer-control.js');

assert.equal(formatTimerDuration(0), '');
assert.equal(formatTimerDuration(12), '12s');
assert.equal(formatTimerDuration(90), '1m');
assert.equal(formatTimerDuration(3660), '1h');

const timer = new TimerControl({ durationS: 10 });
const start = 1000;
timer.setDuration(10, start);
assert.equal(timer.tick(start), true);
assert.equal(timer._label._cachedText, '10s');
assert.equal(timer.tick(start + 9500), true);
assert.equal(timer._label._cachedText, '1s');
assert.equal(timer.tick(start + 10_000), false);
assert.equal(timer._label._cachedText, '');

console.log('[smoke:timer-control] ok');
