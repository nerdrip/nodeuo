// [jail / [unjail — teleport a misbehaving player to a designated jail
// cell and flag the account. Mirrors ServUO `JailCommand`.
//
// Jail location: Felucca (5276, 1164, 0) — same canonical coordinate
// that ServUO uses for its default cell. Override via env var
// UO_JAIL_X / UO_JAIL_Y / UO_JAIL_Z if your shard maps it elsewhere.
//
// `acc.jailed` is set; an offline jailed account stays offline (rebound
// to jail coords) on next login because handlers.bringIntoWorld can
// honour the flag. `[unjail` clears it; the player must `[stuck`
// themselves out or rely on a GM teleport.

import { moveMobile } from '../../_movement.js';
import { resolveMobileArg } from '../_targeting-helpers.js';

const JAIL_X = parseInt(process.env.UO_JAIL_X ?? '5276', 10);
const JAIL_Y = parseInt(process.env.UO_JAIL_Y ?? '1164', 10);
const JAIL_Z = parseInt(process.env.UO_JAIL_Z ?? '0', 10);
const JAIL_MAP = parseInt(process.env.UO_JAIL_MAP ?? '0', 10);

function teleportTo(api, mob, x, y, z, map) {
  moveMobile(api, mob, { x, y, z, map });
  if (!api.protocol || !mob.client) return;
  try {
    mob.client.send(api.protocol.mobileUpdate({
      serial: mob.serial, body: mob.body, x: mob.x, y: mob.y, z: mob.z,
      direction: mob.direction ?? 0, hue: mob.hue ?? 0, flags: mob.flags ?? 0,
    }));
  } catch (e) { console.error('[jail] teleport push', e); }
}

export default function (api) {
  const { commands } = api;
  const accounts = api.ctx?.accounts;
  if (!accounts) return;

  commands.register({
    name: 'jail',
    help: `Teleport target to jail (${JAIL_X},${JAIL_Y},${JAIL_Z}) and flag the account.`,
    access: 'GameMaster',
    run: (ctx) => {
      resolveMobileArg(api, ctx, 0, (m) => {
        if (!m) return;
        if (!m.accountName) { ctx.state.sendSystemMessage('Target has no account.'); return; }
        const acc = accounts.accounts.get(m.accountName.toLowerCase());
        if (!acc) { ctx.state.sendSystemMessage('Target account not found.'); return; }
        if (acc.accessLevel === 'Admin') {
          ctx.state.sendSystemMessage('Refusing to jail an admin.');
          return;
        }
        acc.jailed = true;
        try { accounts.saveSync(); } catch (e) { console.error('[jail] saveSync', e); }
        teleportTo(api, m, JAIL_X, JAIL_Y, JAIL_Z, JAIL_MAP);
        m.client?.sendSystemMessage?.('You have been jailed.');
        ctx.state.sendSystemMessage(`Jailed ${acc.username}.`);
      });
    },
  });

  commands.register({
    name: 'unjail',
    help: 'Lift the jail flag on the targeted player.',
    access: 'GameMaster',
    run: (ctx) => {
      resolveMobileArg(api, ctx, 0, (m) => {
        if (!m) return;
        if (!m.accountName) { ctx.state.sendSystemMessage('Target has no account.'); return; }
        const acc = accounts.accounts.get(m.accountName.toLowerCase());
        if (!acc) { ctx.state.sendSystemMessage('Target account not found.'); return; }
        acc.jailed = false;
        try { accounts.saveSync(); } catch (e) { console.error('[unjail] saveSync', e); }
        m.client?.sendSystemMessage?.('Your jail status has been lifted.');
        ctx.state.sendSystemMessage(`Unjailed ${acc.username}.`);
      });
    },
  });

  return () => {
    commands.unregister('jail');
    commands.unregister('unjail');
  };
}
