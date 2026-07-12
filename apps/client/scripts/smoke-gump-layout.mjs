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
const { GumpPicTiled } = await import('../src/ui/controls/gump-pic-tiled.js');
const { ItemPic } = await import('../src/ui/controls/item-pic.js');
const { StaticPic } = await import('../src/ui/controls/static-pic.js');
const { CroppedText } = await import('../src/ui/controls/cropped-text.js');
const { HtmlControl } = await import('../src/ui/controls/html-control.js');
const { CheckerTrans } = await import('../src/ui/controls/checker-trans.js');
const { GumpPic } = await import('../src/ui/controls/gump-pic.js');
const { OptionsGump } = await import('../src/ui/gumps/options-gump.js');

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

const gump = parseGumpLayout({
  layout: [
    '{ gumppictiled 10 20 64 48 2620 }',
    '{ buttontileart 3 4 4000 4001 1 0 55 3854 123 6 7 }',
    '{ tilepichue 12 13 4011 44 }',
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
console.log('[smoke:gump-layout] ok');
