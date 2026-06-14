// `[addon <kind>` admin command — drops a decorative addon item bound
// to the matching script. ItemIds chosen to match ServUO graphic refs
// in `Items/Addons/`.

import { nearbyClients } from '../../_spatial.js';
import { itemBySerial } from '../../_entities.js';
import { createItem } from '../../_items.js';

const ADDON_KINDS = {
  // [kind] → { itemId, script, name }
  anvil:           { itemId: 0x0FAF, script: 'anvil',           name: 'an anvil' },
  forge:           { itemId: 0x197A, script: 'forge',           name: 'a forge' },
  loom:            { itemId: 0x1060, script: 'loom',            name: 'a loom' },
  'spinning-wheel':{ itemId: 0x1015, script: 'spinning-wheel',  name: 'a spinning wheel' },
  oven:            { itemId: 0x0931, script: 'oven',            name: 'an oven' },
  'tinker-tools':  { itemId: 0x1EB8, script: 'tinker-tools',    name: 'tinker tools' },
  'carpentry-tools':{itemId: 0x1034, script: 'carpentry-tools', name: 'carpentry tools' },
  'inscription-tools':{itemId: 0x0FBF, script: 'inscription-tools', name: 'inscription tools' },
  'alchemy-table': { itemId: 0x182C, script: 'alchemy-table',   name: 'an alchemy table' },
  'training-dummy':{ itemId: 0x1070, script: 'training-dummy',  name: 'a training dummy' },
  campfire:        { itemId: 0x0DE3, script: 'campfire',        name: 'a campfire' },
  ankh:            { itemId: 0x0003, script: 'ankh',            name: 'an ankh' },
  bookshelf:       { itemId: 0x0A97, script: 'bookshelf',       name: 'a bookshelf' },
  'archery-butte': { itemId: 0x100A, script: 'archery-butte',   name: 'an archery butte' },
  banner:          { itemId: 0x15A8, script: 'banner',          name: 'a banner' },
  fireplace:       { itemId: 0x0DE3, script: 'fireplace',       name: 'a fireplace' },
  'bed-of-nails':  { itemId: 0x1E97, script: 'bed-of-nails',    name: 'a bed of nails' },
  easel:           { itemId: 0x0F65, script: 'easel',           name: 'an easel' },
  'music-box':     { itemId: 0x2AF9, script: 'music-box',       name: 'a music box' },
  'blessed-statue':{ itemId: 0x139A, script: 'blessed-statue',  name: 'a blessed statue' },
  'jewelry-stand': { itemId: 0x0FFE, script: 'jewelry-stand',   name: 'a jewelry stand' },
  'abattoir-block':{ itemId: 0x1183, script: 'abattoir-block',  name: 'an abattoir block' },
  'arcane-circle': { itemId: 0x4FCA, script: 'arcane-circle',   name: 'an arcane circle' },
  scarecrow:       { itemId: 0x1E34, script: 'scarecrow',       name: 'a scarecrow' },
};

export default function register(api) {
  if (!api.commands || !api.world || !api.items) return () => {};

  api.commands.register({
    name: 'addon',
    help: '[addon <kind> — spawn a decorative addon. [addon list. [addon multi <name> — multi-tile addon. [addon redeed.',
    access: 'Admin',
    run(ctx) {
      const arg = String(ctx.args[0] ?? '').toLowerCase();
      if (!arg || arg === 'list') {
        const all = Object.keys(ADDON_KINDS).sort().join(', ');
        ctx.state.sendSystemMessage(`Single-tile addons: ${all}`);
        const multi = api.systems?.addons?.listAddons?.() ?? [];
        if (multi.length) {
          ctx.state.sendSystemMessage(`Multi-tile addons (${multi.length}): ${multi.join(', ')}`);
        }
        return;
      }
      // Multi-tile path — uses systems/housing/addons.js framework.
      if (arg === 'multi') {
        const sys = api.systems?.addons;
        if (!sys) {
          ctx.state.sendSystemMessage('Multi-addon system not loaded.');
          return;
        }
        const name = String(ctx.args[1] ?? '').toLowerCase();
        if (!name || !sys.getAddonDef(name)) {
          ctx.state.sendSystemMessage('Unknown multi-addon. Use [addon list.');
          return;
        }
        const m = ctx.sender;
        const out = sys.placeAddon(api.world, name, {
          x: m.x + 1, y: m.y, z: m.z, map: m.map ?? 1,
        });
        ctx.state.sendSystemMessage(`Placed ${out.length} component(s) of "${name}".`);
        // Broadcast each component to nearby clients.
        for (const item of out) {
          const wi = api.protocol?.worldItemSA?.({
            serial: item.serial, itemId: item.itemId, hue: item.hue,
            amount: 1, x: item.x, y: item.y, z: item.z,
          });
          if (wi) for (const c of nearbyClients(api.world, item)) c.client.send(wi);
        }
        return;
      }
      if (arg === 'redeed') {
        const sys = api.systems?.addons;
        if (!sys) { ctx.state.sendSystemMessage('Multi-addon system not loaded.'); return; }
        ctx.state.sendSystemMessage('Target an addon component.');
        api.targeting?.request?.(ctx.state, (picked) => {
          if (!picked) return;
          const it = itemBySerial(api, picked.serial >>> 0);
          if (!it?._addonAnchor) {
            ctx.state.sendSystemMessage('That is not an addon component.');
            return;
          }
          const r = sys.redeedAddon(api.world, it._addonAnchor);
          if (r) ctx.state.sendSystemMessage(`Re-deeded ${r.addonName}.`);
          else ctx.state.sendSystemMessage('Re-deed failed.');
        });
        return;
      }
      const cfg = ADDON_KINDS[arg];
      if (!cfg) {
        ctx.state.sendSystemMessage(`No such addon. Try [addon list.`);
        return;
      }
      const mob = ctx.sender;
      const item = createItem(api, api.world, {
        itemId: cfg.itemId, x: mob.x, y: mob.y, z: mob.z,
        map: mob.map ?? 1, name: cfg.name, movable: false,
      });
      item.script = cfg.script;
      const wi = api.protocol?.worldItemSA?.({
        serial: item.serial, itemId: item.itemId, hue: item.hue,
        amount: 1, x: item.x, y: item.y, z: item.z,
      });
      if (wi) for (const m of nearbyClients(api.world, item)) m.client.send(wi);
      ctx.state.sendSystemMessage(`You place ${cfg.name}.`);
    },
  });

  return () => api.commands.unregister('addon');
}
