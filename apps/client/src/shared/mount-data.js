// Canonical mounted-animation table.
//
// Layer.Mount contains an ITEM graphic, not a mobile body.  Retail tiledata
// is not a reliable source for this conversion: several client generations
// reuse the 0x3E9x item range for ship parts and therefore expose zero/wrong
// AnimID values.  ClassicUO deliberately keeps the same explicit table in
// Game/Data/Mounts.cs.  Keep this data protocol-neutral: standard shards still
// send the ordinary Layer.Mount item and the web client resolves it locally.

const rows = [
  [0x3E90, 0x0114,  0], [0x3E91, 0x0115,  0], [0x3E92, 0x011C,  0],
  [0x3E94, 0x00F3,  0], [0x3E95, 0x00A9,  0], [0x3E97, 0x00C3,  0],
  [0x3E98, 0x00C2,  0], [0x3E9A, 0x00C1,  0], [0x3E9B, 0x00C0, -9],
  [0x3E9C, 0x00BF,  0], [0x3E9D, 0x00C0, -9], [0x3E9E, 0x00BE,  0],
  // ServUO Horse has four variants.  CUO's current table starts at 0x3EA0,
  // but the classic brown horse pair 0x00C8/0x3E9F is still emitted by
  // ServUO and must remain supported.
  [0x3E9F, 0x00C8,  0], [0x3EA0, 0x00E2,  0], [0x3EA1, 0x00E4,  0],
  [0x3EA2, 0x00CC,  0], [0x3EA3, 0x00D2,  0], [0x3EA4, 0x00DA,  0],
  [0x3EA5, 0x00DB,  0], [0x3EA6, 0x00DC,  0], [0x3EA7, 0x0074,  0],
  [0x3EA8, 0x0075,  0], [0x3EA9, 0x0072,  0], [0x3EAA, 0x0073,  0],
  [0x3EAB, 0x00AA,  0], [0x3EAC, 0x00AB,  0], [0x3EAD, 0x0084,  0],
  [0x3EAF, 0x0078,  0], [0x3EB0, 0x0079,  0], [0x3EB1, 0x0077,  0],
  [0x3EB2, 0x0076,  0], [0x3EB3, 0x0090,  0], [0x3EB4, 0x007A, -9],
  [0x3EB5, 0x00B1,  0], [0x3EB6, 0x00B2,  0], [0x3EB7, 0x00B3,  0],
  [0x3EB8, 0x00BC,  0], [0x3EBA, 0x00BB,  0], [0x3EBB, 0x0319, -9],
  [0x3EBC, 0x0317,  0], [0x3EBD, 0x031A,  0], [0x3EBE, 0x031F,  0],
  [0x3EC3, 0x02D4,  0], [0x3EC5, 0x00D5,  0], [0x3EC6, 0x01B0,  9],
  [0x3EC7, 0x04E6, 18], [0x3EC8, 0x04E7, 18], [0x3EC9, 0x042D,  3],
  [0x3ECA, 0x0579,  9], [0x3ECB, 0x057F,  0], [0x3ECC, 0x0582,  0],
  [0x3ECD, 0x0580,  0], [0x3ECE, 0x059A,  0], [0x3ECF, 0x05A0,  9],
  [0x3ED0, 0x05A1, 18], [0x3ED1, 0x05E6,  0], [0x3ED2, 0x05F6,  9],
  [0x3ED3, 0x05F7, 18], [0x3ED4, 0x060A,  0], [0x3ED5, 0x060B,  0],
  [0x3ED6, 0x060C,  0], [0x3ED7, 0x060D,  0], [0x3ED8, 0x060F,  0],
  [0x3ED9, 0x0610,  0], [0x3EDA, 0x0590,  9], [0x3EDB, 0x0611,  0],
  [0x3EDC, 0x0666,  0], [0x3EDD, 0x0581,  0], [0x3EDE, 0x0673,  0],
  [0x3EDF, 0x0674,  0], [0x3EE0, 0x0675,  0], [0x3EE1, 0x0678,  0],
  [0x3EE2, 0x0679,  0], [0x3F3A, 0x00D5,  0],
];

export const MOUNT_INFO_BY_ITEM = new Map(rows.map(([itemId, body, riderOffsetY]) => [
  itemId,
  Object.freeze({ itemId, body, riderOffsetY }),
]));

// Body.def is only a fallback in CUO when no Bodyconv/UOP source is active.
// Our already-generated v2 manifest does not carry that source bit, so these
// known mount bodies explicitly retain their own extracted frames instead of
// being replaced by an old-client llama/ostard/horse alias.
export const EXACT_MOUNT_BODIES = new Set([
  // These bodies have complete, visually verified modern frames in the
  // shipped atlas while Body.def points at deliberately crude old-client
  // substitutes. Do not include legacy nightmare/war-horse bodies here:
  // for those, their Body.def horse + hue mapping is the correct artwork.
  0x00C3, 0x00C2, 0x00C1, 0x00C0, 0x00BF, 0x0084, 0x007A,
  0x00BC, 0x00BB, 0x0319, 0x0317, 0x031A, 0x031F,
]);

export function mountInfoForItem(itemId) {
  return MOUNT_INFO_BY_ITEM.get((itemId | 0) & 0xFFFF) ?? null;
}
