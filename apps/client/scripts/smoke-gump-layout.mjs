globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
globalThis.window ??= globalThis;
globalThis.window.addEventListener ??= () => {};
globalThis.window.removeEventListener ??= () => {};
globalThis.CanvasRenderingContext2D ??= class CanvasRenderingContext2D {
  constructor() {
    this.font = '';
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
  }

  measureText(text) {
    const width = String(text ?? '').length * 7;
    return {
      width,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: width,
      actualBoundingBoxAscent: 10,
      actualBoundingBoxDescent: 3,
      fontBoundingBoxAscent: 10,
      fontBoundingBoxDescent: 3,
    };
  }

  clearRect() {}
  drawImage() {}
  fillRect() {}
  fillText() {}
  getImageData() { return { data: new Uint8ClampedArray(4) }; }
  restore() {}
  save() {}
  scale() {}
  setTransform() {}
  strokeText() {}
};
globalThis.document ??= {
  createElement(tag) {
    if (tag !== 'canvas') return { style: {}, appendChild() {}, remove() {} };
    return {
      width: 0,
      height: 0,
      getContext() {
        return new globalThis.CanvasRenderingContext2D();
      },
    };
  },
};
globalThis.localStorage ??= (() => {
  const store = new Map();
  return {
    get length() { return store.size; },
    key(index) { return [...store.keys()][index] ?? null; },
    getItem(key) { return store.has(String(key)) ? store.get(String(key)) : null; },
    setItem(key, value) { store.set(String(key), String(value)); },
    removeItem(key) { store.delete(String(key)); },
    clear() { store.clear(); },
  };
})();

const { parseGumpLayout } = await import('../src/ui/gump-layout.js');
const { Button } = await import('../src/ui/controls/button.js');
const { Checkbox } = await import('../src/ui/controls/checkbox.js');
const { Control } = await import('../src/ui/control.js');
const { GumpPicTiled } = await import('../src/ui/controls/gump-pic-tiled.js');
const { ItemPic } = await import('../src/ui/controls/item-pic.js');
const { StaticPic } = await import('../src/ui/controls/static-pic.js');
const { MobilePic } = await import('../src/ui/controls/mobile-pic.js');
const { CroppedText } = await import('../src/ui/controls/cropped-text.js');
const { HtmlControl } = await import('../src/ui/controls/html-control.js');
const { CheckerTrans } = await import('../src/ui/controls/checker-trans.js');
const { GumpPic } = await import('../src/ui/controls/gump-pic.js');
const { Label } = await import('../src/ui/controls/label.js');
const { OptionsGump } = await import('../src/ui/gumps/options-gump.js');
const { SpellbookGump } = await import('../src/ui/gumps/spellbook-gump.js');
const { CraftGump, parseCraftPayload } = await import('../src/ui/gumps/craft-gump.js');
const { BuyShopGump } = await import('../src/ui/gumps/buy-gump.js');
const { TradingGump } = await import('../src/ui/gumps/trading-gump.js');
const { UIManager } = await import('../src/ui/ui-manager.js');
const { Gump } = await import('../src/ui/gump.js');
const { Container } = await import('pixi.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Regression: an explicitly requested 32x32 icon must remain fixed-size
// when its atlas texture resolves. Value-based auto-size detection used to
// mistake this very common explicit size for the loading placeholder.
const fixed32 = new GumpPic(0x08C0, { width: 32, height: 32 });
assert(fixed32._explicitSize === true, 'explicit 32x32 gump art should not auto-resize');
fixed32.dispose();
const natural = new GumpPic(0x08AC);
assert(natural._explicitSize === false, 'size-less gump art should use natural atlas bounds');
natural.dispose();

// Explicitly authored button bounds must remain stable after its native art
// resolves. The old implementation guessed intent from `50x22`, causing
// exactly that common size to jump asynchronously.
const fixedButton = new Button({
  normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
  width: 50, height: 22, label: 'OK',
});
assert(fixedButton._explicitSize === true, 'explicit button bounds should be sticky');
fixedButton.dispose();

let toggled = null;
const checkbox = new Checkbox({ checked: false });
checkbox.onToggle = (value) => { toggled = value; };
checkbox.onClick();
assert(toggled === true && checkbox.checked === true, 'checkbox should notify its consumer on user toggle');
checkbox.dispose();

const bounded = new Control();
bounded.setPosition(Number.NaN, Number.POSITIVE_INFINITY);
bounded.setSize(Number.POSITIVE_INFINITY, -20);
assert(bounded.x === 0 && bounded.y === 0, 'invalid server coordinates should normalize to zero');
assert(bounded.width === 0 && bounded.height === 0, 'invalid/negative server sizes should be bounded');
bounded.dispose();

const craftPayload = parseCraftPayload('blacksmithing|75.0|1|Dagger|7|20|70;2|Plate Chest|7|80|120');
assert(craftPayload.recipes.length === 2 && craftPayload.skillVal === 75,
  'craft payload should parse bounded recipes and skill values');
const craft = new CraftGump({ ...craftPayload, net: { sendCommand() {} } });
assert(craft._visibleRecipes().length === 2, 'craft gump should expose parsed recipes');
craft._search.setValue('plate');
assert(craft._visibleRecipes().length === 1, 'craft search should filter without rebuilding the window');
craft._onlyCraftable = true;
assert(craft._visibleRecipes().length === 0, 'craftable filter should use the authoritative skill value');
craft.dispose();
const richCraft = parseCraftPayload(
  'smithing|100.0|7001|Dagger|8|20|100|Weapons|3921|1|smith|7154:3:ingots|1|0.1|iron:0:0,valorite:2219:99',
);
assert(richCraft.recipes[0].materials[1].name === 'valorite',
  'negotiated craft payload should preserve the server-validated material palette');

const shopLine = { serial: 0x40000001, itemId: 0x0F3F, description: 'Arrow', amount: 3, price: 2 };
const shop = new BuyShopGump({ vendor: 0x1234, items: [shopLine] });
shop._addToBasket(shopLine, 5);
assert(shop._basket.get(shop._lineKey(shopLine)).qty === 3,
  'vendor basket should never exceed authoritative stock');
shop._search.setValue('missing');
assert(shop._stockRows.length === 0, 'vendor search should filter the stock pane');
shop.dispose();

const trade = new TradingGump({ containerSerial: 1, ourSerial: 2, otherSerial: 3, partnerName: 'Tester' });
assert(trade._ourCheckLabel?._cachedText === 'I accept', 'trade acceptance checkbox should have a visible label');
trade._ourCheck.setChecked(true, { silent: true });
trade._resetLocalAcceptance();
assert(!trade._ourCheck.checked && trade._theirState._cachedText.includes('WAITING'),
  'trade mutation should reset both acceptance indicators');
trade.dispose();

const uiRoot = new Container();
const ui = new UIManager(uiRoot);
const keyboardGump = new Gump();
keyboardGump.setSize(180, 80);
const firstButton = new Button({ normalGumpId: 0, pressedGumpId: 0, width: 60, height: 22, flat: true, label: 'First' });
const secondButton = new Button({ normalGumpId: 0, pressedGumpId: 0, width: 60, height: 22, flat: true, label: 'Second' });
secondButton.setPosition(70, 0);
keyboardGump.add(firstButton);
keyboardGump.add(secondButton);
ui.addGump(keyboardGump);
ui._cycleFocus(1);
assert(ui.focused === firstButton, 'Tab focus should start at the first focusable control');
ui._cycleFocus(1);
assert(ui.focused === secondButton, 'Tab focus should advance deterministically');
keyboardGump.isModal = true;
ui.setModal(keyboardGump);
assert(ui.isModalOpen() && ui.focused === firstButton, 'modal activation should trap input and focus its first control');
ui.destroy();

const gump = parseGumpLayout({
  layout: [
    '{ gumppictiled 10 20 64 48 2620 }',
    '{ buttontileart 3 4 4000 4001 1 0 55 3854 123 6 7 }',
    '{ tilepichue 12 13 4011 44 }',
    '{ tilepicfit 70 12 4012 55 48 42 }',
    '{ mobilepic 130 12 200 0 0 52 52 }',
    '{ croppedtext 0 25 30 14 33 0 }',
    '{ htmlgump 40 80 90 34 1 1 1 }',
    '{ checkertrans 0 0 20 20 }',
  ].join(''),
  textLines: [
    'This label is intentionally too long',
    '<basefont color="#ffd06a"><b>Wrapped heading</b><br>Long server text must stay inside its declared rectangle and scroll.</basefont>',
  ],
  serverSerial: 1,
  gumpSerial: 2,
  x: 30,
  y: 40,
});

const tiled = gump.children.find((control) => control instanceof GumpPicTiled);
assert(tiled, 'gumppictiled should create GumpPicTiled');
assert(tiled.gumpId === 2620, 'gumppictiled should keep the gump id');
assert(tiled.width === 64 && tiled.height === 48, 'gumppictiled should keep requested bounds');
const initialGumpWidth = gump.width;
tiled.width = 280;
tiled.onResize?.();
assert(gump.width >= 290 && gump.width > initialGumpWidth, 'async native-art resize should expand the gump hit bounds');

const button = gump.children.find((control) => control instanceof Button && control.buttonId === 55);
assert(button, 'buttontileart should create a Button');
const art = button.children.find((control) => control instanceof ItemPic);
assert(art, 'buttontileart should attach static tile art');
assert(art.itemId === 3854, 'buttontileart should keep the item graphic id');
assert(art.hue === 123, 'buttontileart should keep the item hue');
assert(art.x === 6 && art.y === 7, 'buttontileart should apply tile offsets');
assert(art.acceptMouseInput === false, 'buttontileart overlay should not steal button clicks');

const staticPic = gump.children.find((control) => control instanceof StaticPic);
assert(staticPic, 'tilepichue should create StaticPic');
assert(staticPic.itemId === 4011, 'tilepichue should keep the static graphic id');
assert(staticPic.hue === 44, 'tilepichue should keep the static hue');

const fittedPic = gump.children.find((control) => control instanceof ItemPic
  && !(control instanceof StaticPic) && control.itemId === 4012);
assert(fittedPic, 'tilepicfit should create a bounded ItemPic');
assert(fittedPic.maxWidth === 48 && fittedPic.maxHeight === 42,
  'tilepicfit should preserve its containment box');

const mobilePic = gump.children.find((control) => control instanceof MobilePic);
assert(mobilePic, 'mobilepic should create a web-client mobile preview');
assert(mobilePic.body === 200 && mobilePic.width === 52 && mobilePic.height === 52,
  'mobilepic should preserve body and bounds');

const cropped = gump.children.find((control) => control instanceof CroppedText);
assert(cropped, 'croppedtext should create CroppedText');
assert(cropped.width === 30 && cropped.height === 14, 'croppedtext should keep requested bounds');
assert(cropped._label._cachedText.endsWith('...'), 'croppedtext should ellipsize overflowing text');
assert(cropped._label.width <= cropped.width, 'croppedtext should fit text inside the crop width');
cropped.setSize(240, 14);
cropped.setText('Short');
assert(cropped._label._cachedText === 'Short', 'croppedtext should avoid ellipsis when text fits after resize');
cropped.setSize(30, 14);
cropped.setText('This label is intentionally too long');
assert(cropped._label._cachedText.endsWith('...'), 'croppedtext should recompute ellipsis after resize');
assert(cropped._label.width <= cropped.width, 'croppedtext should remain within bounds after resize');

const overlay = gump.children.find((control) => control instanceof CheckerTrans);
assert(overlay, 'checkertrans should add a translucent overlay');
assert(overlay.width === 20 && overlay.height === 20, 'checkertrans should keep requested bounds');
assert(overlay.acceptMouseInput === false, 'checkertrans overlay should not receive mouse input');

const html = gump.children.find((control) => control instanceof HtmlControl);
assert(html, 'htmlgump should create the bounded HTML renderer');
assert(html.width === 90 && html.height === 34, 'htmlgump should preserve its viewport bounds');
assert(html.contentHeight > html.height, 'long htmlgump content should wrap inside the viewport');
assert(html._content.mask === html._mask, 'htmlgump content should be clipped by its viewport mask');
const beforeScroll = html._scrollY;
html.onWheel(120);
assert(html._scrollY > beforeScroll, 'scrollable htmlgump should move through overflow content');

gump.dispose();

// Fuzz boundary: malformed coordinates and command floods must stay bounded,
// finite and disposable without allocating an unbounded control tree.
const fuzz = parseGumpLayout({
  layout: '{ text NaN Infinity 0 0 }' + '{ page 1 }'.repeat(5000) + '{ text 1 1 0 0 }',
  textLines: ['x'.repeat(20000), ...Array.from({ length: 5000 }, () => 'ignored')],
  serverSerial: -1,
  gumpSerial: Number.MAX_SAFE_INTEGER,
  x: Number.NaN,
  y: Number.POSITIVE_INFINITY,
});
assert(fuzz.children.length <= 4096, 'malicious gump layouts must respect the control/command budget');
for (const control of fuzz.children) {
  assert(Number.isFinite(control.x) && Number.isFinite(control.y), 'malformed control coordinates must normalize');
  assert(Number.isFinite(control.width) && Number.isFinite(control.height), 'malformed control bounds must normalize');
}
fuzz.dispose();

// Options is a vertical-sidebar layout with two bounded content columns.
// Every category is built once here so future settings cannot silently push a
// slider back over the neighbouring column.
globalThis.innerWidth = 1440;
globalThis.innerHeight = 900;
const options = new OptionsGump();
assert(options.width === 900, 'Options should use the readable wide layout');
assert(options._tabButtons.length === 12, 'Options should expose every category in the sidebar');
assert(new Set(options._tabButtons.map((tab) => tab.ctrl.y)).size === 12,
  'Options categories should be vertically separated');
assert(options._contentScroll.x >= 180, 'Options content must start after the sidebar');
for (const tab of options._tabs) {
  options._showTab(tab.id);
  const sliders = options._tabContent.filter((control) => Number.isFinite(control?._value));
  for (const slider of sliders) {
    if (slider.x < 338) {
      assert(slider.x + slider.width < 338, `${tab.id}: left slider crosses into right column`);
    } else {
      assert(slider.x + slider.width <= 682, `${tab.id}: right slider leaves its panel`);
    }
  }
  assert(options._contentDecor, `${tab.id}: content panels should be rendered`);
}
options._showTab('audio'); // cancel any lazy voice-tab continuation before dispose
options.dispose();

// ClassicUO spellbook regression: offset=1 high bits 28/29 are Magery
// spells 61/62. Unknown entries must not create empty detail spreads.
const spellbook = new SpellbookGump(0x7f000001, 0xFFB1, {
  x: 100, y: 100, offset: 1, hi: 0x30000000, lo: 0,
});
assert(spellbook.width === 406 && spellbook.height === 229,
  'spellbook should keep its ClassicUO native 406x229 bounds');
assert(spellbook._maxPage === 5 && spellbook._icons.length === 2,
  'two known Magery spells should share one detail spread after four indexes');
assert(spellbook._cornerLeft.x === 50 && spellbook._cornerLeft.width === 37,
  'spellbook left page curl should use ClassicUO coordinates');
assert(spellbook._cornerRight.x === 321 && spellbook._cornerRight.width === 36,
  'spellbook right page curl should use ClassicUO coordinates');
spellbook._gotoPage(5);
const spellNames = spellbook._pageControls
  .filter((control) => control instanceof Label && control.y === 34)
  .map((control) => control._cachedText);
assert(spellNames.includes('Summon\nDaemon'),
  'long spell names should wrap instead of being ellipsized');
spellbook.dispose();
console.log('[smoke:gump-layout] ok');
