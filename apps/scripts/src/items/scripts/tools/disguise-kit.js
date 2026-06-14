import { applyDisguise } from '../../../commands/combat/disguise.js';
import { isInPack } from '../../../_inventory.js';

export default function buildDisguiseKit(api) {
  return {
    name: 'disguise-kit',
    onUse(world, item, user) {
      const runtimeApi = api?.world ? api : { ...api, world };
      if (!user?.client) return true;
      if (!isInPack(runtimeApi, item, user)) {
        user.client.sendSystemMessage?.('That must be in your pack for you to use it.');
        return true;
      }
      applyDisguise(api, user, (msg) => user.client.sendSystemMessage?.(msg));
      return true;
    },
  };
}
