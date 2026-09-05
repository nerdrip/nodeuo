import {
  EffectKind,
  computeOPLHash,
  graphicalEffect,
  huedEffect,
  objectProperties,
  oplInfo,
  questArrow,
  readOPLRequest,
} from '@uo/protocol';
import { NodeUOChannel, NodeUOChannelFlag, NodeUOChannelMessage } from '@uo/nodeuo-protocol';
import { sendNodeUOChannel } from './nodeuo-modern.js';

function structuredEffect(params) {
  return {
    kind: 'graphic', type: params.kind ?? 0,
    sourceSerial: Number(params.from) >>> 0, targetSerial: Number(params.to) >>> 0,
    graphic: Number(params.itemId) & 0xffff,
    sx: params.fromX | 0, sy: params.fromY | 0, sz: params.fromZ | 0,
    tx: params.toX | 0, ty: params.toY | 0, tz: params.toZ | 0,
    speed: params.speed ?? 1, duration: params.duration ?? 0,
    fixed: params.fixedDirection ? 1 : 0, explode: params.explodes ? 1 : 0,
    hue: params.hue ?? 0, renderMode: params.renderMode ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Object properties / tooltips — 0xD6.
//
// The client sends 0xD6 with a list of serials it wants property-lists for.
// We look them up via `state.ctx.propertyProvider(serial)` which returns
// `{entries, hash}`. Providers hang off sharedCtx; scripts register them.
// ---------------------------------------------------------------------------

/** @typedef {(serial:number, state:import('../net-state.js').NetState)=>({entries:Array<{cliloc:number,args?:string}>, hash?:number}|null)} PropertyProvider */

export function handleOPLRequest(state, pkt) {
  if (!state.ctx.propertyProvider) return;
  let req;
  try { req = readOPLRequest(pkt); }
  catch { return; }
  for (const serial of req.serials) {
    const result = state.ctx.propertyProvider(serial, state);
    if (!result) continue;
    state.ctx.world?.observeProperties?.(state, serial);
    const hash = result.hash ?? computeOPLHash(result.entries);
    state.send(objectProperties({ serial, hash, entries: result.entries }));
  }
}

export const properties = {
  /**
   * Register a global provider that maps `serial → {entries, hash?}`.
   * @param {Object} ctx  sharedCtx
   * @param {PropertyProvider} fn
   */
  setProvider(ctx, fn) { ctx.propertyProvider = fn; },

  /** Send an OPLInfo hash nudge to one client. */
  nudge(state, serial, hash) {
    state.ctx?.world?.markEntityProperties?.(serial);
    state.send(oplInfo(serial, hash));
  },

  /** Send a full 0xD6 packet to one client. */
  send(state, serial, entries) {
    const hash = computeOPLHash(entries);
    state.send(objectProperties({ serial, hash, entries }));
  },

  computeHash: computeOPLHash,
};

// ---------------------------------------------------------------------------
// Graphical effects.
// ---------------------------------------------------------------------------

export const effects = {
  EffectKind,
  /**
   * Play a graphical effect at `mob`'s position, broadcast to every nearby
   * client.
   */
  playAt(world, origin, { itemId, hue = 0, kind = EffectKind.Stationary, speed = 5, duration = 10, renderMode = 0 }) {
    const params = {
      kind, from: origin.serial ?? 0, to: origin.serial ?? 0,
      itemId, fromX: origin.x, fromY: origin.y, fromZ: origin.z,
      toX: origin.x, toY: origin.y, toZ: origin.z,
      speed, duration, hue, renderMode,
    };
    const usesHue = hue !== 0 || renderMode !== 0;
    const build = usesHue ? huedEffect : graphicalEffect;
    const bytes = build(params);
    for (const m of world.mobiles.values()) {
      if (!m.client) continue;
      if (Math.abs(m.x - origin.x) > 24) continue;
      if (Math.abs(m.y - origin.y) > 24) continue;
      const enhanced = sendNodeUOChannel(m.client, {
        channel: NodeUOChannel.Combat, namespace: 'nodeuo.effects',
        kind: NodeUOChannelMessage.Event, flags: NodeUOChannelFlag.LossTolerant,
        payload: structuredEffect(params),
      });
      if (!enhanced) m.client.send(bytes);
    }
  },

  /** Send a single effect packet to one client. */
  send(state, params) {
    const usesHue = params.hue !== undefined || params.renderMode !== undefined;
    const enhanced = sendNodeUOChannel(state, {
      channel: NodeUOChannel.Combat, namespace: 'nodeuo.effects',
      kind: NodeUOChannelMessage.Event, flags: NodeUOChannelFlag.LossTolerant,
      payload: structuredEffect(params),
    });
    if (!enhanced) state.send((usesHue ? huedEffect : graphicalEffect)(params));
  },
};

// ---------------------------------------------------------------------------
// Quest arrow helper.
// ---------------------------------------------------------------------------

export const quest = {
  /** Show / move the quest arrow for one client. */
  show(state, x, y, serial) { state.send(questArrow({ active: true, x, y, serial })); },
  hide(state) { state.send(questArrow({ active: false, x: 0, y: 0 })); },
};
