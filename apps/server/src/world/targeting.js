// Rich targeting framework. Wraps the primitive `targeting.request(state, cb, opts)`
// that handlers.js exposes (single-shot 0x6C round-trip) with the four
// concrete flavors ServUO uses across spells/skills/commands:
//
//   • beneficialTarget(state, opts)  — heal, bless, cure → Promise<resolved>
//   • harmfulTarget(state, opts)     — fireball, magic-arrow, poison → Promise<resolved>
//   • neutralTarget(state, opts)     — telekinesis, mark → Promise<resolved>
//   • multiTarget(state, count, opts)— mass-cure / chain-lightning → Promise<resolved[]>
//
// All four return a promise that resolves with the validated picked entity
// or rejects with a tagged Error (`cancelled`, `out-of-range`, `no-los`,
// `not-beneficial`, `not-harmful`, `timeout`). Callers can `await` and
// keep their flow linear instead of CPS.
//
// The four checks layered on top of the raw 0x6C reply are:
//   1. range — caller's `range` (default 12) tile distance, Manhattan
//   2. line-of-sight — `los.lineOfSight(facet, src, dst)` if `requireLOS`
//   3. classification — beneficial/harmful gate using notoriety:
//      • beneficial: same party, ally, self, criminal/innocent OK; murderer rejects
//      • harmful: anything except self/party/ally
//   4. timeout — caller can pass `timeoutMs`; we cancel the cursor and
//      reject the promise. Default 30s (matches CUO's `TargetTimer`).
//
// The framework attaches itself by `extendTargeting(targeting, deps)` where
// deps = { world, los, notoriety }. The exported `targeting` object grows
// the methods above; it remains the same singleton handlers.js created.

import { lineOfSight } from './los.js';
import { NOTO, viewerNotoriety } from '../notoriety.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Resolve a 0x6C target reply into a {kind, entity} pair. Returns null if
 * the reply has no serial (a tile target) — callers can pass `allowTile:true`
 * to accept those.
 */
function resolvePicked(picked, world) {
  if (!picked) return null;
  const serial = picked.serial >>> 0;
  if (serial === 0) {
    // Tile/static target — return the raw coords so caller can decide.
    return { kind: 'tile', x: picked.x, y: picked.y, z: picked.z, graphic: picked.graphic };
  }
  const mob = world?.mobiles?.get?.(serial);
  if (mob) return { kind: 'mobile', entity: mob, serial, x: mob.x, y: mob.y, z: mob.z };
  const item = world?.items?.get?.(serial);
  if (item) return { kind: 'item', entity: item, serial, x: item.x, y: item.y, z: item.z };
  return null;
}

function manhattan(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function rangeOK(caster, picked, range) {
  if (!caster || !picked) return false;
  return manhattan(caster, picked) <= (range | 0);
}

function losOK(facet, caster, picked) {
  try {
    return lineOfSight(facet, caster, picked, {});
  } catch {
    return true;  // be permissive if LOS table can't resolve
  }
}

/**
 * Beneficial check — true if `caster` may legally heal/buff `target`.
 *   • self: always allowed
 *   • party-mate / guild ally: allowed
 *   • murderer: NOT allowed (red can't be healed by blue)
 *   • non-criminal: allowed
 *   • criminal: allowed (you can heal a grey, you just risk going grey too)
 */
function isBeneficialAllowed(caster, target, world) {
  if (!target) return false;
  if (target === caster) return true;
  // NPC mob without a client always accepts beneficial spells.
  if (!target.client) return true;
  const noto = viewerNotoriety(target, caster, world);
  return noto !== NOTO.Murderer;
}

/**
 * Harmful check — true if `caster` may legally damage `target`.
 *   • self / party / ally: NOT allowed
 *   • everything else: allowed (the shard's notoriety system handles
 *     post-strike consequences like criminal flagging)
 */
function isHarmfulAllowed(caster, target, world) {
  if (!target) return false;
  if (target === caster) return false;
  if (!target.client) return true;  // monsters always harmable
  const noto = viewerNotoriety(target, caster, world);
  if (noto === NOTO.Ally) return false;
  return true;
}

/**
 * Generic gated request. Wraps `targeting.request` in a Promise with
 * range / LOS / classification checks. On reject, sends a system message
 * to the caster so they know why their click was refused.
 *
 * @param {object} state                                  NetState of the caster
 * @param {object} deps                                   { world, targeting }
 * @param {object} opts
 * @param {'beneficial'|'harmful'|'neutral'} opts.mode
 * @param {number} [opts.range=12]                        max tile distance
 * @param {boolean} [opts.requireLOS=true]                LOS check
 * @param {boolean} [opts.allowTile=false]                accept (x,y) tile targets
 * @param {number} [opts.timeoutMs=30000]                 auto-cancel after N ms
 * @param {number} [opts.flags=0]                         passed to 0x6C builder
 * @param {string} [opts.cancelMsg='Targeting cancelled.']
 * @returns {Promise<{kind:'mobile'|'item'|'tile', entity?:object, serial?:number, x:number, y:number, z:number}>}
 */
export function gatedTarget(state, deps, opts = {}) {
  const { world, targeting } = deps;
  const caster = state?.mobile;
  if (!caster) return Promise.reject(new Error('no-caster'));
  const mode = opts.mode ?? 'neutral';
  const range = opts.range ?? 12;
  const requireLOS = opts.requireLOS !== false;
  const allowTile = !!opts.allowTile;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let timer = null;
    const done = (fn, arg) => {
      if (timer) { clearTimeout(timer); timer = null; }
      fn(arg);
    };
    targeting.request(state, (picked) => {
      if (!picked) {
        try { state.sendSystemMessage?.(opts.cancelMsg ?? 'Targeting cancelled.'); } catch {}
        return done(reject, new Error('cancelled'));
      }
      const resolved = resolvePicked(picked, world);
      if (!resolved) {
        try { state.sendSystemMessage?.('You see nothing there.'); } catch {}
        return done(reject, new Error('not-resolved'));
      }
      if (resolved.kind === 'tile' && !allowTile) {
        try { state.sendSystemMessage?.('You must target a creature or item.'); } catch {}
        return done(reject, new Error('tile-not-allowed'));
      }
      if (!rangeOK(caster, resolved, range)) {
        try { state.sendSystemMessage?.('That is too far away.'); } catch {}
        return done(reject, new Error('out-of-range'));
      }
      if (requireLOS && !losOK(caster.map ?? 1, caster, resolved)) {
        try { state.sendSystemMessage?.('You cannot see that.'); } catch {}
        return done(reject, new Error('no-los'));
      }
      if (mode === 'beneficial' && resolved.entity) {
        if (!isBeneficialAllowed(caster, resolved.entity, world)) {
          try { state.sendSystemMessage?.('You cannot perform beneficial acts on your target.'); } catch {}
          return done(reject, new Error('not-beneficial'));
        }
      } else if (mode === 'harmful' && resolved.entity) {
        if (!isHarmfulAllowed(caster, resolved.entity, world)) {
          try { state.sendSystemMessage?.('You cannot perform harmful acts on your target.'); } catch {}
          return done(reject, new Error('not-harmful'));
        }
      }
      done(resolve, resolved);
      // Cursor kind: when the caller's `opts.kind` is unset, infer
      // from `allowTile`. allowTile=true means location/tile cursor
      // (kind=1, the diamond). False means object/entity cursor
      // (kind=0, crosshair). Previously default was 0 regardless of
      // allowTile — spell tile-cursors (e.g. Fire Field, Mark) drew
      // the wrong cursor and tile clicks were silently rejected by
      // resolvePicked.
    }, { kind: opts.kind ?? (allowTile ? 1 : 0), flags: opts.flags ?? 0 });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { state.sendSystemMessage?.('Target timed out.'); } catch {}
        reject(new Error('timeout'));
      }, timeoutMs).unref?.();
    }
  });
}

/** Convenience — beneficial cursor (heal, bless, cure). */
export function beneficialTarget(state, deps, opts = {}) {
  return gatedTarget(state, deps, { ...opts, mode: 'beneficial' });
}

/** Convenience — harmful cursor (fireball, magic-arrow). */
export function harmfulTarget(state, deps, opts = {}) {
  return gatedTarget(state, deps, { ...opts, mode: 'harmful' });
}

/** Convenience — neutral cursor (telekinesis, mark, polymorph self). */
export function neutralTarget(state, deps, opts = {}) {
  return gatedTarget(state, deps, { ...opts, mode: 'neutral' });
}

/**
 * Multi-target cursor. Re-prompts up to `count` times; resolves with the
 * collected resolved entities. Rejection on the first cancel propagates,
 * but a `stopOnCancel:false` opt lets early cancel still resolve with what
 * was picked so far. Used by mass-cure-style group spells.
 */
export async function multiTarget(state, deps, count, opts = {}) {
  const out = [];
  for (let i = 0; i < count; i++) {
    try {
      const r = await gatedTarget(state, deps, opts);
      out.push(r);
    } catch (e) {
      if (opts.stopOnCancel === false && e.message === 'cancelled') break;
      throw e;
    }
  }
  return out;
}

/**
 * Async iterator for sustained targeting (e.g. spirit-speak chained heals).
 * Yields one resolved entity per cycle until the caller breaks. Useful in
 * GM tools that want to repeatedly poke things — `for await (const t of …)`.
 */
export async function* targetStream(state, deps, opts = {}) {
  while (true) {
    try { yield await gatedTarget(state, deps, opts); }
    catch (e) { if (e.message === 'cancelled' || e.message === 'timeout') return; throw e; }
  }
}

/**
 * Bind the framework helpers onto an existing `targeting` object (the one
 * handlers.js exports with `.request(state, cb, opts)`). After calling, the
 * object exposes `.beneficial(...)`, `.harmful(...)`, `.neutral(...)`,
 * `.multi(...)`, `.stream(...)` — all returning promises / iterators.
 *
 * `deps` must include `{ world }`. We capture it once so callers don't have
 * to thread it through every call.
 *
 *   const targeting = buildHandlers().targeting;
 *   extendTargeting(targeting, { world });
 *   const t = await targeting.harmful(state, { range: 10 });
 */
export function extendTargeting(targeting, deps) {
  const wrap = (fn) => (state, opts) => fn(state, { world: deps.world, targeting }, opts);
  targeting.beneficial = wrap(beneficialTarget);
  targeting.harmful    = wrap(harmfulTarget);
  targeting.neutral    = wrap(neutralTarget);
  targeting.multi      = (state, count, opts) => multiTarget(state, { world: deps.world, targeting }, count, opts);
  targeting.stream     = (state, opts) => targetStream(state, { world: deps.world, targeting }, opts);
  return targeting;
}
