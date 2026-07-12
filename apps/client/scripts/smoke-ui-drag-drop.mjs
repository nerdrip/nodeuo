import assert from 'node:assert/strict';
import { Container } from 'pixi.js';

const listeners = new Map();
globalThis.window = globalThis;
globalThis.innerWidth = 1280;
globalThis.innerHeight = 720;
globalThis.addEventListener = (type, fn) => {
  if (!listeners.has(type)) listeners.set(type, []);
  listeners.get(type).push(fn);
};
globalThis.removeEventListener = (type, fn) => {
  const list = listeners.get(type);
  if (!list) return;
  const idx = list.indexOf(fn);
  if (idx >= 0) list.splice(idx, 1);
};
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

// Import after browser globals exist: UIManager pulls in the profile
// singleton during module evaluation.
const { UIManager } = await import('../src/ui/ui-manager.js');
const { Gump } = await import('../src/ui/gump.js');
const { Control } = await import('../src/ui/control.js');

function mouse(button, x, y) {
  return {
    button,
    clientX: x,
    clientY: y,
    preventDefault() {},
    stopPropagation() {},
  };
}

class TestGump extends Gump {
  constructor(x, y, w = 80, h = 80) {
    super();
    this.setPosition(x, y);
    this.setSize(w, h);
  }
  get type() { return 'test'; }
}

class TestControl extends Control {
  constructor(x, y, w, h) {
    super();
    this.setPosition(x, y);
    this.setSize(w, h);
  }
}

const ui = new UIManager(new Container());
ui.setScale(1.25);

const sourceGump = new TestGump(10, 10);
const source = new TestControl(5, 5, 20, 20);
let dragStarted = 0;
let sourceMouseUp = 0;
source.onDragStart = () => { dragStarted++; };
source.onMouseUp = () => { sourceMouseUp++; };
sourceGump.add(source);
ui.addGump(sourceGump);

const targetGump = new TestGump(120, 10);
const dropParent = new TestControl(10, 10, 60, 60);
const dropChild = new TestControl(8, 9, 20, 20);
let dropInfo = null;
dropParent.onDrop = (btn, lx, ly) => {
  dropInfo = { btn, lx, ly };
};
dropParent.add(dropChild);
targetGump.add(dropParent);
ui.addGump(targetGump);

ui._onMouseDown(mouse(0, 25, 25));
ui._onMouseMove(mouse(0, 40, 25));
assert.equal(dragStarted, 1, 'drag source should start after threshold');
ui._onMouseUp(mouse(0, 141 * 1.25, 33 * 1.25));

assert.equal(sourceMouseUp, 1, 'source should receive mouse up');
assert.deepEqual(dropInfo, { btn: 0, lx: 11, ly: 13 }, 'drop should translate through child to parent local coords');

const movable = new TestGump(220, 20);
ui.addGump(movable);
ui._onMouseDown(mouse(0, 230 * 1.25, 30 * 1.25));
ui._onMouseMove(mouse(0, 250 * 1.25, 45 * 1.25));
assert.ok(ui._dragging, 'first threshold-crossing move should arm gump drag');
ui._onMouseMove(mouse(0, 255 * 1.25, 50 * 1.25));
assert.equal(movable.x, 225, 'gump drag should update x from armed drag offset');
assert.equal(movable.y, 25, 'gump drag should update y from armed drag offset');
ui._onMouseUp(mouse(0, 250 * 1.25, 45 * 1.25));
assert.equal(ui._dragging, null, 'gump drag should clear on mouse up');

ui.destroy();
console.log('[smoke:ui-drag-drop] ok');
