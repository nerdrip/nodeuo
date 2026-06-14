// [copy — duplicate the targeted item next to the GM. Mirrors ServUO
// `Dupe.cs` admin tool. Mobiles are not duplicated (their state graph
// is too tangled — use [add <kind> for that).

import { resolveItemArg } from '../_targeting-helpers.js';
import { allMobiles } from '../../_spatial.js';
import { createItem } from '../../_items.js';

const SKIP_KEYS = new Set([
  'serial', 'parent', 'gridX', 'gridY', 'gridLocation', 'layer',
  'x', 'y', 'z', 'map',
  '_decayAt', '_lastTickAt',
]);

export default function (api) {
  const { commands, world, protocol } = api;

  commands.register({
    name: 'copy',
    help: 'Duplicate the targeted item at the caller\'s feet.',
    access: 'GameMaster',
    run: (ctx) => {
      const caller = ctx.state?.mobile;
      if (!caller) return;
      resolveItemArg(api, ctx, 0, (it) => {
        if (!it) return;
        const dup = createItem(api, world, {
          itemId: it.itemId, hue: it.hue ?? 0, amount: it.amount ?? 1,
          x: caller.x, y: caller.y, z: caller.z, map: caller.map,
          name: it.name,
        });
        // Carry over lifecycle + script fields.
        for (const [k, v] of Object.entries(it)) {
          if (SKIP_KEYS.has(k)) continue;
          if (k === 'serial') continue;
          if (typeof v === 'function') continue;
          if (v instanceof Set) dup[k] = new Set(v);
          else if (v instanceof Map) dup[k] = new Map(v);
          else if (Array.isArray(v)) dup[k] = v.slice();
          else if (v && typeof v === 'object') dup[k] = JSON.parse(JSON.stringify(v));
          else dup[k] = v;
        }
        // Refresh visual on every nearby observer.
        if (protocol?.worldItemSA) {
          const pkt = protocol.worldItemSA({
            serial: dup.serial, itemId: dup.itemId, hue: dup.hue ?? 0,
            amount: dup.amount ?? 1, x: dup.x, y: dup.y, z: dup.z,
          });
          for (const m of allMobiles({ world })) {
            if (!m.client || m.map !== dup.map) continue;
            if (Math.abs(m.x - dup.x) > 18 || Math.abs(m.y - dup.y) > 18) continue;
            m.client.send(pkt);
          }
        }
        ctx.state.sendSystemMessage(`Duplicated 0x${(it.serial >>> 0).toString(16)} → 0x${(dup.serial >>> 0).toString(16)}.`);
      });
    },
  });

  return () => commands.unregister('copy');
}
