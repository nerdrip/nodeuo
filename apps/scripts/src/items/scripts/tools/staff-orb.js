import { childrenOf } from '../../../_inventory.js';

function isStaffOrb(item) {
  return item?.script === 'staff-orb' || item?.servuoClass === 'StaffOrb';
}

function findOwnedOrb(world, user) {
  for (const item of childrenOf({ world }, user)) {
    if (!isStaffOrb(item)) continue;
    if (!item.staffOrbOwnerSerial || (item.staffOrbOwnerSerial >>> 0) === (user.serial >>> 0)) return item;
  }
  return null;
}

function assignOrb(item, user) {
  item.staffOrbOwnerSerial = user.serial;
  item.staffOrbHome = { x: user.x, y: user.y, z: user.z | 0, map: user.map ?? 1 };
  item.staffOrbAutoRes ??= true;
  item.name = `${user.name ?? 'Staff'}'s Staff Orb`;
}

function toggleAccess(item, user) {
  const current = user.accessLevel ?? user.client?.account?.accessLevel ?? 'Player';
  if (current === 'Player') {
    user.accessLevel = item.staffOrbStaffLevel ?? 'GM';
    user.blessed = true;
    user.client?.sendSystemMessage?.('Staff status restored.');
  } else {
    item.staffOrbStaffLevel = current;
    user.accessLevel = 'Player';
    user.blessed = false;
    user.client?.sendSystemMessage?.('Staff status hidden.');
  }
}

function registerStaffOrbCommand(api) {
  if (!api.commands || api.commands.commands?.has?.('stafforb')) return;
  api.commands.register({
    name: 'stafforb',
    help: '[stafforb home|sethome|autores',
    access: 'Counselor',
    run(ctx, args) {
      const user = ctx.sender;
      const orb = findOwnedOrb(api.world ?? ctx.world, user);
      if (!orb) {
        ctx.state?.sendSystemMessage?.('You do not carry your staff orb.');
        return;
      }
      const action = String(args?.[0] ?? 'home').toLowerCase();
      if (action === 'sethome') {
        orb.staffOrbHome = { x: user.x, y: user.y, z: user.z | 0, map: user.map ?? 1 };
        ctx.state?.sendSystemMessage?.('The home location on your orb has been set to your current position.');
        return;
      }
      if (action === 'autores') {
        orb.staffOrbAutoRes = !orb.staffOrbAutoRes;
        ctx.state?.sendSystemMessage?.(`Auto-resurrection ${orb.staffOrbAutoRes ? 'enabled' : 'disabled'}.`);
        return;
      }
      const home = orb.staffOrbHome;
      if (!home) {
        ctx.state?.sendSystemMessage?.('No home location is set.');
        return;
      }
      user.x = home.x; user.y = home.y; user.z = home.z | 0; user.map = home.map ?? user.map ?? 1;
      ctx.state?.sendSystemMessage?.('You return to your staff home.');
    },
  });
}

export default function buildStaffOrb(api) {
  registerStaffOrbCommand(api);
  return {
    name: 'staff-orb',
    onCreate(_world, item) {
      item.staffOrbAutoRes ??= true;
      item.blessed = true;
      item.weight = 0;
      item.servuoClasses ??= ['StaffOrb', 'SetHomeEntry', 'GoHomeEntry', 'AutoResTimer'];
    },
    onUse(_world, item, user) {
      if (!user?.client) return true;
      if (!item.staffOrbOwnerSerial) {
        assignOrb(item, user);
        user.client.sendSystemMessage?.('This orb has been assigned to you.');
        return true;
      }
      if ((item.staffOrbOwnerSerial >>> 0) !== (user.serial >>> 0)) {
        user.client.sendSystemMessage?.('This is not yours to use.');
        return true;
      }
      toggleAccess(item, user);
      return true;
    },
  };
}
