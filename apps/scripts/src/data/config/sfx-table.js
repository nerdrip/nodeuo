// SFX table — central sound-id catalogue. ServUO scatters sound ids
// through every spell / item / mob script; we hoist them here so the
// audio asset pipeline (`apps/client/public/sound/<id>.mp3`) has a
// canonical list and content modules can `import { SFX } from
// '../sfx-table.js'` without remembering hex constants.
//
// IDs match `Music/Digital/Config.txt` + ServUO sound-byte usage. Any
// sound the client doesn't ship simply doesn't play (engine clamps).

export const SFX = Object.freeze({
  // ---- Combat hit / miss ----
  COMBAT_HIT_SWORD:     0x023B, COMBAT_HIT_MACE:      0x0233,
  COMBAT_HIT_FENCING:   0x023D, COMBAT_HIT_BOW:       0x0234,
  COMBAT_MISS:          0x0238, COMBAT_PARRY:         0x0204,
  COMBAT_DEATH_HUMAN:   0x015C, COMBAT_DEATH_FEMALE:  0x0150,

  // ---- Spell cast (magery)
  SPELL_HEAL:           0x1F2, SPELL_GREATER_HEAL:    0x202,
  SPELL_CURE:           0x1E0, SPELL_BLESS:           0x1EA,
  SPELL_CURSE:          0x1EB, SPELL_AGILITY:         0x1E7,
  SPELL_CUNNING:        0x1EB, SPELL_STRENGTH:        0x1F2,
  SPELL_PROTECTION:     0x1ED, SPELL_REACTIVE_ARMOR:  0x1F2,
  SPELL_MAGIC_ARROW:    0x1E5, SPELL_HARM:            0x1F1,
  SPELL_FIREBALL:       0x15E, SPELL_LIGHTNING:       0x029,
  SPELL_ENERGY_BOLT:    0x20A, SPELL_EXPLOSION:       0x208,
  SPELL_FLAMESTRIKE:    0x208, SPELL_CHAIN_LIGHTNING: 0x29,
  SPELL_METEOR_SWARM:   0x160, SPELL_EARTHQUAKE:      0x220,
  SPELL_DISPEL:         0x201, SPELL_MASS_DISPEL:     0x201,
  SPELL_PARALYZE:       0x1F6, SPELL_INVISIBILITY:    0x1F8,
  SPELL_REVEAL:         0x1FD, SPELL_TELEKINESIS:     0x1F5,
  SPELL_TELEPORT:       0x1FE, SPELL_RECALL:          0x1FC,
  SPELL_GATE:           0x20E, SPELL_MARK:            0x1FA,
  SPELL_POLYMORPH:      0x218, SPELL_RESURRECTION:    0x214,

  // ---- Necromancy
  NECRO_PAIN_SPIKE:     0x208, NECRO_POISON_STRIKE:   0x205,
  NECRO_STRANGLE:       0x205, NECRO_WITHER:          0x1FB,
  NECRO_VAMPIRIC:       0x108, NECRO_LICH_FORM:       0x108,
  NECRO_WRAITH:         0x205, NECRO_HORRIFIC_BEAST:  0x108,
  NECRO_VENGEFUL:       0x108, NECRO_BLOOD_OATH:      0x205,
  NECRO_CORPSE_SKIN:    0x205, NECRO_EVIL_OMEN:       0x205,
  NECRO_SUMMON_FAMILIAR:0x217, NECRO_CURSE_WEAPON:    0x205,

  // ---- Chivalry
  CHIV_HEAL:            0x209, CHIV_DISPEL:           0x10F,
  CHIV_CONSECRATE:      0x20C, CHIV_DIVINE_FURY:      0x208,
  CHIV_HOLY_LIGHT:      0x212, CHIV_SACRED_JOURNEY:   0x1FC,
  CHIV_NOBLE:           0x212, CHIV_REMOVE_CURSE:     0x209,

  // ---- Bushido / Ninjitsu
  BUSHIDO_CONFIDENCE:   0x51A, BUSHIDO_EVASION:       0x528,
  BUSHIDO_LIGHTNING:    0x29,  BUSHIDO_MOMENTUM:      0x33D,
  NINJA_BACKSTAB:       0x4E2, NINJA_DEATH_STRIKE:    0x4D4,
  NINJA_SHADOWJUMP:     0x4D6, NINJA_SURPRISE:        0x4D5,
  NINJA_SMOKEBOMB:      0x4F2, NINJA_KI_ATTACK:       0x4D7,

  // ---- Spellweaving
  SW_ARCANE_CIRCLE:     0x65A, SW_GIFT_OF_RENEWAL:    0x65C,
  SW_THUNDERSTORM:      0x10D, SW_WILDFIRE:           0x208,
  SW_ESSENCE_OF_WIND:   0x66C, SW_NATURE_FURY:        0x53D,
  SW_REAPER_FORM:       0x65F, SW_WORD_OF_DEATH:      0x66B,
  SW_SUMMON_FEY:        0x217, SW_SUMMON_FIEND:       0x217,
  SW_GIFT_OF_LIFE:      0x214,

  // ---- Mysticism
  MYSTIC_NETHER_BOLT:    0x211, MYSTIC_HEALING_STONE:  0x64C,
  MYSTIC_ENCHANT:        0x64A, MYSTIC_SLEEP:          0x64E,
  MYSTIC_EAGLE_STRIKE:   0x2EE, MYSTIC_BOMBARD:        0x64B,
  MYSTIC_HAILSTORM:      0x64F, MYSTIC_NETHER_CYCLONE: 0x652,
  MYSTIC_RISING_COLOSSUS:0x64D, MYSTIC_SPELL_PLAGUE:   0x654,

  // ---- Skill use
  SKILL_BANDAGE_TIE:    0x57, SKILL_BANDAGE_HEAL:    0x59,
  SKILL_HIDING:         0x340, SKILL_STEALTH:        0x340,
  SKILL_LOCKPICK_ATTEMPT:0x241, SKILL_LOCKPICK_OPEN: 0x4A,
  SKILL_FORENSIC:       0x041, SKILL_ITEM_ID:        0x244,
  SKILL_SNOOP:          0x153, SKILL_FISHING:        0x21D,
  SKILL_MINE:           0x125, SKILL_SMELT:          0x2A,
  SKILL_TINKER:         0x241, SKILL_CHOP:           0x13E,

  // ---- UI / interaction
  UI_BUTTON_CLICK:      0x4D, UI_PAGE_TURN:          0x55,
  UI_GUMP_OPEN:         0x55, UI_GUMP_CLOSE:         0x58,
  UI_DRAG_PICK:         0x47, UI_DRAG_DROP:          0x42,
  UI_GOLD_DROP:         0x37, UI_BANKBOX_OPEN:       0x43,
  UI_DOOR_OPEN:         0xEC, UI_DOOR_CLOSE:         0xF0,

  // ---- Mobile / animal
  MOB_HORSE_NEIGH:      0xA8, MOB_DOG_BARK:          0xA0,
  MOB_CAT_MEOW:         0x70, MOB_COW_MOO:           0x95,
  MOB_CHICKEN:          0x6E, MOB_PIG:               0xC2,
  MOB_DRAGON_ROAR:      0x16C, MOB_LICH_GROAN:       0x183,
  MOB_GHOST_MOAN:       0x17F, MOB_DEATH_SCREAM:     0x150,

  // ---- Poison + DoT
  POISON_STRIKE:        0x205, POISON_TICK:           0x232,
  BURN_TICK:            0x208, FREEZE_TICK:           0x10C,

  // ---- Misc world
  WORLD_RAIN:           0x10,  WORLD_THUNDER:         0x29,
  WORLD_WIND:           0x14,  WORLD_FIREPLACE:       0x47,
  WORLD_WATER_DRIP:     0x53,  WORLD_FOOTSTEP_GRASS:  0x12B,
  WORLD_FOOTSTEP_STONE: 0x12C, WORLD_FOOTSTEP_WOOD:   0x12D,
  WORLD_FOOTSTEP_WATER: 0x12E,
});

/** Names → SFX[name]. Useful for the `[sfx <name>` admin command. */
export const SFX_NAMES = Object.keys(SFX).sort();

/** Resolve a sound id from a friendly name (case-insensitive). */
export function sfxId(name) {
  if (typeof name === 'number') return name & 0xFFFF;
  const upper = String(name ?? '').toUpperCase().replaceAll('-', '_');
  return SFX[upper] ?? null;
}
