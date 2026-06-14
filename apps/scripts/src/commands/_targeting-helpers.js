import { itemBySerial, mobileBySerial } from '../_entities.js';
// Targeting helpers — shared by commands that accept either a
// numeric serial argument OR a cursor-target prompt when no arg is
// supplied. Wave 34 unified entry point so we don't repeat the same
// `parseInt + targeting.request + lookup` boilerplate in five
// command files.

/**
 * Resolve a single item serial. Calls `cb(item)` when the player
 * either passes a serial as `args[argIdx]` or picks one with the
 * cursor target. `cb(null)` is called on cancel or invalid pick.
 *
 * @param {Object} api      ScriptAPI z `world` + `targeting`
 * @param {Object} ctx      command context (`state`, `sender`, `args`)
 * @param {number} argIdx   index w ctx.args gdzie szukamy serial
 * @param {(item:any|null) => void} cb
 * @param {{ promptText?:string }} [opts]
 */
export function resolveItemArg(api, ctx, argIdx, cb, opts = {}) {
  const world = api.world;
  const args = ctx.args;
  const arg = args[argIdx];
  if (arg) {
    const serial = (/^0x/i.test(arg) ? parseInt(arg, 16) : parseInt(arg, 10)) >>> 0;
    if (!Number.isFinite(serial) || serial === 0) {
      ctx.state.sendSystemMessage('Invalid serial. Pass a hex (0x..) or decimal value.');
      cb(null);
      return;
    }
    const item = itemBySerial({ world }, serial);
    if (!item) {
      ctx.state.sendSystemMessage('No such item.');
      cb(null);
      return;
    }
    cb(item);
    return;
  }
  if (!api.targeting?.request) {
    ctx.state.sendSystemMessage('Targeting host unavailable. Pass a serial.');
    cb(null);
    return;
  }
  ctx.state.sendSystemMessage(opts.promptText ?? 'Target the item…');
  api.targeting.request(ctx.state, (picked) => {
    if (!picked || !picked.serial) {
      ctx.state.sendSystemMessage('Selection canceled.');
      cb(null);
      return;
    }
    const item = itemBySerial({ world }, picked.serial >>> 0);
    if (!item) {
      ctx.state.sendSystemMessage('Selection was not an item.');
      cb(null);
      return;
    }
    cb(item);
  });
}

/**
 * Wave 35: combined resolver — accepts either an item OR a mobile.
 * Returns `cb({ kind:'item'|'mobile', ref })` lub `cb(null)` na
 * cancel. Cursor target uses `picked.kind === 1` to disambiguate
 * (UO target packet convention: 0=tile, 1=mobile, 2=static/item).
 *
 * @param {{ promptText?:string }} [opts]
 */
export function resolveItemOrMobileArg(api, ctx, argIdx, cb, opts = {}) {
  const world = api.world;
  const args = ctx.args;
  const arg = args[argIdx];
  if (arg) {
    const serial = (/^0x/i.test(arg) ? parseInt(arg, 16) : parseInt(arg, 10)) >>> 0;
    if (!Number.isFinite(serial) || serial === 0) {
      ctx.state.sendSystemMessage('Invalid serial.');
      cb(null);
      return;
    }
    const item = itemBySerial({ world }, serial);
    if (item) { cb({ kind: 'item', ref: item }); return; }
    const mob = mobileBySerial({ world }, serial);
    if (mob) { cb({ kind: 'mobile', ref: mob }); return; }
    ctx.state.sendSystemMessage('No such item or mobile.');
    cb(null);
    return;
  }
  if (!api.targeting?.request) {
    ctx.state.sendSystemMessage('Targeting host unavailable. Pass a serial.');
    cb(null);
    return;
  }
  ctx.state.sendSystemMessage(opts.promptText ?? 'Target an item or mobile…');
  api.targeting.request(ctx.state, (picked) => {
    if (!picked || !picked.serial) {
      ctx.state.sendSystemMessage('Selection canceled.');
      cb(null);
      return;
    }
    if (picked.kind === 1) {
      const mob = mobileBySerial({ world }, picked.serial >>> 0);
      if (!mob) { ctx.state.sendSystemMessage('Mobile not found.'); cb(null); return; }
      cb({ kind: 'mobile', ref: mob });
      return;
    }
    const item = itemBySerial({ world }, picked.serial >>> 0);
    if (item) { cb({ kind: 'item', ref: item }); return; }
    const mob = mobileBySerial({ world }, picked.serial >>> 0);
    if (mob) { cb({ kind: 'mobile', ref: mob }); return; }
    ctx.state.sendSystemMessage('Selection was neither item nor mobile.');
    cb(null);
  });
}

/**
 * Resolve a single mobile serial. Same contract as `resolveItemArg`
 * but for mobiles (vendors, NPCs, players).
 */
export function resolveMobileArg(api, ctx, argIdx, cb, opts = {}) {
  const world = api.world;
  const args = ctx.args;
  const arg = args[argIdx];
  if (arg) {
    const serial = (/^0x/i.test(arg) ? parseInt(arg, 16) : parseInt(arg, 10)) >>> 0;
    if (!Number.isFinite(serial) || serial === 0) {
      ctx.state.sendSystemMessage('Invalid serial.');
      cb(null);
      return;
    }
    const mob = mobileBySerial({ world }, serial);
    if (!mob) {
      ctx.state.sendSystemMessage('No such mobile.');
      cb(null);
      return;
    }
    cb(mob);
    return;
  }
  if (!api.targeting?.request) {
    ctx.state.sendSystemMessage('Targeting host unavailable. Pass a serial.');
    cb(null);
    return;
  }
  ctx.state.sendSystemMessage(opts.promptText ?? 'Target the mobile…');
  api.targeting.request(ctx.state, (picked) => {
    if (!picked || !picked.serial) {
      ctx.state.sendSystemMessage('Selection canceled.');
      cb(null);
      return;
    }
    const mob = mobileBySerial({ world }, picked.serial >>> 0);
    if (!mob) {
      ctx.state.sendSystemMessage('Selection was not a mobile.');
      cb(null);
      return;
    }
    cb(mob);
  });
}
