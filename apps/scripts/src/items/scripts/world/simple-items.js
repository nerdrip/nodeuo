// Small functional items grouped here to avoid file proliferation.
// Each script is 5-30 LOC: setup `item.X` on create, simple onUse
// behaviour. The content registry already maps each `script: '…'` →
// these builders via items/scripts/index.js.
//
// ServUO references:
//   Items/Misc/Switch.cs           → switch  (lever / stone / wall switch)
//   Items/Doors/SecretDoor.cs      → secret-door
//   Items/Doors/SlidingDoor.cs     → sliding-door
//   Items/Doors/Portcullis.cs      → portcullis
//   Items/Misc/Ankhs.cs            → despise-ankh
//   Items/Misc/SpiderWeb.cs        → spider-web
//   Items/Misc/AcidVine.cs         → acid-vine
//   Items/Mechanisms/*Trap.cs      → world-trap (generic dispatcher)
//   Items/Misc/ChickenCoop.cs      → chicken-coop
//   Items/Misc/Incubator.cs        → incubator
//   Items/Special/IncubatorEgg.cs  → incubator-egg

import { destroyItemBySerial } from '../../../_items.js';
import { createMobile, destroyMobileBySerial } from '../../../_mobiles.js';
import { childrenOf } from '../../../_inventory.js';
import { nearbyClients, nearbyMobiles, sendToClientsNear } from '../../../_spatial.js';
import { itemBySerial, mobileBySerial } from '../../../_entities.js';
import { normalizeSkillValue } from '../../../_rules.js';

/* ──────────────── switch (lever / stone / wall) ──────────────── */
//
// A toggle item that flips its graphic on use (lever rises ↔ falls).
// Switches typically wire to a paired item via `_switchTargetSerial`
// (stamped via `[link <switch> <target>` in admin tools) — when toggled,
// the linked item also gets its `item.door.isOpen` flipped, mirroring
// ServUO's gate-by-lever puzzle pattern.

const SWITCH_FLIP = new Map([
  // Iron Lever 0x108C/0x108D (up/down)
  [0x108C, 0x108D], [0x108D, 0x108C],
  // Stone switch 0x108E/0x108F
  [0x108E, 0x108F], [0x108F, 0x108E],
  // Wall switch 0x1093/0x1094 (and the wood-paneled variant)
  [0x1093, 0x1094], [0x1094, 0x1093],
  // Lever 0x1090/0x1091
  [0x1090, 0x1091], [0x1091, 0x1090],
]);

export function buildSwitch(api) {
  return {
    name: 'switch',
    onCreate(_world, item) {
      item.movable = false;
      item._xmlLeverState ??= 0;
    },
    onUse(world, item, user) {
      const flip = SWITCH_FLIP.get(item.itemId);
      if (flip != null) item.itemId = flip;
      _broadcast(api, world, item);
      const states = String(item.leverType ?? item._xmlLeverType ?? '').toLowerCase().includes('three')
        ? 3
        : Math.max(2, item._xmlStates | 0 || 2);
      item._xmlLeverState = ((item._xmlLeverState | 0) + 1) % states;
      const xmlHandled = _applyXmlSwitchState(api, world, item, user, item._xmlLeverState);
      // Toggle the linked door / mechanism (if any).
      if (!xmlHandled && item._switchTargetSerial) {
        const target = itemBySerial({ world }, item._switchTargetSerial >>> 0);
        if (target?.door) {
          target.door.isOpen = !target.door.isOpen;
          target.itemId = target.door.isOpen ? target.door.openId : target.door.closedId;
          _broadcast(api, world, target);
        }
      }
      user?.client?.sendSystemMessage?.('You hear a clunking sound.');
      try { user?.client?.send?.(api.protocol?.playSound?.({ soundId: 0x004A, x: item.x, y: item.y, z: item.z })); }
      catch { /* sound advisory */ }
      return true;
    },
  };
}

export function buildXmlTileTrap(api) {
  return {
    name: 'xml-tile-trap',
    onCreate(_world, item) {
      item.movable = false;
      item.visible = item.visible ?? false;
      item._xmlTrapInside ??= false;
    },
    onWalkOn(world, item, mob) {
      if (!mob?.client && !item.allowNpcTriggering) return;
      if (item._xmlTrapInside) return;
      item._xmlTrapInside = true;
      _playSwitchSound(api, world, item);
      _applyXmlSwitchState(api, world, item, mob, 1);
    },
    onWalkOff(world, item, mob) {
      if (!item._xmlTrapInside) return;
      item._xmlTrapInside = false;
      _applyXmlSwitchState(api, world, item, mob, 0);
    },
  };
}

/* ──────────────── secret-door ──────────────── */
//
// Renders identical to its surrounding wall until a player passes a
// Detect Hidden roll within 3 tiles. After detection the door becomes
// a normal door for `detectHiddenDuration` seconds (default 30 s).

export function buildSecretDoor(_api) {
  return {
    name: 'secret-door',
    onCreate(_world, item) {
      item.movable = false;
      item.door = item.door ?? { isOpen: false, secret: true };
      item.door.secret = true;
      item._secretDetectedUntil = 0;
    },
    onUse(_world, item, user) {
      const state = user?.client;
      if (!state) return true;
      if (item.door.secret && (item._secretDetectedUntil ?? 0) < Date.now()) {
        state.sendSystemMessage?.('You see only stone here.');
        return true;
      }
      // Detected → standard door toggle handled by the door system on
      // next use.
      return false;
    },
  };
}

/* ──────────────── sliding-door ──────────────── */
//
// Auto-opens when a mobile steps onto the adjacent tile (handled by
// movement system via `onWalkOn`), and auto-closes 5 s later. No
// double-click handling — physical proximity is the trigger.

export function buildSlidingDoor(api) {
  return {
    name: 'sliding-door',
    onCreate(_world, item) {
      item.movable = false;
      item.door = item.door ?? { isOpen: false };
      item.door.sliding = true;
    },
    onWalkOn(world, item, mob) {
      if (item.door?.isOpen) return;
      item.door.isOpen = true;
      if (item.door.openId != null) item.itemId = item.door.openId;
      _broadcast(api, world, item);
      // Auto-close after 5s.
      setTimeout(() => {
        if (!item.door?.isOpen) return;
        item.door.isOpen = false;
        if (item.door.closedId != null) item.itemId = item.door.closedId;
        _broadcast(api, world, item);
      }, 5000);
      void mob;
    },
  };
}

/* ──────────────── portcullis ──────────────── */
//
// A heavy multi-tile gate. Identical mechanically to a door, but does
// NOT auto-close — once opened, it stays open until manually closed
// (e.g. via a paired switch). Movable=false.

export function buildPortcullis(_api) {
  return {
    name: 'portcullis',
    onCreate(_world, item) {
      item.movable = false;
      item.door = item.door ?? { isOpen: false };
      item.door.portcullis = true;
    },
  };
}

/* ──────────────── despise-ankh ──────────────── */
//
// The Despise dungeon ankh — flips the player's virtue alignment
// between Good and Evil. Tied to the Despise revamp arc; we expose
// the irreducible toggle so future content can read `_despiseAlignment`.

export function buildDespiseAnkh(_api) {
  return {
    name: 'despise-ankh',
    onCreate(_world, item) { item.movable = false; },
    onUse(_world, _item, user) {
      const state = user?.client;
      if (!state) return true;
      const cur = user._despiseAlignment ?? 'neutral';
      const next = cur === 'good' ? 'evil' : 'good';
      user._despiseAlignment = next;
      state.sendSystemMessage?.(`The ankh pulses. You now follow the ${next.toUpperCase()} path.`);
      return true;
    },
  };
}

/* ──────────────── spider-web ──────────────── */
//
// Walk-on entanglement — applies 3 s of paralysis to mobiles that walk
// onto the tile, then dissolves the web. Treats it like a single-use
// trap, mirroring ServUO `SpiderWeb.cs:OnMoveOver`.

export function buildSpiderWeb(api) {
  return {
    name: 'spider-web',
    onCreate(_world, item) {
      item.movable = false;
      item.immobile = true;
    },
    onWalkOn(world, item, mob) {
      if (!mob || mob._spiderWebStuckUntil > Date.now()) return;
      mob._spiderWebStuckUntil = Date.now() + 3000;
      api.statusEffects?.apply?.(mob, { name: 'webbed', durationMs: 3000 });
      mob.client?.sendSystemMessage?.('You are caught in a spider web!');
      // Web dissolves on the entanglement.
      try { destroyItemBySerial(api, item.serial); }
      catch { /* tolerate */ }
    },
  };
}

/* ──────────────── acid-vine ──────────────── */
//
// Walk-on poison-damage tile. Each step deals 5 acid damage and applies
// 1 stack of lesser poison. Vine does NOT consume on use; it stays until
// destroyed.

export function buildAcidVine(api) {
  return {
    name: 'acid-vine',
    onCreate(_world, item) {
      item.movable = false;
      item.immobile = true;
    },
    onWalkOn(_world, item, mob) {
      if (!mob) return;
      try {
        api.combat?.damage?.(mob, 5, { damageType: { poison: 100 }, source: null });
      } catch { /* combat optional in tests */ }
      try {
        api.systems?.poison?.applyPoison?.(mob, { level: 1 });
      } catch { /* poison optional */ }
      mob.client?.sendSystemMessage?.('The acid vine burns you!');
      void item;
    },
  };
}

/* ──────────────── world-trap (dispatcher) ──────────────── */
//
// Generic dispatcher for any item tagged `script: 'world-trap'`. Reads
// `item.trapKind` to route to one of the concrete trap implementations:
//   'spike' | 'gas' | 'fire' | 'saw' | 'dart' | 'pressure-plate'
// Existing per-kind scripts already handle the heavy lifting; this
// shim exists for the simple content-registry entries that share an
// itemId across multiple specific traps.

export function buildWorldTrap(api) {
  return {
    name: 'world-trap',
    onCreate(_world, item) {
      item.movable = false;
      item.trapKind = item.trapKind ?? 'spike';
    },
    onWalkOn(world, item, mob) {
      const kind = String(item.trapKind ?? 'spike').toLowerCase();
      const scriptName =
        kind === 'gas'   ? 'gas-trap' :
        kind === 'fire'  ? 'fire-column-trap' :
        kind === 'saw'   ? 'saw-trap' :
        kind === 'dart'  ? 'dart-trap' :
        kind === 'pressure-plate' ? 'pressure-plate' :
                                    'spike-trap';
      const real = api.itemScripts?.get?.(scriptName);
      if (real?.onWalkOn) {
        try { real.onWalkOn(world, item, mob); }
        catch (e) { api.log?.(`world-trap dispatch ${scriptName} threw: ${e.message}`); }
      }
    },
  };
}

/* ──────────────── chicken-coop ──────────────── */
//
// House-decoration container that produces 1 egg every 6 in-game hours
// (capped at 5 stored eggs). Double-click harvests stored eggs into
// the user's backpack.

const COOP_PRODUCE_MS = 6 * 60 * 60 * 1000;
const COOP_MAX_EGGS = 5;

export function buildChickenCoop(api) {
  return {
    name: 'chicken-coop',
    onCreate(_world, item) {
      item.movable = false;
      item.container = true;
      item._lastEggAt = Date.now();
      item._eggCount = 0;
      item.servuoClasses = [...new Set([...(item.servuoClasses ?? []), 'ChickenCoop', 'ClaimAllEntry'])];
    },
    onUse(_world, item, user) {
      const state = user?.client;
      if (!state) return true;
      _tickCoop(item);
      if ((item._eggCount | 0) <= 0) {
        const nextIn = Math.max(0,
          COOP_PRODUCE_MS - (Date.now() - (item._lastEggAt ?? 0)));
        const mins = Math.ceil(nextIn / 60_000);
        state.sendSystemMessage?.(`The coop is empty. Next egg in ~${mins} min.`);
        return true;
      }
      const eggs = item._eggCount | 0;
      const eggItem = api.game?.mobile?.giveItem?.(user, {
        itemId: 0x09B5,
        amount: eggs,
        name: 'egg',
        movable: true,
        stackable: true,
      }, { randomGrid: true });
      if (!eggItem) {
        state.sendSystemMessage?.('You have no backpack.');
        return true;
      }
      item._eggCount = 0;
      state.sendSystemMessage?.(`You collect ${eggs} egg${eggs === 1 ? '' : 's'}.`);
      return true;
    },
  };
}

function _tickCoop(item) {
  const now = Date.now();
  const elapsed = now - (item._lastEggAt ?? now);
  const produced = (elapsed / COOP_PRODUCE_MS) | 0;
  if (produced <= 0) return;
  item._eggCount = Math.min(COOP_MAX_EGGS, (item._eggCount | 0) + produced);
  item._lastEggAt = now;
}

/* ---------------- hitching-post ---------------- */
//
// ServUO DungeonHitchingPost exposes stable/claim entries via context
// menus and speech keywords. The web client does not have that context
// menu path yet, so double-click opens the same stable command surface.

export function buildHitchingPost(api) {
  return {
    name: 'hitching-post',
    onCreate(_world, item) {
      item.movable = false;
      item.forceShowProperties = true;
      item.servuoClasses = [...new Set([...(item.servuoClasses ?? []),
        'HitchingPost',
        'DungeonHitchingPost',
        'StableEntry',
        'StableTarget',
        'ClaimListGump',
        'ClaimAllEntry',
      ])];
      item.servuoClass ??= 'DungeonHitchingPost';
      item.hitchingPostCost ??= HITCHING_POST_COST;
    },
    onUse(world, item, user) {
      const state = user?.client;
      if (!state) return true;
      openHitchingPostGump(api, world, item, user);
      return true;
    },
  };
}

const HITCHING_POST_COST = 30;
const HITCHING_POST_RANGE = 12;

function openHitchingPostGump(api, world, item, user) {
  const state = user?.client;
  if (!state) return false;
  const list = _stabledList(user);
  if (!api.gumps?.send) {
    state.sendSystemMessage?.('Select a pet to stable.');
    _beginHitchingStable(api, world, item, user);
    if (list.length > 0) {
      state.sendSystemMessage?.(`You also have ${list.length} stabled pet${list.length === 1 ? '' : 's'} here; use [stable pickall if the gump host is unavailable.`);
    }
    return true;
  }

  const rows = Math.max(3, list.length + 3);
  const h = 74 + rows * 24;
  const layout = [
    '{ page 0 }',
    `{ resizepic 0 0 9250 330 ${h} }`,
    '{ checkertrans 8 8 314 ',
    String(h - 16),
    ' }',
  ];
  const texts = ['Hitching Post'];
  layout.push('{ text 16 14 1153 0 }');
  layout.push('{ button 18 42 4005 4007 1 0 1 }');
  texts.push('Stable a pet');
  layout.push('{ text 52 44 1153 1 }');
  layout.push('{ button 18 66 4005 4007 1 0 2 }');
  texts.push('Claim all pets');
  layout.push('{ text 52 68 1153 2 }');
  let y = 100;
  texts.push('Claim one pet:');
  layout.push('{ text 16 92 1153 3 }');
  for (let i = 0; i < list.length; i++) {
    const pet = list[i];
    layout.push(`{ button 18 ${y} 10006 10006 1 0 ${100 + i} }`);
    texts.push(pet.name ?? pet.kind ?? `Pet ${i + 1}`);
    layout.push(`{ text 40 ${y - 3} 1153 ${texts.length - 1} }`);
    y += 22;
  }
  if (list.length === 0) {
    texts.push('No pets stabled.');
    layout.push(`{ text 40 ${y - 3} 32 ${texts.length - 1} }`);
  }

  api.gumps.send(state, {
    gumpId: 0xD00651AB,
    x: 70,
    y: 70,
    layout: layout.join(''),
    texts,
  }, (resp) => {
    const button = resp?.buttonId | 0;
    if (button === 1) {
      _beginHitchingStable(api, world, item, user);
    } else if (button === 2) {
      _claimAllHitchingPets(api, world, item, user);
    } else if (button >= 100) {
      _claimOneHitchingPet(api, world, item, user, button - 100);
    }
  });
  return true;
}

function _beginHitchingStable(api, world, item, user) {
  const state = user?.client;
  if (!_alive(user)) return true;
  user.stabled ??= [];
  if (user.stabled.length >= _stableCapFor(user)) {
    state?.sendSystemMessage?.('You have too many pets in the stables!');
    return true;
  }
  state?.sendSystemMessage?.('Which animal would you like to stable here?');
  if (api.targeting?.request) {
    api.targeting.request(state, (picked) => {
      const pet = mobileBySerial({ ...api, world }, picked?.serial ?? picked);
      _endHitchingStable(api, world, item, user, pet);
    });
    return true;
  }
  const pet = _nearestOwnedPet(api, world, item, user);
  if (!pet) {
    state?.sendSystemMessage?.('Stand near an owned pet first.');
    return true;
  }
  _endHitchingStable(api, world, item, user, pet);
  return true;
}

function _endHitchingStable(api, world, item, user, pet) {
  const state = user?.client;
  if (!pet) {
    state?.sendSystemMessage?.("You can't stable that!");
    return false;
  }
  if (pet === user || _isHumanBody(pet)) {
    state?.sendSystemMessage?.('HA HA HA! Sorry, I am not an inn.');
    return false;
  }
  if (!_inRange(item, user, HITCHING_POST_RANGE) || !_inRange(item, pet, HITCHING_POST_RANGE)) {
    state?.sendSystemMessage?.('That is too far away.');
    return false;
  }
  if ((pet.controlMaster >>> 0) !== (user.serial >>> 0)) {
    state?.sendSystemMessage?.('You do not own that pet!');
    return false;
  }
  if (pet.controlled === false) {
    state?.sendSystemMessage?.("You can't stable that!");
    return false;
  }
  if (pet.ghost || pet.dead || pet.isDeadPet || (pet.hp ?? 1) <= 0) {
    state?.sendSystemMessage?.('Living pets only, please.');
    return false;
  }
  if (pet.summoned || pet.summonedUntil) {
    state?.sendSystemMessage?.('I can not stable summoned creatures.');
    return false;
  }
  if (pet.allured) {
    state?.sendSystemMessage?.("You can't stable that!");
    return false;
  }
  if (_packAnimalHasCargo(api, pet)) {
    state?.sendSystemMessage?.('You need to unload your pet.');
    return false;
  }
  if (_petBusy(api, pet)) {
    state?.sendSystemMessage?.("I'm sorry. Your pet seems to be busy.");
    return false;
  }
  user.stabled ??= [];
  if (user.stabled.length >= _stableCapFor(user)) {
    state?.sendSystemMessage?.('You have too many pets in the stables!');
    return false;
  }
  if (!_chargeHitchingPost(api, item, user, 'stable')) return false;

  const snapshot = _petSnapshot(user, pet);
  user.stabled.push(snapshot);
  _adjustFollowers(user, -(snapshot.controlSlots ?? 1));
  if (api.protocol?.removeEntity) {
    const rm = api.protocol.removeEntity(pet.serial);
    sendToClientsNear({ ...api, world }, pet, rm);
  }
  destroyMobileBySerial({ ...api, world }, pet.serial);
  api.ai?.detach?.(pet);
  state?.sendSystemMessage?.(`${snapshot.name ?? snapshot.kind ?? 'Your pet'} is now stabled.`);
  return true;
}

function _claimAllHitchingPets(api, world, item, user) {
  const list = _stabledList(user);
  if (list.length === 0) {
    user?.client?.sendSystemMessage?.('But I have no animals stabled with me at the moment!');
    return false;
  }
  let claimed = 0;
  for (let i = 0; i < user.stabled.length;) {
    const snap = user.stabled[i];
    if (_claimSnapshot(api, world, item, user, snap, i)) claimed++;
    else i++;
  }
  if (claimed > 0) user?.client?.sendSystemMessage?.('Here you go... and good day to you!');
  return claimed > 0;
}

function _claimOneHitchingPet(api, world, item, user, index) {
  const list = _stabledList(user);
  const snap = list[index];
  if (!snap) {
    user?.client?.sendSystemMessage?.('But I have no animals stabled with me at the moment!');
    return false;
  }
  return _claimSnapshot(api, world, item, user, snap, user.stabled.indexOf(snap));
}

function _claimSnapshot(api, world, item, user, snap, index) {
  const state = user?.client;
  if (!_alive(user) || !_inRange(item, user, 14)) return false;
  const slots = snap?.controlSlots ?? snap?._followerCost ?? 1;
  if (((user.followers ?? 0) + slots) > (user.followersMax ?? 5)) {
    state?.sendSystemMessage?.(`${snap.name ?? 'That pet'} remained in the stables because you have too many followers.`);
    return false;
  }
  if (!_chargeHitchingPost(api, item, user, 'claim')) return false;
  user.stabled.splice(index, 1);
  const fresh = createMobile({ ...api, world }, {
    ...snap,
    serial: undefined,
    x: user.x,
    y: user.y,
    z: user.z,
    map: user.map ?? snap.map ?? 1,
  });
  if (!fresh) return false;
  fresh.kind = snap.kind;
  fresh.controlMaster = user.serial >>> 0;
  fresh.controlOrder = 'follow';
  fresh.controlTarget = user.serial >>> 0;
  fresh.isStabled = false;
  fresh.stabledBy = null;
  _adjustFollowers(user, slots);
  api.ai?.attach?.(fresh, 'pet', { command: 'follow', targetSerial: user.serial });
  if (api.protocol?.mobileIncoming) {
    const pkt = api.protocol.mobileIncoming({
      serial: fresh.serial, body: fresh.body, x: fresh.x, y: fresh.y, z: fresh.z,
      direction: fresh.direction, hue: fresh.hue, flags: fresh.flags,
      notoriety: fresh.notoriety, equipment: [],
    });
    sendToClientsNear({ ...api, world }, fresh, pkt);
  }
  state?.sendSystemMessage?.(`${fresh.name ?? fresh.kind ?? 'Your pet'} returns to your side.`);
  return true;
}

function _petSnapshot(user, pet) {
  return {
    serial: pet.serial,
    kind: pet.kind,
    name: pet.name,
    body: pet.body,
    hue: pet.hue,
    hp: pet.hp,
    hpMax: pet.hpMax,
    str: pet.str,
    dex: pet.dex,
    int: pet.int,
    mana: pet.mana,
    manaMax: pet.manaMax,
    stam: pet.stam,
    stamMax: pet.stamMax,
    notoriety: pet.notoriety,
    controlMaster: user.serial >>> 0,
    controlSlots: pet.controlSlots ?? pet._followerCost ?? 1,
    map: pet.map,
    stabledAt: Date.now(),
    petXp: pet.petXp,
    petLevel: pet.petLevel,
    _origPetHpMax: pet._origPetHpMax,
    _origPetStr: pet._origPetStr,
  };
}

function _stableCapFor(mob) {
  const taming = normalizeSkillValue(mob?.skills?.[36] ?? mob?.skills?.['36'] ?? 0);
  const lore = normalizeSkillValue(mob?.skills?.[3] ?? mob?.skills?.['3'] ?? 0);
  const vet = normalizeSkillValue(mob?.skills?.[40] ?? mob?.skills?.['40'] ?? 0);
  const sum = taming + lore + vet;
  let max = sum >= 240 ? 5 : sum >= 200 ? 4 : sum >= 160 ? 3 : 2;
  max += mob?.rewardStableSlots | 0;
  return max;
}

function _chargeHitchingPost(api, item, user, action) {
  const state = user?.client;
  if ((item.usesRemaining ?? 1) <= 0) {
    state?.sendSystemMessage?.('Hitching rope is insufficient. You have to supply it.');
    return false;
  }
  const staff = !user?.client?.account
    || user.client.account.accessLevel === 'GM'
    || user.client.account.accessLevel === 'Admin';
  const cost = item.hitchingPostCost ?? HITCHING_POST_COST;
  if (!staff && _consumeGold(api, user, cost) < cost) {
    state?.sendSystemMessage?.(`You need ${cost} gold to ${action} a pet.`);
    return false;
  }
  if (item.usesRemaining != null && item.replica) {
    item.usesRemaining = Math.max(0, (item.usesRemaining | 0) - 1);
  }
  return true;
}

function _consumeGold(api, mob, cost) {
  const pack = api.game?.inventory?.findBackpack?.(mob)
    ?? api.game?.inventory?.findEquipped?.(mob, 21);
  if (!pack) return 0;
  let remaining = cost;
  for (const it of childrenOf(api, pack)) {
    if (remaining <= 0) break;
    if (it.itemId !== 0x0EED) continue;
    const have = it.amount ?? 1;
    if (have <= remaining) {
      remaining -= have;
      try { destroyItemBySerial(api, it.serial); }
      catch { it.amount = 0; }
    } else {
      it.amount = have - remaining;
      remaining = 0;
    }
  }
  return cost - remaining;
}

function _stabledList(user) {
  user.stabled ??= [];
  user.stabled = user.stabled.filter(Boolean);
  return user.stabled;
}

function _nearestOwnedPet(api, world, item, user) {
  for (const m of nearbyMobiles({ ...api, world }, item, user, HITCHING_POST_RANGE)) {
    if ((m.controlMaster >>> 0) === (user.serial >>> 0)) return m;
  }
  return null;
}

function _packAnimalHasCargo(api, pet) {
  const name = String(pet.kind ?? pet.name ?? '').toLowerCase();
  const packAnimal = name.includes('pack horse')
    || name.includes('pack llama')
    || name.includes('beetle');
  if (!packAnimal) return false;
  for (const it of childrenOf(api, pet)) {
    if (it.layer === 21 || it.container || it.parent === pet.serial) return true;
  }
  return false;
}

function _petBusy(api, pet) {
  const targetSerial = pet._combatTarget ?? pet.combatant ?? pet.combatantSerial;
  if (!targetSerial && !((pet._combatUntil ?? 0) > Date.now())) return false;
  const target = mobileBySerial(api, targetSerial);
  if (!target) return (pet._combatUntil ?? 0) > Date.now();
  return _inRange(pet, target, 12);
}

function _alive(mob) {
  return !!mob && !mob.deleted && !mob.ghost && !mob.dead && (mob.hp ?? 1) > 0;
}

function _isHumanBody(mob) {
  const body = mob?.body | 0;
  return body === 0x0190 || body === 0x0191 || body === 0x025D || body === 0x025E;
}

function _inRange(a, b, range) {
  if ((a?.map ?? 1) !== (b?.map ?? 1)) return false;
  return Math.max(Math.abs((a?.x | 0) - (b?.x | 0)), Math.abs((a?.y | 0) - (b?.y | 0))) <= range;
}

function _adjustFollowers(user, delta) {
  if (typeof user.followers !== 'number') return;
  user.followers = Math.max(0, user.followers + delta);
}

/* ──────────────── incubator + incubator-egg ──────────────── */
//
// An Incubator is a housing-decoration container that hatches an egg
// over N days (set on the egg item via `data.daysToHatch`). At the end
// of the timer the egg is consumed and the configured pet kind spawns
// in the user's pack as a tamed creature.
//
// Eggs are placed INTO the incubator (the `parent` switches on drop)
// and tick from that moment forward. `_incubateUntil` is set by the
// drop-into hook; for now we expose a manual `[incubate check` flow
// triggered on incubator double-click.

export function buildIncubator(api) {
  return {
    name: 'incubator',
    onCreate(_world, item) {
      item.movable = false;
      item.container = true;
      item.capacity = 8;
    },
    onUse(world, item, user) {
      const state = user?.client;
      if (!state) return true;
      // Walk the eggs inside; hatch any whose timer is up.
      const eggs = [...childrenOf({ world }, item)];
      let hatched = 0;
      for (const egg of eggs) {
        if (egg.script !== 'incubator-egg') continue;
        const due = egg._incubateUntil ?? Number.POSITIVE_INFINITY;
        if (Date.now() < due) continue;
        // Hatch — spawn the kind, destroy the egg.
        const kind = egg.data?.hatch ?? 'chicken';
        try {
          const factory = api.ctx?.spawnFactory ?? api.spawnFactory;
          if (factory) {
            const pet = factory(world, kind, {
              x: user.x, y: user.y, z: user.z, map: user.map ?? 1,
            });
            if (pet) {
              pet.tamed = true;
              pet.controlMaster = user.serial;
            }
          }
          destroyItemBySerial(api, egg.serial);
          hatched++;
        } catch (e) {
          api.log?.(`incubator hatch ${kind} threw: ${e.message}`);
        }
      }
      if (hatched > 0) {
        state.sendSystemMessage?.(`${hatched} egg${hatched === 1 ? '' : 's'} hatched!`);
      } else {
        const next = eggs
          .map((e) => e._incubateUntil ?? Number.POSITIVE_INFINITY)
          .reduce((m, t) => Math.min(m, t), Number.POSITIVE_INFINITY);
        if (Number.isFinite(next)) {
          const mins = Math.max(0, Math.ceil((next - Date.now()) / 60_000));
          state.sendSystemMessage?.(`Next hatch in ~${mins} min.`);
        } else {
          state.sendSystemMessage?.('The incubator is empty.');
        }
      }
      return true;
    },
  };
}

export function buildIncubatorEgg(_api) {
  return {
    name: 'incubator-egg',
    onCreate(_world, item) {
      // When the egg is created, stamp the hatch deadline if not set.
      const days = item.data?.daysToHatch ?? 7;
      item._incubateUntil = item._incubateUntil
        ?? Date.now() + days * 24 * 60 * 60 * 1000;
    },
  };
}

/* ──────────────── helpers ──────────────── */

function _stateProp(item, state) {
  return item[`target${state}Property`]
      ?? item[`_target${state}Property`]
      ?? item[`_xmlTarget${state}Property`]
      ?? item[`targetProperty${state}`]
      ?? item.targetProperty;
}

function _stateTarget(world, item, state) {
  const serial = item[`target${state}Serial`]
    ?? item[`_target${state}Serial`]
    ?? item[`_xmlTarget${state}Serial`]
    ?? item[`target${state}Item`]
    ?? item._switchTargetSerial
    ?? item.linkSerial;
  return serial ? itemBySerial({ world }, serial >>> 0) : item;
}

function _applyXmlSwitchState(api, world, item, user, state) {
  const prop = _stateProp(item, state);
  if (!prop) return false;
  const target = _stateTarget(world, item, state) ?? item;
  const xml = api.systems?.xmlSpawner;
  if (!xml?.applySpawnDirectives) return false;
  try {
    xml.applySpawnDirectives(target, {
      world,
      trigMob: user,
      user,
      entry: { raw: _xmlActionRaw(prop) },
      broadcastSpeech: (mob, text) => api.protocol?.broadcastSpeech?.(mob, text),
      playSoundNear: api.combat?.playSoundNear,
      damage: api.combat?.damage,
    });
    _broadcast(api, world, target);
    return true;
  } catch (e) {
    api.log?.(`xml switch state ${state} failed: ${e.message}`);
    return false;
  }
}

function _xmlActionRaw(prop) {
  const text = String(prop ?? '').trim();
  if (/^(SET|SETONTHIS|SETONTRIGMOB|MSG|SENDMSG|PRIVMSG|SAY|SPEECH|SOUND|DAMAGE|ATTACH)\b/i.test(text)) {
    return text;
  }
  return `SET/${text}`;
}

function _playSwitchSound(api, world, item) {
  try {
    const soundId = item.switchSound ?? item.leverSound ?? 0x03AB;
    const pkt = api.protocol?.playSound?.({ soundId, x: item.x, y: item.y, z: item.z });
    if (!pkt) return;
    for (const m of nearbyClients(world ?? api.world, item)) m.client.send(pkt);
  } catch { /* advisory */ }
}

function _broadcast(api, world, item) {
  const wi = api.protocol?.worldItemSA?.({
    serial: item.serial, itemId: item.itemId, hue: item.hue,
    amount: item.amount ?? 1, x: item.x, y: item.y, z: item.z,
  });
  if (!wi) return;
  for (const m of nearbyClients(world, item)) m.client.send(wi);
}
