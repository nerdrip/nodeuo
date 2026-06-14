// FAZA BP — clothing presets + `[outfit <preset>` admin command.
//
// Presets are *named bundles* of items.json template references. Each
// entry resolves to:
//   { template: 'shirt', layer: 5, hue?: number }
// The optional `hue` overrides the template's `defaultHue` so the same
// shirt can render in different colours per outfit.
//
// Equipping is done by:
//   1. iterating current equipment on the target mobile
//   2. destroying any existing piece on a layer the preset touches
//   3. spawning the new piece via `api.templates.spawn()` parented to
//      the mobile with the requested layer
//   4. broadcasting equipUpdate so observers re-render the paperdoll
//
// We deliberately do NOT touch the backpack (layer 21) — outfit changes
// must not delete the player's inventory container.

import { equipUpdate } from '@uo/protocol';
import { equipped } from '../../_inventory.js';
import { sendToClientsNear } from '../../_spatial.js';
import { destroyItemBySerial } from '../../_items.js';

const PRESETS = {
  // Plain peasant: shirt + long pants + sandals.
  peasant: [
    { template: 'shirt',      layer:  5, hue: 904 },
    { template: 'long-pants', layer:  4, hue: 954 },
    { template: 'sandals',    layer:  3, hue: 1107 },
  ],
  // Warrior: leather armour + boots.
  warrior: [
    { template: 'leather-tunic',    layer: 13 },
    { template: 'leather-leggings', layer: 24 },
    { template: 'leather-cap',      layer:  6 },
    { template: 'boots',            layer:  3 },
    { template: 'cloak',            layer: 20, hue: 0x21 },
  ],
  // Mage / scholar: fancy shirt, robe, wizard hat.
  mage: [
    { template: 'fancy-shirt', layer:  5, hue: 1109 },
    { template: 'long-pants',  layer:  4, hue:   38 },
    { template: 'robe',        layer: 22, hue:   38 },
    { template: 'wizard-hat',  layer:  6, hue:   38 },
    { template: 'shoes',       layer:  3, hue:   68 },
  ],
  // Noble / fancy townie.
  noble: [
    { template: 'doublet',     layer:  5, hue:   68 },
    { template: 'long-pants',  layer:  4, hue: 1175 },
    { template: 'shoes',       layer:  3, hue:   68 },
    { template: 'cloak',       layer: 20, hue: 1175 },
    { template: 'feathered-hat', layer: 6 },
  ],
  // Bandit / rogue: dark leathers + bandana.
  bandit: [
    { template: 'shirt',      layer:  5, hue:    37 },
    { template: 'short-pants',layer:  4, hue:    38 },
    { template: 'bandana',    layer:  6, hue:    37 },
    { template: 'boots',      layer:  3 },
    { template: 'body-sash',  layer: 12, hue:    37 },
  ],
  // Pirate.
  pirate: [
    { template: 'fancy-shirt',layer:  5, hue: 0x66D },
    { template: 'long-pants', layer:  4, hue:    38 },
    { template: 'tricorne',   layer:  6 },
    { template: 'thigh-boots',layer:  3 },
    { template: 'body-sash',  layer: 12, hue: 0x66D },
  ],
};

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.commands || !api.templates) return () => {};

  api.commands.register({
    name: 'outfit',
    help: '[outfit <preset> — dress yourself: peasant | warrior | mage | noble | bandit | pirate',
    run(ctx, args) {
      const presetName = (args[0] ?? '').toLowerCase();
      const preset = PRESETS[presetName];
      if (!preset) {
        const list = Object.keys(PRESETS).join(', ');
        ctx.state.sendSystemMessage?.(`Usage: [outfit <${list}>`);
        return;
      }
      applyOutfit(api, ctx.world, ctx.sender, preset);
      ctx.state.sendSystemMessage?.(`Outfit changed: ${presetName}`);
    },
  });

  return () => {
    api.commands.unregister('outfit');
  };
}

/**
 * Public for tests + the character-creator path (FAZA BR will call this
 * directly once a body/sex/preset selection completes).
 *
 * @param {import('@uo/server/src/scripts.js').ScriptAPI} api
 * @param {import('../../../server/src/world/world.js').World} world
 * @param {import('../../../server/src/world/world.js').Mobile} mob
 * @param {Array<{template:string, layer:number, hue?:number}>} preset
 */
export function applyOutfit(api, world, mob, preset) {
  const runtimeApi = api?.world ? api : { ...api, world };
  const touchedLayers = new Set(preset.map((p) => p.layer));

  // Strip any existing items on the layers we're about to fill. Layer
  // 21 (Backpack) is never in any preset so the inventory is preserved.
  for (const it of [...equipped(runtimeApi, mob)]) {
    if (touchedLayers.has(it.layer ?? 0)) {
      // Fire onUnequip first so lit torches snuff, etc.
      runtimeApi.itemScripts?.dispatch?.(world, it, 'onUnequip', mob);
      destroyItemBySerial({ world }, it.serial);
    }
  }

  // Spawn each piece and equip it.
  for (const piece of preset) {
    let item;
    try {
      item = api.templates.spawn(world, piece.template, {
        x: mob.x, y: mob.y, z: mob.z, map: mob.map,
        parent: mob.serial,
        layer: piece.layer,
        ...(piece.hue != null ? { hue: piece.hue } : {}),
      });
    } catch (e) {
      api.log?.(`outfit: spawn ${piece.template} failed: ${e.message}`);
      continue;
    }
    runtimeApi.itemScripts?.dispatch?.(world, item, 'onEquip', mob);
    // Broadcast to nearby clients (same fan-out as handleWearItem).
    const msg = equipUpdate({
      serial: item.serial, itemId: item.itemId, layer: item.layer,
      parent: mob.serial, hue: item.hue ?? 0,
    });
    sendToClientsNear(runtimeApi, mob, msg);
  }
}

export const _PRESETS_FOR_TEST = PRESETS;
