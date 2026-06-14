import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const tile = read('../src/renderer/tile-renderer.js');
const mobile = read('../src/renderer/mobile-renderer.js');
const effects = read('../src/renderer/effect-renderer.js');
const profile = read('../src/managers/profile-manager.js');
const options = read('../src/ui/gumps/options-gump.js');
const gameScene = read('../src/scenes/game-scene.js');
const commandPanel = read('../src/managers/command-panel.js');
const textInput = read('../src/ui/controls/text-input.js');

for (const needle of [
  'ui.circleOfTransparencyType',
  'ui.circleOfTransparencyRadius',
  '_cotAlphaFor',
  '_updateCotDebugOverlay',
  'debug.cotOverlay',
  '_updateRoofDebugOverlay',
  'debug.roofOverlay',
]) {
  assert.ok(tile.includes(needle), `TileRenderer should consume/render ${needle}`);
}

for (const needle of [
  'ui.fieldsType',
  '_isFieldGraphic',
  '_shouldAnimateStaticGraphic',
  '_profileStaticGraphic',
  'ui.treeToStumps',
  'ui.hideVegetation',
  'ui.enableCaveBorder',
  'graphics.noColorObjectsOutOfRange',
  '_setNoColorTint',
]) {
  assert.ok(tile.includes(needle), `TileRenderer should consume profile option ${needle}`);
}

assert.ok(mobile.includes('graphics.noColorObjectsOutOfRange'), 'MobileRenderer should apply range color to mobiles');
assert.ok(profile.includes('cotOverlay: false'), 'profile defaults should include debug.cotOverlay');
assert.ok(profile.includes('roofOverlay: false'), 'profile defaults should include debug.roofOverlay');
assert.ok(options.includes("'debug.cotOverlay'"), 'OptionsGump should expose debug.cotOverlay');
assert.ok(options.includes("'debug.roofOverlay'"), 'OptionsGump should expose debug.roofOverlay');

for (const needle of [
  "bus.on('fx:particle'",
  "bus.on('fx:hued-short'",
  '_spawnParticleFallback',
  '_spawnHuedShortFallback',
  '_burst',
  'Number.isFinite(info.renderMode)',
  'ScreenMore',
  'ScreenLess',
  'info.renderMode | 0',
]) {
  assert.ok(effects.includes(needle), `EffectRenderer should handle rare opcode fallback ${needle}`);
}

for (const needle of [
  'uo-game-panel',
  'uo-chatbar',
  'uo-chat-input',
  'uo-hud-grid',
  'uo-journal-panel',
]) {
  assert.ok(gameScene.includes(needle), `GameScene DOM UI should include ${needle}`);
}

assert.ok(commandPanel.includes('uo-command-panel'), 'CommandPanel should use the polished command panel shell');
assert.ok(commandPanel.includes('backdrop-filter'), 'CommandPanel should keep the modern translucent shell');
assert.ok(textInput.includes('roundRect(0, 0, this.width, this.height, 3)'), 'TextInput should use rounded modern input chrome');

console.log('[smoke:render-profile-options] ok');
