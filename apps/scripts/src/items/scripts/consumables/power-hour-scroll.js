// Power Hour scroll — double-click grants 1 h of 1.5× skill gain.
// ServUO `PowerHourScroll.OnDoubleClick`. Stamps `_powerHourUntil`
// on the user; tryGain in skill-gain.js reads the flag.

import { consumeOne } from '../_shared/consume.js';

export default function buildPowerHourScript(api) {
  return {
    name: 'power-hour-scroll',
    onUse(world, item, user) {
      if (!user) return true;
      const now = Date.now();
      if ((user._powerHourUntil ?? 0) > now) {
        user.client?.sendSystemMessage?.('A power hour is already in effect.');
        return true;
      }
      user._powerHourUntil = now + 60 * 60 * 1000;
      user.client?.sendSystemMessage?.('You feel an arcane focus — skill gains accelerated for 1 hour.');
      consumeOne(api ?? {}, world, item, user);
      return true;
    },
  };
}
