import { destroyItemBySerial } from '../../../_items.js';
// Quest reward bags — Heritage Token Bag (ML quest reward) + Tokuno
// Greater Pigments Sack (Tokuno turn-in chain).
//
// ServUO `HeritageTokenBag.cs` / `TokunoPigmentsSack.cs`. Both items
// are single-use containers that drop a single random reward from
// their pool on use, then self-destruct.

const HERITAGE_TOKENS = [
  { name: 'Bola Ball',                  itemId: 0x0E73, hue: 0x47E },
  { name: 'Token of Loyalty',           itemId: 0x14EB, hue: 0x47E },
  { name: 'Heritage Cloak',             itemId: 0x1515, hue: 0x59 },
  { name: 'Heritage Hairdye',           itemId: 0x0E26, hue: 0x481 },
  { name: 'Heritage Sash',              itemId: 0x152C, hue: 0x481 },
  { name: 'Heritage Statuette (Bear)',  itemId: 0x14F0, hue: 0x47E },
  { name: 'Sherry the Mouse Statuette', itemId: 0x14F0, hue: 0x489 },
];

const TOKUNO_PIGMENT_TIERS = [
  { name: 'pigments of Tokuno: Faded',     itemId: 0x4007, hue: 0      },
  { name: 'pigments of Tokuno: Vivid',     itemId: 0x4007, hue: 0x481  },
  { name: 'pigments of Tokuno: Greater',   itemId: 0x4007, hue: 0x47E  },
];

const SANCTUARY_REWARDS = [
  { name: 'Heartwood Talisman',         itemId: 0x2F58, hue: 0x59  },
  { name: 'Bonecutter',                 itemId: 0x13B7, hue: 0x47E },
  { name: 'Soul Seeker',                itemId: 0x26C2, hue: 0x489 },
  { name: 'Brightsight Lenses',         itemId: 0x1538, hue: 0x47E },
  { name: 'Acid-Proof Robe',            itemId: 0x1F03, hue: 0x500 },
  { name: 'Hat of the Magi',            itemId: 0x1714, hue: 0x489 },
];

function rollAndGive(api, item, user, pool, message) {
  const state = user?.client;
  if (!state) return false;
  const pick = pool[(Math.random() * pool.length) | 0];
  try {
    const reward = api.game?.mobile?.giveItem?.(user, {
      itemId: pick.itemId, hue: pick.hue, name: pick.name,
      movable: true,
    }, { randomGrid: true });
    if (!reward) { state.sendSystemMessage?.('You have no backpack.'); return true; }
    if (reward) {
      reward.artifact = pick.name;
    }
  } catch (e) {
    api.log?.(`[reward-bag] spawn failed: ${e.message}`);
  }
  state.sendSystemMessage?.(`${message}: ${pick.name}.`);
  try { destroyItemBySerial(api, item.serial); }
  catch { /* ignore */ }
  return true;
}

export function buildHeritageTokenBag(api) {
  return {
    name: 'heritage-token-bag',
    onUse(_world, item, user) {
      return rollAndGive(api, item, user, HERITAGE_TOKENS,
        'The Heritage bag splits open and yields');
    },
  };
}

export function buildTokunoPigmentSack(api) {
  return {
    name: 'tokuno-pigment-sack',
    onUse(_world, item, user) {
      return rollAndGive(api, item, user, TOKUNO_PIGMENT_TIERS,
        'The pigment sack reveals');
    },
  };
}

export function buildSanctuaryRewardBag(api) {
  return {
    name: 'sanctuary-reward-bag',
    onUse(_world, item, user) {
      return rollAndGive(api, item, user, SANCTUARY_REWARDS,
        'The Sanctuary bag offers');
    },
  };
}
