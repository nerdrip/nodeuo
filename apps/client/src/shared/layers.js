// UO equipment layer constants. Mirrors CUO `Layer` enum + ServUO
// `Layer` enum (Server/Mobile.cs). 1..29 are the worn / held layers
// the paperdoll iterates; 0 is reserved for "not equipped", and 30+
// are internal markers (Bank, Mount visual, Shop containers, …) that
// neither paperdoll nor the admin editor surface.
//
// SHARED MODULE: pure constants. Imported by paperdoll-gump (draw
// order), mobile-renderer (per-direction equip overlay z-sort),
// vendor.js / clothing-presets.js (outfit application), and the
// admin editor's mobile inspector.

export const LAYER_INVALID    = 0;
export const LAYER_ONE_HANDED  = 1;
export const LAYER_TWO_HANDED  = 2;
export const LAYER_SHOES       = 3;
export const LAYER_PANTS       = 4;
export const LAYER_SHIRT       = 5;
export const LAYER_HELM        = 6;
export const LAYER_GLOVES      = 7;
export const LAYER_RING        = 8;
export const LAYER_TALISMAN    = 9;
export const LAYER_NECK        = 10;
export const LAYER_HAIR        = 11;
export const LAYER_WAIST       = 12;
export const LAYER_TORSO       = 13;        // inner chest
export const LAYER_BRACELET    = 14;
export const LAYER_FACE        = 15;        // unused on default human
export const LAYER_BEARD       = 16;
export const LAYER_TUNIC       = 17;        // outer chest
export const LAYER_EARRINGS    = 18;
export const LAYER_ARMS        = 19;
export const LAYER_CLOAK       = 20;
export const LAYER_BACKPACK    = 21;
export const LAYER_ROBE        = 22;
export const LAYER_SKIRT       = 23;
export const LAYER_LEGS        = 24;        // outer legs
export const LAYER_MOUNT       = 25;
export const LAYER_VENDOR_BUY  = 26;
export const LAYER_VENDOR_RESALE = 27;
export const LAYER_VENDOR_SELL = 28;
export const LAYER_BANK        = 29;

/** Inclusive range of layers the paperdoll draws + the player can
 *  actually equip. Excludes the special vendor / bank layers above 25
 *  and Mount (visual only, not a slot the user interacts with). */
export const WORN_LAYERS = Object.freeze([
  LAYER_ONE_HANDED, LAYER_TWO_HANDED, LAYER_SHOES, LAYER_PANTS,
  LAYER_SHIRT, LAYER_HELM, LAYER_GLOVES, LAYER_RING, LAYER_TALISMAN,
  LAYER_NECK, LAYER_HAIR, LAYER_WAIST, LAYER_TORSO, LAYER_BRACELET,
  LAYER_FACE, LAYER_BEARD, LAYER_TUNIC, LAYER_EARRINGS, LAYER_ARMS,
  LAYER_CLOAK, LAYER_ROBE, LAYER_SKIRT, LAYER_LEGS,
]);

/** Paperdoll draw order — bottom (drawn first → painted under) to top
 *  (drawn last → painted over). Cloak goes UNDER the body, weapons go
 *  ON TOP of everything else. Matches CUO `PaperDollInteractable.cs`
 *  layer order for the gump variant. */
export const PAPERDOLL_DRAW_ORDER = Object.freeze([
  LAYER_CLOAK,        // 20 — under body
  LAYER_SHIRT,        //  5
  LAYER_PANTS,        //  4
  LAYER_SHOES,        //  3
  LAYER_LEGS,         // 24
  LAYER_ARMS,         // 19
  LAYER_TORSO,        // 13
  LAYER_TUNIC,        // 17
  LAYER_RING,         //  8
  LAYER_BRACELET,     // 14
  LAYER_FACE,         // 15
  LAYER_GLOVES,       //  7
  LAYER_SKIRT,        // 23
  LAYER_ROBE,         // 22
  LAYER_WAIST,        // 12
  LAYER_NECK,         // 10
  LAYER_HAIR,         // 11
  LAYER_BEARD,        // 16
  LAYER_EARRINGS,     // 18
  LAYER_HELM,         //  6
  LAYER_ONE_HANDED,   //  1 — over body, hand
  LAYER_TWO_HANDED,   //  2 — over body, two hands
]);
