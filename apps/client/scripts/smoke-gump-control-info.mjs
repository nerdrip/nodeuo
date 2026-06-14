import assert from 'node:assert/strict';

const {
  ensureGumpControlInfo,
  getGumpControlInfo,
} = await import('../src/ui/controls/gump-control-info.js');

const control = {};
const info = ensureGumpControlInfo(control);
assert.equal(info.appendTooltip('First'), 'First');
assert.equal(info.appendTooltip('Second'), 'First\nSecond');
assert.equal(info.setItemPropertySerial(0x40001234), 0x40001234);
assert.equal(getGumpControlInfo(control), info);
assert.equal(control.gumpControlInfo.tooltipText, 'First\nSecond');

const gump = {};
ensureGumpControlInfo(gump).setMasterGumpSerial(0x1234);
assert.equal(getGumpControlInfo(gump).masterGumpSerial, 0x1234);

console.log('[smoke:gump-control-info] ok');
