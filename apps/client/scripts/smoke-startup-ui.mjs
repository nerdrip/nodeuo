import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

class MiniElement {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.attributes = {};
    this.eventListeners = new Map();
    this.classList = { add: (...names) => { this._classes = [...(this._classes ?? []), ...names]; } };
    this.textContent = '';
    this.value = '';
    this.id = '';
    this._idMap = new Map();
  }

  get firstElementChild() { return this.children[0] ?? null; }

  set innerHTML(html) {
    this._html = String(html ?? '');
    this.children.length = 0;
    this._idMap = new Map();

    const rootMatch = /<([a-zA-Z0-9-]+)([^>]*)>/.exec(this._html);
    const root = new MiniElement(rootMatch?.[1] ?? 'div');
    root.parentNode = this;
    this.children.push(root);
    root._html = this._html;
    root._idMap = this._idMap;
    this._indexElement(root, rootMatch?.[2] ?? '');

    const tagRe = /<([a-zA-Z0-9-]+)([^>]*\sid="([^"]+)"[^>]*)>/g;
    for (const match of this._html.matchAll(tagRe)) {
      const el = new MiniElement(match[1]);
      el.parentNode = root;
      root.children.push(el);
      this._indexElement(el, match[2]);
      this._idMap.set(el.id, el);
    }
  }

  get innerHTML() { return this._html ?? ''; }

  _indexElement(el, attrsRaw) {
    const attrs = String(attrsRaw ?? '');
    const id = /\sid="([^"]+)"/.exec(attrs)?.[1] ?? '';
    const value = /\svalue="([^"]*)"/.exec(attrs)?.[1];
    const type = /\stype="([^"]*)"/.exec(attrs)?.[1];
    if (id) el.id = id;
    if (type) el.type = type;
    if (value != null) el.value = value.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    if (el.tagName === 'SELECT' && id === 'm-mode' && !el.value) el.value = 'ws';
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }

  addEventListener(type, fn) {
    if (!this.eventListeners.has(type)) this.eventListeners.set(type, []);
    this.eventListeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this.eventListeners.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  dispatchEvent(event) {
    event.target ??= this;
    for (const fn of this.eventListeners.get(event.type) ?? []) fn(event);
    return true;
  }

  click() { this.dispatchEvent({ type: 'click' }); }

  focus() { globalThis.document.activeElement = this; }

  querySelector(selector) {
    if (!selector?.startsWith('#')) return null;
    const id = selector.slice(1);
    return this._idMap?.get(id) ?? findById(this, id);
  }
}

function findById(root, id) {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

globalThis.window ??= globalThis;
globalThis.window.innerWidth ??= 1280;
globalThis.window.innerHeight ??= 720;
globalThis.window.addEventListener ??= () => {};
globalThis.window.removeEventListener ??= () => {};
globalThis.window.close ??= () => {};
globalThis.window.prompt ??= () => '';
globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
globalThis.CanvasRenderingContext2D ??= class CanvasRenderingContext2D {
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
globalThis.document = {
  activeElement: null,
  body: new MiniElement('body'),
  addEventListener() {},
  removeEventListener() {},
  createElement(tag) {
    if (tag === 'canvas') {
      const canvas = new MiniElement('canvas');
      canvas.getContext = () => new globalThis.CanvasRenderingContext2D();
      return canvas;
    }
    return new MiniElement(tag);
  },
  querySelector(selector) { return this.body.querySelector(selector); },
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

const { LoginScene, LoginSteps } = await import('../src/scenes/login-scene.js');

const mounted = [];
const gc = {
  ui: { addChildAt() {}, removeChild() {} },
  domMount(el) {
    mounted.push(el);
    document.body.appendChild(el);
  },
  setStatus(status) { this.status = status; },
};
const scene = new LoginScene(gc);
scene._setStep(LoginSteps.Main);

assert.equal(gc.status, 'main');
assert.ok(scene._panel, 'LoginScene should mount a DOM panel');
assert.ok(scene._panel.querySelector('#m-mode'), 'login screen should expose transport mode');
assert.ok(scene._panel.querySelector('#m-host'), 'login screen should expose host input');
assert.ok(scene._panel.querySelector('#m-port'), 'login screen should expose port input');
assert.ok(scene._panel.querySelector('#m-account'), 'login screen should expose account input');
assert.ok(scene._panel.querySelector('#m-password'), 'login screen should expose password input');
assert.ok(scene._panel.querySelector('#m-login'), 'login screen should expose login button');

await scene._doConnect();
assert.match(scene._panel.querySelector('#m-msg').textContent, /please fill/i);
scene.unload();
assert.equal(scene._panel, null);
assert.ok(mounted.length >= 1, 'DOM mount should be exercised');

const gameSceneSource = readFileSync(new URL('../src/scenes/game-scene.js', import.meta.url), 'utf8');
for (const [tag, eventName] of [
  ['ADMIN', 'ui:admin:open'],
  ['PLAYERVENDOR', 'ui:player-vendor:open'],
  ['HUNTMASTER', 'ui:huntmaster:open'],
  ['MAPPINS', 'ui:map-pins:open'],
  ['VVV', 'ui:vvv:open'],
  ['PETTRAINING', 'ui:pet-training:open'],
]) {
  assert.match(gameSceneSource, new RegExp(`${tag}:\\s+'${eventName}'`));
}
for (const sentinel of [
  '@@OPEN_STABLE_GUMP@@',
  '@@OPEN_IMBUING_GUMP@@',
  '@@OPEN_BANKER_GUMP@@',
  '@@OPEN_CRAFT_GUMP@@',
  '@@OPEN_HOUSE_GUMP@@',
]) {
  assert.ok(gameSceneSource.includes(sentinel), `GameScene should handle ${sentinel}`);
}

const { parseMapPinsPayload } = await import('../src/ui/gumps/map-pin-editor-gump.js');
const { parseHuntmasterPayload } = await import('../src/ui/gumps/huntmaster-trophy-gump.js');

const pins = parseMapPinsPayload('40000001||320||320||12|34|Danger;22|44|Bank');
assert.equal(pins.itemSerial, 0x40000001);
assert.equal(pins.width, 320);
assert.deepEqual(pins.pins, [
  { x: 12, y: 34, label: 'Danger' },
  { x: 22, y: 44, label: 'Bank' },
]);

const hunt = parseHuntmasterPayload('dragon||Ancient Dragon||3||1|Alice|500;2|Bob|250');
assert.equal(hunt.target, 'dragon');
assert.equal(hunt.targetName, 'Ancient Dragon');
assert.equal(hunt.tier, 3);
assert.deepEqual(hunt.board, [
  { rank: 1, name: 'Alice', score: 500 },
  { rank: 2, name: 'Bob', score: 250 },
]);

console.log('[smoke:startup-ui] ok');
process.exit(0);
