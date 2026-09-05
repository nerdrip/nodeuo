// Ultima Store — port of ServUO `Scripts/Services/UltimaStore/`.
// We deliberately don't accept real currency in
// our shard — the "store" is just a curated catalogue of decorative
// items that players can buy with `sovereigns`, an alternate currency
// awarded by event participation, anniversaries, BODs, etc.

import { resolveItemType } from '../../world/item-types.js';
import { createItem } from '../../world/items.js';

const CATALOGUE = Object.freeze([
  { id: 'silver-cuff',    type: 'SilverBracelet',      label: 'Silver Cuff',        cost: 50,  category: 'jewelry', hue: 0x0481 },
  { id: 'sage-scarf',     type: 'BodySash',            label: 'Sage Scarf',         cost: 80,  category: 'apparel', hue: 0x059B },
  { id: 'crystal-bell',   type: 'HolidayBell',         label: 'Crystal Bell',       cost: 120, category: 'decor',   hue: 0x0482 },
  { id: 'phoenix-banner', type: 'UltimaBanner',        label: 'Phoenix Banner',     cost: 220, category: 'decor',   hue: 0x0489 },
  { id: 'shrine-pillar',  type: 'ObsidianPillarDeed', label: 'Shrine Pillar Deed', cost: 350, category: 'decor',   hue: 0x047E },
  { id: 'tribal-mask',    type: 'TribalMask',          label: 'Tribal Mask',        cost: 180, category: 'apparel', hue: 0x044E },
  { id: 'mystical-orb',   type: 'MagicCrystalBall',    label: 'Mystical Orb',       cost: 600, category: 'rare',    hue: 0x0481 },
].map(Object.freeze));

export function catalogue() { return CATALOGUE; }
export function findItem(id) { return CATALOGUE.find((i) => i.id === id) ?? null; }

export function balance(account) { return account?._sovereigns | 0; }
export function award(account, n) {
  if (!account) return 0;
  account._sovereigns = (account._sovereigns | 0) + Math.max(0, n | 0);
  return account._sovereigns;
}

export function buy(account, mob, itemId, api) {
  const it = findItem(itemId);
  if (!it) return { ok: false, reason: 'Unknown item.' };
  if (!account || !mob) return { ok: false, reason: 'No account or character context.' };
  const have = balance(account);
  if (have < it.cost) return { ok: false, reason: `Need ${it.cost} sovereigns (you have ${have}).` };

  const definition = resolveItemType(it.type);
  if (!definition) return { ok: false, reason: `Store item ${it.id} is not configured.` };
  const payload = {
    definitionId: definition.definitionId,
    itemId: definition.itemId,
    hue: it.hue ?? definition.hue ?? 0,
    name: it.label,
    storeItemId: it.id,
  };

  // Commit delivery before the debit. A missing backpack or factory failure
  // therefore cannot consume sovereigns without producing an item.
  let spawned = null;
  try {
    spawned = api?.game?.mobile?.giveItem?.(mob, payload, { randomGrid: true }) ?? null;
    if (!spawned && api?.world) {
      const pack = api.game?.inventory?.findBackpack?.(mob)
        ?? mob.backpack ?? mob.equipment?.get?.(21) ?? mob.equipment?.[21];
      if (pack?.serial) {
        spawned = createItem(api.world, {
          ...payload, parent: pack.serial, map: mob.map ?? 1,
          x: 60, y: 60, z: 0, gridX: 60, gridY: 60,
        });
      }
    }
  } catch {
    spawned = null;
  }
  if (!spawned) return { ok: false, reason: 'The item could not be delivered; no sovereigns were spent.' };

  account._sovereigns = have - it.cost;
  return { ok: true, item: it, spawned, remaining: account._sovereigns };
}
