// Canonical classification for placeable UO multis. Keeping this in one
// module prevents the GM browser, deed system and housing bridge from
// disagreeing about whether an id represents a house, a boat or scenery.

export const CLASSIC_HOUSE_NAMES = Object.freeze({
  0x64: 'Stone Plaster House',
  0x66: 'Field Stone House',
  0x68: 'Small Brick House',
  0x6A: 'Wood House',
  0x6C: 'Wood Plaster House',
  0x6E: 'Thatched Roof Cottage',
  0x74: 'Brick House (Guild)',
  0x76: 'Two-Story Wood Plaster',
  0x78: 'Two-Story Stone Plaster',
  0x7A: 'Tower',
  0x7C: 'Keep',
  0x7E: 'Castle',
  0x8C: 'Large Patio',
  0x96: 'Large Marble',
  0x98: 'Small Tower',
  0x9A: 'Log Cabin',
  0x9C: 'Sandstone Patio',
  0x9E: 'Villa',
  0xA0: 'Stone Workshop',
  0xA2: 'Marble Workshop',
});

const CLASSIC_FOUNDATIONS = Object.freeze({
  0x64: 'small-stone', 0x66: 'small-stone', 0x68: 'small-brick',
  0x6A: 'small-stone', 0x6C: 'small-marble', 0x6E: 'stone-cottage',
  0x74: 'brick-house', 0x76: '2-story-cottage', 0x78: '2-story-stone',
  0x7A: '2-story-tower', 0x7C: 'keep', 0x7E: 'castle',
  0x8C: 'villa', 0x96: '2-story-marble', 0x98: 'stone-tower',
  0x9A: 'log-cabin', 0x9C: 'sandstone', 0x9E: 'villa',
  0xA0: 'small-stone', 0xA2: 'small-marble',
});

const BOAT_NAMES = Object.freeze({
  0x00: 'Small Ship (N)', 0x01: 'Small Ship (E)', 0x02: 'Small Ship (S)', 0x03: 'Small Ship (W)',
  0x04: 'Small Dragon (N)', 0x05: 'Small Dragon (E)', 0x06: 'Small Dragon (S)', 0x07: 'Small Dragon (W)',
  0x08: 'Medium Ship (N)', 0x09: 'Medium Ship (E)', 0x0A: 'Medium Ship (S)', 0x0B: 'Medium Ship (W)',
  0x0C: 'Medium Dragon (N)', 0x0D: 'Medium Dragon (E)', 0x0E: 'Medium Dragon (S)', 0x0F: 'Medium Dragon (W)',
  0x10: 'Large Ship (N)', 0x11: 'Large Ship (E)', 0x12: 'Large Ship (S)', 0x13: 'Large Ship (W)',
  0x14: 'Large Dragon (N)', 0x15: 'Large Dragon (E)', 0x16: 'Large Dragon (S)', 0x17: 'Large Dragon (W)',
  0x18: 'Orcish Galleon', 0x24: 'Gargish Galleon', 0x30: 'Tokuno Galleon',
  0x3C: 'Rowboat (N)', 0x3D: 'Rowboat (E)', 0x3E: 'Rowboat (S)', 0x3F: 'Rowboat (W)',
  0x40: 'Britannian Ship',
});

// ServUO HouseFoundation multis start at 0x13EC. Current OSI/ServUO data
// extends the plot family through 0x147D (including the larger keep/castle
// foundations). Gaps in the range simply never occur in multi.json.
export function isCustomHouseMulti(id) {
  const n = id | 0;
  return n >= 0x13EC && n <= 0x147D;
}

export function isClassicHouseMulti(id) {
  return Object.hasOwn(CLASSIC_HOUSE_NAMES, id | 0);
}

export function isHouseMulti(id) {
  return isClassicHouseMulti(id) || isCustomHouseMulti(id);
}

export function isBoatMulti(id) {
  const n = id | 0;
  return n >= 0x00 && n <= 0x4B;
}

export function multiKind(id) {
  if (isHouseMulti(id)) return 'house';
  if (isBoatMulti(id)) return 'boat';
  return 'other';
}

export function nameForMulti(id) {
  const n = id | 0;
  if (CLASSIC_HOUSE_NAMES[n]) return CLASSIC_HOUSE_NAMES[n];
  if (BOAT_NAMES[n]) return BOAT_NAMES[n];
  if (n >= 0x18 && n <= 0x23) return 'Orcish Galleon';
  if (n >= 0x24 && n <= 0x2F) return 'Gargish Galleon';
  if (n >= 0x30 && n <= 0x3B) return 'Tokuno Galleon';
  if (n >= 0x40 && n <= 0x4B) return 'Britannian Ship';
  if (isCustomHouseMulti(n)) return 'Customizable House Foundation';
  if (n >= 0x2000) return 'AOS Multi';
  return '';
}

export function foundationForMulti(id) {
  const n = id | 0;
  if (isCustomHouseMulti(n)) return 'custom-foundation';
  return CLASSIC_FOUNDATIONS[n] ?? 'small-stone';
}
