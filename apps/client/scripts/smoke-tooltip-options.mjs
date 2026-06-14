import assert from 'node:assert/strict';

globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
  key() { return null; },
  get length() { return 0; },
};

const {
  tooltipCategoryForSerial,
  tooltipHueToCss,
  tooltipLineColor,
  tooltipProfileSettings,
  tooltipSettingsAllowCategory,
  renderTooltipResistLine,
} = await import('../src/managers/tooltip-manager.js');

const defaults = tooltipProfileSettings({
  get(path) {
    return ({
      'tooltips.enabled': true,
      'tooltips.items': true,
      'tooltips.mobs': true,
      'tooltips.corpses': true,
      'tooltips.delayMs': 220,
      'tooltips.width': 280,
      'tooltips.fontSize': 12,
      'tooltips.backgroundOpacity': 0.78,
      'tooltips.textHue': 0xFFFF,
      'tooltips.colorResists': true,
      'tooltips.colorArtifact': true,
      'tooltips.echoToChat': false,
      'tooltips.holdAltToShow': false,
    })[path];
  },
});

assert.equal(defaults.enabled, true);
assert.equal(defaults.width, 280);
assert.equal(defaults.fontSize, 12);
assert.equal(defaults.backgroundOpacity, 0.78);
assert.equal(defaults.textColor, '#FFFFFF');
assert.equal(defaults.echoToChat, false);
assert.equal(defaults.holdAltToShow, false);

const clamped = tooltipProfileSettings({
  get(path) {
    return ({
      'tooltips.enabled': false,
      'tooltips.items': false,
      'tooltips.mobs': true,
      'tooltips.corpses': false,
      'tooltips.delayMs': 99999,
      'tooltips.width': 1,
      'tooltips.fontSize': 100,
      'tooltips.backgroundOpacity': -1,
      'tooltips.textHue': 0x0481,
      'tooltips.colorResists': false,
      'tooltips.colorArtifact': false,
      'tooltips.echoToChat': true,
      'tooltips.holdAltToShow': true,
    })[path];
  },
});

assert.equal(clamped.enabled, false);
assert.equal(clamped.items, false);
assert.equal(clamped.corpses, false);
assert.equal(clamped.delayMs, 2000);
assert.equal(clamped.width, 120);
assert.equal(clamped.fontSize, 24);
assert.equal(clamped.backgroundOpacity, 0);
assert.equal(clamped.textColor, '#FFF0C0');
assert.equal(clamped.echoToChat, true);
assert.equal(clamped.holdAltToShow, true);

assert.equal(tooltipHueToCss(0xFFFF), '#FFFFFF');
assert.equal(tooltipHueToCss(0x0099), '#FFD060');
assert.match(tooltipHueToCss(0x0033), /^#[0-9A-F]{6}$/);

assert.equal(tooltipSettingsAllowCategory(defaults, 'items'), true);
assert.equal(tooltipSettingsAllowCategory(clamped, 'items'), false);
assert.equal(tooltipSettingsAllowCategory({ ...defaults, mobs: false }, 'mobs'), false);
assert.equal(tooltipSettingsAllowCategory({ ...defaults, corpses: false }, 'corpses'), false);

const worldLike = {
  mobiles: new Map([[0x100, { serial: 0x100, body: 0x0190 }]]),
  items: new Map([
    [0x200, { serial: 0x200, itemId: 0x0f0e }],
    [0x300, { serial: 0x300, itemId: 0x2006 }],
    [0x400, { serial: 0x400, itemId: 0x1000, isCorpse: true }],
  ]),
};
assert.equal(tooltipCategoryForSerial(worldLike, 0x100), 'mobs');
assert.equal(tooltipCategoryForSerial(worldLike, 0x200), 'items');
assert.equal(tooltipCategoryForSerial(worldLike, 0x300), 'corpses');
assert.equal(tooltipCategoryForSerial(worldLike, 0x400), 'corpses');
assert.equal(tooltipCategoryForSerial(worldLike, 0x500, { serial: 0x500, body: 0x0191 }), 'mobs');
assert.equal(tooltipCategoryForSerial(worldLike, 0x600, { serial: 0x600, itemId: 0x2006 }), 'corpses');

assert.equal(
  tooltipLineColor({ cliloc: 1042971 }, 'Resists 1/2/3/4/5', false, defaults),
  'multi-resist',
);
assert.equal(
  tooltipLineColor({ cliloc: 1042971 }, 'Resists 1/2/3/4/5', false, clamped),
  null,
);
assert.equal(
  tooltipLineColor({ cliloc: 1042971 }, '[Artifact]', false, defaults),
  '#FFD700',
);
assert.equal(
  tooltipLineColor({ cliloc: 1042971 }, '[Artifact]', false, clamped),
  null,
);
assert.equal(tooltipLineColor({ cliloc: 1 }, 'name', true, clamped), '#FFF0C0');
assert.match(renderTooltipResistLine('Resists 1/2/3/4/5', defaults), /#FF6060/);
assert.equal(renderTooltipResistLine('Resists 1/2/3/4/5', clamped), 'Resists 1/2/3/4/5');

console.log('[smoke:tooltip-options] ok');
