import { destroyItemBySerial } from '../../../_items.js';

const DEFAULT_GUMP_ID = 0x0009;

function ensureCleanupAddon(item) {
  item.container = true;
  item.kind = 'container';
  item.gumpId ||= DEFAULT_GUMP_ID;
  item.capacity ??= 125;
  item.maxWeight ??= 400;
  item.movable = false;
  item.forceShowProperties = true;
  item.cleanupAddonType ??= item.servuoClass ?? 'BaseAddonContainer';
  item.servuoClasses = [...new Set([
    ...(item.servuoClasses ?? []),
    item.servuoClass,
    'BaseAddonContainer',
    'BaseAddonContainerDeed',
    'CleanupArray',
    'AppraiseforCleanup',
    'ContextMenuEntry',
  ].filter(Boolean))];
}

function cleanupName(item) {
  return String(item.cleanupAddonType ?? item.servuoClass ?? item.name ?? '').toLowerCase();
}

function dropMessage(item) {
  return cleanupName(item).includes('venus')
    ? 'The item will be digested in three minutes.'
    : 'The item will be deleted in three minutes.';
}

function successMessage(item, points) {
  if (cleanupName(item).includes('venus')) {
    return points > 0
      ? `The flytrap digests the offering. (+${points} Cleanup Britannia points)`
      : 'The flytrap digests that.';
  }
  return points > 0
    ? `The altar accepts the sacrifice. (+${points} Cleanup Britannia points)`
    : 'The altar consumes that.';
}

export default function buildCleanupAddonContainer(api) {
  return {
    name: 'cleanup-addon-container',
    onCreate(_world, item) {
      ensureCleanupAddon(item);
    },
    onUse(_world, item, user) {
      ensureCleanupAddon(item);
      user?.client?.sendSystemMessage?.('Drop unwanted items here, or use [trash appraise <item> to check Clean Up Britannia value.');
      return true;
    },
    onDrop(world, item, dropped, dropper) {
      ensureCleanupAddon(item);
      if (!dropped || !dropper) return false;
      const acc = dropper.client?.account ?? dropper.account;
      const points = acc ? (api.systems?.cleanup?.turnIn?.(acc, world, dropped) ?? 0) : 0;
      if (points <= 0) {
        try { destroyItemBySerial({ ...api, world }, dropped.serial); }
        catch { /* already gone */ }
      }
      dropper.client?.sendSystemMessage?.(dropMessage(item));
      dropper.client?.sendSystemMessage?.(successMessage(item, points));
      return true;
    },
  };
}
