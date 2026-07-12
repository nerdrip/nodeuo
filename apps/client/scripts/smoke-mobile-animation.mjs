import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage ?? {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { assets } = await import('../src/assets/asset-manager.js');
const {
  Action,
  ANIMATION_PRIORITY,
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
    // A real rat frame is intentionally smaller than 16 px. It must remain
    // body 238 instead of switching per-frame to BODY_FALLBACK (llama/horse).
    238: {
      actions: {
        0: { dirs: { 0: [{ page: 0, u: 0, v: 0, w: 9, h: 13, cx: 5, cy: 1 }] } },
      },
    },
    // Plain monster body.
    9: action(0, 1, 4, 12, 13, 19),
    // Human body with people groups.
    400: action(0, 4, 9, 16, 20, 21, 22, 30),
    // Gargoyle-ish body with real SA fly idle.
    666: action(4, 19, 62, 64),
    // Modern body: logical UOP actions alias a physical stored group.
    717: {
      ...action(1, 11),
      actionAliases: { 22: 11, 24: 11, 25: 11 },
    },
  },
  mobTypes: {
    717: { type: 'MONSTER', flags: 0x10000 },
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
assert.equal(resolveGroup(717, Action.Walk), 22, 'UOP monster uses peaceful walk group');
assert.equal(resolveGroup(717, Action.Run), 24, 'UOP monster uses dedicated run group');
assert.equal(resolveGroup(717, Action.Idle), 25, 'UOP monster uses peaceful idle group');
assert.equal(resolveGroup(717, Action.Idle, { inWarMode: true }), 1, 'UOP monster uses war idle group');
assert.equal(resolveRenderableGroup(717, Action.Idle, null, 0), 25, 'logical UOP alias remains renderable');
assert.equal(assets._tryMobileFrame(717, 25, 0, 0).action, 11, 'asset lookup follows physical action alias');
assert.equal(
  assets._mobileFrameMeta(238, 0, 0, 0).realBody,
  238,
  'small but valid rat art never switches to a horse-sized fallback',
);

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

const directional = new MobileAnimation();
directional.frame = 4;
directional.setDirection(6);
assert.equal(directional.frame, 4, 'turning preserves the gait frame like ClassicUO AnimIndex');

const death = new MobileAnimation();
death.setAction(Action.DieFwd, {
  oneShot: true,
  frameCount: 3,
  delay: 10,
  priority: ANIMATION_PRIORITY.Death,
  holdLastFrame: true,
});
assert.equal(
  death.setAction(Action.GetHit, { oneShot: true, priority: ANIMATION_PRIORITY.Hit }),
  false,
  'hit reaction cannot interrupt death',
);
death.tick(1);
assert.equal(death.action, Action.DieFwd, 'death remains the active action');
assert.equal(death.frame, 2, 'death holds its final frame until the corpse replaces it');

const repeated = new MobileAnimation();
repeated.setAction(Action.Attack, {
  oneShot: true,
  frameCount: 2,
  repeatCount: 3,
  delay: 1,
  priority: ANIMATION_PRIORITY.Server,
});
repeated.tick(1);
assert.equal(repeated.action, Action.Attack, 'repeatCount keeps a one-shot active across wraps');
repeated.tick(1);
assert.equal(repeated.action, Action.Attack, 'repeatCount drains one completed cycle at a time');
repeated.tick(1);
assert.equal(repeated.action, Action.Idle, 'one-shot returns to idle after the requested repeats');

const stalled = new MobileAnimation();
stalled.setAction(Action.Attack, { frameCount: 100, delay: 1 });
stalled.tick(99);
assert.ok(stalled.frame <= 4, 'background-tab delta advances at most four frames per render tick');

const gait = new MobileAnimation();
gait.setAction(Action.Walk);
gait._frameCount = 6;
gait.setContext({ moveDurationMs: 400 });
for (let i = 0; i < 4; i++) gait.tick(0.1);
assert.equal(gait.frame, 0, 'walk completes one gait cycle per tile interpolation');
gait.setAction(Action.Run);
gait.setContext({ run: true, moveDurationMs: 200 });
gait._frameCount = 6;
for (let i = 0; i < 2; i++) gait.tick(0.1);
assert.equal(gait.frame, 0, 'run completes one gait cycle in half the walk time');

console.log('[smoke:mobile-animation] ok');
