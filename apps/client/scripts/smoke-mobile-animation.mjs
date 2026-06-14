import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage ?? {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { assets } = await import('../src/assets/asset-manager.js');
const {
  Action,
  MobileAnimation,
  resolveGroup,
  resolveRenderableGroup,
} = await import('../src/renderer/mobile-animation.js');

function action(...ids) {
  const actions = {};
  for (const id of ids) {
    actions[id] = { dirs: { 0: [{ page: 0, u: 0, v: 0, w: 32, h: 32, cx: 16, cy: 32 }] } };
  }
  return { actions };
}

assets.mobilesAtlas = {
  aliases: {},
  bodies: {
    // Body < 200 but only LOW animal groups exist, a common bodyconv/mobtypes case.
    6: action(0, 2, 5, 8, 9),
    // Plain animal body.
    226: action(0, 1, 2, 5, 8, 9, 10, 12),
    // Plain monster body.
    9: action(0, 1, 4, 12, 13, 19),
    // Human body with people groups.
    400: action(0, 4, 9, 16, 20, 21, 22, 30),
    // Gargoyle-ish body with real SA fly idle.
    666: action(4, 19, 62, 64),
  },
};
assets.prefetchMobileCycle = async () => {};

assert.equal(resolveGroup(6, Action.Idle), 1, 'range-only resolver still sees body 6 as High');
assert.equal(resolveRenderableGroup(6, Action.Idle, null, 0), 2, 'body 6 remaps idle to Low stand');
assert.equal(resolveRenderableGroup(6, Action.Attack, null, 0), 5, 'body 6 remaps attack to Low attack');

assert.equal(resolveRenderableGroup(226, 17, null, 0), 9, 'server High fidget maps to Low fidget');
assert.equal(resolveRenderableGroup(400, 2, null, 0), 21, 'server High die1 maps to People die1');
assert.equal(resolveRenderableGroup(400, 15, null, 0), 30, 'server High walk-warmode maps to People turn');
assert.equal(resolveRenderableGroup(9, 19, null, 0), 19, 'monster fly stays on High fly when present');

const anim = new MobileAnimation();
anim.setBody(6);
anim.setAction(Action.Attack);
assert.equal(anim.currentGroupId(), 5);

anim.setBody(400);
anim.setContext({ isFlying: true });
anim.setAction(Action.Idle);
assert.equal(anim.currentGroupId(), 4, 'flying human without fly frames falls back to stand');

anim.setBody(666);
anim.setContext({ isFlying: true });
anim.setAction(Action.Idle);
assert.equal(anim.currentGroupId(), 19, 'gargoyle body keeps SA fly idle when present');

anim.setAction(9, { staticFrame: 3 });
anim.tick(99);
assert.equal(anim.frame, 3, 'static server animation frame stays pinned');
anim.setAction(Action.Idle);
anim.tick(99);
assert.notEqual(anim.action, 9, 'static animation clears when a new action starts');

console.log('[smoke:mobile-animation] ok');
