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
const { mountInfoForItem } = await import('../src/shared/mount-data.js');
const { normalizeUoHueIndex } = await import('../src/renderer/hue-filter.js');

function action(...ids) {
  const actions = {};
  for (const id of ids) {
    actions[id] = { dirs: { 0: [{ page: 0, u: 0, v: 0, w: 32, h: 32, cx: 16, cy: 32 }] } };
  }
  return { actions };
}

assets.mobilesAtlas = {
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
    // Body.def in older clients maps these to ostard/llama compatibility
    // art, but the extracted Bodyconv/UOP body is complete and canonical.
    794: action(0, 1, 2, 5, 8),
    219: action(0, 1, 2, 5, 8),
  },
  aliases: { 794: { trueBody: 219, hue: 2128 } },
  mobTypes: {
    717: { type: 'MONSTER', flags: 0x10000 },
  },
  equipConv: {
    400: {
      100: { animBody: 500, gump: 123, hue: 321 },
      101: { animBody: 501, gump: 124, hue: 322 },
    },
  },
};
assets.tiledata = {
  land: [{ name: 'native grass', flags: 1, texId: 0 }],
  statics: [{ name: 'native chair', flags: 2, height: 4 }],
};
assets.multis = {
  count: 1,
  multis: { 42: [{ id: 100, x: 0, y: 0, z: 0, visible: true }] },
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
assert.equal(
  assets._mobileFrameMeta(794, 2, 0, 0).realBody,
  794,
  'canonical swamp-dragon frames win over obsolete Body.def ostard alias',
);
assert.equal(assets.mobileRenderHue(794, 77), 77, 'exact mount art keeps the server hue');
assets.mobilesAtlas.aliases[238] = { trueBody: 226, hue: 1444 };
assert.equal(assets.mobileRenderHue(238, 77), 1444, 'a real Body.def replacement overrides hue like CUO');
delete assets.mobilesAtlas.aliases[238];
assets.applyAssetOverrides({
  schemaVersion: 2,
  land: { 0: { file: 'overrides/land-0.png', updatedAt: 123, metadata: { name: 'custom grass', flags: 7, texId: 3 } } },
  static: { 0: { file: 'overrides/static-0.png', updatedAt: 123, metadata: { name: 'custom chair', flags: 8, height: 9 } } },
  multi: { 42: { components: [{ id: 200, x: 1, y: 2, z: 3, visible: false }] } },
  animation: {
    50000: {
      name: 'voidling', type: 'MONSTER', updatedAt: 123,
      actions: { 0: { dirs: { 0: [{ file: 'overrides/animation-50000-0-0-0.png', w: 17, h: 23, cx: 8, cy: 22 }] } } },
    },
  },
});
assert.deepEqual(assets.tiledata.land[0], { name: 'custom grass', flags: 7, texId: 3 }, 'custom land metadata overlays native TileData in memory');
assert.deepEqual(assets.tiledata.statics[0], { name: 'custom chair', flags: 8, height: 9 }, 'custom item metadata overlays native TileData in memory');
assert.deepEqual(assets.multis.multis[42], [{ id: 200, x: 1, y: 2, z: 3, visible: false }], 'custom multi blueprint overlays the extracted native record');
const customFrame = assets._tryMobileFrame(50000, 1, 4, 0);
assert.equal(customFrame.realBody, 50000, 'custom mobile body wins without a native atlas row');
assert.equal(customFrame.meta.customFile, 'overrides/animation-50000-0-0-0.png');
assert.equal(customFrame.meta.customRevision, 123, 'custom frame URLs carry a cache-busting revision');
assert.equal(assets.mobileRenderBody(50000), 50000);
assert.deepEqual(assets.mobileBodyInfo(50000), { type: 'MONSTER', custom: true, name: 'voidling' });
assets.tiledata = {
  land: [{ name: 'regenerated grass', flags: 11, texId: 8, season: 'spring' }],
  statics: [{ name: 'regenerated chair', flags: 12, height: 6, material: 'oak' }],
};
assets.applyAssetOverrides({ schemaVersion: 2,
  land: { 0: { file: 'overrides/land-0.png', updatedAt: 124, metadata: { name: 'custom grass', flags: 7, texId: 3 } } },
  static: { 0: { file: 'overrides/static-0.png', updatedAt: 124, metadata: { name: 'custom chair', flags: 8, height: 9 } } },
  multi: { 42: { components: [{ id: 201, x: 4, y: 5, z: 6, visible: true }] } },
  animation: {
    50000: {
      name: 'voidling', type: 'MONSTER', updatedAt: 123,
      actions: { 0: { dirs: { 0: [{ file: 'overrides/animation-50000-0-0-0.png', w: 17, h: 23, cx: 8, cy: 22 }] } } },
    },
  },
});
assert.equal(assets.tiledata.land[0].season, 'spring', 'custom reload preserves fields from freshly regenerated native TileData');
assert.equal(assets.tiledata.statics[0].material, 'oak', 'custom reload does not restore stale native item metadata');
assert.deepEqual(assets.multis.multis[42], [{ id: 201, x: 4, y: 5, z: 6, visible: true }], 'hot reload replaces the active custom multi blueprint');
assets.applyAssetOverrides({ schemaVersion: 2, land: {}, static: {}, multi: {}, animation: {
  50000: {
    name: 'voidling', type: 'MONSTER', updatedAt: 123,
    actions: { 0: { dirs: { 0: [{ file: 'overrides/animation-50000-0-0-0.png', w: 17, h: 23, cx: 8, cy: 22 }] } } },
  },
} });
assert.deepEqual(assets.tiledata.land[0], { name: 'regenerated grass', flags: 11, texId: 8, season: 'spring' }, 'removing a land override restores freshly regenerated native metadata');
assert.deepEqual(assets.tiledata.statics[0], { name: 'regenerated chair', flags: 12, height: 6, material: 'oak' }, 'removing an item override restores freshly regenerated native metadata');
assert.deepEqual(assets.multis.multis[42], [{ id: 100, x: 0, y: 0, z: 0, visible: true }], 'removing a multi override restores the extracted Ultima blueprint');
assert.deepEqual(
  assets.resolveEquipAnim(400, 100, 77),
  { animBody: 500, hue: 77 },
  'an item dye wins over the Equipconv default hue',
);
assert.deepEqual(
  assets.resolveEquipAnim(400, 101, 0),
  { animBody: 501, hue: 322 },
  'an unhued item inherits the Equipconv default hue',
);
assert.deepEqual(
  mountInfoForItem(0x3EBD),
  { itemId: 0x3EBD, body: 0x031A, riderOffsetY: 0 },
  'Layer.Mount swamp-dragon item resolves without relying on corrupt tiledata',
);
assert.equal(mountInfoForItem(0x3EB4).riderOffsetY, -9, 'unicorn rider offset mirrors ClassicUO');
assert.equal(normalizeUoHueIndex(0), -1, 'unhued art bypasses the LUT');
assert.equal(normalizeUoHueIndex(1), 0, 'UO hue one maps to LUT row zero');
assert.equal(normalizeUoHueIndex(0x83EA), 1001, 'skin hue strips packet flag bits before LUT lookup');
assert.equal(normalizeUoHueIndex(0xC3EA), 1001, 'partial-hue flag does not change the palette row');

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
gait.tick(0.09);
gait.tick(0.09);
assert.equal(gait.frame, 2, 'walk advances at ClassicUO 80 ms character-frame cadence');
gait.setAction(Action.Run);
gait.setContext({ run: true, moveDurationMs: 200 });
gait._frameCount = 6;
gait.tick(0.09);
gait.tick(0.09);
assert.equal(gait.frame, 4, 'run uses the same 80 ms frame timer instead of racing one cycle per tile');

const sustainedRun = new MobileAnimation();
sustainedRun.setBody(400);
sustainedRun.setContext({ run: true, moveDurationMs: 200 });
sustainedRun.setAction(Action.Run);
sustainedRun._frameCount = 6;
for (let i = 0; i < 30; i++) sustainedRun.tick(0.08);
assert.equal(sustainedRun.action, Action.Run, 'locomotion remains active after multiple complete run cycles');
assert.equal(sustainedRun.frame, 0, 'run animation continues wrapping instead of holding a mid-air frame');

const fidgetInterruptedByRun = new MobileAnimation();
fidgetInterruptedByRun.setAction(Action.Fidget, {
  oneShot: true,
  priority: ANIMATION_PRIORITY.Fidget,
});
assert.equal(
  fidgetInterruptedByRun.setAction(Action.Run, { priority: ANIMATION_PRIORITY.Locomotion }),
  true,
  'movement immediately interrupts an idle fidget',
);
assert.equal(fidgetInterruptedByRun.action, Action.Run);

assets.configureMobileAtlas({
  shardSize: 64,
  bodies: {},
  aliases: { 524: { trueBody: 545, hue: 0 } },
  shards: { 8: { file: 'mobiles-atlas-008.json' } },
});
assert.equal(
  assets.isMobileBodyMetadataReady(524),
  false,
  'equipment metadata is transiently pending before its atlas shard lands',
);
assets._mobileLoadedShards.add('mobiles-atlas-008.json');
assert.equal(
  assets.isMobileBodyMetadataReady(524),
  true,
  'equipment metadata becomes authoritative once the shard is loaded',
);

console.log('[smoke:mobile-animation] ok');
