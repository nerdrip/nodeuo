// `[setname <new-name>` — GM rename for either an item OR a mobile.
// Without a serial argument, opens a cursor target prompt and the
// GM clicks whatever they want to rename. The resolver auto-routes
// the picked serial to either `world.items` or `world.mobiles`.
//
// Items: also broadcasts a worldItemSA refresh so the new name shows
// in tooltips immediately. Mobiles: broadcasts mobileIncoming so
// nearby clients update the entity.
//
// 60-character cap (matches `[vendortitle`). Empty input clears the
// name (item.name = undefined; mob.name reverts to defaults).

import { resolveItemOrMobileArg } from '../_targeting-helpers.js';
import { allMobiles } from '../../_spatial.js';

const NAME_MAX = 60;

// Wave 37: in-memory rename history ring (cap 200). Each entry:
// { ts, gm, kind:'item'|'mobile', serial, oldName, newName }.
// Read via `[setname history [N]` (optional cap, default 20). Cleared
// on process restart — auditors who need durability should pipe to
// shoplog or a dedicated audit log.
const RENAME_HISTORY = [];
const HISTORY_CAP = 200;

function pushHistory(entry) {
  RENAME_HISTORY.push(entry);
  while (RENAME_HISTORY.length > HISTORY_CAP) RENAME_HISTORY.shift();
}

export default function (api) {
  const { commands, world } = api;
  if (!commands) return () => {};

  commands.register({
    name: 'setname',
    help: '[setname <new-name> | history [N] — GM rename + audit ring.',
    access: 'GM',
    run(ctx) {
      // Wave 37: history subcommand. `[setname history [N]` dumps
      // the last N rename events (default 20, max 200).
      if (String(ctx.args[0] ?? '').toLowerCase() === 'history') {
        const n = Math.max(1, Math.min(HISTORY_CAP, parseInt(ctx.args[1], 10) || 20));
        if (!RENAME_HISTORY.length) {
          ctx.state.sendSystemMessage('No rename history yet.');
          return;
        }
        const slice = RENAME_HISTORY.slice(-n);
        ctx.state.sendSystemMessage(`Last ${slice.length} renames:`);
        for (const e of slice) {
          const t = new Date(e.ts).toISOString().slice(11, 19);
          const ser = `0x${(e.serial >>> 0).toString(16)}`;
          const oldN = e.oldName ?? '(none)';
          const newN = e.newName ?? '(cleared)';
          ctx.state.sendSystemMessage(
            `  ${t} ${e.gm} ${e.kind} ${ser}: "${oldN}" → "${newN}"`,
          );
        }
        return;
      }
      const name = ctx.args.join(' ').trim();
      if (name.length > NAME_MAX) {
        ctx.state.sendSystemMessage(`Name too long (max ${NAME_MAX} chars).`);
        return;
      }
      ctx.state.sendSystemMessage(
        name ? `Target what you want renamed to "${name}"…` : 'Target whose name you want cleared…',
      );
      // Args index 99 = sentinel forcing cursor target (no serial parse).
      resolveItemOrMobileArg(api, ctx, 99, (picked) => {
        if (!picked) return;
        if (picked.kind === 'item') {
          const item = picked.ref;
          const oldName = item.name ?? `(itemId 0x${(item.itemId | 0).toString(16)})`;
          item.name = name || undefined;
          // Broadcast — ground items via worldItemSA, parented via container update.
          if (!item.parent && api.protocol?.worldItemSA) {
            const pkt = api.protocol.worldItemSA({
              serial: item.serial, itemId: item.itemId, hue: item.hue ?? 0,
              amount: item.amount ?? 1,
              x: item.x | 0, y: item.y | 0, z: item.z | 0,
            });
            for (const m of allMobiles({ world })) {
              if (!m.client || m.map !== item.map) continue;
              if (Math.abs((m.x | 0) - (item.x | 0)) > 18) continue;
              if (Math.abs((m.y | 0) - (item.y | 0)) > 18) continue;
              m.client.send(pkt);
            }
          } else if (item.parent && api.protocol?.containerContentUpdate) {
            ctx.state.send(api.protocol.containerContentUpdate(item, item.parent));
          }
          // Tooltip cache invalidate.
          const provider = ctx.state?.ctx?.propertyProvider;
          if (provider && api.properties?.nudge && api.properties?.computeHash) {
            const r = provider(item.serial, ctx.state);
            if (r?.entries) api.properties.nudge(ctx.state, item.serial, api.properties.computeHash(r.entries));
          }
          pushHistory({
            ts: Date.now(), gm: ctx.sender?.name ?? '?',
            kind: 'item', serial: item.serial >>> 0,
            oldName: oldName, newName: name || null,
          });
          ctx.state.sendSystemMessage(
            name
              ? `Renamed item 0x${(item.serial >>> 0).toString(16)}: "${oldName}" → "${name}".`
              : `Cleared name on item 0x${(item.serial >>> 0).toString(16)}.`,
          );
          return;
        }
        // mobile branch
        const mob = picked.ref;
        const oldName = mob.name ?? '(unnamed)';
        mob.name = name || undefined;
        if (api.protocol?.mobileIncoming) {
          const pkt = api.protocol.mobileIncoming({
            serial: mob.serial, body: mob.body,
            x: mob.x, y: mob.y, z: mob.z,
            direction: mob.direction, hue: mob.hue,
            flags: mob.flags, notoriety: mob.notoriety ?? 1,
          });
          for (const m of allMobiles({ world })) {
            if (!m.client || m.map !== mob.map) continue;
            if (Math.abs(m.x - mob.x) > 18 || Math.abs(m.y - mob.y) > 18) continue;
            m.client.send(pkt);
          }
        }
        // Tooltip cache invalidate.
        const provider = ctx.state?.ctx?.propertyProvider;
        if (provider && api.properties?.nudge && api.properties?.computeHash) {
          const r = provider(mob.serial, ctx.state);
          if (r?.entries) api.properties.nudge(ctx.state, mob.serial, api.properties.computeHash(r.entries));
        }
        pushHistory({
          ts: Date.now(), gm: ctx.sender?.name ?? '?',
          kind: 'mobile', serial: mob.serial >>> 0,
          oldName: oldName, newName: name || null,
        });
        ctx.state.sendSystemMessage(
          name
            ? `Renamed mobile 0x${(mob.serial >>> 0).toString(16)}: "${oldName}" → "${name}".`
            : `Cleared name on mobile 0x${(mob.serial >>> 0).toString(16)}.`,
        );
      }, { promptText: 'Targeting…' });
    },
  });

  return () => commands.unregister('setname');
}
