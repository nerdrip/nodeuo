import { EXACT_MOUNT_BODIES } from '../shared/mount-data.js';

/** Safety substitutions for stale/incomplete UO animation archives. */
export const BODY_FALLBACK = Object.freeze({
  52: 51, 29: 211, 81: 80, 106: 12, 142: 42, 143: 42,
  235: 234, 236: 277, 239: 241, 260: 24, 268: 780,
  // Stygian Abyss / Mondain post-AOS bodies.
  716: 28, 717: 28, 718: 13, 719: 26, 720: 15, 721: 9, 722: 24,
  723: 28, 724: 28, 725: 9, 726: 226, 727: 226, 728: 65, 729: 28,
  730: 235, 732: 51, 733: 5, 734: 28, 735: 28, 736: 28, 737: 28,
  738: 87, 739: 26, 740: 24, 741: 9, 742: 9, 743: 9,
  826: 12, 829: 14, 830: 24, 831: 6, 832: 6,
  // Small legacy animals with missing or placeholder frames.
  201: 226, 205: 226, 238: 215, 234: 235, 287: 51,
  // EP1 Bodyconv redirects.
  256: 9, 257: 12, 258: 65, 259: 9, 261: 13,
  262: 9, 263: 9, 264: 65, 265: 12, 266: 235, 267: 9,
  269: 5, 270: 9, 271: 9, 272: 9, 273: 9,
  276: 235, 280: 9, 281: 9, 285: 14,
  277: 26, 278: 226, 279: 226, 282: 6, 283: 6, 284: 226,
  // Necromancy, Bushido and Ninjitsu transformation bodies.
  747: 24, 748: 0x0303, 749: 305, 750: 47, 751: 312, 752: 87,
  753: 24, 754: 226, 755: 6, 756: 24,
  // Some archives contain only the female gargoyle animation.
  666: 667,
});

export const GENERIC_MONSTER = 9;
export const GENERIC_ANIMAL = 226;

/** Resolve Body.def without overriding canonical Bodyconv/UOP/mount art. */
export function resolvedMobileBody(atlas, body) {
  body |= 0;
  if (!atlas) return body;
  const hasExact = !!atlas.bodies?.[body];
  const bodyConv = atlas.bodyConv?.[body];
  const usesUop = ((atlas.mobTypes?.[body]?.flags | 0) & 0x10000) !== 0;
  if (hasExact && (bodyConv || usesUop || EXACT_MOUNT_BODIES.has(body))) return body;
  const alias = atlas.aliases?.[body];
  const aliasBody = alias?.body ?? alias?.trueBody;
  return aliasBody != null && atlas.bodies?.[aliasBody] ? aliasBody : body;
}
