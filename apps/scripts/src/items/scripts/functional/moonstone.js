import { createItem, destroyItemBySerial } from '../../../_items.js';
import { mobileBySerial } from '../../../_entities.js';
import { isInPack } from '../../../_inventory.js';
import { moveItem, moveMobile } from '../../../_movement.js';

const SETTLE_FIRST_MS = 2500;
const SETTLE_STEP_MS = 1000;
const GATE_DURATION_MS = 30_000;

function targetMapFor(item, userMap = 1) {
  const t = String(item.moonstoneType ?? item.type ?? '').toLowerCase();
  if (t.includes('fel')) return 0;
  if (t.includes('tram')) return 1;
  return (userMap | 0) === 0 ? 1 : 0;
}

function canUseMoonstone(world, item, user) {
  if (!user?.client) return false;
  if (!isInPack({ world }, item, user)) {
    user.client.sendSystemMessage?.('That must be in your pack for you to use it.');
    return false;
  }
  if (user.mounted || user.mountSerial) {
    user.client.sendSystemMessage?.('You cannot bury a stone while mounted.');
    return false;
  }
  const targetMap = targetMapFor(item, user.map);
  if ((user.map | 0) === targetMap || ![0, 1].includes(user.map | 0)) {
    user.client.sendSystemMessage?.('You cannot bury the stone here.');
    return false;
  }
  if (user.carryingSigil || user.factionSigil) {
    user.client.sendSystemMessage?.("You can't do that while carrying the sigil.");
    return false;
  }
  if (user.young && targetMap === 0) {
    user.client.sendSystemMessage?.('You decide against traveling to Felucca while you are still young.');
    return false;
  }
  if (user.criminal) {
    user.client.sendSystemMessage?.('The magic of the stone cannot be evoked by the lawless.');
    return false;
  }
  if (user.murderer || (user.kills | 0) >= 5) {
    user.client.sendSystemMessage?.('The magic of the stone cannot be evoked by someone with blood on their hands.');
    return false;
  }
  return true;
}

function sameParty(api, a, b) {
  if (!a || !b) return false;
  if (a.serial === b.serial) return true;
  const pa = api.party?.partyOf?.(a.serial);
  const pb = api.party?.partyOf?.(b.serial);
  return !!pa && pa === pb;
}

function createGatePair(api, world, stone) {
  const st = stone.moonstoneSettling;
  if (!st) return;
  const hue = stone.hue || st.hue || 0x47E;
  const common = {
    itemId: 0x0F6C,
    hue,
    name: 'moonstone gate',
    movable: false,
    script: 'moonstone-gate',
    gateOwnerSerial: st.casterSerial,
    moonstoneGate: true,
    gateExpiresAt: Date.now() + GATE_DURATION_MS,
    servuoClass: 'MoonstoneGate',
    servuoClasses: ['MoonstoneGate', 'Moongate', 'DelayTimer'],
  };
  createItem(api, world, {
    ...common,
    x: st.x, y: st.y, z: st.z, map: st.map,
    teleportTo: { x: st.x, y: st.y, z: st.z, map: st.targetMap },
  });
  createItem(api, world, {
    ...common,
    x: st.x, y: st.y, z: st.z, map: st.targetMap,
    teleportTo: { x: st.x, y: st.y, z: st.z, map: st.map },
  });
  try {
    const caster = mobileBySerial({ ...api, world }, st.casterSerial);
    api.effects?.playAt?.(world, caster ?? stone, { itemId: 0x3728, hue, duration: 10 });
  } catch { /* visual only */ }
  destroyItemBySerial({ world }, stone.serial);
}

function useGate(api, world, gate, mob) {
  if (!mob || !gate.teleportTo) return true;
  if (mob.murderer || (mob.kills | 0) >= 5) return true;
  const owner = mobileBySerial({ ...api, world }, gate.gateOwnerSerial);
  if (owner && !sameParty(api, owner, mob)) {
    mob.client?.sendSystemMessage?.('The gate is bound to another party.');
    return true;
  }
  const teleport = api.itemScripts?.get?.('teleporter');
  if (teleport?.onWalkOn) {
    teleport.onWalkOn(world, gate, mob);
  } else {
    moveMobile(api, mob, gate.teleportTo);
  }
  return true;
}

export function buildMoonstoneGate(api) {
  return {
    name: 'moonstone-gate',
    hasTick: true,
    onUse(world, item, user) {
      return useGate(api, world, item, user);
    },
    onWalkOn(world, item, mob) {
      return useGate(api, world, item, mob);
    },
    onTick(world, item) {
      if ((item.gateExpiresAt ?? 0) > Date.now()) return;
      destroyItemBySerial({ world }, item.serial);
    },
  };
}

export default function buildMoonstone(api) {
  return {
    name: 'moonstone',
    hasTick: true,
    onUse(world, item, user) {
      if (!canUseMoonstone(world, item, user)) return true;
      const targetMap = targetMapFor(item, user.map);
      moveItem(api, item, {
        parent: null,
        x: user.x, y: user.y, z: user.z, map: user.map ?? 1,
      });
      item.movable = false;
      item.hue ||= 0x47E + ((Math.random() * 12) | 0);
      item.moonstoneSettling = {
        x: user.x, y: user.y, z: user.z,
        map: user.map ?? 1,
        targetMap,
        casterSerial: user.serial,
        count: 0,
        nextAt: Date.now() + SETTLE_FIRST_MS,
        hue: item.hue,
      };
      user.client?.sendSystemMessage?.('You bury the moonstone.');
      return true;
    },
    onTick(world, item) {
      const st = item.moonstoneSettling;
      if (!st || (st.nextAt ?? 0) > Date.now()) return;
      st.count = (st.count | 0) + 1;
      st.nextAt = Date.now() + SETTLE_STEP_MS;
      const caster = mobileBySerial({ ...api, world }, st.casterSerial);
      if (st.count === 1) {
        caster?.client?.sendSystemMessage?.('The stone settles into the ground.');
      } else if (st.count >= 10) {
        item.z = (item.z | 0) - 1;
      }
      if (st.count >= 16) {
        if (!caster) {
          destroyItemBySerial({ world }, item.serial);
          return;
        }
        createGatePair(api, world, item);
      }
    },
  };
}
