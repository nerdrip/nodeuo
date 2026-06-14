import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage ?? {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
globalThis.document = globalThis.document ?? {
  addEventListener: () => {},
  removeEventListener: () => {},
};

const { assets } = await import('../src/assets/asset-manager.js');
assets.speeches = {
  entries: [
    { id: 1, keyword: 'bank' },
    { id: 2, keyword: 'thank you' },
  ],
};

const { isVendorKeyword } = await import('../src/managers/chat-manager.js');
assert.equal(isVendorKeyword('Bank, please!'), true);
assert.equal(isVendorKeyword('I would like to thank you.'), true);
assert.equal(isVendorKeyword('snowbank'), false);

const { bus } = await import('../src/core/event-bus.js');
const { world } = await import('../src/world/world.js');
const { messageManager, TextType } = await import('../src/managers/message-manager.js');

world.player = { serial: 0x01020304 };
messageManager.install();

let journalLine = null;
const off = bus.on('message:journal', (m) => { journalLine = m; });
bus.emit('chat:unicode', {
  serial: 0x01020304,
  name: 'Player',
  text: 'Bank, please!',
  hue: 0xffff,
  font: 3,
  type: 0,
  language: 'ENU',
});
off?.();

assert.equal(journalLine?.textType, TextType.Normal);
assert.equal(journalLine?.matchesVendorKeyword, true);

console.log('[smoke:speech-keywords] ok');
