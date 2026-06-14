// CLILOC constant table — common cliloc IDs server side broadcasts
// (combat / movement / system / craft). Mirrors the ServUO Cliloc.cs
// usage; numeric values come from the canonical English `cliloc.enu`.
// Codes here can be passed straight to `messageLocalized` and
// translated to whatever locale the client is using.
//
// This is a focused subset — the full file is 50k+ entries, but most
// gameplay broadcasts come from the few hundred listed here.

export const CLILOC = Object.freeze({
  // ---- Combat -----------------------------------------------------
  COMBAT_ATTACK_NO_TARGET:         500441,   // "You can't see that target."
  COMBAT_TARGET_DEAD:              500445,   // "That mobile is dead."
  COMBAT_TARGET_SAFE:              500446,   // "That target is too peaceful to attack."
  COMBAT_OUT_OF_RANGE:             500312,   // "Target is too far away."
  COMBAT_NO_LINE_OF_SIGHT:         500237,   // "You cannot see that target."
  COMBAT_NEED_FREE_HAND:            42,      // "You can't use that with two-handed weapons."
  COMBAT_DEATH_NOTICE:             500449,   // "<name> has been slain."

  // ---- Movement / region -----------------------------------------
  REGION_ENTER_TOWN:               500001,   // "You have entered <region>."
  REGION_GUARDED:                  500113,   // "You are now in a guarded zone."
  REGION_UNGUARDED:                500114,   // "You are no longer in a guarded zone."
  REGION_NO_RECALL:                501802,   // "Recall has been blocked here."
  REGION_NO_GATE:                  501942,   // "Gate travel may not be used here."
  REGION_NO_CHAT:                  502344,   // "Chat is not enabled in this region."

  // ---- Magic / spells --------------------------------------------
  SPELL_INSUFFICIENT_MANA:         502625,   // "You don't have enough mana."
  SPELL_INSUFFICIENT_REAGENTS:     502630,   // "You lack the necessary reagents."
  SPELL_FAILED:                    502632,   // "The spell fizzles."
  SPELL_NEED_TARGET:               501987,   // "Select target..."
  SPELL_OUT_OF_RANGE:              501587,   // "Your target is too far away."
  SPELL_BLOCKED:                   1078262,  // "Magical interference prevents the spell."

  // ---- Skills ----------------------------------------------------
  SKILL_RAISED:                    1042815,  // "You feel your skill in <skill> improving."
  SKILL_AT_CAP:                    501500,   // "You cannot improve any further."
  SKILL_LOCKED:                    500637,   // "That skill is locked."
  SKILL_NEED_TOOL:                 500580,   // "You need the proper tool for that."

  // ---- Crafting --------------------------------------------------
  CRAFT_SUCCESS:                   1044110,  // "You create <item>."
  CRAFT_EXCEPTIONAL:               1044155,  // "You create an exceptional <item>."
  CRAFT_FAILED:                    1044157,  // "You fail to create <item>."
  CRAFT_LACK_RESOURCES:            1044253,  // "You don't have the necessary materials."
  CRAFT_NOT_NEAR_FORGE:            1044305,  // "You must be near a forge to do that."

  // ---- Looting / item ops ----------------------------------------
  ITEM_OUT_OF_RANGE:               500312,
  ITEM_NOT_OWNED:                  500235,   // "You cannot pick that up."
  ITEM_HOUSE_LOCKED:               500383,   // "That item is locked down in this house."
  CONTAINER_FULL:                  502385,   // "That container is full."

  // ---- Death / corpse -------------------------------------------
  DEATH_RESURRECTED:               501224,   // "You have been resurrected."
  DEATH_GHOST_CAN_NOT:             501041,   // "You are a ghost and may not."

  // ---- Chat / speech ---------------------------------------------
  CHAT_BLOCKED_TOXIC:              1062925,  // "Your speech was deemed inappropriate."

  // ---- House -----------------------------------------------------
  HOUSE_PLACED:                    501271,   // "Your house has been placed."
  HOUSE_REMOVED:                   501325,   // "Your house has been demolished."
  HOUSE_FRIEND_ADDED:              501326,   // "<name> is now a friend of the house."
  HOUSE_FRIEND_REMOVED:            501327,   // "<name> is no longer a friend."
  HOUSE_BANNED:                    501328,   // "<name> is now banned from the house."
  HOUSE_LOCKDOWN_FULL:             1005379,  // "You cannot lock down any more items in this house."

  // ---- Vendor ----------------------------------------------------
  VENDOR_NO_GOLD:                  500192,   // "You don't have enough gold."
  VENDOR_THANKS:                   501550,   // "Thank you for your patronage."
  VENDOR_INSUFFICIENT_BANK:        500200,   // "Your bank box does not contain enough gold."

  // ---- Pet -------------------------------------------------------
  PET_TOO_HUNGRY:                  502117,   // "Your pet is too hungry to obey."
  PET_DOES_NOT_OBEY:               501522,   // "That pet does not obey you."
  PET_BONDED_NOTIFY:               1049666,  // "Your pet has bonded to you."

  // ---- Bard ------------------------------------------------------
  BARD_NEED_INSTRUMENT:            500612,
  BARD_TARGET_TOO_TOUGH:           501587,
  BARD_DISCORDED:                  500616,   // "<target> appears agitated and confused."
  BARD_PROVOKED:                   501592,   // "Your music incites the targets to fight."
  BARD_PEACEFUL:                   500616,

  // ---- World event broadcast (event channel) ---------------------
  ARTIFACT_DISCOVERED:             1043336,  // "<player> has discovered the artifact <item>!"
  CHAMPION_DEFEATED:               1075639,  // "The champion of <name> has been slain."
  WORLD_BOSS_SPAWNED:              1075640,  // "<name> has appeared in <region>."
});

/** Reverse lookup — name from numeric. Useful for debug. */
export const CLILOC_NAME_BY_ID = Object.freeze(
  Object.fromEntries(Object.entries(CLILOC).map(([k, v]) => [v, k])),
);
