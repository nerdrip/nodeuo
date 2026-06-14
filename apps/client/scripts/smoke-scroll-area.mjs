import { ScrollArea } from '../src/ui/controls/scroll-area.js';
import { Control } from '../src/ui/control.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const scroll = new ScrollArea({ width: 100, height: 40 });
const child = new Control();
child.setSize(20, 20);
child.setPosition(5, 60);
scroll.add(child);

assert(scroll.content.children.includes(child.node), 'control child should render inside clipped content');
assert(scroll.pickAt(6, 25)?.control !== child, 'offscreen child should not be hittable before scroll');

scroll.scrollTo(40);
assert(scroll.scrollY === 40, 'scrollY getter should expose current scroll position');
assert(scroll.pickAt(6, 25)?.control === child, 'scrolled child should be hittable in viewport coordinates');
assert(scroll.pickAt(90, 10)?.control === scroll, 'scrollbar hit should target scroll area');

let onScrollCalls = 0;
scroll.onScroll = () => { onScrollCalls++; };
scroll.scrollTo(20);
assert(scroll.scrollY === 20, 'scrollTo should update scrollY');
assert(onScrollCalls === 1, 'onScroll should fire only when scroll changes');
scroll.scrollTo(20);
assert(onScrollCalls === 1, 'onScroll should not fire when scroll stays unchanged');

scroll.remove(child);
assert(!scroll.content.children.includes(child.node), 'removed control should leave clipped content');

scroll.beginBulkUpdate();
const a = new Control();
a.setSize(10, 10);
a.setPosition(0, 0);
const b = new Control();
b.setSize(10, 10);
b.setPosition(0, 60);
scroll.add(a);
scroll.add(b);
scroll.remove(a);
scroll.endBulkUpdate();
assert(scroll.children.length === 1 && scroll.children[0] === b, 'bulk add/remove should keep control list exact');
assert(scroll.content.children.includes(b.node), 'bulk child should render inside clipped content');

console.log('[smoke:scroll-area] ok');
