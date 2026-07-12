import { createItem } from '../../_items.js';
// City Stones — port of ServUO `Engines/CityLoyaltySystem/Mobiles/CityStone.cs`.
// Each major town has a granite/marble stone in its loyalty hall that
// the player double-clicks to:
//   - see their current loyalty tier + points + vendor discount
//   - declare citizenship (≥2000 points; locks them to that city)
//   - renounce citizenship (free; lets them rebind elsewhere)
//
// Item is bound to a `_loyaltyCity` field (the city key — 'Britain',
// 'Trinsic', etc.). Spawn one per town during `[createworld` or manually
// with `[citystone <city>`.

const STONE_ITEM_ID = 0x0EDC;        // engraved granite stone graphic
const STONE_HUE = 0x047E;            // marble white

function accountKeyFor(mob) {
  return mob.accountName ?? mob.name ?? `mob:${mob.serial}`;
}

export default function register(api) {
  if (!api.commands || !api.items) return () => {};
  const citySystem = api.systems?.cityLoyalty;
  const cityNames = citySystem?.listCities?.() ?? [];

  // Lifecycle: any item flagged `_loyaltyCity` becomes a city stone.
  const cityStoneScript = {
    name: 'city-stone',
    onUse(world, item, user) {
      const city = item._loyaltyCity;
      const reg = api.ctx?.cityLoyalty;
      if (!city || !reg) {
        user?.client?.sendSystemMessage?.('The stone is silent.');
        return;
      }
      const acc = accountKeyFor(user);
      const st = reg.status(acc, city);
      user.client?.sendSystemMessage?.(
        `[${city}]  ${st.tierName}  —  ${st.points} loyalty  (${Math.floor(st.discount * 100)}% vendor discount)`,
      );
      if (st.citizen) {
        user.client?.sendSystemMessage?.(
          `You are a citizen of ${city}. Say "renounce" to give up citizenship.`,
        );
      } else if (st.points >= 2000) {
        user.client?.sendSystemMessage?.(
          `Say "I pledge allegiance to ${city}" to declare citizenship.`,
        );
      } else {
        user.client?.sendSystemMessage?.(
          `You need ${2000 - st.points} more loyalty to become a citizen.`,
        );
      }
      user._cityStoneFocus = city;
    },
  };
  api.itemScripts?.register?.(cityStoneScript);

  // Speech listener — any city stone within range hears the pledge /
  // renounce sentences. We attach a behavior to a synthetic `mob`-like
  // wrapper around the stone? Simpler: hook into the global speech bus
  // via a per-player flag (`_cityStoneFocus` set by onUse above).
  api.lifecycle?.event?.('speech', ({ speaker, text }) => {
    if (!speaker?._cityStoneFocus) return;
    const reg = api.ctx?.cityLoyalty;
    if (!reg) return;
    const city = speaker._cityStoneFocus;
    const acc = accountKeyFor(speaker);
    const lower = String(text ?? '').toLowerCase();
    if (lower.includes(`pledge allegiance to ${city.toLowerCase()}`)) {
      const ok = reg.declareCitizen(acc, city);
      speaker.client?.sendSystemMessage?.(
        ok ? `You are now a citizen of ${city}.`
           : `You lack the loyalty to be a citizen of ${city}.`,
      );
    } else if (lower === 'renounce' || lower.includes('renounce citizenship')) {
      const ok = reg.renounce(acc, city);
      speaker.client?.sendSystemMessage?.(
        ok ? `You give up your citizenship of ${city}.`
           : `You are not a citizen of ${city}.`,
      );
    }
  });

  api.commands.register({
    name: 'citystone',
    help: '[citystone <city> — admin: place a city loyalty stone at your feet.',
    access: 'Admin',
    run(ctx, args) {
      const city = String(args?.[0] ?? '');
      if (!cityNames.includes(city)) {
        ctx.state.sendSystemMessage(`Unknown city. Valid: ${cityNames.join(', ')}`);
        return;
      }
      const mob = ctx.sender;
      const stone = createItem(api, api.world, {
        itemId: STONE_ITEM_ID, hue: STONE_HUE,
        x: mob.x, y: mob.y, z: mob.z, map: mob.map,
        name: `${city} City Stone`,
        _loyaltyCity: city,
        kind: 'city-stone',
        scripts: ['city-stone'],
        movable: false,
      });
      ctx.state.sendSystemMessage(
        `${city} city stone 0x${stone.serial.toString(16)} placed.`,
      );
    },
  });

  return () => {
    api.commands.unregister('citystone');
    api.itemScripts?.unregister?.('city-stone');
  };
}
