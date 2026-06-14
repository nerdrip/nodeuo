import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage ?? {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { Season } = await import('../src/managers/season-manager.js');
const { darknessOverlayColor, seasonOverlayTint } = await import('../src/renderer/light-overlay.js');
const { weatherTemperatureTint } = await import('../src/renderer/weather.js');

assert.deepEqual(seasonOverlayTint(Season.Spring), { color: 0x8cff9c, alpha: 0.035 });
assert.deepEqual(seasonOverlayTint(Season.Summer), { color: 0xb8ff80, alpha: 0.025 });
assert.deepEqual(seasonOverlayTint(Season.Fall), { color: 0xff9040, alpha: 0.08 });
assert.deepEqual(seasonOverlayTint(Season.Winter), { color: 0x88aaff, alpha: 0.10 });
assert.deepEqual(seasonOverlayTint(Season.Desolation), { color: 0x404044, alpha: 0.18 });
assert.equal(seasonOverlayTint(99), null);

assert.equal(darknessOverlayColor(30, false), 0x000018);
assert.equal(darknessOverlayColor(30, true), 0x040c26);
assert.notEqual(darknessOverlayColor(15, false), darknessOverlayColor(15, true));

assert.equal(weatherTemperatureTint(0), null);
assert.deepEqual(weatherTemperatureTint(127), { color: 0xffb060, alpha: 0.1 });
assert.deepEqual(weatherTemperatureTint(255), { color: 0xffb060, alpha: 0.1 });
assert.deepEqual(weatherTemperatureTint(-127), { color: 0x80b8ff, alpha: 0.1 });
assert.deepEqual(weatherTemperatureTint(-255), { color: 0x80b8ff, alpha: 0.1 });

console.log('[smoke:light-overlay] ok');
