// Misc tool items — Spyglass, Bedroll, Bag of Sending.
//
// Each script is a thin OnUse handler that mirrors a single ServUO
// utility item. None of them require complex state, so they share a
// module + a registry export rather than getting their own files.

import { findChild } from '../../../_inventory.js';
import { moveItem } from '../../../_movement.js';
import { itemBySerial } from '../../../_entities.js';

const MOON_PHASES = [
  'new', 'waxing crescent', 'first quarter', 'waxing gibbous',
  'full', 'waning gibbous', 'last quarter', 'waning crescent',
];

const TIDE_DIRECTIONS = [
  'north', 'northeast', 'east', 'southeast',
  'south', 'southwest', 'west', 'northwest',
];

/** Map server time to one of 8 lunar phases. ServUO `Misc/Spyglass.cs`
 *  reads `Server.Clock.GetMoonPhase(MoonType)` which we approximate
 *  with two staggered cycles (Trammel 8.6 days, Felucca 12.7 days). */
export function moonPhaseIndex(facetId, now = Date.now()) {
  const period = facetId === 0 ? 12.7 * 86400_000 : 8.6 * 86400_000;
  const phase = (now / period) % 1;
  return Math.floor(phase * MOON_PHASES.length);
}

export function moonPhase(facetId, now = Date.now()) {
  return MOON_PHASES[moonPhaseIndex(facetId, now)];
}

/** ServUO also reports tide direction. We derive a stable direction from
 *  the relative pull of both moons so it changes gradually with the same
 *  clock source as the phase display. */
export function tideDirection(now = Date.now()) {
  const tram = moonPhaseIndex(1, now);
  const fel = moonPhaseIndex(0, now);
  return TIDE_DIRECTIONS[(tram + (fel * 2)) % TIDE_DIRECTIONS.length];
}

export function buildSpyglassScript(api) {
  return {
    name: 'spyglass',
    onUse(_w, _item, user) {
      if (!user?.client) return true;
      const now = typeof api?.now === 'function' ? api.now() : Date.now();
      const tram = moonPhase(1, now);
      const fel  = moonPhase(0, now);
      const tide = tideDirection(now);
      user.client.sendSystemMessage?.(`You sight the heavens through the spyglass.`);
      user.client.sendSystemMessage?.(`  Trammel:  ${tram} moon`);
      user.client.sendSystemMessage?.(`  Felucca:  ${fel} moon`);
      user.client.sendSystemMessage?.(`  Tide:     flowing ${tide}`);
      return true;
    },
  };
}

export function buildBedrollScript(_api) {
  return {
    name: 'bedroll',
    onUse(_w, item, user) {
      if (!user?.client) return true;
      // Toggle rolled / unrolled state via itemId swap. ServUO has
      // 0x0A55 (rolled) / 0x0A57 (unrolled). When unrolled the bedroll
      // applies a temporary +regen buff while the user remains adjacent.
      if (item.itemId === 0x0A55) {
        item.itemId = 0x0A57;
        user._restedUntil = Date.now() + 30 * 60_000;
        user._restedRegen = 2;
        user.client.sendSystemMessage?.('You spread the bedroll out and sit down to rest.');
      } else {
        item.itemId = 0x0A55;
        delete user._restedRegen;
        user.client.sendSystemMessage?.('You roll up the bedroll.');
      }
      return true;
    },
  };
}

export function buildBagOfSendingScript(api) {
  return {
    name: 'bag-of-sending',
    onUse(world, item, user) {
      if (!user?.client) return true;
      item.charges ??= 20;                         // ServUO default 20 charges
      if (item.charges <= 0) {
        user.client.sendSystemMessage?.('The bag of sending is depleted.');
        return true;
      }
      if (!api.targeting?.request) return true;
      user.client.sendSystemMessage?.('Target an item to send to your bank.');
      api.targeting.request(user.client, (picked) => {
        if (!picked?.serial) return;
        const obj = itemBySerial({ world }, picked.serial >>> 0);
        if (!obj) { user.client.sendSystemMessage?.('That cannot be sent.'); return; }
        if (obj.parent !== user.serial) {
          user.client.sendSystemMessage?.('The item must be in your pack.');
          return;
        }
        // Find the bank container (layer 29 on the mob, or
        // user.bankSerial pointer if exposed by the engine).
        const bank = findChild(api, user, (it) => it.layer === 29);
        if (!bank) {
          user.client.sendSystemMessage?.('You have no bank box.');
          return;
        }
        try {
          moveItem(api, obj, { parent: bank.serial, x: 0, y: 0, z: 0 });
        } catch { /* */ }
        item.charges -= 1;
        try { api.items?.invalidateProps?.(item.serial); } catch { /* */ }
        user.client.sendSystemMessage?.(
          `Sent ${obj.name ?? 'an item'} to your bank (${item.charges} charges left).`,
        );
      });
      return true;
    },
  };
}
