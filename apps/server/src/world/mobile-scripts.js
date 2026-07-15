// Mobile-script registry — symmetric to item-scripts.js.
//
// Content scripts (apps/scripts/src/...) can attach behaviour to a
// monster / NPC by setting `mob.script = '<name>'` and registering
// `{ name, onBeforeMove, onAfterMove, onDeath, onDamage, onHit, onSpeech, onTick, ... }`
// here. This is the canonical Mobile-level hook set ServUO exposes via
// `Mobile.OnBeforeMove`, `Mobile.OnDeath`, `Mobile.OnDamage`, `Mobile.OnGotMeleeAttack`,
// `Mobile.OnSpeech`, etc.
//
// All callbacks are best-effort: errors are caught + logged. Returning
// `true` from `onBeforeMove` cancels the step (analogue of ServUO
// `OnBeforeMove` returning false from base impl).

/** @typedef {Object} MobileScript
 *  @property {string} name
 *  @property {boolean} [hasTick]
 *  @property {(world:any, mob:any, dir:number, dest:{x:number,y:number,z:number,map:number}) => boolean|void} [onBeforeMove]
 *  @property {(world:any, mob:any, prev:{x:number,y:number,z:number,map:number}) => void} [onAfterMove]
 *  @property {(world:any, mob:any, killer:any|null) => void} [onDeath]
 *  @property {(world:any, mob:any, attacker:any, amount:number, type?:string) => void} [onDamage]
 *  @property {(world:any, mob:any, target:any, amount:number) => void} [onHit]
 *  @property {(world:any, mob:any, speaker:any, text:string) => boolean|void} [onSpeech]
 *  @property {(world:any, mob:any) => void} [onSpawn]
 *  @property {(world:any, mob:any) => void} [onDelete]
 *  @property {(world:any, mob:any, dt:number) => void} [onTick]
 */

/** @type {Map<string, MobileScript>} */
const REGISTRY = new Map();
let _tickCacheDirty = true;
let _anyScriptHasTick = false;

/** @param {MobileScript} script */
export function registerMobileScript(script) {
  if (!script || typeof script.name !== 'string') {
    throw new Error('mobileScript needs a name');
  }
  REGISTRY.set(script.name, script);
  _tickCacheDirty = true;
}

export function unregisterMobileScript(name) {
  REGISTRY.delete(name);
  _tickCacheDirty = true;
}
export function getMobileScript(name) { return REGISTRY.get(name); }
export function allMobileScripts() { return [...REGISTRY.values()]; }

function refreshTickCache() {
  _anyScriptHasTick = false;
  for (const s of REGISTRY.values()) {
    if (s?.hasTick) {
      _anyScriptHasTick = true;
      break;
    }
  }
  _tickCacheDirty = false;
}

/**
 * Dispatch a named lifecycle event to a mobile's script. Returns the
 * script's return value (`true` from onBeforeMove cancels the step;
 * `true` from onSpeech swallows it).
 */
export function dispatchMobileEvent(world, mob, eventName, ...args) {
  const scriptName = mob?.script;
  if (!scriptName) return undefined;
  const s = REGISTRY.get(scriptName);
  if (!s) return undefined;
  if (eventName === 'onSpawn' && s.hasTick) world?._tickingMobiles?.add?.(mob.serial);
  if (eventName === 'onDelete') world?._tickingMobiles?.delete?.(mob.serial);
  const fn = s[eventName];
  if (typeof fn !== 'function') return undefined;
  try { return fn(world, mob, ...args); }
  catch (e) {
    console.error(`[mobile-script] ${scriptName}.${eventName} threw:`, e);
    return undefined;
  }
}

/** Rebuild after persistence restore or a script hot-reload. */
export function rebuildTickingMobileIndex(world) {
  if (!world?.mobiles) return 0;
  const index = world._tickingMobiles ?? new Set();
  index.clear();
  for (const mob of world.mobiles.values()) {
    const script = mob?.script ? REGISTRY.get(mob.script) : null;
    if (script?.hasTick) index.add(mob.serial);
  }
  world._tickingMobiles = index;
  return index.size;
}

/**
 * Walk every world.mobiles entry whose script opts into ticking. Called
 * from main.js at a steady cadence (default 1Hz).
 */
export function tickAllMobileScripts(world, dt) {
  if (!world?.mobiles) return;
  if (_tickCacheDirty) refreshTickCache();
  if (!_anyScriptHasTick) return;
  const index = world._tickingMobiles;
  const candidates = index ? [...index] : world.mobiles.values();
  for (const candidate of candidates) {
    const mob = index ? world.mobiles.get(candidate) : candidate;
    if (!mob) { index?.delete?.(candidate); continue; }
    const s = mob.script ? REGISTRY.get(mob.script) : null;
    if (!s?.hasTick) { index?.delete?.(mob.serial); continue; }
    try { s.onTick?.(world, mob, dt); }
    catch (e) {
      console.error(`[mobile-script] ${mob.script}.onTick threw:`, e);
    }
  }
}
