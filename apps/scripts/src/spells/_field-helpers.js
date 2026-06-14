// Shared spawner for field spells (fire-field, poison-field, paralyze-
// field, energy-field, wall-of-stone). Each field is a row of immovable
// items at the caster-targeted tile. The row runs perpendicular to the
// caster→target axis so the caster's own line of fire stays clear (CUO
// `Spells.Magery.WallOfStoneSpell.GetTilesInLine`).
//
// Opts:
//   itemId       - art id for each tile
//   length       - tile count (5 default — ServUO standard for stone wall)
//   durationMs   - how long the field lives before auto-despawn
//   onWalkOn(world, item, mob) - optional per-step trigger (damage,
//                                poison, paralyze) attached to each tile
//   name         - human-readable item name (cliloc lookups skipped)
//   hue          - colour override

import { broadcastSound, clientsNear, mobilesNear } from './_helpers.js';
import { createItem, destroyItemBySerial } from '../_items.js';

function* mobilesAt(api, center) {
  if (api?.query?.mobilesAt) {
    yield* api.query.mobilesAt(center);
    return;
  }
  yield* mobilesNear(api, center, 0);
}

/** Compute the start tile + perpendicular step delta. */
function fieldGeometry(caster, target, length) {
  const cx = caster.x | 0, cy = caster.y | 0;
  const tx = target.x | 0, ty = target.y | 0;
  const dx = tx - cx, dy = ty - cy;
  // Pick the perpendicular axis with the greater dominant component.
  // |dx| > |dy| → caster is east/west of target → field runs north-south.
  let stepX = 0, stepY = 1;
  if (Math.abs(dx) > Math.abs(dy)) { stepX = 0; stepY = 1; }
  else                              { stepX = 1; stepY = 0; }
  // Centre the field on the target tile.
  const half = (length - 1) >> 1;
  const startX = tx - stepX * half;
  const startY = ty - stepY * half;
  return { startX, startY, stepX, stepY };
}

/** Spawn the field. Returns the array of created items so the caller
 *  can attach extra payload (e.g. specific damage type). */
export function spawnField(api, ctx, picked, opts = {}) {
  const caster = ctx.sender;
  if (!picked) {
    ctx.state?.sendSystemMessage?.('You need to target a location.');
    return [];
  }
  const target = picked.entity ?? picked;
  const length = opts.length ?? 5;
  const dur    = opts.durationMs ?? 30_000;
  const itemId = opts.itemId | 0;
  if (!itemId) return [];
  const { startX, startY, stepX, stepY } = fieldGeometry(caster, target, length);
  /** @type {any[]} */
  const created = [];
  for (let i = 0; i < length; i++) {
    const x = (startX + stepX * i) & 0xffff;
    const y = (startY + stepY * i) & 0xffff;
    const it = createItem(api, api.world, {
      itemId, hue: opts.hue ?? 0,
      x, y, z: target.z ?? 0, map: target.map ?? caster.map ?? 1,
      name: opts.name,
      movable: false,
    });
    if (!it) continue;
    it._noDecay = true;            // managed by our explicit despawn timer
    if (opts.onWalkOn) {
      it.script = opts.scriptName ?? 'spell-field';
      it._fieldOnWalkOn = opts.onWalkOn;
      it._fieldCaster = caster.serial >>> 0;
    }
    // Broadcast the spawn so observers see the field immediately.
    if (api.protocol?.worldItemSA) {
      const pkt = api.protocol.worldItemSA({
        serial: it.serial, itemId: it.itemId, hue: it.hue ?? 0,
        amount: 1, x: it.x, y: it.y, z: it.z,
        flags: 0x00,
      });
      for (const m of clientsNear(api, api.world, it, 18)) {
        m.client.send(pkt);
      }
    }
    created.push(it);
  }
  // Audit #31 P2 #7 — ServUO `FireField.InternalTimer` ticks every 1 s
  // and damages every mob STANDING on the field tile, not just those
  // who step onto it. Previously a player could simply stand in fire
  // for 30 s and take 0 damage as long as they didn't move. Add a
  // shared 1 Hz interval per field group that walks each tile's
  // mobiles-at-(x,y) and re-fires the `onWalkOn` trigger. Caster
  // exemption mirrors the dispatchTileWalkEvents path.
  let standingTimer = null;
  if (opts.onWalkOn) {
    standingTimer = setInterval(() => {
      try {
        for (const it of created) {
          if (!it || it._destroyed) continue;
          for (const m of mobilesAt(api, it)) {
            if (!m || (m.hp ?? 0) <= 0) continue;
            if ((it._fieldCaster | 0) === (m.serial >>> 0)) continue;
            try { opts.onWalkOn(api.world, it, m); }
            catch (e) { console.error('[spell-field tick] threw:', e); }
          }
        }
      } catch (e) { console.error('[spell-field tick] outer:', e); }
    }, 1000);
    standingTimer.unref?.();
  }
  // Auto-despawn timer.
  setTimeout(() => {
    if (standingTimer) clearInterval(standingTimer);
    for (const it of created) {
      try {
        if (api.protocol?.removeEntity) {
          const pkt = api.protocol.removeEntity(it.serial);
          for (const m of clientsNear(api, api.world, it, 18)) {
            m.client.send(pkt);
          }
        }
        destroyItemBySerial(api, it.serial);
        it._destroyed = true;
      } catch { /* best-effort */ }
    }
  }, dur).unref?.();
  // Cast feedback.
  if (opts.soundId) broadcastSound(api, api.world, caster, opts.soundId);
  return created;
}

/** Apply a field item's onWalkOn trigger when a mobile steps onto it.
 *  Wired into the existing item-script dispatch (see
 *  `apps/server/src/world/item-scripts.js dispatchTileWalkEvents`). */
export function buildSpellFieldScript() {
  return {
    name: 'spell-field',
    onWalkOn(world, item, mob) {
      if (!item._fieldOnWalkOn || !mob) return;
      // Don't fire on the caster themselves — UO convention: your own
      // wall doesn't fry you. Without this, fire-field-on-self would
      // immediately tick the caster.
      if ((item._fieldCaster | 0) === (mob.serial >>> 0)) return;
      try { item._fieldOnWalkOn(world, item, mob); }
      catch (e) { console.error('[spell-field] onWalkOn threw:', e); }
    },
  };
}
