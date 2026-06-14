// Sample item templates. Registers a handful of canonical UO items so
// content scripts and admin commands can spawn them by name. Each template
// is disposed on script reload so that registry stays in sync with the
// source on disk.

// NOTE: This file used to also register torch/candle/gold/apple/bandage/
// key/backpack/pouch/anvil — but those names are already declared in
// data/config/items.json with the correct itemIds + scripts. Because the
// script loader walks alphabetically and this file loads AFTER `data.js`,
// the local entries silently OVERWROTE the canonical registrations —
// notably, torch was set to 0x0A25 (lit-lantern art) and lost its
// items.json `script: 'torch'` link. User report 2026-05-19 "torch tworzy
// się w eq z grafiką latarni". Keep only entries that are unique to this
// file (no name collision with items.json).
import { nearbyClients } from '../../_spatial.js';

const TEMPLATES = [
  // --- Food ------------------------------------------------------------
  { name: 'bread',       itemId: 0x103B, label: 'a loaf of bread' },
  { name: 'cheese',      itemId: 0x097E, label: 'a wheel of cheese' },

  // --- Containers ------------------------------------------------------
  { name: 'bag',         itemId: 0x0E76, gumpId: 0x003D, label: 'a bag' },
  { name: 'chest',       itemId: 0x09AB, gumpId: 0x0042, movable: false, label: 'a metal chest' },
  { name: 'crate',       itemId: 0x0E3F, gumpId: 0x0044, movable: false, label: 'a wooden crate' },

  // --- Decor / static --------------------------------------------------
  { name: 'sign',        itemId: 0x0B95, movable: false, label: 'a wooden sign' },
  { name: 'forge',       itemId: 0x0FB1, movable: false, label: 'a forge' },
];

/**
 * @param {import('@uo/server/src/scripts.js').ScriptAPI} api
 */
export default function register(api) {
  if (!api.templates) {
    api.log('items/templates: api.templates missing, nothing to register');
    return () => {};
  }
  const names = [];
  for (const t of TEMPLATES) {
    api.templates.registerTemplate(t);
    names.push(t.name);
  }
  api.log(`items/templates: registered ${names.length} templates (${names.slice(0, 6).join(', ')}${names.length > 6 ? ', ...' : ''})`);

  // `[spawn <name>[,hue]` — admin command that creates a templated item at the
  // sender's feet. Complements `[add` (which takes a raw graphic id).
  api.commands.register({
    name: 'spawn',
    help: '[spawn <template>[,hue] — spawn a templated item at your feet',
    run(ctx, args) {
      if (!args.length) {
        ctx.state.sendSystemMessage(`Usage: [spawn <template>  (known: ${api.templates.templateNames().slice(0, 8).join(', ')}, ...)`);
        return;
      }
      const [tmplName, hueStr] = args[0].split(',');
      const hue = hueStr ? parseInt(hueStr, 0) & 0xFFFF : undefined;
      try {
        const item = api.templates.spawn(ctx.world, tmplName, {
          x: ctx.sender.x, y: ctx.sender.y, z: ctx.sender.z, map: ctx.sender.map,
          ...(hue !== undefined ? { hue } : {}),
        });
        for (const other of nearbyClients(api, item)) other.client.sendItem(item);
        ctx.state.sendSystemMessage(`Spawned ${tmplName} as 0x${item.serial.toString(16)}.`);
      } catch (e) {
        ctx.state.sendSystemMessage(`spawn failed: ${e.message}`);
      }
    },
  });

  // Disposer: remove templates + command on reload.
  return () => {
    for (const n of names) api.templates.unregisterTemplate(n);
    api.commands.unregister('spawn');
  };
}
