// FAZA BV — Shrine lifecycle script + `[shrine` admin command.
//
// onWalkOn: ghost steps on the shrine → instant resurrect.
// onUse:    ghost double-clicks the shrine → resurrect (accessibility).
//
// Both paths call `resurrectAtShrine`, which delegates to corpse.js
// and applies the shrine's HP / mana / stam policy.

import { allItems, sendToClientsNear } from '../../_spatial.js';
import { canCreateItem } from '../../_items.js';

/**
 * Canonical UO shrines. Coordinates copied from ServUO `Scripts/Items/
 * Decorative/Shrine*.cs`. Loaded once per server boot inside the script
 * disposer scope so a hot-reload re-spawns them at the same spots.
 */
const SHRINES = [
  { name: 'Spirituality', x: 1738, y: 2967 },
  { name: 'Compassion',   x: 1858, y: 873  },
  { name: 'Valor',        x: 2491, y: 3930 },
  { name: 'Honor',        x: 4264, y: 564  },
  { name: 'Honesty',      x: 4209, y: 562  },
  { name: 'Justice',      x: 1300, y: 630  },
  { name: 'Sacrifice',    x: 1606, y: 2490 },
  { name: 'Humility',     x: 4274, y: 3697 },
];

export default function register(api) {
  if (!canCreateItem(api, api.world)) return () => {};
  const shrines = api.systems?.shrines;
  if (!shrines) {
    api.log?.('shrines: shrine system unavailable');
    return () => {};
  }

  api.itemScripts?.register?.({
    name: 'shrine',
    onUse(world, item, user) {
      if (!user?.ghost) {
        user?.client?.sendSystemMessage?.('The shrine accepts only the dead.');
        return true;
      }
      const ok = shrines.resurrectAtShrine(world, api.corpse, user, item);
      if (ok) {
        user.client?.sendSystemMessage?.(`The shrine of ${item.shrine?.name ?? 'Light'} restores you.`);
      } else {
        user.client?.sendSystemMessage?.('You must be near the shrine.');
      }
      return true;
    },
    onWalkOn(world, item, mob) {
      if (!mob?.ghost) return;
      const ok = shrines.resurrectAtShrine(world, api.corpse, mob, item);
      if (ok) {
        mob.client?.sendSystemMessage?.(`The shrine of ${item.shrine?.name ?? 'Light'} restores you.`);
      }
    },
  });

  // Drop the canonical shrines on world load. Idempotent: skip if a
  // shrine of the same name already exists in the same tile to survive
  // hot reload + persisted saves.
  const placed = [];
  for (const cfg of SHRINES) {
    const exists = [...allItems(api)].some((it) =>
      it.script === 'shrine' && it.shrine?.name === cfg.name
      && it.x === cfg.x && it.y === cfg.y);
    if (exists) continue;
    placed.push(shrines.placeShrine(api, api.world, cfg));
  }
  if (placed.length) api.log?.(`shrines: placed ${placed.length} new shrines`);

  // Admin: `[shrine <Name>` drops a custom shrine at sender's feet.
  if (api.commands) {
    api.commands.register({
      name: 'shrine',
      help: '[shrine <name> — place a resurrection shrine at your feet',
      access: 'GameMaster',
      run(ctx, args) {
        const name = (args[0] ?? 'Custom').replace(/[^A-Za-z0-9]/g, '');
        const item = shrines.placeShrine(api, api.world, {
          name, x: ctx.sender.x, y: ctx.sender.y, z: ctx.sender.z, map: ctx.sender.map,
          fullRestore: true,
        });
        const wi = api.protocol?.worldItemSA?.({
          serial: item.serial, itemId: item.itemId, hue: item.hue,
          amount: 1, x: item.x, y: item.y, z: item.z,
        });
        if (wi) sendToClientsNear(api, item, wi);
        ctx.state.sendSystemMessage(`Shrine of ${name} placed.`);
      },
    });
  }

  return () => {
    api.commands?.unregister('shrine');
  };
}
