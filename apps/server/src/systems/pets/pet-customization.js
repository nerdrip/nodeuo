// Pet customization — color/dye/saddle/decoration overlays. Mirrors
// ServUO `Items/Equipment/Decoration/PetSlotDeed.cs` + the dye-tub
// applied to ridable mounts.
//
// Each pet stores customisation in `pet.cosmetics`:
//   {
//     coatHue,         // base body hue tint
//     saddleColor,     // ribbon/saddle hue
//     decoration,      // 'flowers' | 'bells' | 'banner' | 'ghost'
//                      // (rendered as overhead overlay sprite)
//     trinketId,       // optional accessory item id (e.g. saddlebags)
//     namePlate,       // 'gold' | 'silver' | 'bronze' (title hue tier)
//   }
//
// Applied at runtime — `cosmetics.coatHue` overrides the broadcast
// 0x77/0x78 hue, `decoration` is announced via 0x70 graphic effect on
// movement events.

const ALLOWED_COATS = new Set([
  0,         // natural
  0x47E,     // crimson
  0x48E,     // violet
  0x481,     // ice blue
  0x44E,     // golden
  0x4F4,     // teal
  0x44,      // bright red
  0x47D,     // purple shadow
  0x35,      // forest green
  0x60,      // ivory
]);

const ALLOWED_DECORATIONS = new Set([
  'flowers', 'bells', 'banner', 'ghost', 'sparkles', 'rune-aura',
]);

/** Apply a coat colour to the pet. */
export function setCoat(pet, hue) {
  if (!pet) return false;
  hue = hue & 0xFFFF;
  if (!ALLOWED_COATS.has(hue)) return false;
  pet.cosmetics ??= {};
  pet.cosmetics.coatHue = hue;
  // ServUO simply re-broadcasts the mob with the new hue field; we
  // do the same — caller (pet command + dye-tub on-use) is responsible
  // for the mobileMoving fan-out.
  pet.hue = hue;
  return true;
}

/** Apply a saddle/ribbon colour. Stored separately from coatHue so a
 *  client gump can render the tack overlay distinct from the body. */
export function setSaddle(pet, hue) {
  if (!pet) return false;
  pet.cosmetics ??= {};
  pet.cosmetics.saddleColor = (hue & 0xFFFF) | 0;
  return true;
}

/** Set a decoration overlay. */
export function setDecoration(pet, kind) {
  if (!pet) return false;
  if (kind && !ALLOWED_DECORATIONS.has(kind)) return false;
  pet.cosmetics ??= {};
  pet.cosmetics.decoration = kind ?? null;
  return true;
}

/** Attach a trinket (saddlebags, banner pole). */
export function setTrinket(pet, itemId) {
  if (!pet) return false;
  pet.cosmetics ??= {};
  pet.cosmetics.trinketId = (itemId | 0) || null;
  return true;
}

/** Name plate tier — purely cosmetic. */
export function setNamePlate(pet, tier) {
  if (!pet) return false;
  if (!['gold', 'silver', 'bronze', null, undefined].includes(tier)) return false;
  pet.cosmetics ??= {};
  pet.cosmetics.namePlate = tier ?? null;
  return true;
}

export function snapshotCosmetics(pet) {
  return pet?.cosmetics ? { ...pet.cosmetics } : null;
}

export function clearCosmetics(pet) {
  if (!pet) return false;
  delete pet.cosmetics;
  return true;
}

export const PET_COSMETICS_CONST = Object.freeze({
  ALLOWED_COATS: [...ALLOWED_COATS],
  ALLOWED_DECORATIONS: [...ALLOWED_DECORATIONS],
});
