// Character-creation protocol decoding and domain policy. Keeping this module
// free of world/session side effects lets login handlers focus on orchestration
// and gives protocol compatibility rules one testable source of truth.

import { PacketReader } from '@uo/protocol';

export function decodeClassicCreateGenderRace(genderRace, extended) {
  const value = genderRace | 0;
  const female = (value & 1) === 1;
  // Modern ClassicUO uses 2/3 human, 4/5 elf, 6/7 gargoyle. Legacy 0x00
  // used 0/1 human and 2/3 elf. Preserve both wire formats unchanged.
  const decodedRace = (extended || value >= 4)
    ? (value < 4 ? 0 : ((value >> 1) - 1))
    : (value >> 1);
  return { female, race: Math.max(0, Math.min(2, decodedRace | 0)) };
}

export function parseCreateCharacter(packet, extended) {
  const reader = new PacketReader(packet);
  reader.readU8();
  reader.readU32();
  reader.readU32();
  reader.readU8();
  const name = reader.readAsciiFixed(30).replace(/\0+$/, '').trim();
  reader.skip(2);
  reader.readU32();
  reader.readU32();
  reader.readU32();
  const profession = reader.readU8();
  reader.skip(15);
  const genderRace = reader.readU8();
  const str = reader.readU8();
  const dex = reader.readU8();
  const intel = reader.readU8();
  const skill1 = reader.readU8();
  const val1 = reader.readU8();
  const skill2 = reader.readU8();
  const val2 = reader.readU8();
  const skill3 = reader.readU8();
  const val3 = reader.readU8();
  let skill4 = -1;
  let val4 = 0;
  if (extended) {
    skill4 = reader.readU8();
    val4 = reader.readU8();
  }
  const skinHue = reader.readU16();
  const hairId = reader.readU16();
  const hairHue = reader.readU16();
  const beardId = reader.readU16();
  const beardHue = reader.readU16();
  let cityIndex = 0;
  let shirtHue = 0;
  let pantsHue = 0;
  try { cityIndex = reader.readU16(); } catch { /* legacy short form */ }
  try { reader.readU32(); } catch { /* character slot */ }
  try { reader.readU32(); } catch { /* client IP */ }
  try { shirtHue = reader.readU16(); } catch { /* pre-AOS */ }
  try { pantsHue = reader.readU16(); } catch { /* pre-AOS */ }

  const skills = {};
  for (const [skillId, value] of [[skill1, val1], [skill2, val2], [skill3, val3], [skill4, val4]]) {
    if (skillId >= 0 && skillId <= 57 && value > 0) skills[skillId + 1] = value;
  }
  const { race, female } = decodeClassicCreateGenderRace(genderRace, extended);
  return {
    name,
    sex: female ? 1 : 0,
    race,
    profession,
    str: str | 0,
    dex: dex | 0,
    int: intel | 0,
    skills,
    skinHue: skinHue | 0,
    hair: hairId ? { itemId: hairId, hue: hairHue } : null,
    beard: beardId ? { itemId: beardId, hue: beardHue } : null,
    shirtHue,
    pantsHue,
    cityIndex,
  };
}

const RESERVED_NAME_FRAGMENTS = [
  'gm', 'admin', 'staff', 'lord british', 'blackthorn',
  'jaana', 'mariah', 'shamino', 'iolo', 'dupre', 'geoffrey',
  'system', 'server', 'console', 'fuck', 'shit', 'cunt', 'nigger',
];
const NAME_PATTERN = /^[A-Za-z][A-Za-z' -]{1,29}$/;

export function validateCharacterName(name) {
  const trimmed = (name ?? '').trim();
  if (trimmed.length < 2) return 'name too short';
  if (trimmed.length > 30) return 'name too long';
  if (!NAME_PATTERN.test(trimmed)) return 'illegal characters in name';
  const lower = trimmed.toLowerCase();
  for (const fragment of RESERVED_NAME_FRAGMENTS) {
    if (lower.includes(fragment)) return `name contains reserved fragment "${fragment}"`;
  }
  return null;
}

export const STARTER_CITIES = Object.freeze([
  { name: 'New Haven', x: 3667, y: 2625, z: 0, map: 1 },
  { name: 'Britain', x: 1496, y: 1624, z: 10, map: 1 },
  { name: 'Trinsic', x: 1825, y: 2728, z: 0, map: 1 },
  { name: 'Moonglow', x: 4459, y: 1086, z: 0, map: 1 },
  { name: 'Yew', x: 548, y: 979, z: 0, map: 1 },
  { name: 'Magincia', x: 3777, y: 2225, z: 19, map: 1 },
  { name: 'Skara Brae', x: 643, y: 2067, z: 5, map: 1 },
  { name: 'Vesper', x: 2876, y: 676, z: 0, map: 1 },
  { name: 'Minoc', x: 2477, y: 411, z: 15, map: 1 },
]);

export function bodyForRace(race, female) {
  switch (race | 0) {
    case 1: return female ? 0x025E : 0x025D;
    case 2: return female ? 0x029B : 0x029A;
    default: return female ? 0x0191 : 0x0190;
  }
}

const CREATOR_RACE_NAMES = ['human', 'elf', 'gargoyle'];

export function raceNameFromCreatorIndex(race) {
  return CREATOR_RACE_NAMES[Math.max(0, Math.min(2, race | 0))] ?? 'human';
}

export function racePacketId(race, body = 0) {
  if (body === 0x0190 || body === 0x0191) return 1;
  if (body === 0x025D || body === 0x025E) return 2;
  if (body === 0x029A || body === 0x029B || body === 0x0666 || body === 0x0667) return 3;
  if (race === 1 || race === 'human') return 1;
  if (race === 2 || race === 'elf') return 2;
  if (race === 3 || race === 'gargoyle') return 3;
  return 1;
}

const ELF_SKIN_HUES = new Set([
  0x4DE, 0x76C, 0x835, 0x430, 0x24D, 0x24E, 0x24F, 0x0BF,
  0x4A7, 0x361, 0x375, 0x367, 0x3E8, 0x3DE, 0x353, 0x903,
  0x76D, 0x384, 0x579, 0x3E9, 0x374, 0x389, 0x385, 0x376,
  0x53F, 0x381, 0x382, 0x383, 0x76B, 0x3E5, 0x51D, 0x3E6,
]);

export function normalizeCreatorSkinHue(race, hue) {
  const value = (hue | 0) & 0x3fff;
  switch (race | 0) {
    case 1: return (ELF_SKIN_HUES.has(value) ? value : 0x4DE) | 0x8000;
    case 2: return Math.max(1755, Math.min(1779, value || 1755)) | 0x8000;
    default: return Math.max(1002, Math.min(1058, value || 1002)) | 0x8000;
  }
}

export function isValidCreatorHair(race, female, itemId) {
  const id = itemId | 0;
  if (id === 0) return false;
  switch (race | 0) {
    case 1:
      if ((female && (id === 0x2FCD || id === 0x2FBF)) || (!female && (id === 0x2FCC || id === 0x2FD0))) return false;
      return (id >= 0x2FBF && id <= 0x2FC2) || (id >= 0x2FCC && id <= 0x2FD1);
    case 2:
      if (!female) return id >= 0x4258 && id <= 0x425F;
      return id === 0x4261 || id === 0x4262
        || (id >= 0x4273 && id <= 0x4275)
        || id === 0x42B0 || id === 0x42B1 || id === 0x42AA || id === 0x42AB;
    default:
      if ((female && id === 0x2048) || (!female && id === 0x2046)) return false;
      return (id >= 0x203B && id <= 0x203D) || (id >= 0x2044 && id <= 0x204A);
  }
}

export function isValidCreatorBeard(race, female, itemId) {
  const id = itemId | 0;
  if (id === 0 || female) return false;
  switch (race | 0) {
    case 1: return false;
    case 2: return id >= 0x42AD && id <= 0x42B0;
    default: return (id >= 0x203E && id <= 0x2041) || (id >= 0x204B && id <= 0x204D);
  }
}

export function presetFromProfession(profession) {
  switch (profession | 0) {
    case 1: return 'warrior';
    case 2: return 'mage';
    case 3: return 'blacksmith';
    case 4: return 'necromancer';
    case 5: return 'paladin';
    case 6: return 'samurai';
    case 7: return 'ninja';
    default: return 'peasant';
  }
}

export const CREATOR_PRESETS = Object.freeze({
  peasant: [
    { template: 'shirt', layer: 5, hue: 904 },
    { template: 'long-pants', layer: 4, hue: 954 },
    { template: 'sandals', layer: 3, hue: 1107 },
  ],
  warrior: [
    { template: 'leather-tunic', layer: 13 },
    { template: 'leather-leggings', layer: 24 },
    { template: 'leather-cap', layer: 6 },
    { template: 'boots', layer: 3 },
  ],
  mage: [
    { template: 'fancy-shirt', layer: 5, hue: 1109 },
    { template: 'long-pants', layer: 4, hue: 38 },
    { template: 'robe', layer: 22, hue: 38 },
    { template: 'wizard-hat', layer: 6, hue: 38 },
    { template: 'shoes', layer: 3, hue: 68 },
  ],
  blacksmith: [
    { template: 'shirt', layer: 5, hue: 1107 },
    { template: 'long-pants', layer: 4, hue: 1109 },
    { template: 'full-apron', layer: 22, hue: 68 },
    { template: 'boots', layer: 3 },
  ],
  necromancer: [
    { template: 'robe', layer: 22, hue: 38 },
    { template: 'skullcap', layer: 6, hue: 38 },
    { template: 'sandals', layer: 3, hue: 1107 },
  ],
  paladin: [
    { template: 'leather-tunic', layer: 13, hue: 0x03B2 },
    { template: 'leather-leggings', layer: 24, hue: 0x03B2 },
    { template: 'boots', layer: 3 },
    { template: 'body-sash', layer: 12, hue: 0x00CF },
  ],
  samurai: [
    { template: 'shirt', layer: 5, hue: 0x02C3 },
    { template: 'long-pants', layer: 4, hue: 0x02C3 },
    { template: 'wide-brim-hat', layer: 6, hue: 0x02C3 },
    { template: 'boots', layer: 3 },
    { template: 'bokuto', layer: 1 },
  ],
  ninja: [
    { template: 'shirt', layer: 5, hue: 0x0090 },
    { template: 'short-pants', layer: 4, hue: 0x0090 },
    { template: 'bandana', layer: 6, hue: 0x0090 },
    { template: 'body-sash', layer: 12, hue: 0x0090 },
    { template: 'boots', layer: 3 },
    { template: 'bokuto', layer: 1 },
  ],
  bandit: [
    { template: 'shirt', layer: 5, hue: 37 },
    { template: 'short-pants', layer: 4, hue: 38 },
    { template: 'bandana', layer: 6, hue: 37 },
    { template: 'boots', layer: 3 },
    { template: 'body-sash', layer: 12, hue: 37 },
  ],
});
