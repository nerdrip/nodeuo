// Resilient new-character items which must exist before content hot-load ends.

import { createItem } from '../world/items.js';
import { getTemplate, spawn as spawnTemplate } from '../world/templates.js';

/**
 * Give a new character the spell-schema editor key even when content scripts
 * have not registered their templates yet (minimal E2E harnesses and the
 * short cold-boot window).
 */
export function createStarterCodex(world, mobile, backpack) {
  const placement = {
    x: mobile.x, y: mobile.y, z: mobile.z, map: mobile.map,
    parent: backpack.serial,
  };
  const codex = getTemplate('spell-schema-codex')
    ? spawnTemplate(world, 'spell-schema-codex', placement)
    : createItem(world, {
        definitionId: 'spell-schema-codex', artId: 0x0FF0,
        name: 'Arcane Schema Codex', hue: 0x0481,
        script: 'spell-schema-codex', template: 'spell-schema-codex',
        kind: 'book', category: 'spell-schema', weight: 3,
        movable: true, newbied: true, blessed: true, accountBound: true,
        ...placement,
      });
  // These invariants must not depend on item-script registration order.
  codex.newbied = true;
  codex.blessed = true;
  codex.accountBound = true;
  return codex;
}
