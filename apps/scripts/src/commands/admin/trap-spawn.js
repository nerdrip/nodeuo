// `[trap <kind>` admin command — spawns a runtime trap item at the
// caller's feet bound to one of the registered trap scripts. Mirrors
// ServUO admin command set.
//
//   [trap spike       gas       fire        saw       dart
//   [trap pressure  <doorSerial>            — link a plate to a door

import { nearbyClients } from '../../_spatial.js';
import { createItem } from '../../_items.js';

const TRAP_KINDS = {
  spike:    { itemId: 0x10F5, script: 'spike-trap',       name: 'a spike trap' },
  gas:      { itemId: 0x113A, script: 'gas-trap',         name: 'a gas trap' },
  fire:     { itemId: 0x36BD, script: 'fire-column-trap', name: 'a fire column trap' },
  saw:      { itemId: 0x10F5, script: 'saw-trap',         name: 'a saw trap' },
  dart:     { itemId: 0x1BFE, script: 'dart-trap',        name: 'a dart trap' },
  pressure: { itemId: 0x1BC3, script: 'pressure-plate',   name: 'a pressure plate' },
};

export default function register(api) {
  if (!api.commands || !api.world || !api.items) return () => {};

  api.commands.register({
    name: 'trap',
    help: `[trap <${Object.keys(TRAP_KINDS).join('|')}> [linkSerial] — spawn a trap.`,
    access: 'Admin',
    run(ctx) {
      const kind = String(ctx.args[0] ?? '').toLowerCase();
      const cfg = TRAP_KINDS[kind];
      if (!cfg) {
        ctx.state.sendSystemMessage(`Trap kinds: ${Object.keys(TRAP_KINDS).join(', ')}`);
        return;
      }
      const mob = ctx.sender;
      const item = createItem(api, api.world, {
        itemId: cfg.itemId, x: mob.x, y: mob.y, z: mob.z,
        map: mob.map ?? 1, name: cfg.name, movable: false,
      });
      item.script = cfg.script;
      item.owner = mob.serial;
      // Pressure plates take an optional 2nd arg: door serial to link.
      if (kind === 'pressure' && ctx.args[1]) {
        item.linkSerial = Number(ctx.args[1]) | 0;
      }
      const wi = api.protocol?.worldItemSA?.({
        serial: item.serial, itemId: item.itemId, hue: item.hue,
        amount: 1, x: item.x, y: item.y, z: item.z,
      });
      if (wi) for (const m of nearbyClients(api.world, item)) m.client.send(wi);
      ctx.state.sendSystemMessage(`You place ${cfg.name}.`);
    },
  });

  return () => api.commands.unregister('trap');
}
