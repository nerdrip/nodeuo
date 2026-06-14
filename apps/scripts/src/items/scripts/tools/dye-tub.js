import { itemBySerial } from '../../../_entities.js';
import { isEquippedBy, isInPack } from '../../../_inventory.js';
// Dye Tub — ServUO `Items/Resource/DyeTub.cs` + 19 variants.
//
// Each variant is defined in `definitions/functional.js` with a fixed
// hue palette in `dyeHues` (1..20 entries). Double-click cycles the
// tub's selected hue and prompts the player to target a clothing item.
//
// Dyeable layers come from the existing `[dye` command — clothing,
// armor, robe, cloak, pants, leggings. Items in the player's pack are
// also accepted.

const DYEABLE_LAYERS = new Set([3, 4, 5, 6, 12, 13, 20, 22, 24]);

function dyeHuesOf(item) {
  // Definition cache: itemId 0x0FAB has 20 distinct dye tubs by tagId.
  // Item carries the def's data via spawn-time copy (definition.dyeHues
  // is copied to item.dyeHues; legacy items may only have item._def).
  return item.dyeHues
      ?? item._def?.dyeHues
      ?? item.definition?.dyeHues
      ?? null;
}

export default function buildDyeTub(api) {
  return {
    name: 'dye-tub',
    onUse(world, item, user) {
      if (!user?.client) return true;
      const palette = dyeHuesOf(item);
      if (!palette || palette.length === 0) {
        user.client.sendSystemMessage?.('This dye tub has no hues.');
        return true;
      }
      // Cycle hue index (persists on the item).
      const idx = ((item._dyeHueIndex ?? -1) + 1) % palette.length;
      item._dyeHueIndex = idx;
      const hue = palette[idx] | 0;

      const palStr = palette.length === 1
        ? `hue 0x${hue.toString(16)}`
        : `hue ${idx + 1}/${palette.length} (0x${hue.toString(16)})`;
      user.client.sendSystemMessage?.(`Dye Tub set to ${palStr}. Target an item to dye.`);

      if (!api.targeting?.request) return true;
      api.targeting.request(user.client, (picked) => {
        if (!picked?.serial) {
          user.client.sendSystemMessage?.('Cancelled.');
          return;
        }
        const target = itemBySerial({ world }, picked.serial >>> 0);
        if (!target) {
          user.client.sendSystemMessage?.('That is not an item.');
          return;
        }
        const layerOk = DYEABLE_LAYERS.has(target.layer ?? 0);
        const inPack = isInPack({ world }, target, user);
        const worn = isEquippedBy({ world }, target, user);
        if (!layerOk && !inPack && !worn) {
          user.client.sendSystemMessage?.('You may only dye clothing in your pack or on yourself.');
          return;
        }
        target.hue = hue;
        user.client.sendSystemMessage?.(`You dye the item ${palStr}.`);

        if (api.protocol?.containerContentUpdate && target.parent != null) {
          user.client.send(api.protocol.containerContentUpdate({
            serial: target.serial,
            itemId: target.itemId,
            amount: target.amount ?? 1,
            hue: target.hue,
            gridX: 0, gridY: 0, gridLocation: 0,
          }, target.parent));
        }
        // If equipped, push equip update so the wearer sees the new hue.
        if (api.protocol?.equipUpdate && layerOk && worn) {
          user.client.send(api.protocol.equipUpdate({
            serial: target.serial,
            itemId: target.itemId,
            layer: target.layer,
            parent: user.serial,
            hue: target.hue,
          }));
        }
      }, { kind: 0 });
      return true;
    },
  };
}
