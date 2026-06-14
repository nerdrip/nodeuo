// Door templates. A door has two graphics — `closed` and `open` — and
// toggles between them on `onUse`. The open graphic is normally +1 from the
// closed graphic for classic UO doors, but we store both explicitly.
//
// Registered as `door-wood`, `door-metal`, `door-iron`. When the sender
// double-clicks the door it toggles and broadcasts a 0x1A update.

import { nearbyClients } from '../../_spatial.js';

const DOORS = [
  { name: 'door-wood',  closed: 0x0675, open: 0x0676 },
  { name: 'door-metal', closed: 0x0685, open: 0x0686 },
  { name: 'door-iron',  closed: 0x0695, open: 0x0696 },
];

/**
 * @param {import('@uo/server/src/scripts.js').ScriptAPI} api
 */
export default function register(api) {
  if (!api.templates || !api.protocol) return () => {};

  const names = [];
  for (const d of DOORS) {
    api.templates.registerTemplate({
      name: d.name,
      itemId: d.closed,
      movable: false,
      label: 'a door',
      onUse(world, item, user) {
        // @ts-expect-error — we tag per-instance state on the item for toggle.
        const open = !!item._open;
        item.itemId = open ? d.closed : d.open;
        // @ts-expect-error — see above.
        item._open = !open;
        // Rebroadcast to everyone who might see this tile.
        for (const other of nearbyClients(api, item)) other.client.sendItem(item);
        if (user && user.client) {
          user.client.send(api.protocol.playSound({
            soundId: open ? 0x00F1 : 0x00EA, // hinge creak
            x: item.x, y: item.y, z: item.z,
          }));
        }
      },
    });
    names.push(d.name);
  }
  api.log(`items/doors: registered ${names.length} door templates`);

  return () => {
    for (const n of names) api.templates.unregisterTemplate(n);
  };
}
