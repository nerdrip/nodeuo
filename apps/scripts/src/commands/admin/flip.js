// ServUO `FlipCommandHandlers` / `FlipableAttribute` /
// `DynamicFlipingAttribute` / `[Flip`.
// GM command that rotates a targeted item through its known art variants.

import { resolveItemArg } from '../_targeting-helpers.js';

function addServuoClasses(item, classes) {
  item.servuoClasses = [...new Set([...(item.servuoClasses ?? []), ...classes])];
  item.servuoClass ??= classes[0];
}

function flipIdsFor(api, item) {
  if (Array.isArray(item.flipIds) && item.flipIds.length > 1) return item.flipIds;
  const own = api.catalog?.items?.getItem?.(item.itemId | 0);
  if (own?.flipId != null) return [item.itemId | 0, own.flipId | 0];
  const variants = api.catalog?.items?.itemVariants?.(item.itemId | 0) ?? [];
  const ids = [...new Set(variants.flatMap((def) => [def.id, def.flipId]).filter((id) => Number.isFinite(id)))];
  if (ids.length > 1) return ids;
  if (item.flipId != null) return [item.itemId | 0, item.flipId | 0];
  return [];
}

export default function register(api) {
  if (!api.commands) return () => {};
  api.commands.register({
    name: 'flip',
    help: '[flip [serial] - turns a flippable item.',
    access: 'GM',
    run(ctx) {
      resolveItemArg(api, ctx, 0, (item) => {
        if (!item) return;
        const ids = flipIdsFor(api, item);
        if (ids.length < 2) {
          ctx.state?.sendSystemMessage?.('That item has no flip variants.');
          return;
        }
        const current = item.itemId | 0;
        const index = ids.findIndex((id) => (id | 0) === current);
        const next = ids[(index + 1 + ids.length) % ids.length] | 0;
        item.itemId = next;
        addServuoClasses(item, ['FlipCommandHandlers', 'FlipableAttribute', 'DynamicFlipingAttribute']);
        ctx.state?.sendSystemMessage?.(`Flipped item to 0x${next.toString(16)}.`);
      }, { promptText: 'Target the item to flip.' });
    },
  });
  return () => api.commands.unregister('flip');
}
