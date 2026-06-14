// Rune travel helpers shared by Recall (circle 4), Mark (circle 6) and
// Gate Travel (circle 7) spells, plus the `[mark`/`[recall` text
// commands. Centralizes the marked-rune lookup, mark-rune mutation,
// and the teleport+observer-broadcast dance so the three spells can
// drop their placeholder messages.
//
// ServUO equivalents:
//   - templates/ServUO/Scripts/Items/Resource/RecallRune.cs (rune item)
//   - templates/ServUO/Scripts/Spells/Fourth/Recall.cs
//   - templates/ServUO/Scripts/Spells/Sixth/Mark.cs
//   - templates/ServUO/Scripts/Spells/Seventh/GateTravel.cs

import { moveMobile } from '../_movement.js';
import { isInPack as inventoryIsInPack, packItems } from '../_inventory.js';
import { nearbyClients } from '../_spatial.js';
import { isSigilCarrier } from '../_sigils.js';
import { canCreateItem, createItem, destroyItemBySerial } from '../_items.js';

const RUNE_BLANK_ID  = 0x1F14;
const RUNE_MARKED_HUE = 0x47;
const MOONGATE_BLUE_ID = 0x0F6C;
const GATE_TTL_MS = 30_000;

function* clientsNear(api, center, range = 18, self = null) {
  yield* nearbyClients(api, center, self, range);
}

function* packDescendants(api, mob) {
  yield* packItems(api, mob);
}

/** Return the first marked recall-rune in the player's pack, or null. */
export function findMarkedRune(api, mob) {
  for (const it of packDescendants(api, mob)) {
    if (!it.runeDest) continue;
    return it;
  }
  return null;
}

export function isItemInPack(api, item, mob) {
  return inventoryIsInPack(api, item, mob);
}

/**
 * Audit #31 P1 #2 — ServUO `Recall.CheckCast` blockers. Returns a string
 * reason when the cast must be rejected, or null when the caster is
 * clear to teleport. Previously Recall/Gate-Travel only tested
 * `_inCombatUntil` — every other blocker was wide open (criminal flag,
 * overweight, held-cursor stack dupe vector, sigil holder, jail region).
 */
export function checkRecallCast(api, caster, state) {
  if ((caster?._inCombatUntil ?? 0) > Date.now()) return 'You cannot recall while in combat.';
  if ((caster?.criminalUntil ?? 0) > Date.now()) return 'Thou\'rt a criminal and cannot recall.';
  // Held-cursor stack while recalling = dupe vector (item warps with
  // the player, then drops where the cursor lands → stack stays on the
  // ground in source AND in pack). ServUO `Spell.CheckCast` rejects.
  if (state?.heldItem) return 'You cannot recall with an item in your hand.';
  // Stratics / ServUO `WeightOverloading.IsOverloaded`: weight > strCap.
  const w = caster?._wornWeight ?? 0;
  const cap = (caster?.str ?? 100) * 4 + 40;
  if (w > cap) return 'You are too encumbered to attempt that.';
  // Sigil bearer (faction) can't recall. Audit #34 P3 #7 — also check
  // the canonical sigil registry (`_holdingSigil` was a placeholder
  // mob flag never set anywhere; the actual carrier info lives in
  // `systems/pvp/sigils.js`).
  if (caster?._holdingSigil) return 'You cannot recall while bearing a sigil.';
  if (isSigilCarrier(api, caster?.serial | 0)) {
    return "You can't do that while carrying the sigil.";
  }
  return null;
}

/** Return the first blank rune in the player's pack, or null. */
export function findBlankRune(api, mob) {
  for (const it of packDescendants(api, mob)) {
    if (it.itemId !== RUNE_BLANK_ID) continue;
    if (it.runeDest) continue;
    return it;
  }
  return null;
}

/** Mutate `rune` in place with the caster's current location. */
export function markRune(rune, caster) {
  rune.runeDest = {
    x: caster.x | 0, y: caster.y | 0, z: caster.z | 0,
    map: caster.map | 0,
    label: `rune to (${caster.x},${caster.y})`,
  };
  rune.itemId = RUNE_BLANK_ID;
  rune.hue = RUNE_MARKED_HUE;
  rune.name = rune.runeDest.label;
}

/**
 * Teleport `mob` to `dest`. Sends removeEntity to old observers and
 * mobileMoving to new ones so phantoms don't linger. Returns false
 * when the destination is unusable.
 */
export function teleportToRune(api, mob, dest) {
  if (!dest || typeof dest.map !== 'number') return false;
  // Region no-recall gate (Felucca dungeons, jail, etc.).
  if (api.regions?.find) {
    const region = api.regions.find(dest.x, dest.y, dest.map);
    if (region?.noRecall) return false;
  }
  const target = { x: dest.x, y: dest.y, z: dest.z, map: dest.map };
  if (api.game?.mobile?.teleport?.(mob, target, { state: mob.client, refresh: true })) {
    return true;
  }
  {
    const preObservers = [...clientsNear(api, mob, 18, mob)];
    if (api.protocol?.removeEntity) {
      const rm = api.protocol.removeEntity(mob.serial);
      for (const m of preObservers) m.client.send(rm);
    }
    const prevMap = mob.map;
    moveMobile(api, mob, target);
    // Cross-facet recall — client needs 0xBF 0x08 before mobileUpdate so the
    // tile-renderer flips its active facet bins.
    if (mob.client && mob.map !== prevMap && api.protocol?.extMapChange) {
      try { mob.client.send(api.protocol.extMapChange(mob.map)); } catch { /* ignore */ }
    }
    if (mob.client && api.protocol?.mobileUpdate) {
      mob.client.send(api.protocol.mobileUpdate({
        serial: mob.serial, body: mob.body, hue: mob.hue ?? 0,
        flags: mob.flags ?? 0,
        x: mob.x, y: mob.y, z: mob.z, direction: mob.direction ?? 0,
      }));
    }
    if (api.protocol?.mobileMoving) {
      const moving = api.protocol.mobileMoving({
        serial: mob.serial, body: mob.body,
        x: mob.x, y: mob.y, z: mob.z,
        direction: mob.direction ?? 0, hue: mob.hue ?? 0,
        flags: mob.flags ?? 0, notoriety: mob.notoriety ?? 1,
      });
      for (const m of clientsNear(api, mob, 18, mob)) m.client.send(moving);
    }
  }
  // Re-stream the destination's items + mobiles to the teleported
  // client. Without this, post-moongate Moonglow looks empty (no
  // moongate graphic at the new location, no merchants, no statics —
  // user report 2026-05-18 "po teleporcie z Britanii do Moonglow nie
  // ma grafiki portalu"). `refreshSurroundings` is the same path
  // `[go` and admin-panel teleport use.
  try {
    if (mob.client) api.ctx?.handlers?.refreshSurroundings?.(mob.client);
  } catch (e) {
    api.log?.(`[teleport] refreshSurroundings failed: ${e.message}`);
  }
  return true;
}

/**
 * Spawn a temporary blue moongate pair (entry+exit) bound to a
 * destination. The gate teleports any mobile that walks onto it.
 * Both halves auto-despawn after GATE_TTL_MS.
 */
export function spawnGatePair(api, caster, dest) {
  if (!canCreateItem(api, api.world)) return false;
  const gateScript = 'teleporter';
  const gateA = createItem(api, api.world, {
    itemId: MOONGATE_BLUE_ID,
    x: caster.x, y: caster.y, z: caster.z, map: caster.map,
    script: gateScript,
    teleportTo: { x: dest.x, y: dest.y, z: dest.z, map: dest.map },
    creatures: true,
    name: 'a moongate',
  });
  const gateB = createItem(api, api.world, {
    itemId: MOONGATE_BLUE_ID,
    x: dest.x, y: dest.y, z: dest.z, map: dest.map,
    script: gateScript,
    teleportTo: { x: caster.x, y: caster.y, z: caster.z, map: caster.map },
    creatures: true,
    name: 'a moongate',
  });
  const showGate = (gate) => {
    if (!gate || !api.protocol?.worldItemSA) return;
    const pkt = api.protocol.worldItemSA({
      serial: gate.serial,
      itemId: gate.itemId,
      amount: gate.amount ?? 1,
      hue: gate.hue ?? 0,
      x: gate.x,
      y: gate.y,
      z: gate.z,
    });
    for (const m of clientsNear(api, gate, 18)) m.client.send(pkt);
  };
  const destroyGate = (gate) => {
    if (!gate) return;
    if (api.protocol?.removeEntity) {
      const rm = api.protocol.removeEntity(gate.serial);
      for (const m of clientsNear(api, gate, 18)) m.client.send(rm);
    }
    try {
      destroyItemBySerial(api, gate.serial);
    } catch { /* may already be gone */ }
  };
  showGate(gateA);
  showGate(gateB);
  setTimeout(() => {
    destroyGate(gateA);
    destroyGate(gateB);
  }, GATE_TTL_MS).unref?.();
  return true;
}
