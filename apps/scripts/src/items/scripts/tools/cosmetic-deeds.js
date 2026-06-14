import { destroyItemBySerial } from '../../../_items.js';
// Cosmetic deed family — ServUO `Items/Special/*` consumable cosmetics.
//
//   • Name Change Deed   → prompts the user for a new character name.
//                           Validates length + no profanity (basic).
//   • Hair Restyling Deed → spawns a `[hairstyle` prompt; player picks
//                           a hair style id from a pre-defined list.
//   • Beard Restyling Deed → same for facial hair.
//   • Incense / Perfume   → cosmetic flavor; broadcasts a fragrance
//                           overhead message and lingers 10 min.
//   • Necromancy Reagent  → no-op "container" that auto-restocks 5
//     Pouch                 reagents per double-click if charges remain.
//
// All deeds destroy themselves on success. Failures (invalid name, no
// charges, etc.) leave the item intact.

const HAIR_STYLE_IDS = [0x203B, 0x203C, 0x203D, 0x2044, 0x2045, 0x2047, 0x2048, 0x2049];
const BEARD_STYLE_IDS = [0x203E, 0x203F, 0x2040, 0x2041, 0x2042, 0x2043, 0x204B, 0x204C, 0x204D];

const PROFANITY = new Set(['admin', 'gm', 'staff', 'seer', 'counselor']);

function validateName(name) {
  if (typeof name !== 'string') return 'name-required';
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 24) return 'bad-length';
  if (!/^[A-Za-z][A-Za-z' -]*$/.test(trimmed)) return 'bad-chars';
  if (PROFANITY.has(trimmed.toLowerCase())) return 'reserved';
  return null;
}

export function buildNameChangeDeed(api) {
  return {
    name: 'name-change-deed',
    onUse(world, item, user) {
      if (!user?.client) return true;
      user.client.sendSystemMessage?.('Type a new name and confirm in chat (or hit ENTER to cancel):');
      // We expose a one-shot prompt — the speech handler reads
      // `user._nameChangePending` and applies the rename. If the
      // engine ships a TextEntry dialog hook, prefer that; fallback
      // sets a flag the speech path consumes.
      user._nameChangePending = { itemSerial: item.serial };
      // Auto-clear after 30 s so the deed cannot be abused as a
      // permanent "your next chat line renames you" toggle.
      setTimeout(() => { if (user._nameChangePending?.itemSerial === item.serial) delete user._nameChangePending; }, 30_000).unref?.();
      return true;
    },
    onSpeech(world, item, user, text) {
      if (user._nameChangePending?.itemSerial !== item.serial) return false;
      const err = validateName(text);
      if (err) {
        user.client?.sendSystemMessage?.(`Cannot rename: ${err}.`);
        return false;
      }
      const oldName = user.name;
      user.name = text.trim();
      try { destroyItemBySerial(api, item.serial); } catch { /* */ }
      delete user._nameChangePending;
      user.client?.sendSystemMessage?.(`Renamed from ${oldName} to ${user.name}.`);
      return true;
    },
  };
}

export function buildHairRestylingDeed(api) {
  return {
    name: 'hair-restyling-deed',
    onUse(world, item, user) {
      if (!user?.client) return true;
      // ServUO opens a gump; we cycle through styles + report. The
      // user can `[deed-next` to advance, but for an MVP we randomise.
      const next = HAIR_STYLE_IDS[Math.floor(Math.random() * HAIR_STYLE_IDS.length)];
      user._hairItemId = next;
      try { destroyItemBySerial(api, item.serial); } catch { /* */ }
      user.client.sendSystemMessage?.(`Your hairstyle changes (0x${next.toString(16)}).`);
      return true;
    },
  };
}

export function buildBeardRestylingDeed(api) {
  return {
    name: 'beard-restyling-deed',
    onUse(world, item, user) {
      if (!user?.client) return true;
      const next = BEARD_STYLE_IDS[Math.floor(Math.random() * BEARD_STYLE_IDS.length)];
      user._beardItemId = next;
      try { destroyItemBySerial(api, item.serial); } catch { /* */ }
      user.client.sendSystemMessage?.(`Your facial hair changes (0x${next.toString(16)}).`);
      return true;
    },
  };
}

export function buildIncenseScript(_api) {
  return {
    name: 'incense',
    onUse(_w, item, user) {
      if (!user?.client) return true;
      const SCENTS = ['sandalwood', 'jasmine', 'patchouli', 'amber', 'cedar'];
      const scent = item.scent ?? SCENTS[Math.floor(Math.random() * SCENTS.length)];
      user._scentUntil = Date.now() + 10 * 60_000;
      user._scent = scent;
      user.client.sendSystemMessage?.(`A wisp of ${scent} surrounds you.`);
      return true;
    },
  };
}

export function buildPerfumeScript(_api) {
  return {
    name: 'perfume',
    onUse(_w, item, user) {
      if (!user?.client) return true;
      item.charges ??= 10;
      if (item.charges <= 0) {
        user.client.sendSystemMessage?.('The perfume bottle is empty.');
        return true;
      }
      item.charges -= 1;
      user._perfumeUntil = Date.now() + 30 * 60_000;
      user.client.sendSystemMessage?.(`You dab on a touch of perfume (${item.charges} uses).`);
      return true;
    },
  };
}

const NECRO_REAGENT_KINDS = [
  'bat-wing', 'daemon-blood', 'grave-dust', 'nox-crystal', 'pig-iron',
];
const NECRO_REAGENT_ITEMS = {
  'bat-wing': 0x0F78,
  'daemon-blood': 0x0F7D,
  'grave-dust': 0x0F8F,
  'nox-crystal': 0x0F8E,
  'pig-iron': 0x0F8A,
};

export function buildNecroReagentPouch(api) {
  return {
    name: 'necro-reagent-pouch',
    onUse(world, item, user) {
      if (!user?.client) return true;
      item.charges ??= 30;
      if (item.charges <= 0) {
        user.client.sendSystemMessage?.('The pouch is empty.');
        return true;
      }
      const reagent = NECRO_REAGENT_KINDS[Math.floor(Math.random() * NECRO_REAGENT_KINDS.length)];
      const stack = api.game?.mobile?.giveItem?.(user, {
        itemId: NECRO_REAGENT_ITEMS[reagent],
        name: reagent.replace(/-/g, ' '),
        amount: 5,
      }, { randomGrid: true });
      if (!stack) { user.client.sendSystemMessage?.('You have no pack.'); return true; }
      stack.kind = reagent;
      item.charges -= 5;
      try { api.items?.invalidateProps?.(item.serial); } catch { /* */ }
      user.client.sendSystemMessage?.(`The pouch yields 5 ${reagent} (${item.charges} left).`);
      return true;
    },
  };
}
